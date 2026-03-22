package search

// GNU Global 統合
//
// このファイルを削除し、handlers.go の gtags 分岐を除去するだけで
// GNU Global 機能を完全に取り外せます。

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
)

// GtagsInPath は gtags コマンドが PATH に存在するか確認する。
func GtagsInPath() bool {
	_, err := exec.LookPath("gtags")
	return err == nil
}

// GtagsIndexed は dir 配下に GTAGS ファイルが存在するか確認する。
func GtagsIndexed(dir string) bool {
	gtagsFile := filepath.Join(dir, "GTAGS")
	if _, err := os.Stat(gtagsFile); err == nil {
		return true
	}
	// fallback: global -p で確認
	c := exec.Command("global", "-p")
	c.Dir = dir
	return c.Run() == nil
}

// GtagsAvailable は GNU Global が使用可能か（インストール済み + インデックス済み）確認する。
func GtagsAvailable(dir string) bool {
	return GtagsInPath() && GtagsIndexed(dir)
}

// _gtagsStale は非同期staleチェックの結果（0=不明/新鮮, 1=古い）。
var _gtagsStale int32

// GtagsIsStale はインデックスが古いかどうかを返す。
func GtagsIsStale() bool {
	return atomic.LoadInt32(&_gtagsStale) == 1
}

// GtagsCheckStaleAsync は goroutine でソースファイルの mtime と GTAGS を比較する。
// GTAGS より新しいソースファイルが1件でもあれば stale フラグを立てる。
var srcExts = map[string]bool{
	".c": true, ".h": true, ".cpp": true, ".cc": true, ".cxx": true,
	".hpp": true, ".hh": true, ".java": true,
}

func GtagsCheckStaleAsync(dir string) {
	go func() {
		gtagsFile := filepath.Join(dir, "GTAGS")
		info, err := os.Stat(gtagsFile)
		if err != nil {
			return // インデックスなし
		}
		gtagsMtime := info.ModTime()

		_ = filepath.Walk(dir, func(path string, fi os.FileInfo, err error) error {
			if err != nil || fi.IsDir() {
				return nil
			}
			if !srcExts[strings.ToLower(filepath.Ext(path))] {
				return nil
			}
			if fi.ModTime().After(gtagsMtime) {
				atomic.StoreInt32(&_gtagsStale, 1)
				return filepath.SkipAll
			}
			return nil
		})
	}()
}

// GtagsResetStale はインデックス更新後にstaleフラグをリセットする。
func GtagsResetStale() {
	atomic.StoreInt32(&_gtagsStale, 0)
}


// GtagsBuildIndex は dir で gtags を実行してインデックスを生成する。
func GtagsBuildIndex(ctx context.Context, dir string) error {
	cmd := exec.CommandContext(ctx, "gtags")
	cmd.Dir = dir
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return fmt.Errorf("%w: %s", err, msg)
		}
		return err
	}
	return nil
}

// GtagsRebuildIndex は既存インデックスを削除してから gtags で再生成する。
func GtagsRebuildIndex(ctx context.Context, dir string) error {
	for _, name := range []string{"GTAGS", "GRTAGS", "GPATH"} {
		os.Remove(filepath.Join(dir, name))
	}
	return GtagsBuildIndex(ctx, dir)
}

// GtagsUpdateIndex は global -u で差分更新する。
func GtagsUpdateIndex(ctx context.Context, dir string) error {
	cmd := exec.CommandContext(ctx, "global", "-u")
	cmd.Dir = dir
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return fmt.Errorf("%w: %s", err, msg)
		}
		return err
	}
	return nil
}

// gtagsParseOutput は global -x の出力をパースして DefHit のスライスを返す。
// 出力フォーマット: "symbol  linenum  filepath  content"
// dir を渡すと相対パスを絶対パスに変換する。
func gtagsParseOutput(out []byte, kind, dir string) []DefHit {
	var results []DefHit
	scanner := bufio.NewScanner(bytes.NewReader(out))
	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		lineNum, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		file := fields[2]
		if !filepath.IsAbs(file) {
			file = filepath.Join(dir, file)
		}
		text := strings.Join(fields[3:], " ")
		results = append(results, DefHit{
			File: file,
			Line: lineNum,
			Text: strings.TrimSpace(text),
			Kind: kind,
		})
	}
	return results
}

// GtagsFindDefinitions は GNU Global で word の定義を検索する。
func GtagsFindDefinitions(ctx context.Context, word, dir string) ([]DefHit, error) {
	cmd := exec.CommandContext(ctx, "global", "-xd", word)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return nil, nil // not found
		}
		return nil, err
	}
	return gtagsParseOutput(out, "func", dir), nil
}

// gtagsClassifyKind はファイルの該当行テキストから kind を判定する。
func gtagsClassifyKind(line string) string {
	t := strings.TrimSpace(line)
	if strings.HasPrefix(t, "#define") {
		return "define"
	}
	if strings.Contains(t, "struct") {
		return "struct"
	}
	if strings.Contains(t, "enum") {
		return "enum"
	}
	if strings.Contains(t, "union") {
		return "union"
	}
	return "func"
}

// GtagsFindHoverHits は GNU Global で定義位置を特定し、
// ファイル行から kind を再分類した DefHit スライスを返す（ホバー用）。
func GtagsFindHoverHits(ctx context.Context, word, dir string) ([]DefHit, error) {
	hits, err := GtagsFindDefinitions(ctx, word, dir)
	if err != nil || len(hits) == 0 {
		return hits, err
	}
	for i, h := range hits {
		lines, lerr := CachedLines(h.File)
		if lerr != nil || h.Line <= 0 || h.Line > len(lines) {
			continue
		}
		hits[i].Kind = gtagsClassifyKind(lines[h.Line-1])
		hits[i].Text = strings.TrimSpace(lines[h.Line-1])
	}
	return hits, nil
}

// GtagsFindRefs は GNU Global で word の参照箇所を検索する（callers 用）。
// 各参照行を囲む関数名・定義行を findContainingFunc で解決して返す。
func GtagsFindRefs(ctx context.Context, word, dir string) ([]CallSite, error) {
	cmd := exec.CommandContext(ctx, "global", "-xr", word)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return nil, nil
		}
		return nil, err
	}
	hits := gtagsParseOutput(out, "ref", dir)
	var results []CallSite
	seen := map[string]bool{}
	for _, h := range hits {
		lines, lerr := CachedLines(h.File)
		if lerr != nil {
			continue
		}
		funcName, defLine := findContainingFunc(lines, h.Line)
		if funcName == "" || funcName == word {
			continue
		}
		key := h.File + ":" + strconv.Itoa(defLine)
		if seen[key] {
			continue
		}
		seen[key] = true
		results = append(results, CallSite{
			Func:     funcName,
			File:     h.File,
			Line:     defLine,
			CallLine: h.Line,
		})
	}
	return results, nil
}
