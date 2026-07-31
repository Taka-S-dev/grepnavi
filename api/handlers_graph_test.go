package api

import (
	"bytes"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"grepnavi/graph"
)

// ブラウザは range memo を camelCase (startLine/endLine) で送るが、
// graph.RangeMemo の JSON タグは snake_case (start_line/end_line) なので、
// PUT /api/graph/memos がそのままデコードすると StartLine/EndLine が 0 のまま
// 保存され、以後 ShiftLines が何も動かさない実質 no-op になる。
// camelCase を受け付けて変換することを確認する。
func TestHandleGraphMemosAcceptsCamelCaseRangeMemo(t *testing.T) {
	dir := t.TempDir()
	st := graph.NewStore(filepath.Join(dir, "g.json"), dir)
	t.Cleanup(st.Close)
	h := &Handler{store: st, root: dir, events: NewEventBus()}

	body := `{"range_memos":[{"id":"r1","file":"a.c","startLine":10,"endLine":17,"memo":"range"}]}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("PUT", "/api/graph/memos", bytes.NewBufferString(body))
	h.handleGraphMemos(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	g := st.GetGraphResponse()
	if len(g.RangeMemos) != 1 {
		t.Fatalf("range memos = %+v, want 1", g.RangeMemos)
	}
	if g.RangeMemos[0].StartLine == 0 || g.RangeMemos[0].EndLine == 0 {
		t.Fatalf("StartLine/EndLine not populated from camelCase input: %+v", g.RangeMemos[0])
	}
	if g.RangeMemos[0].StartLine != 10 || g.RangeMemos[0].EndLine != 17 {
		t.Errorf("StartLine/EndLine = %d/%d, want 10/17", g.RangeMemos[0].StartLine, g.RangeMemos[0].EndLine)
	}
}
