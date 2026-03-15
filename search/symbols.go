package search

import (
	"regexp"
	"strings"
)

// Symbol は関数シンボルを表す。
type Symbol struct {
	Name      string `json:"name"`
	Detail    string `json:"detail"`
	StartLine int    `json:"start_line"`
	EndLine   int    `json:"end_line"`
}

var (
	symFuncRe  = regexp.MustCompile(`\b([a-zA-Z_]\w*)\s*\(`)
	symSkip    = map[string]bool{
		"if": true, "for": true, "while": true, "switch": true,
		"do": true, "else": true, "return": true, "sizeof": true,
		"typedef": true, "defined": true, "assert": true,
	}
)

// ExtractSymbols はファイルから関数シンボル一覧を返す。
func ExtractSymbols(filePath string) ([]Symbol, error) {
	lines, err := cachedLines(filePath)
	if err != nil {
		return nil, err
	}
	return extractSymbols(lines), nil
}

func extractSymbols(lines []string) []Symbol {
	var symbols []Symbol
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") || !strings.Contains(trimmed, "(") {
			continue
		}
		// インデントが深い行はスキップ（関数定義は浅い位置にある）
		indent := len(line) - len(strings.TrimLeft(line, " \t"))
		if indent > 2 {
			continue
		}
		next := ""
		if i+1 < len(lines) {
			next = strings.TrimSpace(lines[i+1])
		}
		if !strings.Contains(trimmed, "{") && !strings.HasPrefix(next, "{") {
			continue
		}
		m := symFuncRe.FindStringSubmatch(trimmed)
		if m == nil || symSkip[m[1]] {
			continue
		}
		braceStart := i
		if !strings.Contains(trimmed, "{") {
			braceStart = i + 1
		}
		// 対応する } を追跡して関数本体の終端を求める
		depth, endLine := 0, len(lines)-1
	outer:
		for j := braceStart; j < len(lines); j++ {
			for _, ch := range lines[j] {
				if ch == '{' {
					depth++
				} else if ch == '}' {
					depth--
					if depth == 0 {
						endLine = j
						break outer
					}
				}
			}
		}
		symbols = append(symbols, Symbol{
			Name:      m[1],
			Detail:    trimmed,
			StartLine: i + 1,
			EndLine:   endLine + 1,
		})
	}
	return symbols
}
