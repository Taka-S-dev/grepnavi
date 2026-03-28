package graph

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"
)

const maxUndoDepth = 50

// undoSnapshot はツリーの構造スナップショット（アンドゥ用）。
type undoSnapshot struct {
	treeID    string
	nodes     map[string]*Node
	edges     []*Edge
	rootOrder []string
}

// Store はプロジェクトファイルのインメモリストアと JSON 永続化を担う。
type Store struct {
	mu        sync.RWMutex
	pf        *ProjectFile
	filePath  string
	saveCh    chan []byte      // バックグラウンド書き込みキュー（最新1件のみ保持）
	undoStack []undoSnapshot   // アンドゥ履歴（メモリのみ、永続化しない）
}

func NewStore(filePath, rootDir string) *Store {
	s := &Store{
		filePath: filePath,
		saveCh:   make(chan []byte, 1),
	}
	if pf, err := loadProjectFile(filePath); err == nil {
		s.pf = pf
	} else {
		s.pf = NewProjectFile(rootDir)
	}
	go s.saveLoop()
	return s
}

// saveLoop はバックグラウンドでディスク書き込みを処理する。
// ミューテックスを保持せずに I/O を行うことで、書き込み競合によるロック詰まりを防ぐ。
func (s *Store) saveLoop() {
	for data := range s.saveCh {
		tmp := s.filePath + ".tmp"
		if err := os.WriteFile(tmp, data, 0644); err != nil {
			continue
		}
		_ = os.Rename(tmp, s.filePath)
	}
}

func loadProjectFile(path string) (*ProjectFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var pf ProjectFile
	if err := json.Unmarshal(data, &pf); err != nil {
		return nil, err
	}
	if len(pf.Trees) == 0 {
		return nil, fmt.Errorf("no trees in project file")
	}
	for _, t := range pf.Trees {
		if t == nil {
			return nil, fmt.Errorf("project file contains nil tree element")
		}
		if t.Nodes == nil {
			t.Nodes = make(map[string]*Node)
		}
		if t.Edges == nil {
			t.Edges = []*Edge{}
		}
	}
	return &pf, nil
}

// save はインメモリ状態を JSON にシリアライズして saveCh に送る。
// ミューテックス保持中に呼ぶこと（s.pf への安全なアクセスのため）。
// 実際のディスク書き込みは saveLoop で行われるため、この関数はブロックしない。
// 連続して呼ばれた場合は最新の1件のみが書き込まれる（中間状態は破棄）。
func (s *Store) save() error {
	s.pf.UpdatedAt = time.Now()
	data, err := json.MarshalIndent(s.pf, "", "  ")
	if err != nil {
		return err
	}
	// 古い pending データを捨てて最新を送る（ノンブロッキング）
	select {
	case s.saveCh <- data:
	default:
		<-s.saveCh
		s.saveCh <- data
	}
	return nil
}

// activeTree は現在アクティブなツリーを返す（ロック保持中に呼ぶこと）。
func (s *Store) activeTree() *Tree {
	for _, t := range s.pf.Trees {
		if t.ID == s.pf.ActiveTreeID {
			return t
		}
	}
	if len(s.pf.Trees) > 0 {
		s.pf.ActiveTreeID = s.pf.Trees[0].ID
		return s.pf.Trees[0]
	}
	t := NewTree("ツリー1")
	s.pf.Trees = []*Tree{t}
	s.pf.ActiveTreeID = t.ID
	return t
}

func (s *Store) treeMetas() []TreeMeta {
	metas := make([]TreeMeta, 0, len(s.pf.Trees))
	for _, t := range s.pf.Trees {
		if t != nil {
			metas = append(metas, TreeMeta{ID: t.ID, Name: t.Name})
		}
	}
	return metas
}

func (s *Store) buildResponse(t *Tree) *GraphResponse {
	return &GraphResponse{
		ID:           t.ID,
		Name:         t.Name,
		Nodes:        t.Nodes,
		Edges:        t.Edges,
		RootDir:      s.pf.RootDir,
		FilePath:     s.filePath,
		UpdatedAt:    t.UpdatedAt,
		Trees:        s.treeMetas(),
		ActiveTreeID: s.pf.ActiveTreeID,
		LineMemos:    s.pf.LineMemos,
		RootOrder:    t.RootOrder,
	}
}

// ===== アンドゥ =====

// pushUndo はアクティブツリーの現在状態をスナップショットとして保存する。
// ミューテックスを保持中に呼ぶこと（内部用）。
func (s *Store) pushUndo(t *Tree) {
	// JSON 経由でディープコピー
	data, err := json.Marshal(struct {
		Nodes     map[string]*Node `json:"nodes"`
		Edges     []*Edge          `json:"edges"`
		RootOrder []string         `json:"root_order"`
	}{t.Nodes, t.Edges, t.RootOrder})
	if err != nil {
		return
	}
	var snap struct {
		Nodes     map[string]*Node `json:"nodes"`
		Edges     []*Edge          `json:"edges"`
		RootOrder []string         `json:"root_order"`
	}
	if err := json.Unmarshal(data, &snap); err != nil {
		return
	}
	s.undoStack = append(s.undoStack, undoSnapshot{
		treeID:    t.ID,
		nodes:     snap.Nodes,
		edges:     snap.Edges,
		rootOrder: snap.RootOrder,
	})
	if len(s.undoStack) > maxUndoDepth {
		s.undoStack = s.undoStack[1:]
	}
}

// PushUndo はロックを取得してアクティブツリーのスナップショットを保存する（外部向け）。
func (s *Store) PushUndo() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pushUndo(s.activeTree())
}

// Undo は最後のスナップショットに戻す。
func (s *Store) Undo() (*GraphResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// アクティブツリーのエントリを末尾から探す
	t := s.activeTree()
	idx := -1
	for i := len(s.undoStack) - 1; i >= 0; i-- {
		if s.undoStack[i].treeID == t.ID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return nil, fmt.Errorf("これ以上戻れません")
	}
	snap := s.undoStack[idx]
	s.undoStack = append(s.undoStack[:idx], s.undoStack[idx+1:]...)
	t.Nodes = snap.nodes
	t.Edges = snap.edges
	t.RootOrder = snap.rootOrder
	t.UpdatedAt = time.Now()
	if err := s.save(); err != nil {
		return nil, err
	}
	return s.buildResponse(t), nil
}

func (s *Store) ReorderRoot(order []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.activeTree()
	s.pushUndo(t)
	t.RootOrder = order
	t.UpdatedAt = time.Now()
	return s.save()
}

// GetGraphResponse はアクティブツリーの GraphResponse を返す。
func (s *Store) GetGraphResponse() *GraphResponse {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.buildResponse(s.activeTree())
}

func (s *Store) SetRootDir(root string) {
	s.mu.Lock()
	s.pf.RootDir = root
	s.mu.Unlock()
	_ = s.save()
}

func (s *Store) GetFilePath() string {
	return s.filePath
}

func (s *Store) GetRootDir() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.pf.RootDir
}

// ===== ツリー管理 =====

func (s *Store) CreateTree(name string) (*GraphResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := NewTree(name)
	s.pf.Trees = append(s.pf.Trees, t)
	s.pf.ActiveTreeID = t.ID
	return s.buildResponse(t), s.save()
}

func (s *Store) SwitchTree(id string) (*GraphResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, t := range s.pf.Trees {
		if t.ID == id {
			s.pf.ActiveTreeID = id
			if err := s.save(); err != nil {
				return nil, err
			}
			return s.buildResponse(t), nil
		}
	}
	return nil, fmt.Errorf("tree %s not found", id)
}

func (s *Store) RenameTree(id, name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, t := range s.pf.Trees {
		if t.ID == id {
			t.Name = name
			return s.save()
		}
	}
	return fmt.Errorf("tree %s not found", id)
}

func (s *Store) DeleteTree(id string) (*GraphResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.pf.Trees) <= 1 {
		return nil, fmt.Errorf("最後のツリーは削除できません")
	}
	idx := -1
	for i, t := range s.pf.Trees {
		if t.ID == id {
			idx = i
			break
		}
	}
	if idx == -1 {
		return nil, fmt.Errorf("tree %s not found", id)
	}
	s.pf.Trees = append(s.pf.Trees[:idx], s.pf.Trees[idx+1:]...)
	if s.pf.ActiveTreeID == id {
		s.pf.ActiveTreeID = s.pf.Trees[0].ID
	}
	t := s.activeTree()
	return s.buildResponse(t), s.save()
}

func (s *Store) ClearActiveTree() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.activeTree()
	t.Nodes = make(map[string]*Node)
	t.Edges = []*Edge{}
	t.UpdatedAt = time.Now()
	return s.save()
}

// ===== ノード操作 =====

func (s *Store) AddNode(n *Node) (*Node, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.activeTree()
	if existing, ok := t.Nodes[n.ID]; ok {
		return existing, nil
	}
	if n.Tags == nil {
		n.Tags = []string{}
	}
	if n.Children == nil {
		n.Children = []string{}
	}
	if n.Label == "" {
		n.Label = fmt.Sprintf("%s:%d", shortPath(n.Match.File), n.Match.Line)
	}
	t.Nodes[n.ID] = n
	t.UpdatedAt = time.Now()
	return n, s.save()
}

func (s *Store) UpdateNode(id string, fn func(*Node)) (*Node, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.activeTree()
	n, ok := t.Nodes[id]
	if !ok {
		return nil, fmt.Errorf("node %s not found", id)
	}
	fn(n)
	t.UpdatedAt = time.Now()
	return n, s.save()
}

func (s *Store) DeleteNode(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.activeTree()
	if _, ok := t.Nodes[id]; !ok {
		return fmt.Errorf("node %s not found", id)
	}
	delete(t.Nodes, id)
	for _, n := range t.Nodes {
		n.Children = removeStr(n.Children, id)
	}
	edges := t.Edges[:0]
	for _, e := range t.Edges {
		if e.From != id && e.To != id {
			edges = append(edges, e)
		}
	}
	t.Edges = edges
	t.UpdatedAt = time.Now()
	return s.save()
}

// ===== エッジ操作 =====

func (s *Store) AddEdge(e *Edge) (*Edge, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.activeTree()
	for _, existing := range t.Edges {
		if existing.From == e.From && existing.To == e.To && existing.Label == e.Label {
			return existing, nil
		}
	}
	t.Edges = append(t.Edges, e)
	if parent, ok := t.Nodes[e.From]; ok {
		if !containsStr(parent.Children, e.To) {
			parent.Children = append(parent.Children, e.To)
		}
	}
	t.UpdatedAt = time.Now()
	return e, s.save()
}

func (s *Store) DeleteEdge(from, to string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.activeTree()
	edges := t.Edges[:0]
	found := false
	for _, e := range t.Edges {
		if e.From == from && e.To == to {
			found = true
			continue
		}
		edges = append(edges, e)
	}
	if !found {
		return fmt.Errorf("edge %s->%s not found", from, to)
	}
	t.Edges = edges
	if parent, ok := t.Nodes[from]; ok {
		parent.Children = removeStr(parent.Children, to)
	}
	t.UpdatedAt = time.Now()
	return s.save()
}

// ===== ツリー再構成 =====

func (s *Store) Reparent(nodeID, newParentID, edgeLabel string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.activeTree()
	s.pushUndo(t)
	if _, ok := t.Nodes[nodeID]; !ok {
		return fmt.Errorf("node %s not found", nodeID)
	}
	if newParentID != "" {
		if _, ok := t.Nodes[newParentID]; !ok {
			return fmt.Errorf("parent %s not found", newParentID)
		}
		if isDescendantInTree(t, newParentID, nodeID) {
			return fmt.Errorf("循環参照になります")
		}
	}
	for _, n := range t.Nodes {
		n.Children = removeStr(n.Children, nodeID)
	}
	edges := t.Edges[:0]
	for _, e := range t.Edges {
		if e.To != nodeID {
			edges = append(edges, e)
		}
	}
	t.Edges = edges
	if newParentID != "" {
		// 子になるノードはルート順から除去する
		t.RootOrder = removeStr(t.RootOrder, nodeID)
		parent := t.Nodes[newParentID]
		if !containsStr(parent.Children, nodeID) {
			parent.Children = append(parent.Children, nodeID)
		}
		if edgeLabel == "" {
			edgeLabel = "ref"
		}
		t.Edges = append(t.Edges, &Edge{
			ID:    fmt.Sprintf("%s->%s", newParentID[:8], nodeID[:8]),
			From:  newParentID,
			To:    nodeID,
			Label: edgeLabel,
		})
	}
	t.UpdatedAt = time.Now()
	return s.save()
}

func isDescendantInTree(t *Tree, target, root string) bool {
	visited := make(map[string]bool)
	return isDescendantRec(t, target, root, visited)
}

func isDescendantRec(t *Tree, target, root string, visited map[string]bool) bool {
	if visited[root] {
		return false
	}
	visited[root] = true
	n, ok := t.Nodes[root]
	if !ok {
		return false
	}
	for _, c := range n.Children {
		if c == target {
			return true
		}
		if isDescendantRec(t, target, c, visited) {
			return true
		}
	}
	return false
}

// ===== プロジェクトファイル保存/読み込み =====

func (s *Store) SaveAs(path string, lineMemos map[string]string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pf.LineMemos = lineMemos
	s.pf.UpdatedAt = time.Now()
	data, err := json.MarshalIndent(s.pf, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	s.filePath = path
	return nil
}

func (s *Store) OpenFile(path string) (*GraphResponse, error) {
	pf, err := loadProjectFile(path)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.pf = pf
	s.filePath = path
	resp := s.buildResponse(s.activeTree())
	s.mu.Unlock()
	return resp, nil
}

// ExportJSON は現在のプロジェクトを JSON バイト列として返す（ファイル書き込みなし）。
func (s *Store) ExportJSON(lineMemos map[string]string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	prev := s.pf.LineMemos
	s.pf.LineMemos = lineMemos
	s.pf.UpdatedAt = time.Now()
	data, err := json.MarshalIndent(s.pf, "", "  ")
	s.pf.LineMemos = prev
	return data, err
}

// ImportJSON は JSON バイト列をパースしてプロジェクトとしてロードする（ファイル読み込みなし）。
func (s *Store) ImportJSON(data []byte) (*GraphResponse, error) {
	var pf ProjectFile
	if err := json.Unmarshal(data, &pf); err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.pf = &pf
	resp := s.buildResponse(s.activeTree())
	s.mu.Unlock()
	return resp, nil
}

// ===== ユーティリティ =====

func shortPath(p string) string {
	if len(p) > 40 {
		return "..." + p[len(p)-37:]
	}
	return p
}

func removeStr(ss []string, s string) []string {
	out := ss[:0]
	for _, v := range ss {
		if v != s {
			out = append(out, v)
		}
	}
	return out
}

func containsStr(ss []string, s string) bool {
	for _, v := range ss {
		if v == s {
			return true
		}
	}
	return false
}
