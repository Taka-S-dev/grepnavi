package graph

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testRoot = `C:\proj`

// newTestStore は毎回別の一時ディレクトリを使い、テスト間で作業ファイルを共有しない。
// Close は必須: 保存は非同期なので、待たないと t.TempDir の後始末と書き込みが競合する。
func newTestStore(t *testing.T) *Store {
	t.Helper()
	s := NewStore(filepath.Join(t.TempDir(), "graph.json"), testRoot)
	t.Cleanup(s.Close)
	return s
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

	d := s.GetDigest(testRoot)
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
	d := s.GetDigest(testRoot)
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

	d := s.GetDigest(testRoot)
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
	d := newTestStore(t).GetDigest(testRoot)
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

// グラフは root を切り替えても残るので、linux の調査に openssl のノードが混ざりうる。
// 見比べる使い方は正当なので数えるだけにし、気づけるようにする。
func TestGetDigestCountsNodesOutsideRoot(t *testing.T) {
	s := newTestStore(t)
	tree := s.activeTree()
	add := func(id, file string) {
		tree.Nodes[id] = &Node{ID: id, Label: id, Match: Match{File: file, Line: 1}}
	}
	add("in1", `C:\proj\src\a.c`)
	add("in2", `c:/PROJ/src/b.c`) // 区切り・大小が違っても root 配下
	add("out1", `C:\other\ssl\x.c`)
	add("out2", `C:\projx\y.c`) // 接頭辞が同じだけの別ディレクトリ

	d := s.GetDigest(testRoot)
	if d.OutsideRoot != 2 {
		t.Errorf("OutsideRoot = %d, want 2", d.OutsideRoot)
	}
	if d.Nodes != 4 {
		t.Errorf("Nodes = %d, want 4", d.Nodes)
	}
	// root が分からないときは判定しない（0 件として出さない）
	if got := s.GetDigest("").OutsideRoot; got != 0 {
		t.Errorf("root 未指定で OutsideRoot = %d, want 0", got)
	}
}

// ===== 作業ファイルの退避と復元 =====

func writeStoreWithNode(t *testing.T, path, nodeID string) {
	t.Helper()
	s := NewStore(path, testRoot)
	s.activeTree().Nodes[nodeID] = &Node{ID: nodeID, Label: nodeID}
	if err := s.save(); err != nil {
		t.Fatal(err)
	}
	s.Close() // 書き込み完了を待つ
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("%s was not written: %v", path, err)
	}
}

// 起動時に前回の内容をそのまま読むと「保存したものを開いている」ように見える。
// 必ず空から始め、前回分は復元ファイルへ退避する。
func TestNewWorkingStoreStartsEmptyAndKeepsRecover(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "graph.json")
	writeStoreWithNode(t, path, "n1")

	s := NewWorkingStore(path, testRoot)
	defer s.Close()
	if n := len(s.activeTree().Nodes); n != 0 {
		t.Errorf("起動直後のノード数 = %d, want 0", n)
	}
	if _, err := os.Stat(path); err == nil {
		t.Error("作業ファイルは退避されるので残っていないはず")
	}
	rec := s.Recover()
	if rec == nil || rec.Nodes != 1 {
		t.Fatalf("Recover() = %+v, want 1 ノード", rec)
	}

	g, err := s.RestoreRecover()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := g.Nodes["n1"]; !ok {
		t.Errorf("復元後のノード = %+v, want n1", g.Nodes)
	}
	// 復元しても保存先は作業ファイルのまま（名前を付けていない状態は変わらない）
	if s.GetFilePath() != path {
		t.Errorf("FilePath = %q, want %q", s.GetFilePath(), path)
	}
}

// 空の作業ファイルを退避しても復元する価値がないので、古い復元ファイルを潰さない。
func TestNewWorkingStoreKeepsOlderRecoverWhenEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "graph.json")
	writeStoreWithNode(t, path, "old")
	NewWorkingStore(path, testRoot).Close() // 1回目: old が復元ファイルへ

	// 2回目は作業ファイルが空のまま終了した想定
	empty := NewStore(path, testRoot)
	if err := empty.save(); err != nil {
		t.Fatal(err)
	}
	empty.Close()
	s := NewWorkingStore(path, testRoot)
	defer s.Close()

	rec := s.Recover()
	if rec == nil || rec.Nodes != 1 {
		t.Fatalf("Recover() = %+v, want old の 1 ノードが残っていること", rec)
	}
}

// -graph を明示したときは利用者が名前を付けたのと同じなので、そのまま読み込む。
func TestNewStoreLoadsExistingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "named.json")
	writeStoreWithNode(t, path, "n1")

	s := NewStore(path, testRoot)
	defer s.Close()
	if _, ok := s.activeTree().Nodes["n1"]; !ok {
		t.Error("明示指定したファイルは読み込まれるべき")
	}
	if s.Recover() != nil {
		t.Error("退避は起きないはず")
	}
}

func TestRecoverPath(t *testing.T) {
	if got := RecoverPath("/a/graph.json"); got != "/a/graph.recover.json" {
		t.Errorf("RecoverPath = %q", got)
	}
	if got := RecoverPath(""); got != "" {
		t.Errorf("RecoverPath(\"\") = %q", got)
	}
}
