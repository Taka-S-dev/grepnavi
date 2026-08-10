package api

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"grepnavi/proc"
	"grepnavi/search"
)

// findCtagsBin は Universal Ctags を優先して ctags バイナリのパスを返す。
// Universal Ctags が見つからない場合は PATH 上の ctags を返す。
// 第2戻り値は選ばれたのが Universal Ctags かどうか（対応オプションが違う）。
func findCtagsBin() (string, bool, bool) {
	// 候補パスを順に試す（Universal Ctags を優先）
	candidates := []string{}

	// Scoop のシムパス
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates,
			filepath.Join(home, "scoop", "shims", "ctags.exe"),
			filepath.Join(home, "scoop", "shims", "ctags"),
		)
	}

	// PATH 上の全 ctags を探す
	if p, err := exec.LookPath("ctags"); err == nil {
		candidates = append(candidates, p)
	}

	// 各候補で Universal Ctags かチェック
	for _, p := range candidates {
		if _, err := os.Stat(p); err != nil {
			continue
		}
		out, err := proc.Command(p, "--version").Output()
		if err != nil {
			continue
		}
		if strings.Contains(string(out), "Universal Ctags") {
			return p, true, true
		}
	}

	// Universal Ctags が見つからなければ PATH 上の ctags を使う
	if p, err := exec.LookPath("ctags"); err == nil {
		return p, false, true
	}
	return "", false, false
}

// handleCtagsMacros はファイルに出現するマクロ名をctagsキャッシュとの積集合で返す。
func (h *Handler) handleCtagsMacros(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()
	empty := map[string]interface{}{"macros": []string{}, "ready": false, "loading": false}
	if !search.CtagsIndexed(root) {
		jsonOK(w, map[string]interface{}{"macros": []string{}, "ready": true, "loading": false})
		return
	}
	slog.Debug("ctags-macros request", "root", root)
	state := search.CtagsMacroNames(root)
	slog.Debug("ctags-macros state", "ready", state.Ready, "loading", state.Loading)
	if state.Loading {
		jsonOK(w, map[string]interface{}{"macros": []string{}, "ready": false, "loading": true})
		return
	}
	if !state.Ready {
		// アイドルトリム後・別 root への切替直後: サイドカーからの再構築を発火し、
		// loading として返す（UI 側は既存のポーリングで完了を拾う）
		search.CtagsMacroWarmup(root)
		jsonOK(w, map[string]interface{}{"macros": []string{}, "ready": false, "loading": true})
		return
	}

	file := r.URL.Query().Get("file")
	if file == "" {
		jsonOK(w, empty)
		return
	}
	if !strings.HasPrefix(filepath.Clean(file), filepath.Clean(root)) {
		jsonOK(w, empty)
		return
	}

	// ファイルに出現するシンボルをkind別に返す
	slog.Debug("ctags-macros file", "file", file)
	syms := search.SymbolsInFile(file, state.Symbols)
	slog.Debug("ctags-macros result", "macros", len(syms.Macros))
	jsonOK(w, map[string]interface{}{"macros": syms.Macros, "ready": true, "loading": false})
}

// handleCtagsFileSymbols は指定ファイルの ctags シンボル一覧を返す。
func (h *Handler) handleCtagsFileSymbols(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()

	file := r.URL.Query().Get("file")
	if file == "" {
		http.Error(w, "file required", http.StatusBadRequest)
		return
	}
	if !search.CtagsIndexed(root) {
		jsonOK(w, []search.DefHit{})
		return
	}
	hits, err := search.CtagsSymbolsForFile(file, root)
	if err != nil {
		jsonOK(w, []search.DefHit{})
		return
	}
	jsonOK(w, hits)
}

func (h *Handler) handleCtagsStatus(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()
	_, _, installed := findCtagsBin()
	indexed := search.CtagsIndexed(root)
	jsonOK(w, map[string]interface{}{
		"installed": installed,
		"indexed":   indexed,
	})
}

func (h *Handler) handleCtagsIndex(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	sendLine := func(line string) {
		fmt.Fprintf(w, "data: %s\n\n", line)
		flusher.Flush()
	}
	sendEvent := func(event, data string) {
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
		flusher.Flush()
	}

	slog.Info("ctags-index start", "root", root)
	sendLine("--- ctags インデックス生成開始: " + root + " ---")

	ctagsBin, isUniversal, ok := findCtagsBin()
	if !ok {
		sendEvent("ctags-error", "ctags が見つかりません")
		return
	}
	sendLine("使用バイナリ: " + ctagsBin)
	sendLine("対象言語: C / C++")

	var stderrBuf bytes.Buffer
	tagsPath := filepath.Join(root, "tags")
	// root をカレントにして "." を渡し、相対パスで記録させる（tags の場所基準で
	// 解決するのが各エディタ共通の規約で、ツリーを移動しても壊れない）。
	// Universal Ctags の既定 (u-ctags) は Windows でもパス区切りが / になり、
	// エディタによってはタグジャンプを解決できないため、Vim の :h tags-file-format
	// が定義する e-ctags 形式を明示する。Exuberant はこのオプションを知らないが、
	// 既定の出力が元々 e-ctags 形式なので付けない。
	//
	// 索引を C/C++ に絞る。この索引を読むのは定義ジャンプ・シンボル検索・
	// マクロと enum のハイライトで、どれも C/C++ の話しかしない。既定の
	// 全言語のままだと、ツリーに紛れた生成物（doc の minified JS 等）まで
	// 拾って openssl で 490MB / 34 秒かかり、C/C++ だけなら 10MB / 2.9 秒で済む。
	// 大きさだけの問題でもなく、空白始まりのタグ名が "!_TAG_FILE_SORTED"
	// ヘッダを押し下げてソート済み判定を壊し、1 回の検索が 0.5ms から 220ms に
	// 落ちる原因にもなっていた。
	args := []string{"-R", "--fields=+n", "--languages=C,C++"}
	if isUniversal {
		args = append(args, "--output-format=e-ctags")
	}
	args = append(args, "-f", tagsPath, ".")
	cmd := proc.CommandContext(context.Background(), ctagsBin, args...)
	cmd.Dir = root
	cmd.Stderr = &stderrBuf

	if err := cmd.Start(); err != nil {
		sendEvent("ctags-error", err.Error())
		return
	}

	// ctags は進捗出力がないので1秒ごとにハートビートを送る
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
loop:
	for {
		select {
		case err := <-done:
			if err != nil {
				msg := err.Error()
				if s := stderrBuf.String(); s != "" {
					msg += "\nstderr: " + s
				}
				// exit code 1 は警告扱い（tags ファイルは生成されている場合）
				if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
					sendLine("警告(exit=1): " + msg)
					break loop
				}
				sendEvent("ctags-error", msg)
				return
			}
			break loop
		case <-ticker.C:
			sendLine("... 生成中")
		}
	}

	search.CtagsMacroWarmup(root)
	defCacheClear()
	// index 更新で関数行が動き得るので auto-resolved な Def を一括破棄する。
	if err := h.store.ClearAllDefs(); err == nil {
		h.events.Publish("defs.invalidated", map[string]interface{}{"engine": "ctags"})
	}
	sendLine("--- 完了 ---")
	sendEvent("ctags-done", "ok")
}
