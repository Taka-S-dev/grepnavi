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
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
)

const (
	// shim (gtags-shell.bat 等の wrapper) 検出閾値（バイト）。本物は数百 KB〜MB、shim は数 KB 以下。
	_gtagsShimSizeThreshold = 2048
	// 進捗ログをまとめてフラッシュするバッチ件数。
	_gtagsLogFlushBatchSize = 100
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

// staleSkipDirs はサイズの大きい依存物・成果物ディレクトリ。
// gtags は元々これらを索引対象にしないので、stale 判定でも歩く必要がない。
var staleSkipDirs = map[string]bool{
	".git": true, ".hg": true, ".svn": true,
	"node_modules": true, "vendor": true, "third_party": true,
	"build": true, "out": true, "dist": true, "target": true,
	"obj": true, ".cache": true, ".vscode": true, ".idea": true,
}

func GtagsCheckStaleAsync(dir string) {
	go func() {
		gtagsFile := filepath.Join(dir, "GTAGS")
		info, err := os.Stat(gtagsFile)
		if err != nil {
			return // インデックスなし
		}
		gtagsMtime := info.ModTime()

		_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				if path != dir && staleSkipDirs[d.Name()] {
					return filepath.SkipDir
				}
				return nil
			}
			if !srcExts[strings.ToLower(filepath.Ext(path))] {
				return nil
			}
			fi, ferr := d.Info()
			if ferr != nil {
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
// インデックスが書き換わるため、定義・参照のキャッシュも破棄する。
func GtagsResetStale() {
	atomic.StoreInt32(&_gtagsStale, 0)
	gtagsClearResultCaches()
	// プリロード済み定義表も古くなるので破棄し、対象環境なら作り直す
	_gtagsPreloadGen.Add(1)
	_gtagsDefsAll.Store(nil)
	_gtagsPreloadMu.Lock()
	dir := _gtagsPreloadDir
	_gtagsPreloadMu.Unlock()
	if dir != "" {
		maybePreloadDefsAsync(resolveGlobalBin(), dir)
	}
}

// 定義・参照の結果キャッシュ。キーは "dir\x00word"。インデックス更新で全消し。
// シンボル単位で連打したり、ホバー→Ctrl+click と続けても 2 回目以降は即返る。
var (
	_gtagsDefCache  sync.Map // value: []DefHit
	_gtagsRefsCache sync.Map // value: []CallSite
)

func gtagsCacheKey(dir, word string) string { return dir + "\x00" + word }

func gtagsClearResultCaches() {
	_gtagsDefCache.Range(func(k, _ any) bool { _gtagsDefCache.Delete(k); return true })
	_gtagsRefsCache.Range(func(k, _ any) bool { _gtagsRefsCache.Delete(k); return true })
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
		if r > unicode.MaxASCII {
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
// extra に同名の変数があれば os.Environ() 側の既存値は除去する
// （シェルで GTAGSDBPATH 等を設定されていた場合の重複を防ぐ）。
func englishEnv(extra ...string) []string {
	override := map[string]bool{"LANG": true, "LC_ALL": true}
	for _, e := range extra {
		if i := strings.Index(e, "="); i > 0 {
			override[e[:i]] = true
		}
	}
	env := os.Environ()
	filtered := make([]string, 0, len(env)+len(extra)+2)
	for _, e := range env {
		if i := strings.Index(e, "="); i > 0 && override[e[:i]] {
			continue
		}
		filtered = append(filtered, e)
	}
	filtered = append(filtered, "LANG=C", "LC_ALL=C")
	filtered = append(filtered, extra...)
	return filtered
}

// gtagsEnv は GTAGSDBPATH / GTAGSROOT を設定した環境変数を返す。
// パスは ToSlash しない: Cygwin ビルドの global.exe は Windows パス
// (バックスラッシュ) を受け付けるが、フォワードスラッシュだと検索が
// 空を返す症状が実機で確認されている。
func gtagsEnv(dir string) []string {
	return englishEnv("GTAGSDBPATH="+dir, "GTAGSROOT="+dir)
}

// ===== 実行経路の記憶 (sticky transport) =====
//
// 直接起動の stdout が空になる環境 (EDR/DLP がプロセス起動ごとに未署名バイナリを
// 検査する環境では1起動あたり数秒かかる) で、毎回 直接→ファイル→bash と試すと
// 失敗確定の起動を2回余分に払う。一度成功した経路を記憶して以降はそこから入る。

const (
	_transportDirect int32 = iota // 既定: cmd.Output() が使える
	_transportFile                // ファイルリダイレクトのみ通る
	_transportBash                // bash 経由のみ通る
)

var (
	_globalTransport atomic.Int32
	// _transportVerified は記憶経路がこのプロセスで非空出力を返した実績。
	// 永続化ファイルから復元しただけの経路は false のままで、実績が付くまで
	// 空出力を「ヒットなし」と断定しない（環境が変わっている可能性があるため）。
	_transportVerified atomic.Bool
	_transportLoadOnce sync.Once
)

// _gtagsTransportStateFile は検出済み経路の永続化ファイル名（exe と同階層）。
// 次回起動時の症状検出（EDR 環境ではプロセス起動数回分 = 十数秒）を省く。
const _gtagsTransportStateFile = "gtags-transport.txt"

func transportStatePath() string { return filepath.Join(logDir(), _gtagsTransportStateFile) }

// parseTransportState は永続化ファイルの中身を経路定数に変換する。
func parseTransportState(s string) (int32, bool) {
	switch strings.TrimSpace(s) {
	case "file":
		return _transportFile, true
	case "bash":
		return _transportBash, true
	}
	return _transportDirect, false
}

// loadPersistedTransport は前回起動で検出した経路を一度だけ読み込む。
// あくまでヒント: 実績（_transportVerified）が付くまでは、空出力で
// 全経路カスケードに戻る（runGlobalSticky 参照）。
func loadPersistedTransport() {
	_transportLoadOnce.Do(func() {
		data, err := os.ReadFile(transportStatePath())
		if err != nil {
			return
		}
		t, ok := parseTransportState(string(data))
		if !ok {
			return
		}
		// このプロセスで既に検出済みなら上書きしない
		if _globalTransport.CompareAndSwap(_transportDirect, t) {
			slog.Info("gtags-transport", "msg", "restored from previous run", "state", strings.TrimSpace(string(data)))
		}
	})
}

// persistTransport は検出した経路を保存する。direct はファイル削除で表す。
// 書き込めない場所（Program Files 等）では黙って諦める（毎回検出に戻るだけ）。
func persistTransport(t int32) {
	p := transportStatePath()
	switch t {
	case _transportFile:
		_ = os.WriteFile(p, []byte("file\n"), 0o644)
	case _transportBash:
		_ = os.WriteFile(p, []byte("bash\n"), 0o644)
	default:
		_ = os.Remove(p)
	}
}

// demoteTransportToDirect は記憶経路を破棄して全経路カスケードに戻す。
func demoteTransportToDirect(reason string) {
	_globalTransport.Store(_transportDirect)
	persistTransport(_transportDirect)
	slog.Info("gtags-transport", "msg", "transport reset to direct", "reason", reason)
}

// GtagsTransport は現在記憶している global 実行経路を返す（診断表示用）。
func GtagsTransport() string {
	loadPersistedTransport()
	switch _globalTransport.Load() {
	case _transportFile:
		return "file"
	case _transportBash:
		return "bash"
	}
	return "direct"
}

// runGlobalSticky は記憶済みの成功経路で global を実行する。
// handled=false は「直接起動経路を使うべき」という意味（経路未記憶 or 経路不調）。
//
// 記憶経路が空を返した場合: このプロセスで非空出力の実績があればヒットなし。
// 実績がなければ（= 永続化からの復元直後）環境が変わった可能性があるので、
// 記憶を破棄して全経路カスケードへ戻す。カスケードが再発見した経路は
// recoverEmptyGlobalOutput 側で再び記憶・永続化される。
func runGlobalSticky(globalBin, dir, word, mode string) (out []byte, handled bool) {
	loadPersistedTransport()
	t := _globalTransport.Load()
	if t == _transportDirect {
		return nil, false
	}
	var o []byte
	var attempted bool
	if t == _transportFile {
		o, attempted = runGlobalToFile(globalBin, dir, word, mode)
	} else {
		o, attempted = runGlobalViaBash(globalBin, dir, word, mode)
	}
	if attempted {
		if len(bytes.TrimSpace(o)) > 0 {
			_transportVerified.Store(true)
			return o, true
		}
		if _transportVerified.Load() {
			return nil, true // 実績のある経路で空 = 本当にヒットなし
		}
	}
	demoteTransportToDirect("persisted transport returned empty or unavailable")
	return nil, false
}

// ===== Cygwin bash フォールバック =====
//
// 同梱の Cygwin ビルド global.exe が native Windows プロセス(Go) が作成した
// pipe に書き込めず stdout が空になる症状への対策。
// Cygwin bash を経由して /tmp に出力させ、それを読み戻すことで回避する。
//
// bash が PATH に無い環境ではフォールバックを無効化し、従来通り cmd.Output()
// の結果（空かもしれない）をそのまま使う。Cygwin 必須化はしない。

var (
	_bashOnce          sync.Once
	_bashPath          string // Cygwin/MSYS bash.exe のフルパス、未検出なら ""
	_cygTmpWindowsPath string // POSIX側 /tmp の Windows パス、未検出なら ""
	_cygDrivePrefix    string // ドライブパス変換の POSIX プレフィックス ("/cygdrive/" か "/")
)

// knownBashLocations は PATH に無くても bash.exe が見つかりそうな既定インストール先。
// Git for Windows は既定で "Git\bin" を PATH に追加しない設定でインストールされることが
// 多く、その場合 exec.LookPath("bash") は失敗するが bash.exe 自体は存在する。
func knownBashLocations() []string {
	var candidates []string
	roots := []string{
		os.Getenv("ProgramFiles"),
		os.Getenv("ProgramFiles(x86)"),
		os.Getenv("ProgramW6432"),
	}
	for _, root := range roots {
		if root == "" {
			continue
		}
		candidates = append(candidates,
			filepath.Join(root, "Git", "bin", "bash.exe"),
			filepath.Join(root, "Git", "usr", "bin", "bash.exe"),
		)
	}
	return candidates
}

// initBashRun は bash の検出と /tmp の Windows パス取得を一度だけ実行する。
func initBashRun() {
	_bashOnce.Do(func() {
		p, err := exec.LookPath("bash")
		if err != nil {
			for _, cand := range knownBashLocations() {
				if fi, statErr := os.Stat(cand); statErr == nil && !fi.IsDir() {
					p = cand
					slog.Info("gtags-bash-fallback", "msg", "bash not in PATH, found via known install location", "path", p)
					break
				}
			}
			if p == "" {
				slog.Info("gtags-bash-fallback", "msg", "bash not found in PATH or known locations, fallback disabled")
				return
			}
		}
		out, err := exec.Command(p, "-c", "cygpath -w /tmp").Output()
		if err != nil {
			slog.Info("gtags-bash-fallback", "msg", "cygpath failed, fallback disabled", "err", err)
			return
		}
		// ドライブパスの POSIX 変換規則は実装によって違う:
		// Cygwin は "/cygdrive/c/..."、Git for Windows (MSYS2) は "/c/..." を使う。
		// 実際に cygpath -u で変換させて、どちらの形式かを実行時に確定する。
		prefix := "/cygdrive/"
		if uOut, uErr := exec.Command(p, "-c", `cygpath -u "C:\\"`).Output(); uErr == nil {
			if s := strings.TrimSpace(string(uOut)); strings.HasPrefix(s, "/cygdrive/") {
				prefix = "/cygdrive/"
			} else if len(s) >= 2 && s[0] == '/' {
				prefix = "/"
			}
		}
		_bashPath = p
		_cygTmpWindowsPath = strings.TrimSpace(string(out))
		_cygDrivePrefix = prefix
		slog.Info("gtags-bash-fallback", "msg", "ready", "bash", _bashPath, "tmp_win", _cygTmpWindowsPath, "drive_prefix", _cygDrivePrefix)
	})
}

// GtagsWarmupAsync は bash 検出と「直接起動で stdout が空になる」症状の検査を
// バックグラウンドで済ませる。症状検出時は recoverEmptyGlobalOutput 側で経路の
// 記憶と定義プリロードまで走るため、最初のジャンプから速い経路に乗れる。
// 既定シンボルの -xd を試し、exit=0 なのに空 = パイプ症状（本当に無いなら exit=1）。
func GtagsWarmupAsync(dir string) {
	go func() {
		if !GtagsAvailable(dir) {
			return
		}
		initBashRun()
		loadPersistedTransport()
		if _globalTransport.Load() != _transportDirect {
			// 判定済み（前回起動の永続化含む）: プリロードだけ開始する。
			// 永続化が古かった場合は最初のルックアップが検出し直す。
			maybePreloadDefsAsync(resolveGlobalBin(), dir)
			return
		}
		globalBin := resolveGlobalBin()
		for _, w := range []string{"main", "init", "open", "close"} {
			cmd := exec.Command(globalBin, "-xd", w)
			cmd.Dir = dir
			cmd.Env = gtagsEnv(dir)
			out, err := cmd.Output()
			if err != nil {
				continue // exit=1 (シンボルなし) 等 → 次の語で判定
			}
			if len(bytes.TrimSpace(out)) > 0 {
				slog.Debug("gtags-warmup", "msg", "direct output healthy", "word", w)
				return
			}
			if recovered := recoverEmptyGlobalOutput(globalBin, dir, w, "-xd", "gtags-warmup"); recovered != nil {
				return
			}
		}
	}()
}

// windowsToCygwinPath は Windows パス (C:\foo\bar) を POSIX パスに変換する。
// initBashRun で確定した _cygDrivePrefix に従い、Cygwin なら
// "/cygdrive/c/foo/bar"、Git for Windows (MSYS2) なら "/c/foo/bar" になる。
// filepath.ToSlash はホスト OS の区切り文字にしか効かないため使わない
// （入力は常に Windows パスであり、Linux 上のテストでも同じ結果になるべき）。
func windowsToCygwinPath(p string) string {
	p = strings.ReplaceAll(p, `\`, "/")
	prefix := _cygDrivePrefix
	if prefix == "" {
		prefix = "/cygdrive/" // 未確定時は Cygwin 形式を既定とする（従来動作を維持）
	}
	if len(p) >= 2 && p[1] == ':' {
		return prefix + strings.ToLower(p[0:1]) + p[2:]
	}
	return p
}

// shellQuote は bash 用にシングルクォートで囲む。
// 文字列内の ' を '\'' で escape する標準テクニック。
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// runGlobalViaBash は global.exe を Cygwin bash 経由で実行し結果バイト列を返す。
// 戻り値の第2引数 attempted が true なら bash 経路を試みた（成功/失敗問わず）。
// false の場合は bash が無いので呼び出し側はフォールバック断念。
//
// mode は global の検索オプション (`-xd` 定義 / `-xr` 参照 等)。
func runGlobalViaBash(globalBin, dir, word, mode string) (data []byte, attempted bool) {
	initBashRun()
	if _bashPath == "" {
		return nil, false
	}
	tmpName := fmt.Sprintf("grepnavi-gtags-%d-%d.txt", os.Getpid(), time.Now().UnixNano())
	cygTmp := "/tmp/" + tmpName
	winTmp := filepath.Join(_cygTmpWindowsPath, tmpName)
	defer os.Remove(winTmp)

	globalCyg := windowsToCygwinPath(globalBin)
	// GTAGSDBPATH/GTAGSROOT は Windows パスのまま (Cygwin global は両方解釈する)。
	// global.exe の実行パスは Cygwin パス (/cygdrive/...) でなければ bash が認識しない。
	// 出力先は Cygwin パス (/tmp/...): bash の > リダイレクトは POSIX パス前提。
	cmdStr := fmt.Sprintf("GTAGSDBPATH=%s GTAGSROOT=%s %s %s %s > %s 2>/dev/null",
		shellQuote(dir), shellQuote(dir),
		shellQuote(globalCyg),
		mode,
		shellQuote(word),
		shellQuote(cygTmp))

	cmd := exec.Command(_bashPath, "-c", cmdStr)
	// exit=1 は「ヒットなし」なので情報的、それ以外は警告
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() != 1 {
			slog.Debug("gtags-bash-fallback exec", "err", err, "cmd", cmdStr)
		}
	}
	out, rerr := os.ReadFile(winTmp)
	if rerr != nil {
		// ファイル無し = 結果なし (global が "no results" で何も書かなかった等)
		return nil, true
	}
	return out, true
}

// runGlobalToFile は global.exe の stdout を実ファイルにリダイレクトして実行し結果を返す。
// attempted が false なのは一時ファイル作成に失敗したときだけ。
//
// Cygwin ビルドの global.exe は Go が cmd.Output() で作る匿名パイプに書き込めず stdout が
// 空になることがある（runGlobalViaBash と同症状）。通常のファイルハンドルになら書き込める
// ため、Cygwin/Git bash が無い環境でも回避できる。bash 経由より優先して試す。
func runGlobalToFile(globalBin, dir, word, mode string) (data []byte, attempted bool) {
	f, err := os.CreateTemp("", "grepnavi-gtags-*.txt")
	if err != nil {
		return nil, false
	}
	tmpName := f.Name()
	defer os.Remove(tmpName)

	cmd := exec.Command(globalBin, mode, word)
	cmd.Dir = dir
	cmd.Env = gtagsEnv(dir)
	cmd.Stdout = f
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	f.Close()
	if runErr != nil {
		// exit=1 は「ヒットなし」で正常、それ以外のみ記録。
		if ee, ok := runErr.(*exec.ExitError); !ok || ee.ExitCode() != 1 {
			slog.Debug("gtags-file-fallback exec", "err", runErr, "stderr", strings.TrimSpace(stderr.String()))
		}
	}
	out, rerr := os.ReadFile(tmpName)
	if rerr != nil {
		return nil, true
	}
	return out, true
}

// recoverEmptyGlobalOutput は cmd.Output() が空（Cygwin パイプ症状）だったときの再取得を
// 一手にまとめる。実ファイルリダイレクト→bash の順で試し、得られた非空の出力を返す。
// どちらでも回収できなければ nil（＝本当に結果なし）。logTag は呼び出し元の識別用。
func recoverEmptyGlobalOutput(globalBin, dir, word, mode, logTag string) []byte {
	if fileOut, attempted := runGlobalToFile(globalBin, dir, word, mode); attempted && len(bytes.TrimSpace(fileOut)) > 0 {
		_globalTransport.Store(_transportFile)
		_transportVerified.Store(true)
		persistTransport(_transportFile)
		maybePreloadDefsAsync(globalBin, dir)
		slog.Info(logTag, "msg", "file-redirect fallback succeeded", "word", word, "bytes", len(fileOut))
		return fileOut
	}
	if bashOut, attempted := runGlobalViaBash(globalBin, dir, word, mode); attempted && len(bytes.TrimSpace(bashOut)) > 0 {
		_globalTransport.Store(_transportBash)
		_transportVerified.Store(true)
		persistTransport(_transportBash)
		maybePreloadDefsAsync(globalBin, dir)
		slog.Info(logTag, "msg", "bash fallback succeeded", "word", word, "bytes", len(bashOut))
		return bashOut
	}
	return nil
}

// ===== 定義テーブルの一括プリロード =====
//
// 直接起動が使えない環境ではプロセス起動1回ごとに EDR の検査コスト（数秒）が
// 乗るため、全定義を1回のダンプ (global -xd ".*") でメモリに載せ、以降の
// 定義ジャンプをプロセス起動なしで返す。直接起動が健全な環境では起動コストが
// 数十msなので、メモリを消費してまでプリロードしない。

// _gtagsPreloadMaxBytes を超えるダンプはプリロードを断念する（メモリ保護）。
const _gtagsPreloadMaxBytes = 256 << 20

type gtagsDefsSnapshot struct {
	dir  string
	defs map[string][]DefHit
}

var (
	_gtagsDefsAll        atomic.Pointer[gtagsDefsSnapshot]
	_gtagsPreloadGen     atomic.Int64 // インデックス世代。再生成のたびに +1
	_gtagsPreloadMu      sync.Mutex
	_gtagsPreloadRunning bool
	_gtagsPreloadDir     string // インデックス更新後の再プリロード用に対象 dir を覚える
)

// GtagsPreloadedSymbols はプリロード済み定義表のシンボル数を返す（未ロードは 0）。
func GtagsPreloadedSymbols() int {
	if snap := _gtagsDefsAll.Load(); snap != nil {
		return len(snap.defs)
	}
	return 0
}

// GtagsDefsPreloaded は dir の全定義プリロードが有効かを返す。
// true のとき「定義なし」はインデックス全体に対する確定情報なので、
// 呼び出し側は rg 全域スキャン等の保険を省略してよい。
func GtagsDefsPreloaded(dir string) bool {
	snap := _gtagsDefsAll.Load()
	return snap != nil && snap.dir == dir
}

// maybePreloadDefsAsync は直接起動が使えない環境でのみ、バックグラウンドで
// 全定義をプリロードする。ロード済み・実行中なら何もしない。
func maybePreloadDefsAsync(globalBin, dir string) {
	if _globalTransport.Load() == _transportDirect {
		return
	}
	if snap := _gtagsDefsAll.Load(); snap != nil && snap.dir == dir {
		return
	}
	_gtagsPreloadMu.Lock()
	if _gtagsPreloadRunning {
		_gtagsPreloadMu.Unlock()
		return
	}
	_gtagsPreloadRunning = true
	_gtagsPreloadDir = dir
	_gtagsPreloadMu.Unlock()

	go func() {
		gen := _gtagsPreloadGen.Load()
		retry := false
		defer func() {
			_gtagsPreloadMu.Lock()
			_gtagsPreloadRunning = false
			_gtagsPreloadMu.Unlock()
			if retry {
				maybePreloadDefsAsync(globalBin, dir)
			}
		}()

		t0 := time.Now()
		out, handled := runGlobalSticky(globalBin, dir, ".*", "-xd")
		if !handled || len(bytes.TrimSpace(out)) == 0 {
			slog.Info("gtags-preload", "msg", "dump empty, preload skipped", "dir", dir)
			return
		}
		if len(out) > _gtagsPreloadMaxBytes {
			slog.Info("gtags-preload", "msg", "dump too large, preload skipped", "bytes", len(out))
			return
		}
		defs := gtagsParseAllDefs(out, dir)
		if len(defs) == 0 {
			return
		}
		// ダンプ中にインデックスが再生成されていたら古いデータなので捨てて撮り直す
		if _gtagsPreloadGen.Load() != gen {
			slog.Debug("gtags-preload", "msg", "index changed during preload, retrying")
			retry = true
			return
		}
		_gtagsDefsAll.Store(&gtagsDefsSnapshot{dir: dir, defs: defs})
		slog.Info("gtags-preload", "msg", "ready", "dir", dir, "symbols", len(defs), "bytes", len(out), "elapsed", time.Since(t0))
	}()
}

// gtagsParseAllDefs は global -xd ".*" の全定義ダンプを symbol → DefHit 群に変換する。
func gtagsParseAllDefs(out []byte, dir string) map[string][]DefHit {
	defs := make(map[string][]DefHit)
	scanner := bufio.NewScanner(bytes.NewReader(out))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
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
		defs[fields[0]] = append(defs[fields[0]], DefHit{
			File: file,
			Line: lineNum,
			Text: strings.TrimSpace(strings.Join(fields[3:], " ")),
			Kind: "func",
		})
	}
	return defs
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
			if len(logBuf) >= _gtagsLogFlushBatchSize {
				flushLog()
				// バッチごとに進捗をブラウザへ送る
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
// Windows ではパイプバッファリングにより出力が遅延するため、5 秒ごとにハートビートを送る。
func GtagsUpdateIndexStream(ctx context.Context, dir string, w io.Writer) error {
	cmd := exec.CommandContext(ctx, resolveGlobalBin(), "-u", "-v")
	// Cygwin global.exe は Windows パス (バックスラッシュ) を受け付ける。
	// ToSlash でフォワードスラッシュ化すると検索が空を返す症状が出るため使わない。
	cmd.Env = gtagsEnv(dir)

	pr, pw := io.Pipe()
	cmd.Stdout = pw
	cmd.Stderr = pw

	if err := cmd.Start(); err != nil {
		pr.Close()
		pw.Close()
		return err
	}

	// プロセス完了後にパイプを閉じる
	waitDone := make(chan error, 1)
	go func() {
		waitDone <- cmd.Wait()
		pw.Close()
	}()

	// 出力が来ない間も定期的にハートビートを送る（バッファリング対策）
	stopHB := make(chan struct{})
	received := make(chan struct{}, 1)
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				select {
				case <-received:
					// 直近に出力があった → ハートビート不要
				default:
					fmt.Fprintln(w, "... global 実行中")
				}
			case <-stopHB:
				return
			}
		}
	}()

	// 行単位でスキャンしてブラウザへ送る
	scanner := bufio.NewScanner(pr)
	for scanner.Scan() {
		// 出力を受信したことをハートビートゴルーチンに通知
		select {
		case received <- struct{}{}:
		default:
		}
		fmt.Fprintln(w, sanitizeLine(scanner.Text()))
	}
	pr.Close()
	close(stopHB)

	return <-waitDone
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
// 結果は (dir,word) でキャッシュされ、インデックス更新まで保持される。
func GtagsFindDefinitions(ctx context.Context, word, dir string) ([]DefHit, error) {
	cacheKey := gtagsCacheKey(dir, word)
	if v, ok := _gtagsDefCache.Load(cacheKey); ok {
		return v.([]DefHit), nil
	}

	// パース→分類→定義優先→キャッシュの共通後段
	finish := func(rawHits []DefHit) []DefHit {
		for i := range rawHits {
			rawHits[i].Kind = classifyLineKind(rawHits[i].Text)
		}
		hits := preferDefinitionHits(rawHits)
		slog.Debug("gtags-find", "hits", len(hits))
		for i, h := range hits {
			slog.Debug("gtags-find hit", "i", i, "file", h.File, "line", h.Line, "text", h.Text)
		}
		_gtagsDefCache.Store(cacheKey, hits)
		return hits
	}

	globalBin := resolveGlobalBin()

	// プリロード済みならプロセス起動なしで即答（見つからないことも確定できる）
	if snap := _gtagsDefsAll.Load(); snap != nil && snap.dir == dir {
		raw := snap.defs[word]
		// snapshot は全ルックアップで共有しているので複製してから書き換える
		cp := make([]DefHit, len(raw))
		copy(cp, raw)
		return finish(cp), nil
	}

	// 成功実績のある経路が記憶されていれば、失敗確定の直接起動を飛ばす
	if out, handled := runGlobalSticky(globalBin, dir, word, "-xd"); handled {
		maybePreloadDefsAsync(globalBin, dir)
		return finish(gtagsParseOutput(out, "func", dir)), nil
	}

	// global.exe は高速（数十ms）なので HTTP キャンセルに巻き込まれないよう
	// context をデタッチして最後まで実行させる。
	// キャンセルされても結果はキャッシュに入るので次回即返せる。
	cmd := exec.CommandContext(context.Background(), globalBin, "-xd", word)
	cmd.Dir = dir
	cmd.Env = gtagsEnv(dir)
	if devNull, err := os.Open(os.DevNull); err == nil {
		cmd.Stdin = devNull
		defer devNull.Close()
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	slog.Debug("gtags-find", "word", word, "bin", globalBin, "dir", dir,
		"cmd", strings.Join(cmd.Args, " "),
		"env_gtagsdbpath", "GTAGSDBPATH="+dir,
		"env_gtagsroot", "GTAGSROOT="+dir)

	// DBファイルの存在確認
	for _, name := range []string{"GTAGS", "GRTAGS", "GPATH"} {
		p := filepath.Join(dir, name)
		if fi, err := os.Stat(p); err == nil {
			slog.Debug("gtags-find db", "file", name, "size", fi.Size())
		} else {
			slog.Debug("gtags-find db", "file", name, "status", "missing")
		}
	}

	t0 := time.Now()
	out, err := cmd.Output()
	elapsed := time.Since(t0)
	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		}
	}
	slog.Debug("gtags-find result",
		"exit", exitCode,
		"elapsed", elapsed,
		"stdout", strings.TrimSpace(string(out)),
		"stderr", strings.TrimSpace(stderr.String()),
		"err", err)

	// Cygwin global.exe が native Windows pipe に書けず stdout が空のことがある。
	// exit=0 かつ stdout が空 = この症状の可能性 → bash 経由で再実行を試みる。
	if err == nil && len(bytes.TrimSpace(out)) == 0 {
		if recovered := recoverEmptyGlobalOutput(globalBin, dir, word, "-xd", "gtags-find"); recovered != nil {
			out = recovered
		}
	}

	if err != nil {
		if exitCode == 1 {
			slog.Debug("gtags-find", "msg", "exit=1 not found (normal)")
			_gtagsDefCache.Store(cacheKey, []DefHit(nil))
			return nil, nil
		}
		return nil, err
	}
	return finish(gtagsParseOutput(out, "func", dir)), nil
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


// GtagsDiagnose は gtags 環境の診断情報をログに出力する。
// word を指定すると「なぜそのシンボルが見つからないか」も追加診断する。
func GtagsDiagnose(dir, word string) {
	slog.Info("=== gtags-diag start ===", "dir", dir, "test_word", word)

	// ---- 1. DBファイルの存在・サイズ・フォーマット ----
	dbFormat := ""
	for _, name := range []string{"GTAGS", "GRTAGS", "GPATH"} {
		p := filepath.Join(dir, name)
		fi, err := os.Stat(p)
		if err != nil {
			slog.Info("gtags-diag [1] DB", "file", name, "status", "★ MISSING ★ インデックスが存在しない")
			continue
		}
		slog.Info("gtags-diag [1] DB", "file", name, "size", fi.Size(), "mtime", fi.ModTime().Format("2006-01-02 15:04:05"))

		if name == "GTAGS" {
			f, ferr := os.Open(p)
			if ferr == nil {
				hdr := make([]byte, 16)
				n, _ := f.Read(hdr)
				f.Close()
				if n > 0 {
					switch {
					case n >= 4 && hdr[0] == 0x13 && hdr[1] == 0x57:
						dbFormat = "gdbm big-endian (MSYS2/Linux gtags で生成)"
					case n >= 4 && hdr[0] == 0xce && hdr[1] == 0x9a:
						dbFormat = "gdbm little-endian (Windows native gtags で生成)"
					default:
						dbFormat = "unknown"
					}
					slog.Info("gtags-diag [1] DB format", "format", dbFormat, "header", fmt.Sprintf("% x", hdr[:n]))
				}
			}
		}
	}

	// ---- 2. global / gtags バイナリとバージョン ----
	bin := resolveGlobalBin()
	globalVer := "(取得失敗)"
	if fi, err := os.Stat(bin); err == nil {
		shim := fi.Size() < _gtagsShimSizeThreshold
		shimNote := ""
		if shim {
			shimNote = " ★ shim の可能性あり（環境変数が渡らない場合がある）"
		}
		slog.Info("gtags-diag [2] global bin", "path", bin, "size", fi.Size(), "possible_shim", shim, "note", shimNote)
	} else {
		slog.Info("gtags-diag [2] global bin", "path", bin, "stat_err", err)
	}
	if out, err := exec.Command(bin, "--version").Output(); err == nil {
		globalVer = firstLine(strings.TrimSpace(string(out)))
	}
	slog.Info("gtags-diag [2] global version", "version", globalVer)

	gtagsBin := resolveGtagsBin()
	gtagsVer := "(取得失敗)"
	if fi, err := os.Stat(gtagsBin); err == nil {
		slog.Info("gtags-diag [2] gtags bin", "path", gtagsBin, "size", fi.Size(), "possible_shim", fi.Size() < _gtagsShimSizeThreshold)
	}
	if out, err := exec.Command(gtagsBin, "--version").Output(); err == nil {
		gtagsVer = firstLine(strings.TrimSpace(string(out)))
	}
	slog.Info("gtags-diag [2] gtags version", "version", gtagsVer)
	if globalVer != gtagsVer && globalVer != "(取得失敗)" && gtagsVer != "(取得失敗)" {
		slog.Info("gtags-diag [2] version-mismatch", "conclusion",
			"★ global と gtags のバージョンが異なる → DB フォーマット不一致の可能性あり",
			"global", globalVer, "gtags", gtagsVer)
	} else {
		slog.Info("gtags-diag [2] version-match", "global", globalVer, "gtags", gtagsVer)
	}

	// ---- 3. 環境変数 ----
	for _, key := range []string{"GTAGSCONF", "GTAGSDBPATH", "GTAGSROOT", "GTAGSLABEL", "SCOOP", "USERPROFILE"} {
		v := os.Getenv(key)
		note := ""
		if key == "GTAGSDBPATH" && v != "" && v != dir {
			note = " ★ アプリが設定する値と異なる"
		}
		slog.Info("gtags-diag [3] env", "key", key, "value", v, "note", note)
	}

	// ---- 4. DB読み取りテスト（共通シンボルで疎通確認）----
	env := gtagsEnv(dir)
	cmdLine := fmt.Sprintf("%s -xd <word>  (GTAGSDBPATH=%s  GTAGSROOT=%s)", bin, dir, dir)
	slog.Info("gtags-diag [4] command-line", "cmd", cmdLine, "note", "以下のコマンドをターミナルで実行して同じ結果か確認してください")

	dbReadable := false
	for _, testWord := range []string{"main", "open", "close", "init"} {
		exit, stdout, stderr := runGlobalCmd(bin, env, "-xd", testWord)
		if exit == 0 && stdout != "" {
			slog.Info("gtags-diag [4] DB疎通", "status", "✓ OK", "word", testWord, "example", firstLine(stdout))
			dbReadable = true
			break
		} else if exit == 1 {
			slog.Info("gtags-diag [4] DB疎通", "word", testWord, "exit", 1, "note", "ヒットなし（続けてテスト）")
		} else {
			slog.Info("gtags-diag [4] DB疎通", "status", "★ ERROR ★", "word", testWord,
				"exit", exit, "stderr", stderr, "guess", diagGuess(stderr))
		}
	}
	if !dbReadable {
		slog.Info("gtags-diag [4] DB疎通", "conclusion",
			"★ main/open/close/init すべてヒットなし → DBが空・破損・フォーマット不一致のいずれか。GTAGSを再生成してください")
	}

	// ---- 5. インデックス済みファイル数 ----
	exit, stdout, _ := runGlobalCmd(bin, env, "-P", "")
	if exit == 0 {
		lines := strings.Split(strings.TrimSpace(stdout), "\n")
		count := len(lines)
		if stdout == "" {
			count = 0
		}
		sample := ""
		if count > 0 {
			sample = lines[0]
		}
		note := ""
		if count == 0 {
			note = "★ ファイルが1件もない → gtags が正常に完了していない可能性"
		}
		slog.Info("gtags-diag [5] indexed-files", "count", count, "sample", sample, "note", note)
	} else {
		slog.Info("gtags-diag [5] indexed-files", "status", "取得失敗", "exit", exit)
	}

	// ---- 6. 指定シンボルの詳細テスト ----
	if word != "" {
		slog.Info("gtags-diag [6] symbol-test", "word", word)

		// 6a. 定義検索
		exit, stdout, stderr := runGlobalCmd(bin, env, "-xd", word)
		if exit == 0 && stdout != "" {
			slog.Info("gtags-diag [6a] -xd (定義)", "status", "✓ ヒットあり", "result", firstLine(stdout))
		} else if exit == 1 {
			slog.Info("gtags-diag [6a] -xd (定義)", "status",
				"✗ インデックスに定義なし → このシンボルはGTAGSに登録されていない")
		} else {
			slog.Info("gtags-diag [6a] -xd (定義)", "status", "★ ERROR", "exit", exit, "stderr", stderr)
		}

		// 6b. 参照検索（定義がなくても参照はあるか）
		exit, stdout, _ = runGlobalCmd(bin, env, "-xr", word)
		if exit == 0 && stdout != "" {
			slog.Info("gtags-diag [6b] -xr (参照)", "status", "参照はある（定義だけ未登録）", "count", strings.Count(stdout, "\n")+1)
		} else {
			slog.Info("gtags-diag [6b] -xr (参照)", "status", "参照もなし")
		}

		// 6c. 前方一致補完（シンボル名のスペルが正しいか確認）
		exit, stdout, _ = runGlobalCmd(bin, env, "-c", word)
		if exit == 0 && stdout != "" {
			slog.Info("gtags-diag [6c] -c (補完)", "status", "類似シンボルあり", "matches", firstLine(stdout))
		} else {
			slog.Info("gtags-diag [6c] -c (補完)", "status",
				"完全一致も前方一致もなし → このシンボル名はインデックスに存在しない")
		}

		// 6d. 環境変数なし（cwd だけ）で同じ検索（env 渡しが効いているか確認）
		exitNoEnv, stdoutNoEnv, _ := runGlobalCmdDir(bin, nil, dir, "-xd", word)
		if exitNoEnv == 0 && stdoutNoEnv != "" {
			slog.Info("gtags-diag [6d] env無し実行", "status",
				"★ env なしでは見つかる → GTAGSDBPATH の渡し方に問題がある可能性")
		} else {
			slog.Info("gtags-diag [6d] env無し実行", "status", "env なしでも見つからない（env の問題ではない）")
		}
	}

	slog.Info("=== gtags-diag done ===")
}

// runGlobalCmd は global コマンドを env 付きで実行し (exitCode, stdout, stderr) を返す。
func runGlobalCmd(bin string, env []string, flag, arg string) (int, string, string) {
	args := []string{flag}
	if arg != "" {
		args = append(args, arg)
	}
	cmd := exec.Command(bin, args...)
	cmd.Env = env
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	err := cmd.Run()
	exit := 0
	if err != nil {
		if ex, ok := err.(*exec.ExitError); ok {
			exit = ex.ExitCode()
		} else {
			exit = -1
		}
	}
	return exit, strings.TrimSpace(outBuf.String()), strings.TrimSpace(errBuf.String())
}

// runGlobalCmdDir は global コマンドを指定ディレクトリ・env で実行する。env が nil のときは継承しない（空）。
func runGlobalCmdDir(bin string, env []string, dir, flag, arg string) (int, string, string) {
	args := []string{flag}
	if arg != "" {
		args = append(args, arg)
	}
	cmd := exec.Command(bin, args...)
	cmd.Dir = dir
	if env != nil {
		cmd.Env = env
	}
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	err := cmd.Run()
	exit := 0
	if err != nil {
		if ex, ok := err.(*exec.ExitError); ok {
			exit = ex.ExitCode()
		} else {
			exit = -1
		}
	}
	return exit, strings.TrimSpace(outBuf.String()), strings.TrimSpace(errBuf.String())
}

func firstLine(s string) string {
	if i := strings.Index(s, "\n"); i >= 0 {
		return s[:i]
	}
	return s
}

func diagGuess(stderr string) string {
	s := strings.ToLower(stderr)
	switch {
	case strings.Contains(s, "no such file"):
		return "DB ファイルが見つからない → GTAGSDBPATH が正しくセットされていない"
	case strings.Contains(s, "invalid argument") || strings.Contains(s, "format"):
		return "DB フォーマット不一致 → MSYS2 の gtags で生成したDBを Windows ネイティブの global で読もうとしている (再生成が必要)"
	case strings.Contains(s, "permission"):
		return "DBファイルへのアクセス権限がない"
	case strings.Contains(s, "gtagsconf") || strings.Contains(s, "config"):
		return "GTAGSCONF の設定に問題がある"
	default:
		return "原因不明 → stderr の内容を確認してください"
	}
}

// GtagsFindHoverHits は GNU Global で定義位置を特定し、
// ファイル行から kind を再分類した DefHit スライスを返す（ホバー用）。
func GtagsFindHoverHits(ctx context.Context, word, dir string) ([]DefHit, error) {
	hits, err := GtagsFindDefinitions(ctx, word, dir)
	if err != nil || len(hits) == 0 {
		return hits, err
	}
	// GtagsFindDefinitions の戻り値はキャッシュと共有されているため、
	// ここで複製してから書き換える（kind/text の上書きが汚染しないように）。
	out := make([]DefHit, len(hits))
	copy(out, hits)
	for i, h := range out {
		lines, lerr := CachedLines(h.File)
		if lerr != nil || h.Line <= 0 || h.Line > len(lines) {
			continue
		}
		out[i].Kind = classifyLineKind(lines[h.Line-1])
		out[i].Text = strings.TrimSpace(lines[h.Line-1])
	}
	return out, nil
}

// GtagsFindRefs は GNU Global で word の参照箇所を検索する（callers 用）。
// 各参照行を囲む関数名・定義行を findContainingFunc で解決して返す。
// 結果は (dir,word) でキャッシュされ、インデックス更新まで保持される。
func GtagsFindRefs(ctx context.Context, word, dir string) ([]CallSite, error) {
	cacheKey := gtagsCacheKey(dir, word)
	if v, ok := _gtagsRefsCache.Load(cacheKey); ok {
		return v.([]CallSite), nil
	}
	globalBin := resolveGlobalBin()
	var out []byte
	// 成功実績のある経路が記憶されていれば、失敗確定の直接起動を飛ばす
	if stickyOut, handled := runGlobalSticky(globalBin, dir, word, "-xr"); handled {
		maybePreloadDefsAsync(globalBin, dir)
		out = stickyOut
	} else {
		cmd := exec.CommandContext(context.Background(), globalBin, "-xr", word)
		cmd.Dir = dir
		cmd.Env = gtagsEnv(dir)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		var err error
		out, err = cmd.Output()
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
				slog.Debug("gtags-find-refs no results", "word", word)
				_gtagsRefsCache.Store(cacheKey, []CallSite(nil))
				return nil, nil
			}
			slog.Warn("gtags-find-refs error", "word", word, "err", err, "stderr", stderr.String())
			return nil, err
		}
		// Cygwin global.exe が native pipe に書けず stdout が空のことがある（GtagsFindDefinitions と同症状）。
		if len(bytes.TrimSpace(out)) == 0 {
			if recovered := recoverEmptyGlobalOutput(globalBin, dir, word, "-xr", "gtags-find-refs"); recovered != nil {
				out = recovered
			}
		}
	}
	hits := gtagsParseOutput(out, "ref", dir)
	slog.Debug("gtags-find-refs raw hits", "word", word, "count", len(hits))
	var results []CallSite
	seen := map[string]bool{}
	skippedNoFunc, skippedSelf, skippedDup := 0, 0, 0
	for _, h := range hits {
		lines, lerr := CachedLines(h.File)
		if lerr != nil {
			slog.Debug("gtags-find-refs CachedLines error", "file", h.File, "err", lerr)
			continue
		}
		funcName, defLine := findContainingFunc(lines, h.Line)
		if funcName == "" {
			skippedNoFunc++
			continue
		}
		if funcName == word {
			skippedSelf++
			continue
		}
		key := h.File + ":" + strconv.Itoa(defLine)
		if seen[key] {
			skippedDup++
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
	slog.Debug("gtags-find-refs result", "word", word, "results", len(results),
		"skipped_no_func", skippedNoFunc, "skipped_self", skippedSelf, "skipped_dup", skippedDup)
	_gtagsRefsCache.Store(cacheKey, results)
	return results, nil
}
