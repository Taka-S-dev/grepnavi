package graph

import (
	"fmt"
	"time"
)

// ExpandRequest はノード展開リクエスト。
type ExpandRequest struct {
	NodeID    string `json:"node_id"`
	Query     string `json:"query"`
	EdgeLabel string `json:"edge_label"` // e.g. "calls", "uses"
}

// ExpandResult は展開結果。
type ExpandResult struct {
	NewNodes []*Node `json:"new_nodes"`
	NewEdges []*Edge `json:"new_edges"`
}

// AddMatchAsNode は Match をノードとして追加し、parentID が指定されていればエッジも張る。
// label が空文字の場合はデフォルトラベル（ファイル名:行番号）を使用する。
// Store の外部から呼ばれる想定（ロックは AddNode/AddEdge に委譲）。
func (s *Store) AddMatchAsNode(m *Match, parentID, edgeLabel, label string) (*Node, *Edge, error) {
	if label == "" {
		label = fmt.Sprintf("%s:%d", shortPath(m.File), m.Line)
	}
	n := &Node{
		ID:       m.ID,
		Match:    *m,
		Label:    label,
		Tags:     []string{},
		Children: []string{},
		Expanded: true,
	}
	added, err := s.AddNode(n)
	if err != nil {
		return nil, nil, err
	}

	if parentID == "" {
		return added, nil, nil
	}

	e := &Edge{
		ID:    edgeID(parentID, added.ID, edgeLabel),
		From:  parentID,
		To:    added.ID,
		Label: edgeLabel,
	}
	addedEdge, err := s.AddEdge(e)
	if err != nil {
		return added, nil, err
	}
	return added, addedEdge, nil
}

func edgeID(from, to, label string) string {
	return fmt.Sprintf("%s->%s[%s]@%d", from[:8], to[:8], label, time.Now().UnixNano())
}
