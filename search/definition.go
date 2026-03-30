package search

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// DefHit は定義箇所の1件。
type DefHit struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Text string `json:"text"`
	Kind string `json:"kind"` // "define" / "struct" / "enum" / "union" / "typedef" / "func"
}

// FindDefinitions は word の定義候補を ripgrep で検索して返す。
// glob が空なら全ファイルが対象。
func FindDefinitions(ctx context.Context, word, dir, glob string) ([]DefHit, error) {
	return FindDefinitionsN(ctx, word, dir, glob, 50)
}

// FindDefinitionsN は最大件数を指定できる FindDefinitions。
//
// 実行戦略:
//   - 全パターン（define / struct / enum / typedef / func）を1つの正規表現に統合して
//     rg を1回だけ呼ぶ（従来の7プロセス → 1プロセス）。
//   - 各ヒットの kind はマッチ行のテキストから事後判定する。
func FindDefinitionsN(ctx context.Context, word, dir, glob string, maxPerQuery int) ([]DefHit, error) {
	if word == "" || dir == "" {
		return nil, nil
	}

	esc := regexp.QuoteMeta(word)

	// 全定義パターンを OR で結合（1回の rg 呼び出しで全種類を検索）
	combined := `(?:` +
		`#\s*define\s+` + esc + `\b` +
		`|^\s*(?:typedef\s+)?(?:struct|union)\s+` + esc + `\s*(?:\{|$)` +
		`|^\s*(?:typedef\s+)?enum\s+` + esc + `\s*(?:\{|$)` +
		`|\btypedef\b.+\b` + esc + `\b\s*;` +
		`|^\s*\}\s*` + esc + `\s*;` +
		`|^\s+` + esc + `\b\s*[,=]` +
		`|^[^\s#/*].*\b` + esc + `\s*\(` +
		`)`

	t1 := time.Now()
	opts := Options{
		Pattern:       combined,
		Dir:           dir,
		FileGlob:      glob,
		Regex:         true,
		CaseSensitive: true,
		ContextLines:  -1,
		MaxResults:    maxPerQuery,
	}
	matches, err := Search(ctx, opts)
	if err != nil {
		return nil, err
	}

	seen := map[string]bool{}
	var results []DefHit
	for _, m := range matches {
		key := fmt.Sprintf("%s:%d", m.File, m.Line)
		if seen[key] {
			continue
		}
		seen[key] = true
		results = append(results, DefHit{
			File: m.File,
			Line: m.Line,
			Text: strings.TrimSpace(m.Text),
			Kind: classifyDefKind(m.Text, word),
		})
	}

	// K&R スタイル: 関数名と ( が別行のケース（例: "void func\n(\n..."）
	// 通常検索でヒットしなかった場合のみ multiline で補完
	if len(results) == 0 && ctx.Err() == nil {
		karPattern := `^[^\s#/*].*\b` + esc + `\s*\n\s*\(`
		karMatches, karErr := Search(ctx, Options{
			Pattern:       karPattern,
			Dir:           dir,
			FileGlob:      glob,
			Regex:         true,
			CaseSensitive: true,
			ContextLines:  -1,
			MaxResults:    maxPerQuery,
			Multiline:     true,
		})
		if karErr == nil {
			for _, m := range karMatches {
				key := fmt.Sprintf("%s:%d", m.File, m.Line)
				if seen[key] {
					continue
				}
				seen[key] = true
				results = append(results, DefHit{
					File: m.File,
					Line: m.Line,
					Text: strings.TrimSpace(m.Text),
					Kind: "func",
				})
			}
		}
	}

	results = preferDefinitionHits(results)

	slog.Debug("FindDefinitions", "word", word, "hits", len(results), "elapsed", time.Since(t1))
	return results, nil
}

// ===== 定義 vs 宣言 フィルタ（gtags / ripgrep 共通） =====

// preferDefinitionHits は宣言より定義（実態）を優先して返す。
//
// 優先順位:
//  1. テキスト判定: 行末が`;` → 宣言を除外。`{`あり or 次行が`{` → 定義として残す。
//  2. 拡張子ヒント: 定義の中で .c/.cpp 等があれば .h/.hpp を除外。
//
// func 以外の kind（#define, struct 等）は常に定義として扱う。
func preferDefinitionHits(hits []DefHit) []DefHit {
	var defs, decls []DefHit
	for _, h := range hits {
		if isDefinitionHit(h) {
			defs = append(defs, h)
		} else {
			decls = append(decls, h)
		}
	}
	candidates := hits
	if len(defs) > 0 {
		candidates = defs
	}
	// 定義の中に実装ファイル（.c/.cpp 等）があればヘッダを除外
	return filterImplFiles(candidates)
}

// isDefinitionHit はヒットが「宣言」ではなく「定義（実態）」かを判定する。
func isDefinitionHit(h DefHit) bool {
	if h.Kind != "func" {
		return true // #define / struct / enum 等は常に定義
	}
	t := strings.TrimSpace(h.Text)
	tCode := stripLineComment(t) // コメントを除いて判定
	if strings.HasSuffix(tCode, ";") {
		return false // 行末が ; → 宣言
	}
	if strings.Contains(tCode, "{") {
		return true // { を含む → 定義
	}
	// 行末が ) や関数名のみ（K&R スタイル等）→ 次行を確認
	lines, err := CachedLines(h.File)
	if err != nil || h.Line <= 0 || h.Line >= len(lines) {
		return true // 判定不能 → 定義扱い
	}
	next := strings.TrimSpace(lines[h.Line]) // h.Line は1始まり、lines[h.Line] が次行
	return strings.HasPrefix(next, "{")
}

// implExts は実装ファイルの拡張子セット。
var implExts = map[string]bool{
	".c": true, ".cpp": true, ".cc": true, ".cxx": true, ".java": true,
}

// filterImplFiles は .c/.cpp 等の実装ファイルのヒットがあればヘッダを除外して返す。
func filterImplFiles(hits []DefHit) []DefHit {
	var impl []DefHit
	for _, h := range hits {
		if implExts[strings.ToLower(filepath.Ext(h.File))] {
			impl = append(impl, h)
		}
	}
	if len(impl) > 0 {
		return impl
	}
	return hits
}

// classifyDefKind はマッチ行のテキストから kind を判定する。
func classifyDefKind(text, word string) string {
	t := strings.TrimSpace(text)
	if reDefine.MatchString(t) {
		return "define"
	}
	if strings.Contains(t, "struct") {
		return "struct"
	}
	if strings.Contains(t, "union") {
		return "union"
	}
	if strings.Contains(t, "enum") {
		return "enum"
	}
	if strings.HasPrefix(t, "}") {
		return "typedef_close"
	}
	// インデントありで word が先頭近くにある → enum メンバー
	if len(t) > 0 && t[0] == ' ' || (len(text) > 0 && (text[0] == ' ' || text[0] == '\t')) {
		return "enum_member"
	}
	return "func"
}
