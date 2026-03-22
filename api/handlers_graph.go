package api

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"grepnavi/graph"
	"grepnavi/search"
)

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
			Label      *string  `json:"label"`
			Memo       *string  `json:"memo"`
			Tags       []string `json:"tags"`
			PosX       *float64 `json:"pos_x"`
			PosY       *float64 `json:"pos_y"`
			Expanded   *bool    `json:"expanded"`
			Children   []string `json:"children"`
			BadgeColor *string  `json:"badge_color"`
			BadgeText  *string  `json:"badge_text"`
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
			if req.BadgeColor != nil {
				n.BadgeColor = *req.BadgeColor
			}
			if req.BadgeText != nil {
				n.BadgeText = *req.BadgeText
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
	if g.RootDir != "" {
		if info, statErr := os.Stat(g.RootDir); statErr == nil && info.IsDir() {
			h.mu.Lock()
			h.root = g.RootDir
			h.mu.Unlock()
		}
	}
	jsonOK(w, map[string]interface{}{"graph": g, "file_path": req.Path})
}
