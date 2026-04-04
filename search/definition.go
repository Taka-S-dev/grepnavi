package search

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"grepnavi/graph"
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

// FindDefinitionsSmart はヒューリスティック探索で定義を高速に見つける。
//
// 全探索を同時起動し、近い順に優先して最初のヒットを返す。
//
//   level 0: インクルードチェーン + 対応 .c ファイル（意味的な近さ・最優先）
//   level 1: currentFile と同じディレクトリ
//   level 2: 親ディレクトリ
//   ...
//   level N: root 全体（フォールバック）
//
// キャッシュは呼び出し元（handleDefinition）が管理する。
func FindDefinitionsSmart(ctx context.Context, word, currentFile, root, glob string) ([]DefHit, error) {
	if word == "" || root == "" {
		return nil, nil
	}
	t0 := time.Now()

	// walk ディレクトリを近い順にリストアップ
	var walkDirs []string
	if currentFile != "" {
		dir := filepath.Dir(currentFile)
		for {
			rel, err := filepath.Rel(root, dir)
			if err != nil || strings.HasPrefix(rel, "..") {
				break
			}
			walkDirs = append(walkDirs, dir)
			if dir == root {
				break
			}
			dir = filepath.Dir(dir)
		}
	}
	if len(walkDirs) == 0 {
		walkDirs = []string{root}
	}

	// level 0: Phase0、level 1〜N: walkDirs
	total := 1 + len(walkDirs)

	type levelResult struct {
		level int
		hits  []DefHit
		err   error
	}

	innerCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	ch := make(chan levelResult, total)

	// level 0: インクルードチェーン + 対応 .c ファイル
	go func() {
		var hits []DefHit
		var err error
		if currentFile != "" {
			incs, _ := GetFileIncludes(currentFile, root)
			seenFiles := map[string]bool{}
			var files []string
			addFile := func(f string) {
				// パス正規化して重複排除
				f = filepath.Clean(f)
				if !seenFiles[f] {
					seenFiles[f] = true
					files = append(files, f)
				}
			}
			addFile(currentFile)
			var hFiles []string
			for _, inc := range incs {
				if inc.ID != "" {
					abs := filepath.Join(root, inc.ID)
					addFile(abs)
					hFiles = append(hFiles, abs)
				}
			}
			cFiles := findSiblingCFiles(innerCtx, root, hFiles)
			for _, f := range cFiles {
				addFile(f)
			}
			slog.Debug("FindDefinitionsSmart phase0 files", "headers", len(hFiles), "c_siblings", len(cFiles))
			if len(files) > 0 {
				hits, err = findDefinitionsInFiles(innerCtx, word, files)
			}
		}
		ch <- levelResult{0, hits, err}
	}()

	// level 1〜N: 階層的 walk
	for i, d := range walkDirs {
		go func(level int, dir string) {
			var hits []DefHit
			var err error
			if dir == root {
				hits, err = FindDefinitionsN(innerCtx, word, root, glob, 1)
			} else {
				files := listFilesInDir(dir, glob)
				if len(files) > 0 {
					hits, err = findDefinitionsInFiles(innerCtx, word, files)
				}
			}
			ch <- levelResult{level, hits, err}
		}(i+1, d)
	}

	// 結果を受け取り、近い順（level 0 最優先）にチェック
	received := make([]levelResult, total)
	done := make([]bool, total)
	for count := 0; count < total; count++ {
		r := <-ch
		received[r.level] = r
		done[r.level] = true

		for i := 0; i < total; i++ {
			if !done[i] {
				break // 近いレベルがまだ未完
			}
			if len(received[i].hits) == 0 {
				continue
			}
			// root レベル（最後）は宣言フォールバックも許容する
			isRoot := i == total-1
			hasDef := false
			for _, h := range received[i].hits {
				if isDefinitionHit(h) {
					hasDef = true
					break
				}
			}
			if hasDef || isRoot {
				cancel()
				slog.Debug("FindDefinitionsSmart hit", "level", i, "hits", len(received[i].hits), "has_def", hasDef, "elapsed", time.Since(t0))
				return received[i].hits, received[i].err
			}
			// 宣言のみ → 次のレベルを試す
		}
	}

	return nil, nil
}

// listFilesInDir はディレクトリ直下のファイル（サブディレクトリは含まない）を返す。
// glob が指定されている場合はファイル名でフィルタする（例: "*.c,*.h"）。
func listFilesInDir(dir, glob string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	globs := strings.FieldsFunc(glob, func(r rune) bool { return r == ',' || r == ' ' })
	var files []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if len(globs) == 0 {
			files = append(files, filepath.Join(dir, name))
			continue
		}
		for _, g := range globs {
			if matched, _ := filepath.Match(g, name); matched {
				files = append(files, filepath.Join(dir, name))
				break
			}
		}
	}
	return files
}

// findSiblingCFiles は .h/.hpp ファイルのリストから同名の .c ファイルを root 以下で探す。
// 例: include/linux/bpf.h → kernel/bpf/bpf.c
// rg --files -g bpf.c -g filter.c root を1回呼ぶだけなので高速。
func findSiblingCFiles(ctx context.Context, root string, hFiles []string) []string {
	seen := map[string]bool{}
	var args []string
	args = append(args, "--files")
	for _, f := range hFiles {
		base := filepath.Base(f)
		ext := strings.ToLower(filepath.Ext(base))
		if ext == ".h" || ext == ".hpp" {
			cName := strings.TrimSuffix(base, filepath.Ext(base)) + ".c"
			if !seen[cName] {
				seen[cName] = true
				args = append(args, "-g", cName)
			}
		}
	}
	if len(seen) == 0 {
		return nil
	}
	args = append(args, root)
	out, err := exec.CommandContext(ctx, "rg", args...).Output()
	if err != nil {
		return nil
	}
	var result []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line != "" {
			result = append(result, line)
		}
	}
	return result
}

// findDefinitionsInFiles は特定ファイルリストだけを対象に定義検索する。
func findDefinitionsInFiles(ctx context.Context, word string, files []string) ([]DefHit, error) {
	esc := regexp.QuoteMeta(word)
	combined := `(?:` +
		`#\s*define\s+` + esc + `\b` +
		`|^\s*(?:typedef\s+)?(?:struct|union)\s+` + esc + `\s*(?:\{|$)` +
		`|^\s*(?:typedef\s+)?enum\s+` + esc + `\s*(?:\{|$)` +
		`|\btypedef\b.+\b` + esc + `\b\s*;` +
		`|^\s*\}\s*` + esc + `\s*;` +
		`|^\s+` + esc + `\b\s*[,=]` +
		`|^[^\s#/*].*\b` + esc + `\s*\(` +
		`)`
	matches, err := Search(ctx, Options{
		Pattern:       combined,
		Files:         files,
		Regex:         true,
		CaseSensitive: true,
		ContextLines:  -1,
		MaxResults:    20,
	})
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
	return preferDefinitionHits(results), nil
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
	}

	// SearchStream を使い、実態（定義）を maxPerQuery 件見つけた時点で rg を即 kill する。
	// 宣言（行末 ; など）はカウントせず収集のみ行う。
	// これにより「.h の宣言を先に見つけても続行し、.c の定義で即終了」が実現できる。
	seen := map[string]bool{}
	var results []DefHit
	defCount := 0
	errDone := errors.New("done")
	if err := SearchStream(ctx, opts, func(m graph.Match) error {
		key := fmt.Sprintf("%s:%d", m.File, m.Line)
		if seen[key] {
			return nil
		}
		seen[key] = true
		hit := DefHit{
			File: m.File,
			Line: m.Line,
			Text: strings.TrimSpace(m.Text),
			Kind: classifyDefKind(m.Text, word),
		}
		results = append(results, hit)
		if isDefinitionHit(hit) {
			defCount++
			if defCount >= maxPerQuery {
				return errDone // 実態を maxPerQuery 件確認した時点で rg を kill
			}
		}
		return nil
	}); err != nil {
		return nil, err
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
		isDef := isDefinitionHit(h)
		slog.Debug("preferDefinitionHits", "file", h.File, "line", h.Line, "text", h.Text, "isDef", isDef)
		if isDef {
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
	lines, _ := CachedLines(h.File)
	return isDefinitionHitLines(h, lines)
}

// isDefinitionHitLines は lines を直接受け取る isDefinitionHit の内部実装。テストから呼べる。
func isDefinitionHitLines(h DefHit, lines []string) bool {
	t := strings.TrimSpace(h.Text)
	tCode := stripLineComment(t)
	if strings.HasSuffix(tCode, ";") {
		return false // 行末が ; → 宣言
	}
	if strings.Contains(tCode, "{") {
		return true // { を含む → 定義
	}
	// 複数行シグネチャの場合: { か ; が出るまで最大20行スキャン
	if h.Line <= 0 || h.Line >= len(lines) {
		return true // 判定不能 → 定義扱い
	}
	for i := h.Line; i < len(lines) && i < h.Line+20; i++ {
		l := stripLineComment(strings.TrimSpace(lines[i]))
		if strings.HasPrefix(l, "{") || strings.Contains(l, "{") {
			return true // { が出た → 定義
		}
		if strings.HasSuffix(l, ";") {
			return false // ; が出た → 宣言
		}
	}
	return true // 判定不能 → 定義扱い
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
