package search

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode"
)

// HoverHit は1件のホバー定義情報。
type HoverHit struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Kind string `json:"kind"` // "define" / "struct" / "enum" / "union" / "typedef"
	Body string `json:"body"` // 抽出したブロック全体
	Decl bool   `json:"decl"` // true = 宣言のみ（本体なし）
}

// FindHover は word の定義を検索し、ブロック本体付きで返す。
// 検索戦略:
//  1. ヘッダ（*.h,*.hpp）のみ検索 → struct/enum/define/typedef はここで完結
//  2. func の宣言しか見つからなかった場合、ソースファイルも追加検索して定義本体を取得
func FindHover(ctx context.Context, word, dir, glob string, includeChain ...map[string]bool) ([]HoverHit, error) {
	chain := map[string]bool{}
	if len(includeChain) > 0 && includeChain[0] != nil {
		chain = includeChain[0]
	}
	const maxPerQuery = 5
	headerGlob := "*.h,*.hpp"

	// Phase 1: ヘッダのみ
	hits, err := FindDefinitionsN(ctx, word, dir, headerGlob, maxPerQuery)
	if err != nil && ctx.Err() != nil {
		return nil, err
	}

	// Phase 2: ソースファイルも検索してマージ（func の定義本体を取得するため常に実行）
	if glob != headerGlob && ctx.Err() == nil {
		srcHits, _ := FindDefinitionsN(ctx, word, dir, glob, maxPerQuery)
		seen := map[string]bool{}
		for _, h := range hits {
			seen[fmt.Sprintf("%s:%d", h.File, h.Line)] = true
		}
		for _, h := range srcHits {
			key := fmt.Sprintf("%s:%d", h.File, h.Line)
			if !seen[key] {
				hits = append(hits, h)
				seen[key] = true
			}
		}
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
		isDecl := false
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
		case "func":
			body = extractBraceBlock(lines, h.Line, 5)
			// { がない場合は宣言（プロトタイプ）
			if !strings.Contains(body, "{") {
				body = h.Text
				isDecl = true
			}
		default:
			body = extractBraceBlock(lines, h.Line)
		}
		if body == "" {
			body = h.Text
		}
		if comment := extractLeadingComment(lines, h.Line); comment != "" {
			body = comment + "\n" + body
		}
		result = append(result, HoverHit{File: h.File, Line: h.Line, Kind: h.Kind, Body: body, Decl: isDecl})
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
	return result, nil
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

// extractContainingBlock はメンバー行（enum値等）から逆方向に { を探し、
// そのブロック全体（enum { ... } Name; 等）を抽出する。
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

	// openIdx の行から前進して { ... } ブロックを抽出（1-indexed）
	return extractBraceBlock(lines, openIdx+1)
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

// extractLeadingComment は startLine（1-indexed）の直前にあるコメントブロックを返す。
// C スタイル（// / /* */）に対応。空行またはコメント以外の行が来たら打ち切る。
func extractLeadingComment(lines []string, startLine int) string {
	var commentLines []string
	for i := startLine - 2; i >= 0; i-- {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed == "" {
			break
		}
		if strings.HasPrefix(trimmed, "//") ||
			strings.HasPrefix(trimmed, "*") ||
			strings.HasPrefix(trimmed, "/*") {
			commentLines = append([]string{lines[i]}, commentLines...)
		} else {
			break
		}
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
