package api

import (
	"encoding/json"
	"net/http"
	"strings"
)

// --- /api/trees ---

// POST /api/trees          → ツリー新規作成 {"name":"..."}
// GET  /api/trees          → ツリー一覧（GraphResponse と同様）
func (h *Handler) handleTrees(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		jsonOK(w, h.store.GetGraphResponse())
	case http.MethodPost:
		var req struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			jsonErr(w, err.Error(), http.StatusBadRequest)
			return
		}
		if req.Name == "" {
			req.Name = "新しいツリー"
		}
		resp, err := h.store.CreateTree(req.Name)
		if err != nil {
			jsonErr(w, err.Error(), http.StatusInternalServerError)
			return
		}
		jsonOK(w, resp)
	default:
		http.Error(w, "GET or POST only", http.StatusMethodNotAllowed)
	}
}

// --- /api/trees/:id ---

// POST   /api/trees/:id/switch  → アクティブツリー切り替え
// PUT    /api/trees/:id         → リネーム {"name":"..."}
// DELETE /api/trees/:id         → 削除
func (h *Handler) handleTreeByID(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/trees/")
	parts := strings.SplitN(path, "/", 2)
	id := parts[0]
	action := ""
	if len(parts) == 2 {
		action = parts[1]
	}
	if id == "" {
		http.NotFound(w, r)
		return
	}

	switch {
	case r.Method == http.MethodPost && action == "switch":
		resp, err := h.store.SwitchTree(id)
		if err != nil {
			jsonErr(w, err.Error(), http.StatusBadRequest)
			return
		}
		jsonOK(w, resp)

	case r.Method == http.MethodPut && action == "":
		var req struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			jsonErr(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := h.store.RenameTree(id, req.Name); err != nil {
			jsonErr(w, err.Error(), http.StatusBadRequest)
			return
		}
		jsonOK(w, h.store.GetGraphResponse())

	case r.Method == http.MethodDelete && action == "":
		resp, err := h.store.DeleteTree(id)
		if err != nil {
			jsonErr(w, err.Error(), http.StatusBadRequest)
			return
		}
		jsonOK(w, resp)

	default:
		http.NotFound(w, r)
	}
}
