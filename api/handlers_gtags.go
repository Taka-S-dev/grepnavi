package api

import (
	"net/http"

	"grepnavi/search"
)

// --- /api/gtags/* ---
// [GNU Global] このファイルごと削除し、handlers.go の Register から4行除去で取り外し可能。

func (h *Handler) handleGtagsStatus(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()
	jsonOK(w, map[string]interface{}{
		"installed": search.GtagsInPath(),
		"indexed":   search.GtagsIndexed(root),
		"stale":     search.GtagsIsStale(),
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
