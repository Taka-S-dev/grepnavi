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
// GNU Global が利用可能な場合はそちらを優先し、なければ ripgrep にフォールバックする。
// 検索戦略（ripgrep 時）:
//  1. ヘッダ（*.h,*.hpp）のみ検索 → struct/enum/define/typedef はここで完結
//  2. func の宣言しか見つからなかった場合、ソースファイルも追加検索して定義本体を取得
func FindHover(ctx context.Context, word, dir, glob, root string, includeChain ...map[string]bool) ([]HoverHit, error) {
	chain := map[string]bool{}
	if len(includeChain) > 0 && includeChain[0] != nil {
		chain = includeChain[0]
	}
	if root == "" {
		root = dir
	}

	var hits []DefHit

	// GNU Global が使えるなら定義位置をインデックスから直接取得
	if GtagsAvailable(root) {
		gHits, err := GtagsFindHoverHits(ctx, word, dir)
		if err == nil && len(gHits) > 0 {
			hits = gHits
		}
	}

	// GNU Global が使えない or 結果なし → ripgrep にフォールバック
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
			return nil, ctx.Err()
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

		var body string
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
		default:
			body = extractBraceBlock(lines, h.Line)
		}
		if body == "" {
			body = h.Text
		}
		if comment := extractLeadingComment(lines, commentLine); comment != "" {
			body = comment + "\n" + body
		}
		result = append(result, HoverHit{File: h.File, Line: h.Line, Kind: h.Kind, Body: body, Decl: isDecl})
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
			commentLines = append([]string{lines[i]}, commentLines...)
			if strings.HasPrefix(trimmed, "/*") {
				// 1行完結コメント: /* ... */ → 前の行も続けて確認
				i--
				continue
			}
			// 複数行ブロックコメント → /* まで一括収集してループ終了
			i--
			for i >= 0 {
				commentLines = append([]string{lines[i]}, commentLines...)
				if strings.HasPrefix(strings.TrimSpace(lines[i]), "/*") {
					break
				}
				i--
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
