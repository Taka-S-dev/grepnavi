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
	symFuncRe = regexp.MustCompile(`\b([a-zA-Z_]\w*)\s*\(`)
	symSkip   = map[string]bool{
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

// signatureStartLine は複数行シグネチャの先頭行 index を返す。
// 直前の行が文の終わり（; } { */）やコメント・プリプロセッサ・空行なら、
// そこでシグネチャは始まっていると判断して打ち止める。
func signatureStartLine(lines []string, i int) int {
	const maxLookback = 6 // シグネチャがこれ以上長いことは実際上ない
	start := i
	for start > 0 && i-start < maxLookback {
		prev := strings.TrimSpace(lines[start-1])
		// 引数リストの継続行は "," で終わるので、"," を打ち止め条件にしてはいけない
		// （4引数の関数で注釈行から遡れなくなる）。文の終わりだけで判断する。
		if prev == "" || strings.HasPrefix(prev, "#") || strings.HasPrefix(prev, "//") ||
			strings.HasSuffix(prev, ";") || strings.HasSuffix(prev, "{") ||
			strings.HasSuffix(prev, "}") || strings.HasSuffix(prev, "*/") {
			break
		}
		start--
	}
	return start
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
		// { の直前の行が関数名を持っているとは限らない。カーネルでは
		//     int blkg_conf_prep(struct blkcg *blkcg, ...,
		//                        struct blkg_conf_ctx *ctx)
		//         __acquires(&bdev->bd_queue->queue_lock)
		//     {
		// のようにシグネチャが複数行に渡り、最後に sparse 注釈が付く。
		// この行だけ見ると __acquires が関数名になり、本当の関数は
		// どのシンボルにも現れなくなる。シグネチャの先頭まで遡って名前を取る。
		nameLine, name := i, m[1]
		if start := signatureStartLine(lines, i); start < i {
			for k := start; k <= i; k++ {
				if n := funcNameOnLine(strings.TrimSpace(lines[k])); n != "" {
					nameLine, name = k, n
					break
				}
			}
		}
		if symSkip[name] {
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
			Name:      name,
			Detail:    strings.TrimSpace(lines[nameLine]),
			StartLine: nameLine + 1,
			EndLine:   endLine + 1,
		})
	}
	return symbols
}
