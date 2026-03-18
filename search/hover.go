package search

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"unicode"
)

// HoverHit は1件のホバー定義情報。
type HoverHit struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Kind string `json:"kind"` // "define" / "struct" / "enum" / "union" / "typedef"
	Body string `json:"body"` // 抽出したブロック全体
}

// FindHover は word の定義を検索し、ブロック本体付きで返す。
func FindHover(ctx context.Context, word, dir, glob string) ([]HoverHit, error) {
	hits, err := FindDefinitions(ctx, word, dir, glob)
	if err != nil {
		return nil, err
	}

	var result []HoverHit
	seen := map[string]bool{}
	funcCount := 0
	for _, h := range hits {
		// 関数定義は最大2件（大量マッチ防止）
		if h.Kind == "func" {
			if funcCount >= 2 {
				continue
			}
			funcCount++
		}
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

		var body string
		switch h.Kind {
		case "define":
			body = extractDefineBlock(lines, h.Line)
		case "typedef_close":
			body = extractBraceBlockBackward(lines, h.Line)
			h.Kind = "typedef"
		case "func":
			body = extractBraceBlock(lines, h.Line)
			// { を含まない場合は定義でなく呼び出し・宣言なので除外
			if !strings.Contains(body, "{") {
				continue
			}
		default:
			body = extractBraceBlock(lines, h.Line)
		}
		if body == "" {
			body = h.Text
		}
		result = append(result, HoverHit{File: h.File, Line: h.Line, Kind: h.Kind, Body: body})
	}

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
		refHits, _ := FindDefinitions(ctx, m[2], dir, glob)
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
	return result, nil
}

// extractBraceBlock は startLine（1-indexed）からブレースブロックを抽出する。
// 最大 200 行まで。
func extractBraceBlock(lines []string, startLine int) string {
	idx := startLine - 1
	if idx < 0 || idx >= len(lines) {
		return ""
	}

	depth := 0
	started := false
	var buf []string

	for i := idx; i < len(lines) && i < idx+200; i++ {
		line := lines[i]
		buf = append(buf, line)

		// ブレースをカウント（文字列・コメント内は近似処理）
		inStr := false
		inChar := false
		for j := 0; j < len(line); j++ {
			ch := line[j]
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
			// 閉じ } の次の行に ; が続くケース（typedef struct { ... } Name;）
			if i+1 < len(lines) {
				next := strings.TrimLeftFunc(lines[i+1], unicode.IsSpace)
				if strings.HasPrefix(next, ";") || (len(next) > 0 && next[0] != '\n') {
					// typedef の閉じを含む行を追加
					buf = append(buf, lines[i+1])
				}
			}
			break
		}

		// { が見つからないまま数行経過したら打ち切り（関数プロトタイプ等）
		if !started && i > idx+10 {
			break
		}
	}

	return stripCommonIndent(buf)
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
