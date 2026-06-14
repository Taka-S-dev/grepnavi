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

func (h *Handler) handleGraphClear(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()
	jsonOK(w, h.store.ResetInMemory(root))
}

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
		h.events.Publish("graph.node_added", map[string]interface{}{
			"node_id":   node.ID,
			"parent_id": req.ParentID,
		})
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
			Label       *string             `json:"label"`
			Memo        *string             `json:"memo"`
			Tags        []string            `json:"tags"`
			PosX        *float64            `json:"pos_x"`
			PosY        *float64            `json:"pos_y"`
			Expanded    *bool               `json:"expanded"`
			Children    []string            `json:"children"`
			BadgeColor  *string             `json:"badge_color"`
			BadgeText   *string             `json:"badge_text"`
			Line        *int                `json:"line"` // Match.Line を手動補正するための後付けフィールド
			DefOverride *graph.DefOverride  `json:"def_override"` // null 明示で解除、未指定で据え置き
			ClearDefOverride bool            `json:"clear_def_override"` // true で override を消す
			Def         *graph.DefRef       `json:"def"`          // frontend resolveNodeDef の解決結果キャッシュ
			ClearDef    bool                `json:"clear_def"`    // true で def cache を消す
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
			if req.Line != nil && *req.Line > 0 {
				n.Match.Line = *req.Line
			}
			if req.ClearDefOverride {
				n.DefOverride = nil
			} else if req.DefOverride != nil && req.DefOverride.File != "" && req.DefOverride.Line > 0 {
				n.DefOverride = req.DefOverride
			}
			if req.ClearDef {
				n.Def = nil
			} else if req.Def != nil && req.Def.File != "" && req.Def.Line > 0 {
				n.Def = req.Def
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

// --- /api/graph/tree/move-node ---

func (h *Handler) handleTreeMoveNode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		NodeID       string `json:"node_id"`
		TargetTreeID string `json:"target_tree_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.NodeID == "" || req.TargetTreeID == "" {
		jsonErr(w, "node_id and target_tree_id are required", http.StatusBadRequest)
		return
	}
	if err := h.store.MoveNodeToTree(req.NodeID, req.TargetTreeID); err != nil {
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

// --- /api/graph/memos ---

func (h *Handler) handleGraphMemos(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, "PUT only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		LineMemos          map[string]string `json:"line_memos"`
		LineMemoCategories map[string]string `json:"line_memo_categories"`
		LineMemoSources    map[string]string `json:"line_memo_sources"`
		RangeMemos         []graph.RangeMemo `json:"range_memos"`
		Bookmarks          map[string]string `json:"bookmarks"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := h.store.UpdateMemos(graph.MemoSnapshot{
		LineMemos:          req.LineMemos,
		LineMemoCategories: req.LineMemoCategories,
		LineMemoSources:    req.LineMemoSources,
		RangeMemos:         req.RangeMemos,
		Bookmarks:          req.Bookmarks,
	}); err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// 外部 writer (別タブ / 別プロセス) からの更新も browser に反映するため発火。
	// 自分自身の POST でも届くが、loadGraph は冪等なので再 fetch は無害。
	h.events.Publish("memos.updated", map[string]interface{}{
		"line_count":  len(req.LineMemos),
		"range_count": len(req.RangeMemos),
	})
	jsonOK(w, map[string]string{"status": "ok"})
}

// --- /api/graph/description ---

// handleGraphDescription はこの .json の調査メモ（自由記述）を更新する。
func (h *Handler) handleGraphDescription(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, "PUT only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Description string `json:"description"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := h.store.SetDescription(req.Description); err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]string{"status": "ok"})
}

// handleGraphDescriptions は複数の .json パスを受け取り、それぞれの description を返す。
// ドロップダウンで各 .json にホバーしたとき「何の調査か」を表示するために使う。
func (h *Handler) handleGraphDescriptions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Paths []string `json:"paths"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	out := make(map[string]string, len(req.Paths))
	for _, p := range req.Paths {
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var pf struct {
			Description string `json:"description"`
		}
		if json.Unmarshal(data, &pf) == nil && pf.Description != "" {
			out[p] = pf.Description
		}
	}
	jsonOK(w, out)
}

// --- /api/graph/export ---

func (h *Handler) handleGraphExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		LineMemos          map[string]string `json:"line_memos"`
		LineMemoCategories map[string]string `json:"line_memo_categories"`
		LineMemoSources    map[string]string `json:"line_memo_sources"`
		RangeMemos         []graph.RangeMemo `json:"range_memos"`
		Bookmarks          map[string]string `json:"bookmarks"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	data, err := h.store.ExportJSON(graph.MemoSnapshot{
		LineMemos:          req.LineMemos,
		LineMemoCategories: req.LineMemoCategories,
		LineMemoSources:    req.LineMemoSources,
		RangeMemos:         req.RangeMemos,
		Bookmarks:          req.Bookmarks,
	})
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
	newRoot := ""
	if g.RootDir != "" {
		if info, statErr := os.Stat(g.RootDir); statErr == nil && info.IsDir() {
			h.mu.Lock()
			h.root = g.RootDir
			h.mu.Unlock()
			h.store.SetRootDir(g.RootDir)
			invalidateFilesCache()
			newRoot = g.RootDir
			if search.CtagsIndexed(g.RootDir) {
				search.CtagsMacroWarmup(g.RootDir)
			}
		}
	}
	jsonOK(w, map[string]interface{}{"graph": g, "root": newRoot})
}

// --- /api/graph/saveas ---

func (h *Handler) handleGraphSaveAs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Path               string            `json:"path"`
		LineMemos          map[string]string `json:"line_memos"`
		LineMemoCategories map[string]string `json:"line_memo_categories"`
		LineMemoSources    map[string]string `json:"line_memo_sources"`
		RangeMemos         []graph.RangeMemo `json:"range_memos"`
		Bookmarks          map[string]string `json:"bookmarks"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.Path == "" {
		jsonErr(w, "path is required", http.StatusBadRequest)
		return
	}
	if err := h.store.SaveAs(req.Path, graph.MemoSnapshot{
		LineMemos:          req.LineMemos,
		LineMemoCategories: req.LineMemoCategories,
		LineMemoSources:    req.LineMemoSources,
		RangeMemos:         req.RangeMemos,
		Bookmarks:          req.Bookmarks,
	}); err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()
	addGraphToGrepnavi(root, req.Path)
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
	newRoot := ""
	if g.RootDir != "" {
		if info, statErr := os.Stat(g.RootDir); statErr == nil && info.IsDir() {
			h.mu.Lock()
			h.root = g.RootDir
			h.mu.Unlock()
			h.store.SetRootDirNoSave(g.RootDir)
			invalidateFilesCache()
			newRoot = g.RootDir
			if search.CtagsIndexed(g.RootDir) {
				search.CtagsMacroWarmup(g.RootDir)
			}
		}
	}
	effectiveRoot := newRoot
	if effectiveRoot == "" {
		h.mu.RLock()
		effectiveRoot = h.root
		h.mu.RUnlock()
	}
	addGraphToGrepnavi(effectiveRoot, req.Path)
	resp := map[string]interface{}{"graph": g, "file_path": req.Path, "root": newRoot}
	if warn := rootHealthWarning(g, effectiveRoot); warn != nil {
		resp["root_warning"] = warn
	}
	jsonOK(w, resp)
}

// rootHealthWarning は開いたグラフのルート健全性を確認する。root_dir が実在しない、または
// ノードのファイル群が root 下に見つからない（ルート取り違え）場合に警告 map を返す。正常なら nil。
// ノードのパスは相対で root と結合して解決されるため、root を間違えると全ノードが開けなくなる。
func rootHealthWarning(g *graph.GraphResponse, root string) map[string]interface{} {
	rootMissing := false
	if g.RootDir != "" {
		if info, err := os.Stat(g.RootDir); err != nil || !info.IsDir() {
			rootMissing = true
		}
	}
	const sampleCap = 20
	sampled, missing := 0, 0
	seen := make(map[string]bool)
	for _, n := range g.Nodes {
		if n == nil || n.Match.File == "" {
			continue
		}
		if seen[n.Match.File] {
			continue
		}
		seen[n.Match.File] = true
		full := n.Match.File
		if !filepath.IsAbs(full) {
			full = filepath.Join(root, full)
		}
		sampled++
		if _, err := os.Stat(full); err != nil {
			missing++
		}
		if sampled >= sampleCap {
			break
		}
	}
	// 問題があるときだけ返す: root 不在、またはサンプルの過半が見つからない（ルート取り違え）。
	if !rootMissing && (sampled == 0 || missing*2 <= sampled) {
		return nil
	}
	return map[string]interface{}{
		"configured_root": g.RootDir,
		"root_missing":    rootMissing,
		"sampled_files":   sampled,
		"missing_files":   missing,
	}
}
