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
