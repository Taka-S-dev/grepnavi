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
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
)

// localBinDir はアプリ実行ファイルと同階層の bin/ ディレクトリを返す。
// ユーザーが global.exe / gtags.exe をここに置けば PATH 不要で動く。
func localBinDir() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Join(filepath.Dir(exe), "bin")
}

// GtagsInPath は gtags / global コマンドが利用可能か確認する。
// local bin/ フォルダを最優先で確認し、なければ PATH を検索する。
func GtagsInPath() bool {
	if d := localBinDir(); d != "" {
		if _, err := os.Stat(filepath.Join(d, "gtags.exe")); err == nil {
			return true
		}
		if _, err := os.Stat(filepath.Join(d, "global.exe")); err == nil {
			return true
		}
	}
	_, err := exec.LookPath("gtags")
	return err == nil
}

// GtagsIndexed は dir 配下に GTAGS ファイルが存在するか確認する。
func GtagsIndexed(dir string) bool {
	gtagsFile := filepath.Join(dir, "GTAGS")
	_, err := os.Stat(gtagsFile)
	return err == nil
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
// -v フラグで処理中のファイル名をサーバーコンソールにリアルタイム出力する。
func GtagsBuildIndex(ctx context.Context, dir string) error {
	cmd := exec.CommandContext(ctx, resolveGtagsBin(), "-v")
	cmd.Dir = dir

	// stderr に進捗ログが出る（例: "[  1%] parsing .../foo.c"）
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		if strings.Contains(dir, " ") || isNonASCII(dir) {
			return fmt.Errorf("gtags failed (ヒント: 日本語やスペースを含まないパスで試してください): %w", err)
		}
		return err
	}

	// 進捗を1行ずつコンソールに出力
	scanner := bufio.NewScanner(stderr)
	for scanner.Scan() {
		slog.Info("gtags", "line", scanner.Text())
	}

	if err := cmd.Wait(); err != nil {
		if strings.Contains(dir, " ") || isNonASCII(dir) {
			return fmt.Errorf("gtags failed (ヒント: 日本語やスペースを含まないパスで試してください): %w", err)
		}
		return err
	}
	return nil
}

func isNonASCII(s string) bool {
	for _, r := range s {
		if r > 127 {
			return true
		}
	}
	return false
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
	cmd := exec.CommandContext(ctx, resolveGlobalBin(), "-u")
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

// englishEnv は文字化け防止のため LANG=C を追加した環境変数を返す。
func englishEnv(extra ...string) []string {
	env := os.Environ()
	// LANG/LC_ALL を C に上書きして英語出力に統一
	filtered := env[:0:0]
	for _, e := range env {
		if !strings.HasPrefix(e, "LANG=") && !strings.HasPrefix(e, "LC_ALL=") {
			filtered = append(filtered, e)
		}
	}
	filtered = append(filtered, "LANG=C", "LC_ALL=C")
	filtered = append(filtered, extra...)
	return filtered
}

// sanitizeLine はShift-JIS等の不正バイト列を除去してUTF-8安全な文字列に変換する。
func sanitizeLine(s string) string {
	return strings.ToValidUTF8(s, "")
}

// logDir はツール実行ファイルと同じディレクトリを返す。
func logDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exe)
}

// GtagsBuildIndexStream は gtags -v を実行する。
// "[N] extracting tags of <file>" 行はブラウザに送らずログファイルに100件単位で書き込む。
// それ以外の行（開始/完了メッセージ等）はブラウザに送る。
func GtagsBuildIndexStream(ctx context.Context, dir string, w io.Writer) error {
	cmd := exec.CommandContext(ctx, resolveGtagsBin(), "-v")
	cmd.Dir = dir
	cmd.Env = englishEnv()
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		if strings.Contains(dir, " ") || isNonASCII(dir) {
			return fmt.Errorf("gtags failed (ヒント: 日本語やスペースを含まないパスで試してください): %w", err)
		}
		return err
	}

	// ログファイルをツールディレクトリに作成
	logPath := filepath.Join(logDir(), "gtags-build.txt")
	logFile, logErr := os.Create(logPath)
	var logBuf []string
	flushLog := func() {
		if logErr != nil || len(logBuf) == 0 {
			logBuf = logBuf[:0]
			return
		}
		for _, line := range logBuf {
			fmt.Fprintln(logFile, line)
		}
		logBuf = logBuf[:0]
	}

	var fileCount int
	scanner := bufio.NewScanner(stderr)
	for scanner.Scan() {
		line := sanitizeLine(scanner.Text())
		// "[N] extracting tags of <file>" はログファイルへ
		if strings.Contains(line, "extracting tags of") {
			logBuf = append(logBuf, line)
			fileCount++
			if len(logBuf) >= 100 {
				flushLog()
				// 100件ごとに進捗をブラウザへ送る
				fmt.Fprintln(w, line)
			}
			continue
		}
		// それ以外はブラウザへ
		fmt.Fprintln(w, line)
	}
	flushLog()
	if logFile != nil {
		logFile.Close()
	}
	if err := cmd.Wait(); err != nil {
		return err
	}
	if logErr == nil {
		fmt.Fprintf(w, "ファイルリスト → %s\n", logPath)
	}
	return nil
}

// GtagsUpdateIndexStream は global -u --verbose を実行し出力を行単位で w に書き込む。
func GtagsUpdateIndexStream(ctx context.Context, dir string, w io.Writer) error {
	cmd := exec.CommandContext(ctx, resolveGlobalBin(), "-u", "-v")
	cmd.Env = englishEnv("GTAGSDBPATH="+dir, "GTAGSROOT="+dir)
	var combined bytes.Buffer
	// sanitize ラッパー経由で w に書き込む
	sw := &sanitizeWriter{w: w}
	mw := io.MultiWriter(sw, &combined)
	cmd.Stdout = mw
	cmd.Stderr = mw
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(combined.String())
		if msg != "" {
			return fmt.Errorf("%w: %s", err, sanitizeLine(msg))
		}
		return err
	}
	return nil
}

// sanitizeWriter は書き込み時に不正UTF-8バイトを除去するラッパー。
type sanitizeWriter struct{ w io.Writer }

func (s *sanitizeWriter) Write(p []byte) (int, error) {
	clean := []byte(strings.ToValidUTF8(string(p), ""))
	_, err := s.w.Write(clean)
	return len(p), err
}

// GtagsRebuildIndexStream は既存インデックスを削除してから GtagsBuildIndexStream を実行する。
func GtagsRebuildIndexStream(ctx context.Context, dir string, w io.Writer) error {
	for _, name := range []string{"GTAGS", "GRTAGS", "GPATH"} {
		os.Remove(filepath.Join(dir, name))
	}
	fmt.Fprintln(w, "既存インデックスを削除しました。再生成を開始します...")
	return GtagsBuildIndexStream(ctx, dir, w)
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
// 宣言(.h)と実装(.c/.cpp)が両方ヒットした場合は実装を優先する。
func GtagsFindDefinitions(ctx context.Context, word, dir string) ([]DefHit, error) {
	globalBin := resolveGlobalBin()
	cmd := exec.CommandContext(ctx, globalBin, "-xd", word)
	cmd.Dir = dir
	env := append(os.Environ(), "GTAGSDBPATH="+dir, "GTAGSROOT="+dir)
	cmd.Env = env
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			if exitErr.ExitCode() == 1 {
				return nil, nil
			}
		}
		return nil, err
	}
	return preferDefinitionHits(gtagsParseOutput(out, "func", dir)), nil
}

var _globalBinCache  string
var _globalBinSource string // "bin" / "scoop" / "msys" / "path" / ""

// resolveGlobalBin は実際に動作する global.exe のパスを返す。結果をキャッシュする。
func resolveGlobalBin() string {
	if _globalBinCache != "" {
		return _globalBinCache
	}
	bin, src := resolveGlobalBinOnce()
	_globalBinCache  = bin
	_globalBinSource = src
	return bin
}

// GlobalBinSource はバイナリの取得元を返す（"bin" / "scoop" / "msys" / "path" / ""）。
func GlobalBinSource() string {
	resolveGlobalBin() // キャッシュを確実に初期化
	return _globalBinSource
}

var _gtagsBinCache string

// resolveGtagsBin は実際に動作する gtags.exe のパスを返す。結果をキャッシュする。
// local bin/ → PATH の順で探す。
func resolveGtagsBin() string {
	if _gtagsBinCache != "" {
		return _gtagsBinCache
	}
	bin := resolveGtagsBinOnce()
	_gtagsBinCache = bin
	return bin
}

func resolveGtagsBinOnce() string {
	// 1. アプリ隣の bin/ を最優先
	if d := localBinDir(); d != "" {
		p := filepath.Join(d, "gtags.exe")
		if fi, err := os.Stat(p); err == nil {
			slog.Debug("gtags-resolve", "found", "local bin", "path", p, "size", fi.Size())
			return p
		}
	}
	// 2. PATH
	if p, err := exec.LookPath("gtags"); err == nil {
		slog.Debug("gtags-resolve", "found", "PATH", "path", p)
		return p
	}
	slog.Debug("gtags-resolve", "gtags.exe", "not found, falling back to 'gtags'")
	return "gtags"
}

func resolveGlobalBinOnce() (string, string) {
	slog.Debug("gtags-resolve", "msg", "searching global.exe",
		"SCOOP", os.Getenv("SCOOP"), "USERPROFILE", os.Getenv("USERPROFILE"))

	// 0. アプリ隣の bin/ を最優先（PATH 不要・shim 非依存）
	if d := localBinDir(); d != "" {
		p := filepath.Join(d, "global.exe")
		if fi, err := os.Stat(p); err == nil {
			slog.Debug("gtags-resolve", "found", "local bin", "path", p, "size", fi.Size())
			return p, "bin"
		}
		slog.Debug("gtags-resolve", "local bin", "not found", "dir", d)
	}

	scoopAppsDir := ""
	if s := os.Getenv("SCOOP"); s != "" {
		scoopAppsDir = filepath.Join(s, "apps")
	} else if up := os.Getenv("USERPROFILE"); up != "" {
		scoopAppsDir = filepath.Join(up, "scoop", "apps")
	}

	if scoopAppsDir != "" {
		entries, err := os.ReadDir(scoopAppsDir)
		if err != nil {
			slog.Debug("gtags-resolve", "scoop ReadDir error", err)
		} else {
			for _, e := range entries {
				if !e.IsDir() {
					continue
				}
				p := filepath.Join(scoopAppsDir, e.Name(), "current", "global.exe")
				if fi, err := os.Stat(p); err == nil {
					slog.Debug("gtags-resolve", "found", "scoop", "path", p, "size", fi.Size())
					return p, "scoop"
				}
			}
			slog.Debug("gtags-resolve", "scoop", "global.exe not found")
		}
	}

	for _, base := range []string{`C:\msys64`, `C:\msys2`, `D:\msys64`, `D:\msys2`} {
		p := filepath.Join(base, "usr", "bin", "global.exe")
		if _, err := os.Stat(p); err == nil {
			slog.Debug("gtags-resolve", "found", "msys", "path", p)
			return p, "msys"
		}
	}

	if p, err := exec.LookPath("global"); err == nil {
		slog.Debug("gtags-resolve", "found", "PATH", "path", p)
		return p, "path"
	}
	slog.Debug("gtags-resolve", "global.exe", "not found, falling back to 'global'")
	return "global", ""
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
	cmd := exec.CommandContext(ctx, resolveGlobalBin(), "-xr", word)
	cmd.Env = append(os.Environ(), "GTAGSDBPATH="+dir, "GTAGSROOT="+dir)
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
