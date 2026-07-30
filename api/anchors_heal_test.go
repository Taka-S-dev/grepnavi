package api

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"grepnavi/graph"
)

func newHealTestHandler(t *testing.T) (*Handler, string) {
	t.Helper()
	dir := t.TempDir()
	st := graph.NewStore(filepath.Join(dir, "g.json"), dir)
	// Store.save() は非同期。Close() で書き込み完了を待たないと、t.TempDir の
	// 後始末（ディレクトリ削除）と競合して flaky になる。
	t.Cleanup(st.Close)
	return &Handler{store: st, root: dir, events: NewEventBus()}, dir
}

func postHeal(t *testing.T, h *Handler, body string) map[string]json.RawMessage {
	t.Helper()
	rec := httptest.NewRecorder()
	h.handleGraphAnchorsHeal(rec, httptest.NewRequest("POST", "/api/graph/anchors/heal", bytes.NewBufferString(body)))
	if rec.Code != 200 {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// 行が一意に見つかるノードは自動で追従し、テキストも取り直される。
func TestHealNodeFollowsUniqueLine(t *testing.T) {
	h, dir := newHealTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("one\ntwo\nthree"), 0o644)
	os.Chtimes(src, time.Unix(1000, 0), time.Unix(1000, 0))
	node, _, err := h.store.AddMatchAsNode(&graph.Match{File: src, Line: 2, Text: "two"}, "", "ref", "")
	if err != nil {
		t.Fatal(err)
	}
	// 先頭に2行挿入 → "two" は4行目へ
	os.WriteFile(src, []byte("x\ny\none\ntwo\nthree"), 0o644)
	// search.CachedLines は mtime でキャッシュする。同一秒内の書き換えで
	// mtime が変わらないと古い内容を読んでしまうため、明示的にずらす。
	os.Chtimes(src, time.Unix(2000, 0), time.Unix(2000, 0))

	out := postHeal(t, h, "")
	var healed []HealedAnchor
	json.Unmarshal(out["healed"], &healed)
	if len(healed) != 1 || healed[0].NodeID != node.ID || healed[0].ToLine != 4 {
		t.Fatalf("healed = %+v", healed)
	}
	g := h.store.GetGraphResponse()
	for _, n := range g.Nodes {
		if n.ID == node.ID && (n.Match.Line != 4 || strings.TrimSpace(n.Match.Text) != "two") {
			t.Errorf("ノードが追従していない: line=%d text=%q", n.Match.Line, n.Match.Text)
		}
	}
	// 2回目は直すものが無い（冪等）
	out2 := postHeal(t, h, "")
	json.Unmarshal(out2["healed"], &healed)
	if len(healed) != 0 {
		t.Errorf("2回目の healed = %+v, want empty", healed)
	}
}

// 複数一致の行は動かない。「もっともらしく間違う」より止まる方を選ぶ。
func TestHealSkipsAmbiguousLine(t *testing.T) {
	h, dir := newHealTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("}\nfoo\n}"), 0o644)
	h.store.AddMatchAsNode(&graph.Match{File: src, Line: 1, Text: "}"}, "", "ref", "")
	os.WriteFile(src, []byte("bar\n}\nfoo\n}"), 0o644)

	out := postHeal(t, h, "")
	var healed []HealedAnchor
	var drifted []DriftedAnchor
	json.Unmarshal(out["healed"], &healed)
	json.Unmarshal(out["drifted"], &drifted)
	if len(healed) != 0 {
		t.Errorf("曖昧一致が動いた: %+v", healed)
	}
	if len(drifted) != 1 {
		t.Errorf("ずれとして残っていない: %+v", drifted)
	}
}

// 行メモは4マップ揃って移動し、移動先が占有されていれば動かない。
func TestHealMovesMemoAcrossAllMaps(t *testing.T) {
	h, dir := newHealTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("one\ntwo\nthree"), 0o644)
	k := src + "::2"
	h.store.UpdateMemos(graph.MemoSnapshot{
		LineMemos:          map[string]string{k: "メモ本文"},
		LineMemoCategories: map[string]string{k: "warn"},
		LineMemoSources:    map[string]string{k: "ai"},
		LineMemoTexts:      map[string]string{k: "two"},
	})
	os.WriteFile(src, []byte("x\none\ntwo\nthree"), 0o644)

	out := postHeal(t, h, "")
	var healed []HealedAnchor
	json.Unmarshal(out["healed"], &healed)
	if len(healed) != 1 || healed[0].MemoKey != k || healed[0].ToLine != 3 {
		t.Fatalf("healed = %+v", healed)
	}
	g := h.store.GetGraphResponse()
	nk := src + "::3"
	if g.LineMemos[nk] != "メモ本文" || g.LineMemoCategories[nk] != "warn" ||
		g.LineMemoSources[nk] != "ai" || strings.TrimSpace(g.LineMemoTexts[nk]) != "two" {
		t.Errorf("4マップが揃って移動していない: %+v", g)
	}
	if _, ok := g.LineMemos[k]; ok {
		t.Error("旧キーが残っている")
	}
}

func TestHealSkipsOccupiedDestination(t *testing.T) {
	h, dir := newHealTestHandler(t)
	src := filepath.Join(dir, "a.c")
	// ファイル: one / x / two / three。
	// ::2 (anchor "two") の移動先は3行目 = ::3 に先客、
	// ::3 (anchor "x") の移動先は2行目 = ::2 に自分たちの相方。
	// 互いに占有し合っているので、どちらも動かないのが正しい
	// （map の走査順に依存せず決定的）。
	os.WriteFile(src, []byte("one\nx\ntwo\nthree"), 0o644)
	k2, k3 := src+"::2", src+"::3"
	h.store.UpdateMemos(graph.MemoSnapshot{
		LineMemos:     map[string]string{k2: "動くはずのメモ", k3: "先客"},
		LineMemoTexts: map[string]string{k2: "two", k3: "x"},
	})

	postHeal(t, h, "")
	g := h.store.GetGraphResponse()
	if g.LineMemos[k3] != "先客" {
		t.Errorf("先客が上書きされた: %q", g.LineMemos[k3])
	}
	if g.LineMemos[k2] != "動くはずのメモ" {
		t.Errorf("占有スキップのはずが動いた: %+v", g.LineMemos)
	}
}

// {"file": ...} 指定時は他ファイルの項目に触らない。
func TestHealFileFilter(t *testing.T) {
	h, dir := newHealTestHandler(t)
	a, b := filepath.Join(dir, "a.c"), filepath.Join(dir, "b.c")
	os.WriteFile(a, []byte("one\ntwo"), 0o644)
	os.WriteFile(b, []byte("uno\ndos"), 0o644)
	os.Chtimes(a, time.Unix(1000, 0), time.Unix(1000, 0))
	os.Chtimes(b, time.Unix(1000, 0), time.Unix(1000, 0))
	h.store.AddMatchAsNode(&graph.Match{File: a, Line: 2, Text: "two"}, "", "ref", "")
	h.store.AddMatchAsNode(&graph.Match{File: b, Line: 2, Text: "dos"}, "", "ref", "")
	os.WriteFile(a, []byte("x\none\ntwo"), 0o644)
	os.WriteFile(b, []byte("x\nuno\ndos"), 0o644)
	// mtime キャッシュを確実に無効化する（同一秒内の書き換え対策）。
	os.Chtimes(a, time.Unix(2000, 0), time.Unix(2000, 0))
	os.Chtimes(b, time.Unix(2000, 0), time.Unix(2000, 0))

	out := postHeal(t, h, `{"file": "`+strings.ReplaceAll(a, `\`, `\\`)+`"}`)
	var healed []HealedAnchor
	json.Unmarshal(out["healed"], &healed)
	if len(healed) != 1 || !strings.HasSuffix(healed[0].File, "a.c") {
		t.Fatalf("a.c だけが対象のはず: %+v", healed)
	}
}
