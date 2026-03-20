package search

import (
	"context"
	"regexp"
	"strings"
)

// CallSite はコール関係の1件。
type CallSite struct {
	Func     string `json:"func"`      // 関数名
	File     string `json:"file"`      // ファイルパス
	Line     int    `json:"line"`      // 関数定義行（1-indexed）
	CallLine int    `json:"call_line"` // 実際の呼び出し行（callersのみ）
}

// C 系キーワード（関数呼び出しと誤認しないよう除外）
var ctKeywords = map[string]bool{
	"if": true, "else": true, "while": true, "for": true, "switch": true,
	"return": true, "sizeof": true, "typeof": true, "alignof": true,
	"defined": true, "offsetof": true, "case": true, "do": true,
	"catch": true, "throw": true, "new": true, "delete": true,
}

// FindCallers は word を呼び出している関数一覧を返す（最大50件）。
func FindCallers(ctx context.Context, word, dir, glob string) ([]CallSite, error) {
	opts := Options{
		Pattern:       `\b` + regexp.QuoteMeta(word) + `\s*\(`,
		Dir:           dir,
		FileGlob:      glob,
		Regex:         true,
		CaseSensitive: true,
		ContextLines:  -1,  // 呼び出し行の特定のみ目的のためコンテキスト不要
		MaxResults:    500, // 汎用関数名での過剰マッチを抑制
	}
	matches, err := Search(ctx, opts)
	if err != nil {
		return nil, err
	}

	var results []CallSite
	seen := map[string]bool{}

	for _, m := range matches {
		lines, err := CachedLines(m.File)
		if err != nil {
			continue
		}
		funcName, defLine := findContainingFunc(lines, m.Line)
		if funcName == "" || funcName == word {
			continue // 不明 or 自己再帰
		}
		key := funcName + "\x00" + m.File
		if seen[key] {
			continue
		}
		seen[key] = true
		results = append(results, CallSite{
			Func:     funcName,
			File:     m.File,
			Line:     defLine,
			CallLine: m.Line,
		})
		if len(results) >= 50 {
			break
		}
	}
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

	reFuncCall := regexp.MustCompile(`\b([A-Za-z_]\w*)\s*\(`)
	seen := map[string]bool{}
	var result []string

	for _, l := range strings.Split(body, "\n") {
		// 行コメント除去
		if idx := strings.Index(l, "//"); idx >= 0 {
			l = l[:idx]
		}
		for _, m := range reFuncCall.FindAllStringSubmatch(l, -1) {
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

	reFuncName := regexp.MustCompile(`\b([A-Za-z_]\w*)\s*\(`)

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
					for k := i; k >= 0 && k >= i-8; k-- {
						l := lines[k]
						if len(l) == 0 || l[0] == ' ' || l[0] == '\t' || l[0] == '#' {
							continue
						}
						ms := reFuncName.FindAllStringSubmatch(l, -1)
						for mi := len(ms) - 1; mi >= 0; mi-- {
							name := ms[mi][1]
							if !ctKeywords[name] {
								return name, k + 1
							}
						}
					}
					return "", i + 1
				}
			}
		}
	}
	return "", 0
}
