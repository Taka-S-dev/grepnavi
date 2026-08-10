package search

import (
	"context"
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
			funcName, defLine := findContainingFunc(lines, m.Line)
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

// enclosingFuncStart は line（1-indexed）を含む関数の開始行を返す（0 = 不明）。
// シンボル抽出の正規表現に頼らず、「列0から始まる行のブレースブロックが
// その行を含むか」を実際に切り出して確かめる。openssl の
// `static STACK_OF(GENERAL_NAME) *f(...)` のように戻り値がマクロで
// シグネチャが複数行にまたがる形でも、この方法なら取りこぼさない。
func enclosingFuncStart(lines []string, line int) int {
	if line < 1 || line > len(lines) {
		return 0
	}
	for i := line - 1; i >= 0 && line-i < 3000; i-- {
		l := lines[i]
		if l == "" {
			continue
		}
		// 関数定義は列0から始まる。空白始まり・プリプロセッサ・閉じ括弧は候補外
		if l[0] == ' ' || l[0] == '\t' || l[0] == '#' || l[0] == '}' {
			continue
		}
		body := extractBraceBlock(lines, i+1)
		if body == "" {
			continue // 宣言（; で終わる）などはブロックにならない
		}
		if end := i + strings.Count(body, "\n") + 1; i+1 <= line && line <= end {
			return i + 1
		}
	}
	return 0
}

// CalleeHit は FindCallees が返す 1 件。重複名は最初の出現行を採用する。
type CalleeHit struct {
	Name     string `json:"name"`
	CallLine int    `json:"call_line"`      // 呼び出し行（1-indexed）
	Kind     string `json:"kind,omitempty"` // 索引で確認できた種別（"func" / "define" 等）
	Text     string `json:"text,omitempty"` // 呼び出し行のソース（callers と同じ判断材料を渡す）
}

// _calleeKindLookupMax は種別を照会する候補数の上限（1 件につき tags を 1 回引く）。
const _calleeKindLookupMax = 200

// FindCallees は line を含む関数が呼んでいる候補を返す。
// root に ctags 索引があれば種別（func / define 等）を付与する。
//
// 索引に無い候補も落とさないこと: カーネルの btrfs_header_owner や
// folio_test_dirty のようにマクロで生成される API は索引に現れないが、
// 実在する呼び出しである。索引の不在は「存在しない」ではなく「未知」を意味する。
func FindCallees(_ context.Context, file string, line int, root string) ([]CalleeHit, bool, error) {
	lines, err := CachedLines(file)
	if err != nil {
		return nil, false, err
	}
	// 関数の途中の行を渡されても答えられるようにする。読んでいる最中に
	// 「この関数は何を呼んでいるか」を聞くとき、カーソルは本体の中にある
	if start := enclosingFuncStart(lines, line); start > 0 {
		line = start
	}
	// 表示用の 200 行上限だと 500 行級の関数で後半の呼び出しが黙って消える。
	// 一覧は全件そろっていることに意味があるので解析用の上限で切り出し、
	// それでも足りなければ打ち切ったことを返す
	body, truncated := extractBraceBlockN(lines, line, analysisBlockMaxLines)
	if body == "" {
		return nil, false, nil
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
		for _, m := range reCalleeFunc.FindAllStringSubmatch(l, -1) {
			name := m[1]
			if ctKeywords[name] || seen[name] {
				continue
			}
			seen[name] = true
			result = append(result, CalleeHit{
				Name:     name,
				CallLine: line + i,
				Text:     callSiteText(lines, line+i),
			})
		}
	}
	return annotateCalleeKinds(result, root), truncated, nil
}

// annotateCalleeKinds は ctags 索引で分かる範囲の種別を付ける（候補は落とさない）。
func annotateCalleeKinds(hits []CalleeHit, root string) []CalleeHit {
	if root == "" || len(hits) == 0 || len(hits) > _calleeKindLookupMax || !CtagsIndexed(root) {
		return hits
	}
	for i := range hits {
		defs, err := CtagsFindDefinitions(hits[i].Name, root)
		if err == nil && len(defs) > 0 {
			hits[i].Kind = defs[0].Kind
		}
	}
	return hits
}

// findContainingFunc は lines の callLine（1-indexed）から逆方向に
// 包含する関数定義を探し、関数名と定義行（1-indexed）を返す。
func findContainingFunc(lines []string, callLine int) (string, int) {
	idx := callLine - 1
	if idx < 0 || idx >= len(lines) {
		return "", 0
	}

	depth := 0
	for i := idx; i >= 0 && i > idx-2000; i-- {
		line := lines[i]
		for j := len(line) - 1; j >= 0; j-- {
			ch := line[j]
			if ch == '}' {
				depth++
			} else if ch == '{' {
				depth--
				if depth < 0 {
					// インデントされた { は if/for/while 等の内側ブロック。
					// 関数のオープンブレースは列0（`{` 単独行、または `void f(void) {`）
					// なので、そうでなければ1段外に出たものとして走査を続ける。
					// これを見落とすと、ブロック内の呼び出しが全て関数名を取れずに捨てられる。
					if len(line) > 0 && (line[0] == ' ' || line[0] == '\t') {
						depth = 0
						continue
					}
					// この { が包含関数のオープンブレース
					// この行とその前の数行から関数名を探す（行頭が空白でない行）
					var structName string
					var structLine int
					for k := i; k >= 0 && k >= i-8; k-- {
						l := lines[k]
						if len(l) == 0 || l[0] == '#' {
							continue
						}
						if l[0] != ' ' && l[0] != '\t' {
							// 関数定義を優先探索
							ms := reCalleeFunc.FindAllStringSubmatch(l, -1)
							for mi := len(ms) - 1; mi >= 0; mi-- {
								name := ms[mi][1]
								if !ctKeywords[name] {
									return name, k + 1
								}
							}
							// 構造体変数初期化: name = { パターン
							if ms2 := reStructVarName.FindAllStringSubmatch(l, -1); len(ms2) > 0 {
								for mi := len(ms2) - 1; mi >= 0; mi-- {
									name := ms2[mi][1]
									if !ctKeywords[name] && structName == "" {
										structName = name
										structLine = k + 1
									}
								}
							}
						}
					}
					if structName != "" {
						return structName, structLine
					}
					return "", i + 1
				}
			}
		}
	}
	return "", 0
}
