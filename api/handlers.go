package api

import (
	"encoding/json"
	"net/http"
	"runtime"
	"sync"

	"grepnavi/graph"
	"grepnavi/search"
)

// Handler はすべての REST ハンドラをまとめる。
type Handler struct {
	store *graph.Store
	root  string
	mu    sync.RWMutex
}

func NewHandler(store *graph.Store, root string) *Handler {
	h := &Handler{store: store, root: root}
	if search.GtagsAvailable(root) {
		search.GtagsCheckStaleAsync(root)
	}
	if search.CtagsIndexed(root) {
		search.CtagsMacroWarmup(root)
	}
	return h
}

func (h *Handler) Register(mux *http.ServeMux) {
	// static
	mux.HandleFunc("/", h.serveStatic)

	// search
	mux.HandleFunc("/api/search", h.handleSearch)
	mux.HandleFunc("/api/search/stream", h.handleSearchStream) // SSE

	// graph
	mux.HandleFunc("/api/graph", h.handleGraph)
	mux.HandleFunc("/api/graph/node", h.handleNode)
	mux.HandleFunc("/api/graph/node/", h.handleNodeByID)
	mux.HandleFunc("/api/graph/edge", h.handleEdge)
	mux.HandleFunc("/api/graph/edge/delete", h.handleEdgeDelete)
	mux.HandleFunc("/api/graph/expand", h.handleExpand)
	mux.HandleFunc("/api/graph/reparent", h.handleReparent)
	mux.HandleFunc("/api/graph/undo", h.handleUndo)
	mux.HandleFunc("/api/graph/rootorder", h.handleRootOrder)
	mux.HandleFunc("/api/graph/saveas", h.handleGraphSaveAs)
	mux.HandleFunc("/api/graph/openfile", h.handleGraphOpenFile)
	mux.HandleFunc("/api/graph/export", h.handleGraphExport)
	mux.HandleFunc("/api/graph/import", h.handleGraphImport)
	mux.HandleFunc("/api/trees", h.handleTrees)
	mux.HandleFunc("/api/trees/", h.handleTreeByID)
	mux.HandleFunc("/api/open", h.handleOpen)
	mux.HandleFunc("/api/reveal", h.handleReveal)
	mux.HandleFunc("/api/snippet", h.handleSnippet)
	mux.HandleFunc("/api/file", h.handleFile)
	mux.HandleFunc("/api/symbols", h.handleSymbols)
	mux.HandleFunc("/api/ifdef", h.handleIfdef)
	mux.HandleFunc("/api/definition", h.handleDefinition)
	mux.HandleFunc("/api/hover", h.handleHover)
	mux.HandleFunc("/api/new-window", h.handleNewWindow)
	mux.HandleFunc("/api/browse", h.handleBrowse)
	mux.HandleFunc("/api/dirs", h.handleDirs)
	mux.HandleFunc("/api/pick-dir", h.handlePickDir)
	mux.HandleFunc("/api/root", h.handleRoot)
	mux.HandleFunc("/api/files", h.handleFiles)
	// call tree
	mux.HandleFunc("/api/callers", h.handleCallers)
	mux.HandleFunc("/api/callees", h.handleCallees)
	// [GNU Global] 以下の4行を削除し、definition/hover/callersの分岐を除去で取り外し可能
	mux.HandleFunc("/api/gtags/status", h.handleGtagsStatus)
	mux.HandleFunc("/api/gtags/index", h.handleGtagsIndex)
	mux.HandleFunc("/api/gtags/update", h.handleGtagsUpdate)
	mux.HandleFunc("/api/gtags/rebuild", h.handleGtagsRebuild)
	mux.HandleFunc("/api/gtags/stream", h.handleGtagsStream)
	mux.HandleFunc("/api/ctags/status", h.handleCtagsStatus)
	mux.HandleFunc("/api/ctags/index", h.handleCtagsIndex)
	mux.HandleFunc("/api/ctags/file-symbols", h.handleCtagsFileSymbols)
	mux.HandleFunc("/api/ctags/macros", h.handleCtagsMacros)
	// [C言語アドオン] 以下の3行を削除するとインクルードグラフAPIが無効になります
	mux.HandleFunc("/api/include-graph", h.handleIncludeGraph)
	mux.HandleFunc("/api/include-file", h.handleIncludeFile)
	mux.HandleFunc("/api/include-by", h.handleIncludeBy)
	mux.HandleFunc("/api/memstats", h.handleMemStats)
}

func (h *Handler) handleMemStats(w http.ResponseWriter, r *http.Request) {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	jsonOK(w, map[string]uint64{
		"HeapAlloc":   ms.HeapAlloc,
		"HeapInuse":   ms.HeapInuse,
		"HeapSys":     ms.HeapSys,
		"HeapIdle":    ms.HeapIdle,
		"HeapReleased": ms.HeapReleased,
		"Sys":         ms.Sys,
		"NumGC":       uint64(ms.NumGC),
	})
}

func (h *Handler) serveStatic(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/" || r.URL.Path == "/index.html" {
		http.ServeFile(w, r, "static/index.html")
		return
	}
	http.ServeFile(w, r, "static"+r.URL.Path)
}

func jsonOK(w http.ResponseWriter, v interface{}) {
	data, err := json.Marshal(v)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(data)
}

func jsonErr(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
