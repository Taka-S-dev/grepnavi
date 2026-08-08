package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"grepnavi/graph"
	"grepnavi/search"
)

func newJumpHealHandler(t *testing.T) (*Handler, string) {
	t.Helper()
	dir := t.TempDir()
	st := graph.NewStore(filepath.Join(dir, "g.json"), dir)
	t.Cleanup(st.Close)
	return &Handler{store: st, root: dir, events: NewEventBus()}, dir
}

func writeSrc(t *testing.T, dir, name, body string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// 照合そのもの (空白の畳み込み・曖昧一致・手掛かりの可否) の検証は
// search/anchorheal_test.go にある。ここは API 層が足している分——
// root 基準のパス解決・移動した印・ハンドラの入口——だけを見る。

// 相対パスのヒットも root 基準で解決してから照合する。
func TestHealedLineResolvesRelativePath(t *testing.T) {
	h, dir := newJumpHealHandler(t)
	writeSrc(t, dir, "t.c", "a\nb\nvoid target(void)\n")

	if got := h.healedLine("t.c", 1, "void target(void)"); got != 3 {
		t.Errorf("相対パスでも追従するはず: got %d, want 3", got)
	}
}

// 動かしたヒットには印を付ける。黙って動かすと、外したときに気づけない。
func TestHealDefHitsMarksMovedHits(t *testing.T) {
	h, dir := newJumpHealHandler(t)
	src := writeSrc(t, dir, "t.c", "pad\npad\nvoid target(void)\nvoid other(void)\n")

	hits := h.healDefHits([]search.DefHit{
		{File: src, Line: 1, Text: "void target(void)"}, // ずれている
		{File: src, Line: 4, Text: "void other(void)"},  // ずれていない
	})
	if hits[0].Line != 3 || !hits[0].Healed {
		t.Errorf("動かしたヒット: got line=%d healed=%v, want 3/true", hits[0].Line, hits[0].Healed)
	}
	if hits[1].Line != 4 || hits[1].Healed {
		t.Errorf("動かしていないヒットに印を付けてはいけない: got line=%d healed=%v", hits[1].Line, hits[1].Healed)
	}
}

// シンボル名検索は決定時に1件だけ直す。ハンドラは root の外を触らない。
func TestHandleHealLine(t *testing.T) {
	h, dir := newJumpHealHandler(t)
	src := writeSrc(t, dir, "t.c", "pad\npad\nvoid target(void)\n")

	q := url.Values{"file": {src}, "line": {"1"}, "text": {"void target(void)"}}
	rec := httptest.NewRecorder()
	h.handleHealLine(rec, httptest.NewRequest("GET", "/api/heal-line?"+q.Encode(), nil))
	var got struct {
		Line   int  `json:"line"`
		Healed bool `json:"healed"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Line != 3 || !got.Healed {
		t.Errorf("heal-line = %+v, want line=3 healed=true", got)
	}

	outside := url.Values{"file": {filepath.Join(dir, "..", "elsewhere.c")}, "line": {"1"}, "text": {"void target(void)"}}
	rec = httptest.NewRecorder()
	h.handleHealLine(rec, httptest.NewRequest("GET", "/api/heal-line?"+outside.Encode(), nil))
	if rec.Code != http.StatusForbidden {
		t.Errorf("root の外は拒否するはず: got %d", rec.Code)
	}

	bad := url.Values{"file": {src}, "line": {"0"}}
	rec = httptest.NewRecorder()
	h.handleHealLine(rec, httptest.NewRequest("GET", "/api/heal-line?"+bad.Encode(), nil))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("行番号が不正なら 400 のはず: got %d", rec.Code)
	}
}
