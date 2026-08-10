package api

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// /api/macro-values: 決まる名前だけが返り、決まらない名前はキーごと出ない
func TestHandleMacroValues(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not installed")
	}
	dir := t.TempDir()
	src := "#define FATAL 64\n#define MALLOC (1|FATAL)\n"
	if err := os.WriteFile(filepath.Join(dir, "defs.h"), []byte(src), 0644); err != nil {
		t.Fatal(err)
	}
	h := &Handler{root: dir, events: NewEventBus()}

	rec := httptest.NewRecorder()
	h.handleMacroValues(rec, httptest.NewRequest("GET", "/api/macro-values?names=FATAL,MALLOC,NOPE", nil))
	if rec.Code != 200 {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var got map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["FATAL"] != "64" || got["MALLOC"] != "65" {
		t.Errorf("解決値が違う: %v", got)
	}
	if _, ok := got["NOPE"]; ok {
		t.Errorf("未定義の名前に値が出た: %v", got)
	}

	// 名前なしは 400
	rec = httptest.NewRecorder()
	h.handleMacroValues(rec, httptest.NewRequest("GET", "/api/macro-values?names=", nil))
	if rec.Code != 400 {
		t.Errorf("空の names が %d を返した（400 のはず）", rec.Code)
	}
}

// 定義の無い語を引くたびに全域スキャンへ落ちると、大きなツリーでは毎回
// 打ち切りまで待たされる（UI は「定義を検索中」のまま固まって見える）。
// 逆に確定できないのに省くと、索引の外にある定義を取りこぼす。
func TestAuthoritativeGtagsMiss(t *testing.T) {
	tests := []struct {
		name                               string
		answered, stale, preloaded, direct bool
		want                               bool
	}{
		{"直接起動で答えた: 確定できる", true, false, false, true, true},
		{"プリロード表がある: 確定できる", true, false, true, false, true},
		{"索引が古い: 確定できない", true, true, true, true, false},
		{"gtags がエラー: 確定できない", false, false, true, true, false},
		{"迂回経路かつ表も無い: 確定できない", true, false, false, false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := authoritativeGtagsMiss(tt.answered, tt.stale, tt.preloaded, tt.direct); got != tt.want {
				t.Errorf("got %v, want %v", got, tt.want)
			}
		})
	}
}
