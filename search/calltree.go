package search

import (
	"context"
	"regexp"
	"strings"

	"grepnavi/graph"
)

// CallSite はコール関係の1件。
type CallSite struct {
	Func     string `json:"func"`      // 関数名
	File     string `json:"file"`      // ファイルパス
	Line     int    `json:"line"`      // 関数定義行（1-indexed）
	CallLine int    `json:"call_line"` // 実際の呼び出し行（callersのみ）
	Indirect bool   `json:"indirect"`  // 関数ポインタ経由の参照
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
func FindCallers(ctx context.Context, word, dir, glob string) ([]CallSite, error) {
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
		return nil, err
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
	seen := map[string]bool{} // "func\x00file" → 登録済み

	collect := func(matches []graph.Match, indirect bool) {
		limit := 50
		if indirect {
			limit = 30
		}
		for _, m := range matches {
			if len(results) >= 80 {
				break
			}
			lines, err := CachedLines(m.File)
			if err != nil {
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
				continue
			}
			indirectCount := 0
			for _, r := range results {
				if r.Indirect {
					indirectCount++
				}
			}
			if indirect && indirectCount >= limit {
				continue
			}
			results = append(results, CallSite{
				Func:     funcName,
				File:     m.File,
				Line:     defLine,
				CallLine: m.Line,
				Indirect: indirect,
			})
		}
	}

	collect(directMatches, false)
	collect(indirectMatches, true)
	return results, nil
}

// FindCallees は file の line から始まる関数が呼び出す関数名一覧を返す（最大80件）。
func FindCallees(_ context.Context, file string, line int) ([]string, error) {
	lines, err := CachedLines(file)
	if err != nil {
		return nil, err
	}
	body := extractBraceBlock(lines, line)
	if body == "" {
		return nil, nil
	}

	seen := map[string]bool{}
	var result []string

	for _, l := range strings.Split(body, "\n") {
		// 行コメント除去
		if idx := strings.Index(l, "//"); idx >= 0 {
			l = l[:idx]
		}
		for _, m := range reCalleeFunc.FindAllStringSubmatch(l, -1) {
			name := m[1]
			if ctKeywords[name] || seen[name] {
				continue
			}
			seen[name] = true
			result = append(result, name)
		}
	}
	return result, nil
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
