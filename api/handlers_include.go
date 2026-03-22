package api

import (
	"net/http"
	"path/filepath"

	"grepnavi/search"
)

// --- /api/include-by ---

func (h *Handler) handleIncludeBy(w http.ResponseWriter, r *http.Request) {
	file := r.URL.Query().Get("file")
	if file == "" {
		jsonErr(w, "file required", http.StatusBadRequest)
		return
	}
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()

	if !filepath.IsAbs(file) {
		file = filepath.Join(root, file)
	}

	nodes, err := search.GetIncludedBy(file, root, "")
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if nodes == nil {
		nodes = []search.IncludeNode{}
	}
	jsonOK(w, nodes)
}

// --- /api/include-file ---

func (h *Handler) handleIncludeFile(w http.ResponseWriter, r *http.Request) {
	file := r.URL.Query().Get("file")
	if file == "" {
		jsonErr(w, "file required", http.StatusBadRequest)
		return
	}
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()

	if !filepath.IsAbs(file) {
		file = filepath.Join(root, file)
	}

	nodes, err := search.GetFileIncludes(file, root)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if nodes == nil {
		nodes = []search.IncludeNode{}
	}
	jsonOK(w, nodes)
}

// --- /api/include-graph ---

func (h *Handler) handleIncludeGraph(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()

	dir := r.URL.Query().Get("dir")
	if dir == "" {
		dir = root
	} else if !filepath.IsAbs(dir) {
		dir = filepath.Join(root, dir)
	}
	glob := r.URL.Query().Get("glob")

	g, err := search.BuildIncludeGraph(r.Context(), dir, glob)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if g == nil {
		jsonOK(w, map[string]interface{}{"nodes": []struct{}{}, "edges": []struct{}{}})
		return
	}
	jsonOK(w, g)
}
