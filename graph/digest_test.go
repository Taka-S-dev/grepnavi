package graph

import (
	"path/filepath"
	"strings"
	"testing"
)

// newTestStore はディスクへ書かないストアを作る（filePath 空 = saveLoop が無視する）。
func newTestStore(t *testing.T) *Store {
	t.Helper()
	return NewStore(filepath.Join(t.TempDir(), "graph.json"), `C:\proj`)
}

func addNode(t *testing.T, s *Store, id, label, memo string, children ...string) {
	t.Helper()
	tree := s.activeTree()
	tree.Nodes[id] = &Node{
		ID:       id,
		Label:    label,
		Memo:     memo,
		Match:    Match{File: `C:\proj\src\a.c`, Line: 10},
		Children: children,
	}
}

func TestGetDigestCountsAndRoots(t *testing.T) {
	s := newTestStore(t)
	addNode(t, s, "n1", "main:10", "[verified] エントリポイント", "n2")
	addNode(t, s, "n2", "helper:20", "[未確認] たぶん初期化")
	addNode(t, s, "n3", "other:30", "")
	s.activeTree().RootOrder = []string{"n1", "n3"}
	s.pf.Description = "起動シーケンスの調査"
	s.pf.LineMemos = map[string]string{"a.c::1": "x", "a.c::2": "y"}

	d := s.GetDigest()
	if d.Nodes != 3 {
		t.Errorf("Nodes = %d, want 3", d.Nodes)
	}
	if d.Unverified != 1 {
		t.Errorf("Unverified = %d, want 1", d.Unverified)
	}
	if d.LineMemos != 2 {
		t.Errorf("LineMemos = %d, want 2", d.LineMemos)
	}
	if d.Description != "起動シーケンスの調査" {
		t.Errorf("Description = %q", d.Description)
	}
	// 起点は RootOrder の順。map の反復順に任せると呼ぶたび並びが変わる。
	if len(d.Roots) != 2 || d.Roots[0].ID != "n1" || d.Roots[1].ID != "n3" {
		t.Fatalf("Roots = %+v, want n1 then n3", d.Roots)
	}
	// 打ち切っていないときは総数を出さない（値の有無が打ち切りの合図）
	if d.RootsTotal != 0 {
		t.Errorf("RootsTotal = %d, want 0 when nothing was truncated", d.RootsTotal)
	}
	if d.Roots[0].Children != 1 {
		t.Errorf("Roots[0].Children = %d, want 1", d.Roots[0].Children)
	}
}

// RootOrder が未設定の古いグラフでも、親を持たないノードから起点を組み立てる。
func TestGetDigestDerivesRootsWithoutRootOrder(t *testing.T) {
	s := newTestStore(t)
	addNode(t, s, "n1", "main:10", "", "n2")
	addNode(t, s, "n2", "helper:20", "")
	d := s.GetDigest()
	if len(d.Roots) != 1 || d.Roots[0].ID != "n1" {
		t.Errorf("Roots = %+v, want only n1", d.Roots)
	}
}

func TestGetDigestCapsRootsAndMemos(t *testing.T) {
	s := newTestStore(t)
	var order []string
	for i := 0; i < _digestMaxRoots+5; i++ {
		id := string(rune('a' + i))
		addNode(t, s, id, id, strings.Repeat("あ", _digestMaxMemoLen+40))
		order = append(order, id)
	}
	s.activeTree().RootOrder = order

	d := s.GetDigest()
	if len(d.Roots) != _digestMaxRoots {
		t.Errorf("len(Roots) = %d, want %d", len(d.Roots), _digestMaxRoots)
	}
	// 打ち切ったことが分かるよう全体数を返す。黙って切ると「これで全部」と読まれる。
	if d.RootsTotal != _digestMaxRoots+5 {
		t.Errorf("RootsTotal = %d, want %d", d.RootsTotal, _digestMaxRoots+5)
	}
	if r := []rune(d.Roots[0].Memo); len(r) != _digestMaxMemoLen+1 {
		t.Errorf("memo not truncated: %d runes", len(r))
	}
}

func TestGetDigestEmptyGraph(t *testing.T) {
	d := newTestStore(t).GetDigest()
	if d.Nodes != 0 || len(d.Roots) != 0 {
		t.Errorf("want an empty digest, got %+v", d)
	}
	if d.Tree == "" {
		t.Error("Tree name should still be reported for an empty graph")
	}
}

func TestIsUnverifiedMemo(t *testing.T) {
	unverified := []string{"[未確認] x", "[未読]y", " [推測] z", "[unverified] a", "[INFERRED] b"}
	verified := []string{"[verified] x", "[確認済] y", "[読了] z", "普通のメモ", "", "未確認 (タグではない)"}
	for _, m := range unverified {
		if !isUnverifiedMemo(m) {
			t.Errorf("isUnverifiedMemo(%q) = false, want true", m)
		}
	}
	for _, m := range verified {
		if isUnverifiedMemo(m) {
			t.Errorf("isUnverifiedMemo(%q) = true, want false", m)
		}
	}
}
