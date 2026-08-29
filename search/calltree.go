package search

import (
	"context"
	"path/filepath"
	"regexp"
	"strings"

	"grepnavi/graph"
)

const (
	_directCallerLimitPerCall   = 50 // 直接呼び出し（`foo()`）の上限
	_indirectCallerLimitPerCall = 30 // 間接呼び出し（`.ops = &foo`）の上限
	_callerTotalCap             = 80 // 1リクエストで返す呼び出し元の全体上限
)

// CallSite はコール関係の1件。
type CallSite struct {
	Func     string `json:"func"`           // 関数名
	File     string `json:"file"`           // ファイルパス
	Line     int    `json:"line"`           // 関数定義行（1-indexed）
	CallLine int    `json:"call_line"`      // 実際の呼び出し行（callersのみ）
	Indirect bool   `json:"indirect"`       // 関数ポインタ経由の参照
	Assign   bool   `json:"assign,omitempty"` // その語へ書き込んでいる行
	Text     string `json:"text,omitempty"` // 呼び出し行のソース（呼び出しか否かを呼び出し側で判断できるように）
}

// _callSiteTextMax は返す呼び出し行の最大長。
// 判断材料として十分で、かつ AI クライアントのトークンを浪費しない長さ。
const _callSiteTextMax = 200

func callSiteText(lines []string, line int) string {
	if line < 1 || line > len(lines) {
		return ""
	}
	t := strings.TrimSpace(lines[line-1])
	if len(t) > _callSiteTextMax {
		t = t[:_callSiteTextMax] + "…"
	}
	return t
}

var reCalleeFunc = regexp.MustCompile(`\b([A-Za-z_]\w*)\s*\(`)

// 関数ポインタの宣言 `void (*cb)(const SSL *, int)` とキャスト
// `*(int (**)(SSL *, void *))parg` は呼び出しではないが、字面は `識別子(` なので
// 型名が呼び先として拾われる（実測: openssl の ssl3_read_bytes の callee に
// `void`、ssl3_ctx_ctrl に `int` が出ていた）。型名の位置だけを除く。
// 型名の一覧で弾かず形で弾くのは、独自 typedef を型に使った宣言にも効かせるため。
// 名前を任意にしているのは、キャストと引数の宣言では名前が無いことがあるため。
// 末尾を [(\[] にしているのは、ポインタ配列へのキャスト (unsigned char (*)[16]) も
// 同じ形で型名が拾われるため。
var reFuncPtrDecl = regexp.MustCompile(`\b([A-Za-z_]\w*)\s*\(\s*\*+\s*(?:[A-Za-z_]\w*)?(?:\s*\[[^\]]*\])*\s*\)\s*[(\[]`)

// reMemberCall は呼び先名の直前が `->` / `.` で終わっているか、つまり
// `s->method->ssl_read(` `ops.read(` のように構造体メンバを呼んでいるかを見る。
// C にメソッドは無いので、メンバを `(` で呼ぶ形は必ず関数ポインタ経由になる。
// 字面だけで決まり、推定を含まない。
// 第1群は受け手の式（`s->method` / `ops[i]`）。識別子と添字の連鎖だけを取り、
// `get(s)->read(` のように括弧を含むときは空にする（呼び出しの戻り値は
// 名前で追えないので、あるように見せない）。
var reMemberCall = regexp.MustCompile(`(?:([A-Za-z_]\w*(?:\[[^\]]*\])*(?:\s*(?:->|\.)\s*[A-Za-z_]\w*(?:\[[^\]]*\])*)*)\s*)?(?:->|\.)\s*$`)

// 構造体変数名: identifier = { や identifier[] = { のパターン
var reStructVarName = regexp.MustCompile(`\b([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*=\s*\{?\s*$`)

// C 系キーワード（関数呼び出しと誤認しないよう除外）
var ctKeywords = map[string]bool{
	"if": true, "else": true, "while": true, "for": true, "switch": true,
	"return": true, "sizeof": true, "typeof": true, "alignof": true,
	"defined": true, "offsetof": true, "case": true, "do": true,
	"catch": true, "throw": true, "new": true, "delete": true,
}

// FindCallers は word を呼び出している関数一覧を返す（最大50件直接 + 30件間接）。
// 第2戻り値は上限で打ち切ったか。false を返せた場合だけ「これで全部」と言える。
func FindCallers(ctx context.Context, word, dir, glob string) ([]CallSite, bool, error) {
	quoted := regexp.QuoteMeta(word)

	// 直接呼び出し: word(
	directOpts := Options{
		Pattern:       `\b` + quoted + `\s*\(`,
		Dir:           dir,
		FileGlob:      glob,
		Regex:         true,
		CaseSensitive: true,
		ContextLines:  -1,
		MaxResults:    500,
	}
	directMatches, err := Search(ctx, directOpts)
	if err != nil {
		return nil, false, err
	}

	// 間接参照: word が ( を伴わない形（関数ポインタ代入など）
	// 直接呼び出しパターンにマッチしない行のみ対象
	indirectOpts := Options{
		Pattern:       `\b` + quoted + `\b`,
		Dir:           dir,
		FileGlob:      glob,
		Regex:         true,
		CaseSensitive: true,
		ContextLines:  -1,
		MaxResults:    300,
	}
	indirectMatches, err := Search(ctx, indirectOpts)
	if err != nil {
		indirectMatches = nil
	}

	reDirectWord := regexp.MustCompile(`\b` + quoted + `\s*\(`)
	reDeclWord := regexp.MustCompile(`\b` + quoted + `\s*\(.*\)`) // 宣言行除外用

	var results []CallSite
	truncated := false
	seen := map[string]bool{} // "func\x00file" → 登録済み

	code := codeOnlyCache{}
	collect := func(matches []graph.Match, indirect bool) {
		limit := _directCallerLimitPerCall
		if indirect {
			limit = _indirectCallerLimitPerCall
		}
		for _, m := range matches {
			if len(results) >= _callerTotalCap {
				truncated = true
				break
			}
			lines, err := CachedLines(m.File)
			if err != nil {
				continue
			}
			// コメント内・文字列内だけの出現は呼び出しではない
			if !code.mentionsInCode(m.File, lines, m.Line, word) {
				continue
			}
			lineText := ""
			if m.Line >= 1 && m.Line <= len(lines) {
				lineText = lines[m.Line-1]
			}
			if indirect {
				// 直接呼び出しが含まれる行はスキップ（直接呼び出し側で処理済み）
				if reDirectWord.MatchString(lineText) {
					continue
				}
				// 関数定義行（戻り値型 + 関数名(引数)）はスキップ
				if reDeclWord.MatchString(lineText) {
					continue
				}
			}
			funcName, defLine := code.containingFunc(m.File, lines, m.Line)
			if funcName == "" || funcName == word {
				continue
			}
			key := funcName + "\x00" + m.File
			if seen[key] {
				continue
			}
			seen[key] = true
			count := 0
			for _, r := range results {
				if !r.Indirect {
					count++
				}
			}
			if !indirect && count >= limit {
				truncated = true
				continue
			}
			indirectCount := 0
			for _, r := range results {
				if r.Indirect {
					indirectCount++
				}
			}
			if indirect && indirectCount >= limit {
				truncated = true
				continue
			}
			results = append(results, CallSite{
				Func:     funcName,
				File:     m.File,
				Line:     defLine,
				CallLine: m.Line,
				Indirect: indirect,
				Text:     callSiteText(lines, m.Line),
			})
		}
	}

	collect(directMatches, false)
	collect(indirectMatches, true)
	return results, truncated, nil
}

// FilterCallSites は索引が返した呼び出し元を、検索ディレクトリと glob で絞る。
// gtags はツリー全体を一度に引くので、UI の絞り込みが効くのはここだけ。
// これが無いと、検索ディレクトリを狭めても呼び出し元一覧だけ全体が出て、
// エンジンによって同じ操作の結果が変わる。
func FilterCallSites(sites []CallSite, dir, glob string) []CallSite {
	globs := splitGlobs(glob)
	if dir == "" && len(globs) == 0 {
		return sites
	}
	dirPrefix := ""
	if dir != "" {
		dirPrefix = strings.ToLower(filepath.ToSlash(filepath.Clean(dir)))
		if !strings.HasSuffix(dirPrefix, "/") {
			dirPrefix += "/"
		}
	}
	out := sites[:0:0]
	for _, s := range sites {
		if dirPrefix != "" {
			f := strings.ToLower(filepath.ToSlash(filepath.Clean(s.File)))
			if !strings.HasPrefix(f, dirPrefix) {
				continue
			}
		}
		if len(globs) > 0 && !matchesAnyGlob(filepath.Base(s.File), globs) {
			continue
		}
		out = append(out, s)
	}
	return out
}

func matchesAnyGlob(name string, globs []string) bool {
	for _, g := range globs {
		// パス付き glob（src/*.c）はベース名だけでは判定できないので、
		// パターン末尾のファイル名部分で見る
		if i := strings.LastIndexAny(g, `/\`); i >= 0 {
			g = g[i+1:]
		}
		if ok, _ := filepath.Match(g, name); ok {
			return true
		}
	}
	return false
}

// MarkIndirectCalls は呼び出し行の字面を見て、関数ポインタ経由の参照に印を付ける。
// 索引は「参照」としか言わないので、`foo(` の形で呼んでいるのか
// `.ops = foo` のように渡しているだけなのかはここで判定する。
// 区別が付かないと、呼び出し関係を辿っているつもりでテーブル登録を辿ってしまう。
func MarkIndirectCalls(sites []CallSite, word string) {
	reCall := regexp.MustCompile(`\b` + regexp.QuoteMeta(word) + `\s*\(`)
	for i := range sites {
		sites[i].Indirect = !reCall.MatchString(sites[i].Text)
	}
}

// CalleeHit は FindCallees が返す 1 件。重複名は最初の出現行を採用する。
type CalleeHit struct {
	Name     string `json:"name"`
	CallLine int    `json:"call_line"`      // 呼び出し行（1-indexed）
	Kind     string `json:"kind,omitempty"` // 索引で確認できた種別（"func" / "define" 等）
	Text     string `json:"text,omitempty"` // 呼び出し行のソース（callers と同じ判断材料を渡す）
	// Indirect は構造体メンバを呼ぶ形（`s->method->ssl_read(`）。呼び先は
	// メンバに入っている関数で、名前からは決まらない。印が無いと同名の
	// 別関数に解決されて、辿っているつもりで別の実装を読むことになる
	Indirect bool `json:"indirect,omitempty"`
	// Receiver はメンバの持ち主の式（`s->method`）。何が入るかを追う起点。
	// 呼び出しの戻り値など名前で追えない形のときは空
	Receiver string `json:"receiver,omitempty"`
}

// _calleeKindLookupMax は種別を照会する候補数の上限（1 件につき tags を 1 回引く）。
const _calleeKindLookupMax = 200

// FindCallees は line を含む関数が呼んでいる候補を返す。
// root に ctags 索引があれば種別（func / define 等）を付与する。
//
// 索引に無い候補も落とさないこと: カーネルの btrfs_header_owner や
// folio_test_dirty のようにマクロで生成される API は索引に現れないが、
// 実在する呼び出しである。索引の不在は「存在しない」ではなく「未知」を意味する。
// 第2戻り値は解決した「囲む関数」の名前。どの関数の呼び先を出したのかを
// 利用者に見せるために返す。カーソル位置の語ではなく囲む関数を使うので、
// 名前を出さないと `bar()` の中の `foo()` の上で実行したときに
// `foo` の呼び先だと誤解される。
func FindCallees(_ context.Context, file string, line int, root string) ([]CalleeHit, string, bool, error) {
	lines, err := CachedLines(file)
	if err != nil {
		return nil, "", false, err
	}
	// 関数の途中の行を渡されても答えられるようにする。読んでいる最中に
	// 「この関数は何を呼んでいるか」を聞くとき、カーソルは本体の中にある
	funcName := ""
	if sp, ok := enclosingSpan(scanFuncSpans(codeOnlyLines(lines)), line); ok {
		line, funcName = sp.Start, sp.Name
	}
	// 表示用の 200 行上限だと 500 行級の関数で後半の呼び出しが黙って消える。
	// 一覧は全件そろっていることに意味があるので解析用の上限で切り出し、
	// それでも足りなければ打ち切ったことを返す
	body, truncated := extractBraceBlockN(lines, line, analysisBlockMaxLines)
	if body == "" {
		return nil, funcName, false, nil
	}

	seen := map[string]bool{}
	var result []CalleeHit

	// body の i 行目は元ファイルの (line + i) 行目に対応する
	// （extractBraceBlock は startLine から順に行を append する）。
	// 判定はコード部分だけで行う: ブロックコメントや文字列内の foo() を拾わない。
	code := codeOnlyLines(lines)
	// 本体が始まる { より前はシグネチャ。ここを走査すると関数自身が自分の
	// 呼び出し先になり、sparse 注釈や引数の型名まで候補に混ざる。
	bodyStart := 0
	for i, l := range strings.Split(body, "\n") {
		if strings.Contains(l, "{") {
			bodyStart = i
			break
		}
	}
	for i := range strings.Split(body, "\n") {
		if i < bodyStart {
			continue
		}
		srcIdx := line - 1 + i
		if srcIdx < 0 || srcIdx >= len(code) {
			continue
		}
		l := code[srcIdx]
		declType := map[int]bool{}
		for _, m := range reFuncPtrDecl.FindAllStringSubmatchIndex(l, -1) {
			declType[m[2]] = true // 型名の開始位置
		}
		for _, m := range reCalleeFunc.FindAllStringSubmatchIndex(l, -1) {
			if declType[m[2]] {
				continue
			}
			name := l[m[2]:m[3]]
			if ctKeywords[name] {
				continue
			}
			hit := CalleeHit{
				Name:     name,
				CallLine: line + i,
				Text:     callSiteText(lines, line+i),
			}
			// 重複は名前と形の組で見る。`read(fd)` と `f_op->read(` は同じ名前でも
			// 別の呼び先なので、片方を先に見たからといってもう片方を捨てない
			key := name
			if mm := reMemberCall.FindStringSubmatch(l[:m[2]]); mm != nil {
				hit.Indirect = true
				hit.Receiver = strings.Join(strings.Fields(mm[1]), "")
				key = "->" + name
			}
			if seen[key] {
				continue
			}
			seen[key] = true
			result = append(result, hit)
		}
	}
	return annotateCalleeKinds(result, root), funcName, truncated, nil
}

// annotateCalleeKinds は ctags 索引で分かる範囲の種別を付ける（候補は落とさない）。
func annotateCalleeKinds(hits []CalleeHit, root string) []CalleeHit {
	if root == "" || len(hits) == 0 || len(hits) > _calleeKindLookupMax || !CtagsIndexed(root) {
		return hits
	}
	for i := range hits {
		defs, err := CtagsFindDefinitions(hits[i].Name, root)
		if err != nil || len(defs) == 0 {
			continue
		}
		if !hits[i].Indirect {
			hits[i].Kind = defs[0].Kind
			continue
		}
		// メンバ呼び出しの名前で索引を引くと、同名の関数（`read`）が先に立つ。
		// その種別を付けると「関数 read を呼んでいる」と読めてしまうので、
		// メンバとして索引にあるときだけ member と言い、無ければ空のままにする
		for _, d := range defs {
			if d.Kind == "member" {
				hits[i].Kind = "member"
				break
			}
		}
	}
	return hits
}

