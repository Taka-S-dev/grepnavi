package api

import (
	"fmt"
	"net/http"

	"grepnavi/search"
)

// --- /api/gtags/* ---
// [GNU Global] このファイルごと削除し、handlers.go の Register から4行除去で取り外し可能。

func (h *Handler) handleGtagsStatus(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()
	installed := search.GtagsInPath()
	indexed := search.GtagsIndexed(root)

	jsonOK(w, map[string]interface{}{
		"installed":  installed,
		"indexed":    indexed,
		"stale":      search.GtagsIsStale(),
		"bin_source": search.GlobalBinSource(),
	})
}

func (h *Handler) handleGtagsIndex(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()
	if err := search.GtagsBuildIndex(r.Context(), root); err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	search.GtagsResetStale()
	jsonOK(w, map[string]bool{"ok": true})
}

func (h *Handler) handleGtagsUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()
	if err := search.GtagsUpdateIndex(r.Context(), root); err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	search.GtagsResetStale()
	jsonOK(w, map[string]bool{"ok": true})
}

func (h *Handler) handleGtagsRebuild(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()
	if err := search.GtagsRebuildIndex(r.Context(), root); err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	search.GtagsResetStale()
	jsonOK(w, map[string]bool{"ok": true})
}

// handleGtagsStream は gtags コマンドの出力を SSE でストリーミングする。
func (h *Handler) handleGtagsStream(w http.ResponseWriter, r *http.Request) {
	op := r.URL.Query().Get("op") // index | update | rebuild
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

	labels := map[string]string{"update": "差分更新", "rebuild": "再生成", "index": "生成"}
	label := labels[op]
	if label == "" {
		label = "生成"
	}
	sendLine("--- " + label + " 開始: " + root + " ---")

	var err error
	switch op {
	case "update":
		err = search.GtagsUpdateIndexStream(r.Context(), root, lineWriter(sendLine))
	case "rebuild":
		err = search.GtagsRebuildIndexStream(r.Context(), root, lineWriter(sendLine))
	default: // index
		err = search.GtagsBuildIndexStream(r.Context(), root, lineWriter(sendLine))
	}

	if err != nil {
		sendEvent("gtags-error", err.Error())
		return
	}
	search.GtagsResetStale()
	sendEvent("gtags-done", "ok")
}

// lineWriter は io.Writer を1行ずつ sendLine に渡すアダプタ。
type lineWriter func(string)

func (lw lineWriter) Write(p []byte) (int, error) {
	lw(string(p))
	return len(p), nil
}
