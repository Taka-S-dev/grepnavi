package search

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

// HoverHit は1件のホバー定義情報。
type HoverHit struct {
	File  string `json:"file"`
	Line  int    `json:"line"`
	Kind  string `json:"kind"`            // "define" / "struct" / "enum" / "union" / "typedef"
	Body  string `json:"body"`            // 抽出したブロック全体
	Decl  bool   `json:"decl"`            // true = 宣言のみ（本体なし）
	Value string `json:"value,omitempty"` // enum_member の計算値。Body はファイル原文のまま保ち、注釈はUI側でヘッダに出す
}

// FindHover は word の定義を検索し、ブロック本体付きで返す。
// 優先順位: GNU Global → ctags → ripgrep
// 検索戦略（ripgrep 時）:
//  1. ヘッダ（*.h,*.hpp）のみ検索 → struct/enum/define/typedef はここで完結
//  2. func の宣言しか見つからなかった場合、ソースファイルも追加検索して定義本体を取得
// 戻り値の第2要素は使用したエンジン名（"gtags" / "ctags" / "rg"）。
func FindHover(ctx context.Context, word, dir, glob, root string, includeChain ...map[string]bool) ([]HoverHit, string, error) {
	chain := map[string]bool{}
	if len(includeChain) > 0 && includeChain[0] != nil {
		chain = includeChain[0]
	}
	if root == "" {
		root = dir
	}

	var hits []DefHit
	engine := "rg"

	// GNU Global が使えるなら定義位置をインデックスから直接取得
	if GtagsAvailable(root) {
		gHits, err := GtagsFindHoverHits(ctx, word, dir)
		if err == nil && len(gHits) > 0 {
			hits = gHits
			engine = "gtags"
		}
	}

	// ctags インデックスがあれば次の優先候補として使う
	if len(hits) == 0 && CtagsIndexed(root) {
		cHits, err := CtagsFindDefinitions(word, root)
		if err == nil && len(cHits) > 0 {
			hits = cHits
			engine = "ctags"
		}
	}

	// gtags/ctags で結果なし → ripgrep にフォールバック
	if len(hits) == 0 {
		const maxPerQuery = 5
		headerGlob := "*.h,*.hpp"

		type phaseResult struct{ hits []DefHit }
		ch1 := make(chan phaseResult, 1)
		ch2 := make(chan phaseResult, 1)

		// Phase 1 と Phase 2 を並列実行
		go func() {
			h, _ := FindDefinitionsN(ctx, word, dir, headerGlob, maxPerQuery)
			ch1 <- phaseResult{h}
		}()
		go func() {
			if glob == headerGlob {
				ch2 <- phaseResult{}
				return
			}
			h, _ := FindDefinitionsN(ctx, word, dir, glob, maxPerQuery)
			ch2 <- phaseResult{h}
		}()

		r1, r2 := <-ch1, <-ch2
		if ctx.Err() != nil {
			return nil, engine, ctx.Err()
		}

		seen := map[string]bool{}
		for _, h := range r1.hits {
			key := fmt.Sprintf("%s:%d", h.File, h.Line)
			if !seen[key] {
				seen[key] = true
				hits = append(hits, h)
			}
		}
		for _, h := range r2.hits {
			key := fmt.Sprintf("%s:%d", h.File, h.Line)
			if !seen[key] {
				seen[key] = true
				hits = append(hits, h)
			}
		}
	}


	var result []HoverHit
	seen := map[string]bool{}
	for _, h := range hits {
		key := fmt.Sprintf("%s:%d", h.File, h.Line)
		if seen[key] {
			continue
		}
		seen[key] = true

		lines, err := CachedLines(h.File)
		if err != nil {
			// ファイルを読めなければテキスト行だけ返す
			result = append(result, HoverHit{File: h.File, Line: h.Line, Kind: h.Kind, Body: h.Text})
			continue
		}

		var body, value string
		isDecl := false
		commentLine := h.Line // コメント抽出基準行（通常はヒット行、enum_member はブロック開始行）
		switch h.Kind {
		case "define":
			body = extractDefineBlock(lines, h.Line)
		case "typedef_close":
			body = extractBraceBlockBackward(lines, h.Line)
			h.Kind = "typedef"
		case "enum_member":
			body = extractContainingBlock(lines, h.Line)
			if body == "" {
				body = h.Text
			}
			// struct initializer の誤検知を除外（最初の行に enum がなければスキップ）
			firstLine := body
			if nl := strings.IndexByte(body, '\n'); nl >= 0 {
				firstLine = body[:nl]
			}
			if !strings.Contains(firstLine, "enum") {
				continue
			}
			// メンバー行が先頭に来るよう表示を組み替える
			body = extractEnumMemberContext(lines, h.Line)
			if body == "" {
				body = h.Text
			}
			if v, ok := enumMemberValue(lines, h.Line); ok {
				value = strconv.FormatInt(v, 10)
			}
			// コメントはenumブロック開始行（typedef enum { の行）基準で抽出
			commentLine = findContainingBlockStart(lines, h.Line)
		case "func":
			body = extractBraceBlock(lines, h.Line, 20)
			// { がない場合は宣言（プロトタイプ）
			// NOTE: 宣言/定義の判定ロジックは search/classify.go の ClassifyKind と対になっています。
			// 片方を変更した場合はもう片方も確認してください。
			if !strings.Contains(body, "{") {
				body = h.Text
				isDecl = true
			}
		case "var", "member":
			// 変数・メンバーは宣言行をそのまま表示（型情報が含まれる）
			if idx := h.Line - 1; idx >= 0 && idx < len(lines) {
				body = strings.TrimSpace(lines[idx])
			}
		default:
			body = extractBraceBlock(lines, h.Line)
		}
		if body == "" {
			body = h.Text
		}
		if comment := extractLeadingComment(lines, commentLine); comment != "" {
			body = comment + "\n" + body
		}
		result = append(result, HoverHit{File: h.File, Line: h.Line, Kind: h.Kind, Body: body, Decl: isDecl, Value: value})
	}

	// func 結果を実装（decl:false）優先・上限2件でフィルタ
	// 宣言（decl:true）は実装が見つからない場合のみ最大2件補完
	// ※ 以前の funcCount >= 2 制限は宣言2件で実装がスキップされるバグがあったため廃止
	var funcDefs, funcDecls []HoverHit
	var nonFunc []HoverHit
	for _, h := range result {
		if h.Kind != "func" {
			nonFunc = append(nonFunc, h)
		} else if !h.Decl {
			funcDefs = append(funcDefs, h)
		} else {
			funcDecls = append(funcDecls, h)
		}
	}
	if len(funcDefs) > 2 {
		funcDefs = funcDefs[:2]
	}
	var funcResult []HoverHit
	funcResult = append(funcResult, funcDefs...)
	if len(funcDefs) == 0 && len(funcDecls) > 0 {
		if len(funcDecls) > 2 {
			funcDecls = funcDecls[:2]
		}
		funcResult = append(funcResult, funcDecls...)
	}
	result = append(nonFunc, funcResult...)

	// typedef エイリアス（typedef struct foo_st Bar;）で本体が取れなかった場合、
	// 参照先の struct/union/enum を追いかける。
	reAlias := regexp.MustCompile(`typedef\s+(struct|union|enum)\s+(\w+)`)
	var extra []HoverHit
	for _, h := range result {
		if h.Kind != "typedef" || strings.Contains(h.Body, "{") {
			continue
		}
		m := reAlias.FindStringSubmatch(h.Body)
		if m == nil {
			continue
		}
		refHits, _ := FindDefinitionsN(ctx, m[2], dir, glob, 5)
		for _, rh := range refHits {
			if rh.Kind != "struct" && rh.Kind != "enum" {
				continue
			}
			lines, err := CachedLines(rh.File)
			if err != nil {
				continue
			}
			body := extractBraceBlock(lines, rh.Line)
			if body != "" {
				extra = append(extra, HoverHit{File: rh.File, Line: rh.Line, Kind: rh.Kind, Body: body})
			}
		}
	}
	result = append(extra, result...)

	// インクルードチェーン内のファイルを先頭に並べる
	if len(chain) > 0 {
		sort.SliceStable(result, func(i, j int) bool {
			inI := chain[result[i].File]
			inJ := chain[result[j].File]
			return inI && !inJ
		})
	}
	return result, engine, nil
}

// extractBraceBlock は startLine（1-indexed）からブレースブロックを抽出する。
// maxLookAhead: { が見つかるまで何行先まで探すか（0 = デフォルト20行）
// 最大 200 行まで。
func extractBraceBlock(lines []string, startLine int, maxLookAhead ...int) string {
	lookAhead := 20
	if len(maxLookAhead) > 0 && maxLookAhead[0] > 0 {
		lookAhead = maxLookAhead[0]
	}
	idx := startLine - 1
	if idx < 0 || idx >= len(lines) {
		return ""
	}

	depth := 0
	started := false
	var buf []string

	for i := idx; i < len(lines) && i < idx+200; i++ {
		// { が見つからないまま lookAhead 行経過したら打ち切り（関数プロトタイプ等）
		if !started && i > idx+lookAhead {
			break
		}

		line := lines[i]

		// { より前に ; が来たらプロトタイプ宣言（別の構造体等の { を誤検知しないよう打ち切る）
		if !started && strings.ContainsRune(line, ';') {
			return ""
		}

		buf = append(buf, line)

		// ブレースをカウント（文字列・コメント内は近似処理）
		inStr := false
		inChar := false
		for j := 0; j < len(line); j++ {
			ch := line[j]
			// エスケープ（'\'' や "\"" 等）は次の1文字ごとスキップ
			if (inStr || inChar) && ch == '\\' {
				j++
				continue
			}
			// 文字列リテラル内はスキップ
			if ch == '"' && !inChar {
				inStr = !inStr
			} else if ch == '\'' && !inStr {
				inChar = !inChar
			} else if !inStr && !inChar {
				if ch == '{' {
					depth++
					started = true
				} else if ch == '}' {
					depth--
				}
			}
		}

		if started && depth <= 0 {
			// 閉じ } の次の行が識別子か ; で始まる場合のみ追加
			// （typedef struct { ... } Name; パターン対応）
			if i+1 < len(lines) {
				next := strings.TrimLeftFunc(lines[i+1], unicode.IsSpace)
				if len(next) > 0 && (next[0] == ';' || next[0] == '_' ||
					(next[0] >= 'a' && next[0] <= 'z') ||
					(next[0] >= 'A' && next[0] <= 'Z')) {
					buf = append(buf, lines[i+1])
				}
			}
			break
		}

	}

	if !started {
		return ""
	}
	return stripCommonIndent(buf)
}

// findContainingBlockStart はメンバー行から逆方向に { を探し、その行の1-indexed行番号を返す。
func findContainingBlockStart(lines []string, memberLine int) int {
	idx := memberLine - 1
	depth := 0
	for i := idx; i >= 0 && i > idx-500; i-- {
		line := lines[i]
		for j := len(line) - 1; j >= 0; j-- {
			ch := line[j]
			if ch == '}' {
				depth++
			} else if ch == '{' {
				depth--
				if depth < 0 {
					return i + 1 // 1-indexed
				}
			}
		}
	}
	return memberLine
}

// extractContainingBlock はメンバー行（enum値等）から逆方向に { を探し、
// そのブロック全体（enum { ... } Name; 等）を抽出する。
// extractEnumMemberContext はメンバー行を先頭に表示するよう整形する。
// 出力フォーマット:
//
//	enum foo {          ← ヘッダ行
//	    ...             ← メンバーが先頭付近でない場合
//	    PREV_MEMBER,    ← 前後2行のコンテキスト
//	    TARGET,         ← 対象メンバー
//	    NEXT_MEMBER,
//	    ...
//	};
func extractEnumMemberContext(lines []string, memberLine int) string {
	memberIdx := memberLine - 1 // 0-indexed
	if memberIdx < 0 || memberIdx >= len(lines) {
		return ""
	}

	// enum ブロックの開始行と終了行を探す
	blockStart := findContainingBlockStart(lines, memberLine) - 1 // 0-indexed
	if blockStart < 0 {
		return ""
	}
	// blockStart が { を含む行、またはその前の typedef/enum 行
	headerIdx := blockStart

	// ブロック終了 } を探す
	depth := 0
	closeIdx := -1
	for i := blockStart; i < len(lines) && i < blockStart+2000; i++ {
		for _, ch := range lines[i] {
			if ch == '{' {
				depth++
			} else if ch == '}' {
				depth--
				if depth <= 0 {
					closeIdx = i
					break
				}
			}
		}
		if closeIdx >= 0 {
			break
		}
	}
	if closeIdx < 0 {
		return ""
	}

	firstMemberIdx := headerIdx + 1
	for i := headerIdx; i <= closeIdx; i++ {
		if strings.ContainsRune(lines[i], '{') {
			firstMemberIdx = i + 1
			break
		}
	}

	var buf []string
	// ヘッダ行は常に表示
	buf = append(buf, lines[headerIdx])
	// 対象より前のメンバーがあれば ... で省略
	if memberIdx > firstMemberIdx {
		buf = append(buf, "    ...")
	}
	// 対象メンバー行（原文のまま。計算値は HoverHit.Value 経由でUI側ヘッダに表示 —
	// body に注釈を混ぜるとファイル原文と区別が付かなくなるため）
	buf = append(buf, lines[memberIdx])
	// 対象より後ろにメンバーがあれば ... で省略し、閉じ } だけ表示
	if memberIdx < closeIdx-1 {
		buf = append(buf, "    ...")
	}
	buf = append(buf, lines[closeIdx])

	return stripCommonIndent(buf)
}

// enumMemberValue は memberLine（1-indexed）の enum メンバーの値を計算する。
// ブロック開始 { を逆方向に探し、最初のメンバー行から computeEnumValue で数える。
func enumMemberValue(lines []string, memberLine int) (int64, bool) {
	memberIdx := memberLine - 1
	if memberIdx < 0 || memberIdx >= len(lines) {
		return 0, false
	}
	blockStart := findContainingBlockStart(lines, memberLine) - 1 // 0-indexed
	if blockStart < 0 || blockStart >= memberIdx {
		return 0, false
	}
	firstMemberIdx := blockStart + 1
	for i := blockStart; i <= memberIdx; i++ {
		if strings.ContainsRune(lines[i], '{') {
			firstMemberIdx = i + 1
			break
		}
	}
	return computeEnumValue(lines, firstMemberIdx, memberIdx)
}

// reEnumValueLine は enum メンバー1行（コメント除去・トリム済み）にマッチする。
// group1: メンバー名 / group2: = の右辺（あれば）
var reEnumValueLine = regexp.MustCompile(`^([A-Za-z_]\w*)\s*(?:=\s*([^,]+?))?\s*,?$`)

// computeEnumValue は firstMemberIdx..memberIdx（0-indexed）を走査して
// 対象メンバーの enum 値を返す。
// 解釈できない行（式による代入・プリプロセッサ分岐・複数メンバー行等）に
// 当たった時点で ok=false — 間違った値を表示するくらいなら表示しない。
func computeEnumValue(lines []string, firstMemberIdx, memberIdx int) (int64, bool) {
	if firstMemberIdx < 0 || memberIdx >= len(lines) || firstMemberIdx > memberIdx {
		return 0, false
	}
	val := int64(-1) // 最初のメンバーで +1 されて 0 になる
	for i := firstMemberIdx; i <= memberIdx; i++ {
		t := strings.TrimSpace(stripLineComment(lines[i]))
		if t == "" {
			continue
		}
		if strings.HasPrefix(t, "#") {
			return 0, false // #if/#ifdef: どの分岐が生きているか分からない
		}
		m := reEnumValueLine.FindStringSubmatch(t)
		if m == nil {
			return 0, false
		}
		if m[2] != "" {
			// 整数リテラル（10進/16進/8進、負数含む）のみ受理
			n, err := strconv.ParseInt(strings.TrimSpace(m[2]), 0, 64)
			if err != nil {
				return 0, false
			}
			val = n
		} else {
			val++
		}
	}
	return val, true
}

func extractContainingBlock(lines []string, memberLine int) string {
	idx := memberLine - 1 // 0-indexed
	if idx < 0 || idx >= len(lines) {
		return ""
	}

	// 逆方向に { を探す（ネスト深さを追跡）
	depth := 0
	openIdx := -1
	for i := idx; i >= 0 && i > idx-500; i-- {
		line := lines[i]
		for j := len(line) - 1; j >= 0; j-- {
			ch := line[j]
			if ch == '}' {
				depth++
			} else if ch == '{' {
				depth--
				if depth < 0 {
					openIdx = i
					break
				}
			}
		}
		if openIdx >= 0 {
			break
		}
	}
	if openIdx < 0 {
		return strings.TrimSpace(lines[idx])
	}

	// { が独立行にある場合（例: "enum foo\n{"）、前の行に型キーワードがあればそこから開始
	startIdx := openIdx
	if openIdx > 0 {
		prevLine := strings.TrimSpace(lines[openIdx-1])
		if strings.HasPrefix(prevLine, "enum") || strings.HasPrefix(prevLine, "struct") || strings.HasPrefix(prevLine, "union") || strings.HasPrefix(prevLine, "typedef") {
			startIdx = openIdx - 1
		}
	}

	// startIdx の行から前進して { ... } ブロックを抽出（1-indexed）
	return extractBraceBlock(lines, startIdx+1)
}

// extractBraceBlockBackward は } TypedefName; の行から逆方向に { を探してブロックを返す。
func extractBraceBlockBackward(lines []string, endLine int) string {
	idx := endLine - 1 // 0-indexed
	if idx < 0 || idx >= len(lines) {
		return ""
	}
	depth := 0
	startIdx := idx
	for i := idx; i >= 0 && i > idx-500; i-- {
		line := lines[i]
		for j := len(line) - 1; j >= 0; j-- {
			ch := line[j]
			if ch == '}' {
				depth++
			} else if ch == '{' {
				depth--
			}
		}
		if depth <= 0 {
			startIdx = i
			break
		}
	}
	return stripCommonIndent(lines[startIdx : idx+1])
}

// maxLeadingCommentLines は複数行 /* */ ブロックの逆方向収集の上限。
// 開始 /* が見つからないと際限なく遡り、ライセンスヘッダ等の巨大コメントを
// ホバーに丸ごと表示してしまうため、これを超えるブロックは破棄する。
const maxLeadingCommentLines = 50

// extractLeadingComment は startLine（1-indexed）の直前にあるコメントブロックを返す。
// C スタイル（// / /* */）に対応。/* */ ブロックは内部フォーマットを問わず丸ごと取得。
// 空行は関数直前に1行まで許容。
func extractLeadingComment(lines []string, startLine int) string {
	var commentLines []string
	skippedBlank := false
	i := startLine - 2
	for i >= 0 {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed == "" {
			// 空行は関数直前に1行まで許容（コメント収集開始後は打ち切り）
			if skippedBlank || len(commentLines) > 0 {
				break
			}
			skippedBlank = true
			i--
			continue
		}
		// /* */ ブロックコメントの末尾を検出 → 開始 /* まで逆方向に一括収集
		if strings.HasSuffix(trimmed, "*/") {
			// 行頭以外に /* がある = コード行の末尾インラインコメント
			// （例: "#define X 64 /* note */"）→ コメント行ではないので打ち切り
			if strings.Index(trimmed, "/*") > 0 {
				break
			}
			if strings.HasPrefix(trimmed, "/*") {
				// 1行完結コメント: /* ... */ → 前の行も続けて確認
				commentLines = append([]string{lines[i]}, commentLines...)
				i--
				continue
			}
			// 複数行ブロックコメント → /* まで一括収集してループ終了
			// 上限内に開始が見つからなければ末尾行ごとブロックを破棄
			block := []string{lines[i]}
			end := i
			for i--; i >= 0 && end-i < maxLeadingCommentLines; i-- {
				block = append([]string{lines[i]}, block...)
				if strings.HasPrefix(strings.TrimSpace(lines[i]), "/*") {
					commentLines = append(block, commentLines...)
					break
				}
			}
			break
		}
		if strings.HasPrefix(trimmed, "//") {
			commentLines = append([]string{lines[i]}, commentLines...)
		} else {
			break
		}
		i--
	}
	// // 連続行や1行コメントの積み重ねでも上限を超えたら破棄（ブロックコメントと同基準）
	if len(commentLines) > maxLeadingCommentLines {
		return ""
	}
	return strings.Join(commentLines, "\n")
}

// extractDefineBlock は #define の継続行（末尾 \）を含めて抽出する。
func extractDefineBlock(lines []string, startLine int) string {
	idx := startLine - 1
	if idx < 0 || idx >= len(lines) {
		return ""
	}
	var buf []string
	for i := idx; i < len(lines) && i < idx+30; i++ {
		buf = append(buf, lines[i])
		trimmed := strings.TrimRight(lines[i], " \t")
		if !strings.HasSuffix(trimmed, "\\") {
			break
		}
	}
	return strings.Join(buf, "\n")
}

// stripCommonIndent は共通インデントを除去して可読性を高める。
func stripCommonIndent(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	minIndent := 1<<31 - 1
	for _, l := range lines {
		if strings.TrimSpace(l) == "" {
			continue
		}
		cnt := 0
		for _, ch := range l {
			if ch == ' ' {
				cnt++
			} else if ch == '\t' {
				cnt += 4
			} else {
				break
			}
		}
		if cnt < minIndent {
			minIndent = cnt
		}
	}
	if minIndent == 1<<31-1 {
		minIndent = 0
	}

	var sb strings.Builder
	for i, l := range lines {
		stripped := stripLeadingN(l, minIndent)
		if i > 0 {
			sb.WriteByte('\n')
		}
		sb.WriteString(stripped)
	}
	return sb.String()
}

func stripLeadingN(s string, n int) string {
	removed := 0
	for i, ch := range s {
		if removed >= n {
			return s[i:]
		}
		if ch == ' ' {
			removed++
		} else if ch == '\t' {
			removed += 4
		} else {
			break
		}
	}
	return strings.TrimLeft(s, " \t")
}

// ExtractFuncBody は file の targetLine を含む関数全体（コメント込み）を返す。
// 戻り値: (コード本体, 開始行1-indexed, 終了行1-indexed, error)
func ExtractFuncBody(file string, targetLine int) (string, int, int, error) {
	lines, err := CachedLines(file)
	if err != nil {
		return "", 0, 0, err
	}
	if targetLine < 1 || targetLine > len(lines) {
		return "", 0, 0, nil
	}
	idx := targetLine - 1

	// 上方向に { を探してブロック開始を見つける
	blockStartIdx := -1
	depth := 0
	for i := idx; i >= 0 && i > idx-500; i-- {
		line := lines[i]
		for j := len(line) - 1; j >= 0; j-- {
			ch := line[j]
			if ch == '}' {
				depth++
			} else if ch == '{' {
				depth--
				if depth < 0 {
					blockStartIdx = i
					goto foundStart
				}
			}
		}
	}
foundStart:
	if blockStartIdx < 0 {
		// targetLine が関数シグネチャ行 (Linux kernel スタイル:
		//   void foo(...)
		//   {                ← { は次行以降
		// ) のとき、上方向 scan は失敗する。下方向に lookAhead 行だけ { を探す。
		// 途中で ; に当たったら関数定義ではない (prototype 呼び出し等) ので諦める。
		const lookAheadLines = 30
		for i := idx; i < len(lines) && i < idx+lookAheadLines; i++ {
			line := lines[i]
			scIdx := strings.IndexRune(line, ';')
			brIdx := strings.IndexRune(line, '{')
			if scIdx >= 0 && (brIdx < 0 || scIdx < brIdx) {
				// ; が先 (または { 無し) → 関数定義ではない
				break
			}
			if brIdx >= 0 {
				blockStartIdx = i
				break
			}
		}
	}
	if blockStartIdx < 0 {
		// 上下どちらにも { が無い → targetLine 周辺だけ返す
		s := funcMax(0, idx-2)
		e := funcMin(len(lines)-1, idx+2)
		return strings.Join(lines[s:e+1], "\n"), s + 1, e + 1, nil
	}

	// { より前の関数シグネチャ行を含める
	sigStart := blockStartIdx
	for i := blockStartIdx - 1; i >= 0 && i >= blockStartIdx-10; i-- {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed == "" || strings.HasSuffix(trimmed, "}") || strings.HasSuffix(trimmed, ";") {
			break
		}
		sigStart = i
	}

	// 直前のコメント（/** ... */ や //）も含める
	commentStart := sigStart
	for i := sigStart - 1; i >= 0 && i >= sigStart-30; i-- {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed == "" {
			break
		}
		if strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "*") ||
			strings.HasPrefix(trimmed, "/*") || strings.HasSuffix(trimmed, "*/") {
			commentStart = i
		} else {
			break
		}
	}

	// 下方向に対応する } を探す
	depth = 0
	closeIdx := -1
	for i := blockStartIdx; i < len(lines) && i < blockStartIdx+2000; i++ {
		for _, ch := range lines[i] {
			if ch == '{' {
				depth++
			} else if ch == '}' {
				depth--
				if depth <= 0 {
					closeIdx = i
					goto foundEnd
				}
			}
		}
	}
foundEnd:
	if closeIdx < 0 {
		closeIdx = funcMin(len(lines)-1, blockStartIdx+200)
	}

	return strings.Join(lines[commentStart:closeIdx+1], "\n"), commentStart + 1, closeIdx + 1, nil
}

func funcMax(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func funcMin(a, b int) int {
	if a < b {
		return a
	}
	return b
}
