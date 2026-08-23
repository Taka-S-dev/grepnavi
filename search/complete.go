package search

import (
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
)

// 補完エンジン。LSP とデバッグ行ダイアログの両方から同じ口で呼ばれる。
//
// 方針は GUI の他の機能と同じ「索引の表引き + 軽い構文の見立て」で、AST は持たない。
// できること: (1) `s->rlayer.` のようなメンバーアクセスの先のメンバー一覧、
// (2) それ以外の位置での識別子補完（囲む関数のローカル変数・引数、ファイル内シンボル、
// マクロの前方一致）。型は「囲む関数内の宣言 → グローバル変数表」で引き、typedef を
// 実体まで辿って struct のメンバー表を引く。解決できないときは黙って空を返す
// （間違った候補を出すくらいなら出さない、という規律は他機能と同じ）。

type CompletionItem struct {
	Label  string `json:"label"`
	Kind   string `json:"kind"`             // "local" / "field" / "function" / "global" / "macro"
	Detail string `json:"detail,omitempty"` // 型や種別の補足
}

type CompletionResult struct {
	Items        []CompletionItem `json:"items"`
	MemberAccess bool             `json:"member_access"`       // . / -> の後の補完か
	BasePointer  bool             `json:"base_pointer"`        // 直前の式がポインタ（"." を "->" に直す判断材料）
	Prefix       string           `json:"prefix"`              // 入力途中の識別子（置換範囲の計算用）
	BaseType     string           `json:"base_type,omitempty"` // 解決した型（診断表示用）
	// Incomplete は上限で打ち切った印。エディタはこれを見て打鍵ごとに取り直す
	// （false だと最初の応答を手元で絞り込み続け、後から上位に来るべき候補が出ない）。
	Incomplete bool `json:"incomplete"`
}

// Complete は file の line 行目で、行頭からカーソルまでのテキスト before に対する
// 補完候補を返す。索引のキャッシュが未構築なら少し待つ（初回のサイドカー読み込み）。
func Complete(root, file string, line int, before string) CompletionResult {
	syms := completionSymbols(root)
	lines, err := readFileLines(file)
	if err != nil {
		lines = nil
	}
	return completeWith(syms, root, lines, line, before)
}

// CompleteInText は Complete と同じだが、ファイルの中身を content で受ける。
// エディタの未保存バッファ（ディスクより新しい）を見せるための口。
func CompleteInText(root, content string, line int, before string) CompletionResult {
	syms := completionSymbols(root)
	lines := splitLines(content)
	return completeWith(syms, root, lines, line, before)
}

func completionSymbols(root string) SymbolsByKind {
	CtagsMacroWarmup(root)
	deadline := time.Now().Add(2 * time.Second)
	for {
		st := CtagsMacroNames(root)
		if st.Ready {
			return st.Symbols
		}
		if !st.Loading || time.Now().After(deadline) {
			return SymbolsByKind{}
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func readFileLines(file string) ([]string, error) {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	return splitLines(string(b)), nil
}

func splitLines(s string) []string {
	return strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
}

// ident(\[...\])? を . / -> で繋いだ末尾の式。添字の中身は見ない。
var reMemberChain = regexp.MustCompile(`([A-Za-z_]\w*(?:\[[^\]]*\])?(?:\s*(?:->|\.)\s*[A-Za-z_]\w*(?:\[[^\]]*\])?)*)\s*(->|\.)\s*([A-Za-z_]\w*)?$`)
var reTrailingIdent = regexp.MustCompile(`([A-Za-z_]\w*)$`)
var reChainSplit = regexp.MustCompile(`\s*(?:->|\.)\s*`)
var reIndex = regexp.MustCompile(`\[[^\]]*\]`)

const completionMaxItems = 200

func completeWith(syms SymbolsByKind, root string, lines []string, line int, before string) CompletionResult {
	if m := reMemberChain.FindStringSubmatch(before); m != nil {
		chain := reChainSplit.Split(reIndex.ReplaceAllString(m[1], ""), -1)
		partial := m[3]
		typ, isPtr, ok := resolveChainType(syms, root, lines, line, chain)
		res := CompletionResult{MemberAccess: true, BasePointer: isPtr, Prefix: partial, BaseType: typ, Items: []CompletionItem{}}
		if !ok {
			return res
		}
		owner, ok := resolveStruct(syms, typ)
		if !ok {
			return res
		}
		lowerPartial := strings.ToLower(partial)
		for _, mem := range membersOf(syms, root, owner) {
			if partial != "" && !strings.HasPrefix(strings.ToLower(mem.Name), lowerPartial) {
				continue
			}
			res.Items = append(res.Items, CompletionItem{Label: mem.Name, Kind: "field", Detail: mem.Type})
		}
		// このファイルで実際に使われているメンバーを先に出す。名前順だけだと
		// ssl_st のような 100 件級の構造体で、先頭が allow_early_data_cb のような
		// まず触らないメンバーで埋まる
		freq := identifierFrequency(lines, line)
		sort.SliceStable(res.Items, func(i, j int) bool {
			fi, fj := freq[res.Items[i].Label], freq[res.Items[j].Label]
			if fi != fj {
				return fi > fj
			}
			return res.Items[i].Label < res.Items[j].Label
		})
		return res
	}

	prefix := ""
	if m := reTrailingIdent.FindStringSubmatch(before); m != nil {
		prefix = m[1]
	}
	return rankIdentifiers(syms, lines, line, prefix)
}

// ---- 識別子補完の順位付け ----
//
// 定石どおり「広く集めて順位で絞る」。スコアは足し算で、重みは固定:
//   一致の質   (厳密な前方一致 > 大文字小文字を無視した前方一致) × 10000
//   スコープ層 (local > function > global > macro)               × 1000
//   近さ/頻度  (ローカルは宣言がカーソルに近いほど、他はこのファイルでの出現回数)
// 一致の質を層より重くするのは、大文字で打ったらマクロ、小文字なら関数、という
// 打ち手の意図を尊重するため。説明できる順位を優先して、学習や可変重みは持たない。

type rankedItem struct {
	item  CompletionItem
	score int
}

const (
	scopeLocal    = 0
	scopeFunction = 1
	scopeGlobal   = 2
	scopeMacro    = 3
)

func rankIdentifiers(syms SymbolsByKind, lines []string, line int, prefix string) CompletionResult {
	res := CompletionResult{Prefix: prefix, Items: []CompletionItem{}}
	lower := strings.ToLower(prefix)
	matchQuality := func(name string) int {
		if prefix == "" {
			return 1
		}
		if strings.HasPrefix(name, prefix) {
			return 2
		}
		if strings.HasPrefix(strings.ToLower(name), lower) {
			return 1
		}
		return 0
	}
	freq := identifierFrequency(lines, line)
	seen := map[string]bool{}
	var ranked []rankedItem
	add := func(label, kind, detail string, scope int, proximity int) {
		if label == "" || seen[label] {
			return
		}
		q := matchQuality(label)
		if q == 0 {
			return
		}
		seen[label] = true
		score := q*10000 + (3-scope)*1000 + proximity
		ranked = append(ranked, rankedItem{CompletionItem{Label: label, Kind: kind, Detail: detail}, score})
	}
	// ローカル: 宣言がカーソルに近いほど上（同じ関数の中なので距離は行数で十分）
	decls := localDecls(syms, lines, line)
	for _, d := range decls {
		dist := line - d.line
		if dist < 0 {
			dist = 0
		}
		prox := 99 - dist
		if prox < 0 {
			prox = 0
		}
		add(d.name, "local", d.typ, scopeLocal, prox)
	}
	// 1 文字だけでは全体から集めない（候補が数万件になり、ローカルだけ出す方が役に立つ）
	if len(prefix) >= 2 {
		for _, name := range syms.Functions {
			if q := matchQuality(name); q > 0 {
				add(name, "function", "", scopeFunction, capFreq(freq[name]))
			}
		}
		for name, typ := range syms.Globals {
			add(name, "global", typ, scopeGlobal, capFreq(freq[name]))
		}
		for _, name := range syms.Macros {
			if q := matchQuality(name); q > 0 {
				add(name, "macro", "", scopeMacro, capFreq(freq[name]))
			}
		}
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].score != ranked[j].score {
			return ranked[i].score > ranked[j].score
		}
		return ranked[i].item.Label < ranked[j].item.Label
	})
	if len(ranked) > completionMaxItems {
		ranked = ranked[:completionMaxItems]
		res.Incomplete = true
	}
	// 短い前置詞のうちは、打鍵が進んだら取り直してもらう（集合が変わるため）
	if len(prefix) < 3 {
		res.Incomplete = true
	}
	for _, r := range ranked {
		res.Items = append(res.Items, r.item)
	}
	return res
}

// capFreq は出現回数を近さ点に丸める（上限 99）。
func capFreq(n int) int {
	if n > 99 {
		return 99
	}
	return n
}

// identifierFrequency はこのファイルに出てくる識別子の回数。囲む関数の近くほど
// 関連が強いが、まずはファイル単位で十分（「このファイルで使っている API」が上に来る）。
func identifierFrequency(lines []string, line int) map[string]int {
	freq := map[string]int{}
	if len(lines) == 0 {
		return freq
	}
	for _, l := range lines {
		for _, m := range reWord.FindAllString(l, -1) {
			freq[m]++
		}
	}
	return freq
}

var reWord = regexp.MustCompile(`[A-Za-z_]\w*`)

// ---- 型解決 ----

// resolveChainType は chain（先頭が変数名、以降がメンバー名）の末尾の型と、
// それがポインタかを返す。
func resolveChainType(syms SymbolsByKind, root string, lines []string, line int, chain []string) (typ string, isPtr bool, ok bool) {
	if len(chain) == 0 {
		return "", false, false
	}
	typ, isPtr, ok = variableType(syms, lines, line, chain[0])
	if !ok {
		return "", false, false
	}
	for _, member := range chain[1:] {
		owner, ok := resolveStruct(syms, typ)
		if !ok {
			return "", false, false
		}
		found := false
		for _, m := range membersOf(syms, root, owner) {
			if m.Name == member {
				typ = m.Type
				isPtr = strings.Contains(m.Type, "*")
				found = true
				break
			}
		}
		if !found {
			return "", false, false
		}
	}
	return typ, isPtr, true
}

// membersOf は struct/union のメンバー表。索引の表が空なら（マクロ生成の型など
// ctags が拾えなかった場合）本体をソースから読む。root が空なら索引だけ。
func membersOf(syms SymbolsByKind, root, owner string) []Member {
	if ms := syms.Members[owner]; len(ms) > 0 {
		return ms
	}
	if root == "" {
		return nil
	}
	return structMembersFromSource(root, owner)
}

// variableType は name の型を、囲む関数の宣言 → グローバル変数表の順で引く。
func variableType(syms SymbolsByKind, lines []string, line int, name string) (typ string, isPtr bool, ok bool) {
	for _, d := range localDecls(syms, lines, line) {
		if d.name == name {
			typ, isPtr, ok = d.typ, d.ptr, true // 後の宣言が前を隠すので最後まで回す
		}
	}
	if ok {
		return typ, isPtr, true
	}
	if t, found := syms.Globals[name]; found {
		return t, strings.Contains(t, "*"), true
	}
	return "", false, false
}

// resolveStruct は型文字列を struct/union 名まで辿る。"SSL *" → typedef SSL →
// "struct ssl_st" → "ssl_st"。const や * は剥がす。typedef は深さ 10 まで。
func resolveStruct(syms SymbolsByKind, typ string) (string, bool) {
	for depth := 0; depth < 10; depth++ {
		t := normalizeType(typ)
		switch {
		case strings.HasPrefix(t, "struct "):
			return strings.TrimSpace(strings.TrimPrefix(t, "struct ")), true
		case strings.HasPrefix(t, "union "):
			return strings.TrimSpace(strings.TrimPrefix(t, "union ")), true
		}
		if _, isStruct := syms.Members[t]; isStruct {
			return t, true
		}
		// 表に無い struct 名（メンバーを ctags が拾えなかった等）でも、型名として
		// 索引にあれば struct 扱いで返し、メンバーは本体から読む側に任せる
		if _, isTypedef := syms.Typedefs[t]; !isTypedef && isKnownType(syms, t) && !builtinTypes[t] {
			return t, true
		}
		next, found := syms.Typedefs[t]
		if !found || next == typ {
			return "", false
		}
		typ = next
	}
	return "", false
}

var typeQualifiers = map[string]bool{"const": true, "volatile": true, "static": true, "register": true, "extern": true}

func normalizeType(t string) string {
	t = strings.ReplaceAll(t, "*", " ")
	words := strings.Fields(t)
	out := words[:0]
	for _, w := range words {
		if !typeQualifiers[w] {
			out = append(out, w)
		}
	}
	return strings.Join(out, " ")
}

// ---- 宣言の見立て ----

type localDecl struct {
	name string
	typ  string
	ptr  bool
	line int // 宣言行（1-indexed）。引数はシグネチャ行。近さの順位付けに使う
}

var builtinTypes = map[string]bool{
	"int": true, "char": true, "short": true, "long": true, "float": true, "double": true,
	"void": true, "unsigned": true, "signed": true, "size_t": true, "ssize_t": true, "bool": true,
	"int8_t": true, "int16_t": true, "int32_t": true, "int64_t": true,
	"uint8_t": true, "uint16_t": true, "uint32_t": true, "uint64_t": true,
}

// 型の語が並んだあとに宣言子が続く文。型の最後の語が既知の型（索引の型名・typedef・
// 組み込み）であることを要求して、`return foo;` のような文を宣言と見誤らない。
var reDeclStmt = regexp.MustCompile(`^\s*((?:(?:const|volatile|static|register|unsigned|signed|struct|union|enum|extern)\s+)*[A-Za-z_]\w*)\s*(\**\s*[A-Za-z_][^;{}]*?)\s*;`)
var reDeclarator = regexp.MustCompile(`^\s*(\**)\s*([A-Za-z_]\w*)`)

// localDecls は line を囲む関数の引数とローカル宣言を返す（line 行まで）。
// 囲む関数が無ければ空。
func localDecls(syms SymbolsByKind, lines []string, line int) []localDecl {
	if len(lines) == 0 || line < 1 {
		return nil
	}
	code := codeOnlyLines(lines)
	spans := scanFuncSpans(code)
	span, ok := enclosingSpan(spans, line)
	if !ok {
		return nil
	}
	var decls []localDecl
	// 引数: シグネチャの ( ... ) を { まで集める
	sig := strings.Builder{}
	for i := span.Start - 1; i < len(code) && i < line; i++ {
		sig.WriteString(code[i])
		sig.WriteByte(' ')
		if strings.Contains(code[i], "{") {
			break
		}
	}
	if s := sig.String(); strings.Contains(s, "(") {
		params := s[strings.Index(s, "(")+1:]
		if end := strings.LastIndex(params, ")"); end >= 0 {
			params = params[:end]
		}
		for _, p := range splitTopLevelCommas(params) {
			if d, ok := paramDecl(syms, p); ok {
				d.line = span.Start
				decls = append(decls, d)
			}
		}
	}
	// 本体: 1行で完結する宣言文だけ見る（複数行の初期化子は追わない）
	end := line
	if span.End < end {
		end = span.End
	}
	for i := span.Start; i < end && i < len(code); i++ { // span.Start 行自体はシグネチャ
		m := reDeclStmt.FindStringSubmatch(code[i])
		if m == nil {
			continue
		}
		typeWords := strings.TrimSpace(m[1])
		if !isKnownType(syms, lastWord(typeWords)) {
			continue
		}
		for _, piece := range splitTopLevelCommas(m[2]) {
			dm := reDeclarator.FindStringSubmatch(piece)
			if dm == nil {
				continue
			}
			decls = append(decls, localDecl{name: dm[2], typ: typeWords, ptr: dm[1] != "", line: i + 1})
		}
	}
	return decls
}

// paramDecl は "const SSL *s" / "size_t n" / "unsigned char *buf" を分解する。
func paramDecl(syms SymbolsByKind, p string) (localDecl, bool) {
	p = strings.TrimSpace(p)
	if p == "" || p == "void" || strings.Contains(p, "(") { // 関数ポインタ引数は見送る
		return localDecl{}, false
	}
	p = reIndex.ReplaceAllString(p, "")
	// 末尾の識別子が名前、その前の * がポインタ、残りが型
	m := regexp.MustCompile(`^(.*?)\s*(\**)\s*([A-Za-z_]\w*)$`).FindStringSubmatch(p)
	if m == nil || strings.TrimSpace(m[1]) == "" {
		return localDecl{}, false
	}
	typ := strings.TrimSpace(m[1])
	if !isKnownType(syms, lastWord(typ)) {
		return localDecl{}, false
	}
	return localDecl{name: m[3], typ: typ, ptr: m[2] != ""}, true
}

func isKnownType(syms SymbolsByKind, word string) bool {
	if builtinTypes[word] {
		return true
	}
	if _, ok := syms.Typedefs[word]; ok {
		return true
	}
	if _, ok := syms.Members[word]; ok {
		return true
	}
	i := sort.SearchStrings(syms.Types, word)
	return i < len(syms.Types) && syms.Types[i] == word
}

func lastWord(s string) string {
	f := strings.Fields(s)
	if len(f) == 0 {
		return ""
	}
	return f[len(f)-1]
}

// splitTopLevelCommas は括弧の外のカンマで分割する（初期化子の f(a, b) を割らない）。
func splitTopLevelCommas(s string) []string {
	var parts []string
	depth := 0
	start := 0
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '(', '[', '{':
			depth++
		case ')', ']', '}':
			depth--
		case ',':
			if depth == 0 {
				parts = append(parts, s[start:i])
				start = i + 1
			}
		}
	}
	return append(parts, s[start:])
}
