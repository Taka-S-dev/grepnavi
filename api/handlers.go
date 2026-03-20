package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"unicode/utf8"

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
	return &Handler{store: store, root: root}
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
	mux.HandleFunc("/api/snippet", h.handleSnippet)
	mux.HandleFunc("/api/file", h.handleFile)
	mux.HandleFunc("/api/symbols", h.handleSymbols)
	mux.HandleFunc("/api/ifdef", h.handleIfdef)
	mux.HandleFunc("/api/definition", h.handleDefinition)
	mux.HandleFunc("/api/hover", h.handleHover)
	mux.HandleFunc("/api/dirs", h.handleDirs)
	mux.HandleFunc("/api/root", h.handleRoot)
	mux.HandleFunc("/api/files", h.handleFiles)
	// [C言語アドオン] 以下の3行を削除するとインクルードグラフAPIが無効になります
	mux.HandleFunc("/api/include-graph", h.handleIncludeGraph)
	mux.HandleFunc("/api/include-file", h.handleIncludeFile)
	mux.HandleFunc("/api/include-by", h.handleIncludeBy)
}

// --- /api/file ---

func (h *Handler) handleFile(w http.ResponseWriter, r *http.Request) {
	file := r.URL.Query().Get("file")
	if file == "" {
		http.Error(w, "file required", http.StatusBadRequest)
		return
	}
	lines, err := search.CachedLines(file)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	var sb strings.Builder
	for i, l := range lines {
		if i > 0 {
			sb.WriteByte('\n')
		}
		sb.WriteString(sanitizeUTF8(l))
	}
	w.Write([]byte(sb.String()))
}

// --- /api/symbols ---

func (h *Handler) handleSymbols(w http.ResponseWriter, r *http.Request) {
	file := r.URL.Query().Get("file")
	if file == "" {
		jsonErr(w, "file required", http.StatusBadRequest)
		return
	}
	symbols, err := search.ExtractSymbols(file)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if symbols == nil {
		symbols = []search.Symbol{}
	}
	jsonOK(w, symbols)
}

// --- /api/definition ---

func (h *Handler) handleDefinition(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	word := q.Get("word")
	if word == "" {
		jsonErr(w, "word required", http.StatusBadRequest)
		return
	}
	h.mu.RLock()
	hroot := h.root
	h.mu.RUnlock()
	dir := q.Get("dir")
	if dir == "" {
		dir = hroot
	} else if !filepath.IsAbs(dir) {
		dir = filepath.Join(hroot, dir)
	}
	glob := q.Get("glob")
	hits, err := search.FindDefinitions(r.Context(), word, dir, glob)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if hits == nil {
		hits = []search.DefHit{}
	}
	jsonOK(w, hits)
}

// --- /api/hover ---

func (h *Handler) handleHover(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	word := q.Get("word")
	if word == "" {
		jsonErr(w, "word required", http.StatusBadRequest)
		return
	}
	h.mu.RLock()
	hroot := h.root
	h.mu.RUnlock()
	dir := q.Get("dir")
	if dir == "" {
		dir = hroot
	} else if !filepath.IsAbs(dir) {
		dir = filepath.Join(hroot, dir)
	}
	// ホバーは定義検索なので glob フィルターを無視して全ファイルを対象にする
	hits, err := search.FindHover(r.Context(), word, dir, "")
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if hits == nil {
		hits = []search.HoverHit{}
	}
	jsonOK(w, hits)
}

// --- /api/ifdef ---

func (h *Handler) handleIfdef(w http.ResponseWriter, r *http.Request) {
	file := r.URL.Query().Get("file")
	defStr := r.URL.Query().Get("defines")
	if file == "" {
		jsonErr(w, "file required", http.StatusBadRequest)
		return
	}
	defines := search.ParseDefines(defStr)
	lines, err := search.ComputeInactiveLines(file, defines)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if lines == nil {
		lines = []int{}
	}
	jsonOK(w, lines)
}

// --- static ---

func (h *Handler) serveStatic(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/" || r.URL.Path == "/index.html" {
		http.ServeFile(w, r, "static/index.html")
		return
	}
	// static/*.js など
	http.ServeFile(w, r, "static"+r.URL.Path)
}

// --- /api/search/stream (SSE) ---

func (h *Handler) handleSearchStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	q := r.URL.Query()
	pattern := q.Get("q")
	if pattern == "" {
		http.Error(w, "q is required", http.StatusBadRequest)
		return
	}
	h.mu.RLock()
	hroot := h.root
	h.mu.RUnlock()
	dir := q.Get("dir")
	if dir == "" {
		dir = hroot
	} else if !filepath.IsAbs(dir) {
		dir = filepath.Join(hroot, dir)
	}

	opts := search.Options{
		Pattern:       pattern,
		Dir:           dir,
		CaseSensitive: q.Get("case") == "1",
		WordRegexp:    q.Get("word") == "1",
		Regex:         q.Get("regex") == "1",
		FileGlob:      q.Get("glob"),
		ContextLines:  3,
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	ctx := r.Context()
	count := 0
	const streamLimit = 1000

	err := search.SearchStream(ctx, opts, func(m graph.Match) error {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		if count >= streamLimit {
			return fmt.Errorf("limit")
		}

		m.IfdefStack = []graph.IfdefFrame{}

		data, err := json.Marshal(m)
		if err != nil {
			return nil
		}
		count++
		fmt.Fprintf(w, "data: %s\n\n", data)
		flusher.Flush()
		return nil
	})

	if err != nil && err != ctx.Err() {
		fmt.Fprintf(w, "event: error\ndata: %s\n\n", err.Error())
	}
	// 完了イベント
	fmt.Fprintf(w, "event: done\ndata: {\"count\":%d}\n\n", count)
	flusher.Flush()
}

// --- /api/search ---

func (h *Handler) handleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	q := r.URL.Query()
	pattern := q.Get("q")
	if pattern == "" {
		jsonErr(w, "q is required", http.StatusBadRequest)
		return
	}
	h.mu.RLock()
	hroot := h.root
	h.mu.RUnlock()
	dir := q.Get("dir")
	if dir == "" {
		dir = hroot
	} else if !filepath.IsAbs(dir) {
		dir = filepath.Join(hroot, dir)
	}

	limit := 0
	if ls := q.Get("limit"); ls != "" {
		fmt.Sscanf(ls, "%d", &limit)
	}
	opts := search.Options{
		Pattern:       pattern,
		Dir:           dir,
		CaseSensitive: q.Get("case") == "1",
		WordRegexp:    q.Get("word") == "1",
		Regex:         q.Get("regex") == "1",
		FileGlob:      q.Get("glob"),
		ContextLines:  3,
		MaxResults:    limit,
	}

	matches, err := search.Search(r.Context(), opts)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// #ifdef スタックを付加（C/C++ ファイルのみ）
	for i := range matches {
		m := &matches[i]
		if isCLike(m.File) {
			stack, _ := search.ExtractIfdefStack(m.File, m.Line)
			if stack != nil {
				m.IfdefStack = stack
			} else {
				m.IfdefStack = []graph.IfdefFrame{}
			}
		} else {
			m.IfdefStack = []graph.IfdefFrame{}
		}
	}

	jsonOK(w, map[string]interface{}{
		"matches": matches,
		"count":   len(matches),
	})
}

func isCLike(path string) bool {
	lower := strings.ToLower(path)
	for _, ext := range []string{".c", ".h", ".cpp", ".cc", ".cxx", ".hpp"} {
		if strings.HasSuffix(lower, ext) {
			return true
		}
	}
	return false
}

// --- /api/graph ---

func (h *Handler) handleGraph(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		jsonOK(w, h.store.GetGraphResponse())
	case http.MethodDelete:
		if err := h.store.ClearActiveTree(); err != nil {
			jsonErr(w, err.Error(), http.StatusInternalServerError)
			return
		}
		jsonOK(w, h.store.GetGraphResponse())
	default:
		http.Error(w, "GET or DELETE only", http.StatusMethodNotAllowed)
	}
}

// --- /api/graph/node ---

func (h *Handler) handleNode(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		var req struct {
			Match     graph.Match `json:"match"`
			ParentID  string      `json:"parent_id"`
			EdgeLabel string      `json:"edge_label"`
			Label     string      `json:"label"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			jsonErr(w, err.Error(), http.StatusBadRequest)
			return
		}
		if req.EdgeLabel == "" {
			req.EdgeLabel = "ref"
		}
		node, edge, err := h.store.AddMatchAsNode(&req.Match, req.ParentID, req.EdgeLabel, req.Label)
		if err != nil {
			jsonErr(w, err.Error(), http.StatusInternalServerError)
			return
		}
		jsonOK(w, map[string]interface{}{"node": node, "edge": edge})
	default:
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
	}
}

// --- /api/graph/node/:id ---

func (h *Handler) handleNodeByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/graph/node/")
	if id == "" {
		http.NotFound(w, r)
		return
	}

	switch r.Method {
	case http.MethodPut:
		var req struct {
			Label    *string  `json:"label"`
			Memo     *string  `json:"memo"`
			Tags     []string `json:"tags"`
			PosX     *float64 `json:"pos_x"`
			PosY     *float64 `json:"pos_y"`
			Expanded *bool    `json:"expanded"`
		Children []string `json:"children"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			jsonErr(w, err.Error(), http.StatusBadRequest)
			return
		}
		if req.Children != nil {
			h.store.PushUndo()
		}
		node, err := h.store.UpdateNode(id, func(n *graph.Node) {
			if req.Label != nil {
				n.Label = *req.Label
			}
			if req.Memo != nil {
				n.Memo = *req.Memo
			}
			if req.Tags != nil {
				n.Tags = req.Tags
			}
			if req.PosX != nil {
				n.PosX = *req.PosX
			}
			if req.PosY != nil {
				n.PosY = *req.PosY
			}
			if req.Expanded != nil {
				n.Expanded = *req.Expanded
			}
			if req.Children != nil {
				// reparent と saveChildrenOrder の競合で孤立ノードが増殖するのを防ぐため、
				// 現在の children に存在する ID のみ許可（reorder のみ、追加は不可）。
				current := make(map[string]bool, len(n.Children))
				for _, c := range n.Children {
					current[c] = true
				}
				filtered := make([]string, 0, len(req.Children))
				for _, childID := range req.Children {
					if current[childID] {
						filtered = append(filtered, childID)
					}
				}
				n.Children = filtered
			}
		})
		if err != nil {
			jsonErr(w, err.Error(), http.StatusNotFound)
			return
		}
		jsonOK(w, node)

	case http.MethodDelete:
		if err := h.store.DeleteNode(id); err != nil {
			jsonErr(w, err.Error(), http.StatusNotFound)
			return
		}
		jsonOK(w, map[string]string{"status": "deleted"})

	default:
		http.Error(w, "PUT or DELETE only", http.StatusMethodNotAllowed)
	}
}

// --- /api/graph/edge ---

func (h *Handler) handleEdge(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var e graph.Edge
	if err := json.NewDecoder(r.Body).Decode(&e); err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if e.Label == "" {
		e.Label = "ref"
	}
	added, err := h.store.AddEdge(&e)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jsonOK(w, added)
}

// --- /api/graph/edge/delete ---

func (h *Handler) handleEdgeDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := h.store.DeleteEdge(req.From, req.To); err != nil {
		jsonErr(w, err.Error(), http.StatusNotFound)
		return
	}
	jsonOK(w, map[string]string{"status": "deleted"})
}

// --- /api/graph/expand ---

func (h *Handler) handleExpand(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		NodeID    string `json:"node_id"`
		Query     string `json:"query"`
		Dir       string `json:"dir"`
		EdgeLabel string `json:"edge_label"`
		Glob      string `json:"glob"`
		Regex     bool   `json:"regex"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.Query == "" {
		jsonErr(w, "query is required", http.StatusBadRequest)
		return
	}
	h.mu.RLock()
	hroot := h.root
	h.mu.RUnlock()
	if req.Dir == "" {
		req.Dir = hroot
	} else if !filepath.IsAbs(req.Dir) {
		req.Dir = filepath.Join(hroot, req.Dir)
	}
	if req.EdgeLabel == "" {
		req.EdgeLabel = "ref"
	}

	opts := search.Options{
		Pattern:      req.Query,
		Dir:          req.Dir,
		FileGlob:     req.Glob,
		Regex:        req.Regex,
		ContextLines: 3,
	}
	matches, err := search.Search(r.Context(), opts)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}

	var newNodes []*graph.Node
	var newEdges []*graph.Edge

	for i := range matches {
		m := &matches[i]
		if isCLike(m.File) {
			stack, _ := search.ExtractIfdefStack(m.File, m.Line)
			if stack != nil {
				m.IfdefStack = stack
			} else {
				m.IfdefStack = []graph.IfdefFrame{}
			}
		} else {
			m.IfdefStack = []graph.IfdefFrame{}
		}

		node, edge, err := h.store.AddMatchAsNode(m, req.NodeID, req.EdgeLabel, "")
		if err != nil {
			continue
		}
		newNodes = append(newNodes, node)
		if edge != nil {
			newEdges = append(newEdges, edge)
		}
	}

	if newNodes == nil {
		newNodes = []*graph.Node{}
	}
	if newEdges == nil {
		newEdges = []*graph.Edge{}
	}

	jsonOK(w, map[string]interface{}{
		"new_nodes": newNodes,
		"new_edges": newEdges,
	})
}

// --- /api/graph/reparent ---

func (h *Handler) handleReparent(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		NodeID      string `json:"node_id"`
		NewParentID string `json:"new_parent_id"` // 空文字 = ルートに昇格
		EdgeLabel   string `json:"edge_label"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.NodeID == "" {
		jsonErr(w, "node_id is required", http.StatusBadRequest)
		return
	}
	if err := h.store.Reparent(req.NodeID, req.NewParentID, req.EdgeLabel); err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	jsonOK(w, h.store.GetGraphResponse())
}

// --- /api/graph/undo ---

func (h *Handler) handleUndo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	g, err := h.store.Undo()
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	jsonOK(w, g)
}

// --- /api/graph/rootorder ---

func (h *Handler) handleRootOrder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Order []string `json:"order"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := h.store.ReorderRoot(req.Order); err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]string{"status": "ok"})
}

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

// --- /api/graph/saveas ---

// --- /api/graph/export ---

func (h *Handler) handleGraphExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		LineMemos map[string]string `json:"line_memos"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	data, err := h.store.ExportJSON(req.LineMemos)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(data)
}

// --- /api/graph/import ---

func (h *Handler) handleGraphImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	data, err := io.ReadAll(r.Body)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	g, err := h.store.ImportJSON(data)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if g.RootDir != "" {
		if info, statErr := os.Stat(g.RootDir); statErr == nil && info.IsDir() {
			h.mu.Lock()
			h.root = g.RootDir
			h.mu.Unlock()
		}
	}
	jsonOK(w, map[string]interface{}{"graph": g})
}

// --- /api/graph/saveas ---

func (h *Handler) handleGraphSaveAs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Path      string            `json:"path"`
		LineMemos map[string]string `json:"line_memos"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.Path == "" {
		jsonErr(w, "path is required", http.StatusBadRequest)
		return
	}
	if err := h.store.SaveAs(req.Path, req.LineMemos); err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]string{"file_path": req.Path})
}

// --- /api/graph/openfile ---

func (h *Handler) handleGraphOpenFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.Path == "" {
		jsonErr(w, "path is required", http.StatusBadRequest)
		return
	}
	g, err := h.store.OpenFile(req.Path)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// プロジェクトの root_dir がある場合は検索ルートも更新する
	if g.RootDir != "" {
		if info, statErr := os.Stat(g.RootDir); statErr == nil && info.IsDir() {
			h.mu.Lock()
			h.root = g.RootDir
			h.mu.Unlock()
		}
	}
	jsonOK(w, map[string]interface{}{"graph": g, "file_path": req.Path})
}

// --- /api/snippet ---

func (h *Handler) handleSnippet(w http.ResponseWriter, r *http.Request) {
	file := r.URL.Query().Get("file")
	lineStr := r.URL.Query().Get("line")
	ctxStr := r.URL.Query().Get("ctx")
	if file == "" || lineStr == "" {
		jsonErr(w, "file and line are required", http.StatusBadRequest)
		return
	}
	line := 0
	fmt.Sscanf(lineStr, "%d", &line)
	ctx := 15
	fmt.Sscanf(ctxStr, "%d", &ctx)

	lines, err := search.CachedLines(file)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}

	start := line - ctx - 1
	if start < 0 {
		start = 0
	}
	end := line + ctx
	if end > len(lines) {
		end = len(lines)
	}

	type SnipLine struct {
		Line    int    `json:"line"`
		Text    string `json:"text"`
		IsMatch bool   `json:"is_match"`
	}
	result := make([]SnipLine, 0, end-start)
	for i := start; i < end; i++ {
		result = append(result, SnipLine{
			Line:    i + 1,
			Text:    sanitizeUTF8(lines[i]),
			IsMatch: i+1 == line,
		})
	}
	jsonOK(w, result)
}

// --- /api/open ---

func (h *Handler) handleOpen(w http.ResponseWriter, r *http.Request) {
	file := r.URL.Query().Get("file")
	line := r.URL.Query().Get("line")
	if file == "" {
		jsonErr(w, "file is required", http.StatusBadRequest)
		return
	}
	target := file
	if line != "" {
		target = file + ":" + line
	}
	if err := openInEditor(target); err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]string{"status": "ok"})
}

func (h *Handler) handleRoot(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.mu.RLock()
		root := h.root
		h.mu.RUnlock()
		jsonOK(w, map[string]string{"root": root})
	case http.MethodPost:
		var body struct {
			Root string `json:"root"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Root == "" {
			jsonErr(w, "root is required", http.StatusBadRequest)
			return
		}
		abs := filepath.Clean(body.Root)
		if !filepath.IsAbs(abs) {
			jsonErr(w, "absolute path required", http.StatusBadRequest)
			return
		}
		if _, err := os.Stat(abs); err != nil {
			jsonErr(w, "directory not found: "+abs, http.StatusBadRequest)
			return
		}
		h.mu.Lock()
		h.root = abs
		h.mu.Unlock()
		h.store.SetRootDir(abs)
		jsonOK(w, map[string]string{"root": abs})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleFiles は rg --files でプロジェクト内のファイル一覧を返す。
func (h *Handler) handleFiles(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()
	if root == "" {
		root = "."
	}
	cmd := exec.Command("rg", "--files", root)
	out, err := cmd.Output()
	if err != nil {
		// rg が使えない場合は filepath.Walk でフォールバック
		var files []string
		filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() {
				return nil
			}
			base := filepath.Base(filepath.Dir(path))
			if base[0] == '.' || base == "node_modules" || base == "vendor" {
				return nil
			}
			rel, _ := filepath.Rel(root, path)
			files = append(files, filepath.ToSlash(rel))
			return nil
		})
		jsonOK(w, files)
		return
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	files := make([]string, 0, len(lines))
	for _, l := range lines {
		if l == "" {
			continue
		}
		rel, err := filepath.Rel(root, l)
		if err != nil {
			rel = l
		}
		files = append(files, filepath.ToSlash(rel))
	}
	jsonOK(w, files)
}

func (h *Handler) handleDirs(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()
	if root == "" {
		root = "."
	}
	var dirs []string
	filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if !info.IsDir() {
			return nil
		}
		// 隠しディレクトリ・よくある無関係ディレクトリはスキップ
		base := filepath.Base(path)
		if base != "." && (base[0] == '.' || base == "node_modules" || base == "vendor" || base == "__pycache__") {
			return filepath.SkipDir
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		dirs = append(dirs, rel)
		return nil
	})
	jsonOK(w, dirs)
}

func openInEditor(target string) error {
	cmd := exec.Command("code", "--goto", target)
	cmd.Start()
	return nil
}

// --- helpers ---

func sanitizeUTF8(s string) string {
	if utf8.ValidString(s) {
		return s
	}
	b := []byte(s)
	var out strings.Builder
	for len(b) > 0 {
		r, size := utf8.DecodeRune(b)
		if r == utf8.RuneError && size == 1 {
			out.WriteRune('?')
		} else {
			out.WriteRune(r)
		}
		b = b[size:]
	}
	return out.String()
}

// --- /api/include-graph ---

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
