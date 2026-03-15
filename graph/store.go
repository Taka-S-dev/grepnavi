package graph

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"
)

// Store はプロジェクトファイルのインメモリストアと JSON 永続化を担う。
type Store struct {
	mu       sync.RWMutex
	pf       *ProjectFile
	filePath string
}

func NewStore(filePath, rootDir string) *Store {
	s := &Store{filePath: filePath}
	if pf, err := loadProjectFile(filePath); err == nil {
		s.pf = pf
	} else {
		s.pf = NewProjectFile(rootDir)
	}
	return s
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
		if t.Nodes == nil {
			t.Nodes = make(map[string]*Node)
		}
		if t.Edges == nil {
			t.Edges = []*Edge{}
		}
	}
	return &pf, nil
}

func (s *Store) save() error {
	s.pf.UpdatedAt = time.Now()
	data, err := json.MarshalIndent(s.pf, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.filePath + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, s.filePath)
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
	metas := make([]TreeMeta, len(s.pf.Trees))
	for i, t := range s.pf.Trees {
		metas[i] = TreeMeta{ID: t.ID, Name: t.Name}
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
		UpdatedAt:    t.UpdatedAt,
		Trees:        s.treeMetas(),
		ActiveTreeID: s.pf.ActiveTreeID,
		LineMemos:    s.pf.LineMemos,
	}
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
	n, ok := t.Nodes[root]
	if !ok {
		return false
	}
	for _, c := range n.Children {
		if c == target {
			return true
		}
		if isDescendantInTree(t, target, c) {
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
