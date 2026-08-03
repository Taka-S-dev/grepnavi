package api

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"grepnavi/graph"
)

func newInsertionsTestHandler(t *testing.T) (*Handler, string) {
	t.Helper()
	dir := t.TempDir()
	st := graph.NewStore(filepath.Join(dir, "g.json"), dir)
	t.Cleanup(st.Close)
	h := &Handler{store: st, root: dir, events: NewEventBus()}
	h.EnableFileWrites()
	return h, dir
}

func doInsertionsReq(h *Handler, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	switch {
	case path == "/api/insertions":
		h.handleInsertions(rec, req)
	case path == "/api/insertions/removeall":
		h.handleInsertionsRemoveAll(rec, req)
	case path == "/api/insertions/toggle":
		h.handleInsertionsToggle(rec, req)
	case path == "/api/insertions/wrap":
		h.handleInsertionsWrap(rec, req)
	case path == "/api/insertions/group":
		h.handleInsertionsGroup(rec, req)
	default:
		h.handleInsertionByID(rec, req)
	}
	return rec
}

func decodeJSON(t *testing.T, rec *httptest.ResponseRecorder, v interface{}) {
	t.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), v); err != nil {
		t.Fatalf("json.Unmarshal: %v, body=%s", err, rec.Body.String())
	}
}

// タグ置換で挿入した行が、removeall で完全に元通りに撤去されることを確認する。
func TestInsertAndRemoveAllRestoresFile(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	original := []byte("one\ntwo\nthree")
	os.WriteFile(src, original, 0o644)
	os.Chtimes(src, time.Unix(1000, 0), time.Unix(1000, 0))

	rec := doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":1,"lines":["printf(\"[{tag}] hit\\n\");"]}`)
	if rec.Code != 200 {
		t.Fatalf("insert status = %d, body = %s", rec.Code, rec.Body.String())
	}
	os.Chtimes(src, time.Unix(2000, 0), time.Unix(2000, 0))

	got, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	want := "one\nprintf(\"[GN1] hit\\n\");\ntwo\nthree"
	if string(got) != want {
		t.Fatalf("file after insert = %q, want %q", got, want)
	}

	g := h.store.GetGraphResponse()
	if len(g.Insertions) != 1 || g.Insertions[0].Sites[0].Line != 2 {
		t.Fatalf("insertions = %+v", g.Insertions)
	}

	rec2 := doInsertionsReq(h, "POST", "/api/insertions/removeall", "{}")
	if rec2.Code != 200 {
		t.Fatalf("removeall status = %d, body = %s", rec2.Code, rec2.Body.String())
	}
	os.Chtimes(src, time.Unix(3000, 0), time.Unix(3000, 0))

	restored, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(restored, original) {
		t.Fatalf("file after removeall = %q, want original %q", restored, original)
	}

	g2 := h.store.GetGraphResponse()
	if len(g2.Insertions) != 0 {
		t.Fatalf("insertions after removeall = %+v, want empty", g2.Insertions)
	}
}

// 挿入で下にずれたピンやメモの行番号が、応答の shift とサーバ側の両方で追従すること。
func TestInsertShiftsPins(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("one\ntwo\nthree"), 0o644)
	os.Chtimes(src, time.Unix(1000, 0), time.Unix(1000, 0))

	k := src + "::2"
	if err := h.store.UpdateMemos(graph.MemoSnapshot{
		LineMemos:     map[string]string{k: "メモ"},
		LineMemoTexts: map[string]string{k: "two"},
	}); err != nil {
		t.Fatal(err)
	}

	rec := doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":1,"lines":["x"]}`)
	if rec.Code != 200 {
		t.Fatalf("insert status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Shift graph.ShiftResult `json:"shift"`
	}
	decodeJSON(t, rec, &out)
	if out.Shift.MemoKeyMoves[k] != src+"::3" {
		t.Errorf("response shift.memo_key_moves = %+v, want %s -> %s::3", out.Shift.MemoKeyMoves, k, src)
	}

	g := h.store.GetGraphResponse()
	if g.LineMemos[src+"::3"] != "メモ" {
		t.Errorf("server-side memo did not follow: %+v", g.LineMemos)
	}
	if _, ok := g.LineMemos[k]; ok {
		t.Error("old memo key still present")
	}
}

// 挿入後にファイルの該当行を直接書き換えると、DELETE は409を返しファイルもレコードも変わらない。
func TestDeleteModifiedSkipped(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("one\ntwo\nthree"), 0o644)
	os.Chtimes(src, time.Unix(1000, 0), time.Unix(1000, 0))

	rec := doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":1,"lines":["printf(\"hit\");"]}`)
	if rec.Code != 200 {
		t.Fatalf("insert status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var ins struct {
		Insertion graph.Insertion `json:"insertion"`
	}
	decodeJSON(t, rec, &ins)
	id := ins.Insertion.ID

	// 外部エディタによる書き換えを模す: 記録行のテキストが変わる
	os.WriteFile(src, []byte("one\nprintf(\"hit\"); // edited\ntwo\nthree"), 0o644)
	os.Chtimes(src, time.Unix(2000, 0), time.Unix(2000, 0))
	beforeDelete, _ := os.ReadFile(src)

	recDel := doInsertionsReq(h, "DELETE", "/api/insertions/"+id, "")
	if recDel.Code != 409 {
		t.Fatalf("delete status = %d, body = %s", recDel.Code, recDel.Body.String())
	}
	var status struct {
		Status string `json:"status"`
	}
	decodeJSON(t, recDel, &status)
	if status.Status != "modified" {
		t.Errorf("status = %q, want modified", status.Status)
	}

	afterDelete, _ := os.ReadFile(src)
	if !bytes.Equal(beforeDelete, afterDelete) {
		t.Errorf("file changed despite conflict: %q -> %q", beforeDelete, afterDelete)
	}
	g := h.store.GetGraphResponse()
	if len(g.Insertions) != 1 {
		t.Errorf("insertion record changed despite conflict: %+v", g.Insertions)
	}
}

// 挿入後にファイル先頭へ外部で1行足されて記録行がずれても、完全一致検索で見つけて撤去できる。
func TestDeleteAfterExternalShift(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("one\ntwo\nthree"), 0o644)
	os.Chtimes(src, time.Unix(1000, 0), time.Unix(1000, 0))

	rec := doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":1,"lines":["printf(\"hit\");"]}`)
	if rec.Code != 200 {
		t.Fatalf("insert status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var ins struct {
		Insertion graph.Insertion `json:"insertion"`
	}
	decodeJSON(t, rec, &ins)
	id := ins.Insertion.ID
	if ins.Insertion.Sites[0].Line != 2 {
		t.Fatalf("recorded line = %d, want 2", ins.Insertion.Sites[0].Line)
	}

	// 外部で先頭に1行足す。記録している行(2)は実際には3行目にずれる。
	os.WriteFile(src, []byte("zero\none\nprintf(\"hit\");\ntwo\nthree"), 0o644)
	os.Chtimes(src, time.Unix(2000, 0), time.Unix(2000, 0))

	recDel := doInsertionsReq(h, "DELETE", "/api/insertions/"+id, "")
	if recDel.Code != 200 {
		t.Fatalf("delete status = %d, body = %s", recDel.Code, recDel.Body.String())
	}

	got, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	want := "zero\none\ntwo\nthree"
	if string(got) != want {
		t.Fatalf("file after delete = %q, want %q", got, want)
	}
	g := h.store.GetGraphResponse()
	if len(g.Insertions) != 0 {
		t.Errorf("insertion record still present: %+v", g.Insertions)
	}
}

// EnableFileWrites を呼ばないハンドラでは挿入系APIが403になる。
func TestWritesDisabled(t *testing.T) {
	dir := t.TempDir()
	st := graph.NewStore(filepath.Join(dir, "g.json"), dir)
	t.Cleanup(st.Close)
	h := &Handler{store: st, root: dir, events: NewEventBus()} // EnableFileWrites を呼ばない
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("one\ntwo\nthree"), 0o644)

	rec := doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":1,"lines":["x"]}`)
	if rec.Code != 403 {
		t.Fatalf("status = %d, body = %s, want 403", rec.Code, rec.Body.String())
	}
	got, _ := os.ReadFile(src)
	if string(got) != "one\ntwo\nthree" {
		t.Errorf("file was modified despite writes disabled: %q", got)
	}
}

// root 外の絶対パスを指定すると拒否される。
func TestFileOutsideRootRejected(t *testing.T) {
	h, _ := newInsertionsTestHandler(t)
	outside := t.TempDir()
	src := filepath.Join(outside, "a.c")
	os.WriteFile(src, []byte("one\ntwo\nthree"), 0o644)

	rec := doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":1,"lines":["x"]}`)
	if rec.Code != 403 && rec.Code != 400 {
		t.Fatalf("status = %d, body = %s, want 400/403", rec.Code, rec.Body.String())
	}
	got, _ := os.ReadFile(src)
	if string(got) != "one\ntwo\nthree" {
		t.Errorf("file outside root was modified: %q", got)
	}
}

// lines[] に改行を含む要素があると、記録した1サイトが実際には複数物理行
// になり、以後の行数勘定が永久にずれる（CachedLines の1行と二度と完全一致
// しない = DELETE が永久に409になる）。API境界で拒否すること。
func TestInsertRejectsEmbeddedNewline(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("one\ntwo\nthree"), 0o644)
	os.Chtimes(src, time.Unix(1000, 0), time.Unix(1000, 0))

	rec := doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":1,"lines":["a\nb"]}`)
	if rec.Code != 400 {
		t.Fatalf("status = %d, body = %s, want 400", rec.Code, rec.Body.String())
	}
	got, _ := os.ReadFile(src)
	if string(got) != "one\ntwo\nthree" {
		t.Errorf("file was modified despite rejected input: %q", got)
	}
	g := h.store.GetGraphResponse()
	if len(g.Insertions) != 0 {
		t.Errorf("insertion recorded despite rejected input: %+v", g.Insertions)
	}
}

// PUT の new_text も同じ理由で改行混入を拒否する。
func TestPutRejectsEmbeddedNewline(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("one\ntwo\nthree"), 0o644)
	os.Chtimes(src, time.Unix(1000, 0), time.Unix(1000, 0))

	rec := doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":1,"lines":["x"]}`)
	if rec.Code != 200 {
		t.Fatalf("insert status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var ins struct {
		Insertion graph.Insertion `json:"insertion"`
	}
	decodeJSON(t, rec, &ins)
	id := ins.Insertion.ID
	os.Chtimes(src, time.Unix(2000, 0), time.Unix(2000, 0))
	before, _ := os.ReadFile(src)

	recPut := doInsertionsReq(h, "PUT", "/api/insertions/"+id, `{"site":0,"new_text":"a\r\nb"}`)
	if recPut.Code != 400 {
		t.Fatalf("status = %d, body = %s, want 400", recPut.Code, recPut.Body.String())
	}
	after, _ := os.ReadFile(src)
	if !bytes.Equal(before, after) {
		t.Errorf("file changed despite rejected input: %q -> %q", before, after)
	}
}

// DELETE のエラーマッピングが POST/PUT と揃っていること: ファイルが外部で
// UTF-16 相当(NULバイト混入)へ書き換えられた場合、patch.Load は
// ErrUnsupportedEncoding を返し、DELETE はそれを415として返さねばならない
// （以前は一律500に潰していた）。
func TestDeleteUnsupportedEncodingMapped(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("one\ntwo\nthree"), 0o644)
	os.Chtimes(src, time.Unix(1000, 0), time.Unix(1000, 0))

	rec := doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":1,"lines":["x"]}`)
	if rec.Code != 200 {
		t.Fatalf("insert status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var ins struct {
		Insertion graph.Insertion `json:"insertion"`
	}
	decodeJSON(t, rec, &ins)
	id := ins.Insertion.ID

	// 外部で NUL バイト混入（UTF-16 相当）へ書き換えられたことを模す。
	os.WriteFile(src, []byte("o\x00n\x00e\x00\n"), 0o644)
	os.Chtimes(src, time.Unix(2000, 0), time.Unix(2000, 0))

	recDel := doInsertionsReq(h, "DELETE", "/api/insertions/"+id, "")
	if recDel.Code != 415 {
		t.Fatalf("delete status = %d, body = %s, want 415", recDel.Code, recDel.Body.String())
	}
}

// 挿入後にファイル自体が消えている場合、DELETE はファイルへの splice を
// 諦めて記録だけを削除する (仕様「ファイルなし → 記録の削除のみ可能」)。
// 以前は patch.Load の ErrNotExist が一律500に潰れ、記録が永久に残っていた。
func TestDeleteInsertionFileGone(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("one\ntwo\nthree"), 0o644)
	os.Chtimes(src, time.Unix(1000, 0), time.Unix(1000, 0))

	rec := doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":1,"lines":["printf(\"hit\");"]}`)
	if rec.Code != 200 {
		t.Fatalf("insert status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var ins struct {
		Insertion graph.Insertion `json:"insertion"`
	}
	decodeJSON(t, rec, &ins)
	id := ins.Insertion.ID

	if err := os.Remove(src); err != nil {
		t.Fatal(err)
	}

	recDel := doInsertionsReq(h, "DELETE", "/api/insertions/"+id, "")
	if recDel.Code != 200 {
		t.Fatalf("delete status = %d, body = %s, want 200", recDel.Code, recDel.Body.String())
	}
	g := h.store.GetGraphResponse()
	if len(g.Insertions) != 0 {
		t.Errorf("insertion record still present after file was deleted: %+v", g.Insertions)
	}
}

// insMu が POST の read-modify-write + store 更新を直列化しているか:
// 同時に複数の挿入を投げても、タグが重複したり行が失われたりしない。
func TestConcurrentInsertsSerialized(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("one\ntwo\nthree"), 0o644)
	os.Chtimes(src, time.Unix(1000, 0), time.Unix(1000, 0))

	const n = 10
	var wg sync.WaitGroup
	codes := make([]int, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			rec := doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":1,"lines":["y"]}`)
			codes[i] = rec.Code
		}(i)
	}
	wg.Wait()

	for i, c := range codes {
		if c != 200 {
			t.Errorf("goroutine %d: status = %d, want 200", i, c)
		}
	}

	g := h.store.GetGraphResponse()
	if len(g.Insertions) != n {
		t.Fatalf("insertions = %d, want %d (lost update under concurrency?)", len(g.Insertions), n)
	}
	seen := map[string]bool{}
	for _, ins := range g.Insertions {
		if seen[ins.ID] {
			t.Fatalf("duplicate insertion ID %q: tag allocation not serialized", ins.ID)
		}
		seen[ins.ID] = true
	}

	got, _ := os.ReadFile(src)
	wantLines := 3 + n // original 3 lines + n inserted, none lost or overwritten
	if gotLines := bytes.Count(got, []byte("\n")) + 1; gotLines != wantLines {
		t.Errorf("file has %d lines (raw=%q), want %d", gotLines, got, wantLines)
	}
}

// jsonPath は Windows のパス区切り \ を JSON 文字列リテラル内で正しくエスケープする。
func jsonPath(p string) string {
	b, _ := json.Marshal(p)
	s := string(b)
	return s[1 : len(s)-1] // 前後の " を剥がす（呼び出し側で文字列に埋め込むため）
}

// グループは撤去の単位。挿入時に記録され、{group} でテンプレにも埋め込める。
func TestInsertGroupStoredAndPlaceholder(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("one\ntwo"), 0o644)
	os.Chtimes(src, time.Unix(1000, 0), time.Unix(1000, 0))

	rec := doInsertionsReq(h, "POST", "/api/insertions",
		`{"file":"`+jsonPath(src)+`","line":1,"group":"path-A","lines":["printf(\"[{tag}|{group}]\\n\");"]}`)
	if rec.Code != 200 {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	g := h.store.GetGraphResponse()
	if len(g.Insertions) != 1 || g.Insertions[0].Group != "path-A" {
		t.Fatalf("group が記録されていない: %+v", g.Insertions)
	}
	got, _ := os.ReadFile(src)
	if want := "one\nprintf(\"[GN1|path-A]\\n\");\ntwo"; string(got) != want {
		t.Fatalf("{group} 置換: got %q, want %q", got, want)
	}
}

func TestInsertGroupRejectsNewline(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("one\n"), 0o644)
	rec := doInsertionsReq(h, "POST", "/api/insertions",
		`{"file":"`+jsonPath(src)+`","line":1,"group":"a\nb","lines":["x"]}`)
	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

// removeall の group フィルタ: 指定グループだけ撤去。"" は無グループのみ、
// フィールド省略は従来どおり全部。
func TestRemoveAllGroupFilter(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("one\ntwo\nthree"), 0o644)
	os.Chtimes(src, time.Unix(1000, 0), time.Unix(1000, 0))

	post := func(line int, group, text string) {
		body := `{"file":"` + jsonPath(src) + `","line":` + strconv.Itoa(line) + `,"lines":["` + text + `"]`
		if group != "" {
			body += `,"group":"` + group + `"`
		}
		body += `}`
		rec := doInsertionsReq(h, "POST", "/api/insertions", body)
		if rec.Code != 200 {
			t.Fatalf("insert(%s) = %d: %s", group, rec.Code, rec.Body.String())
		}
	}
	post(1, "A", "// a1")
	post(2, "A", "// a2")
	post(3, "", "// ungrouped")

	rec := doInsertionsReq(h, "POST", "/api/insertions/removeall", `{"group":"A"}`)
	if rec.Code != 200 {
		t.Fatalf("removeall(A) = %d: %s", rec.Code, rec.Body.String())
	}
	g := h.store.GetGraphResponse()
	if len(g.Insertions) != 1 || g.Insertions[0].Group != "" {
		t.Fatalf("A だけ消えるはず: %+v", g.Insertions)
	}

	rec = doInsertionsReq(h, "POST", "/api/insertions/removeall", `{"group":""}`)
	if rec.Code != 200 {
		t.Fatalf("removeall(\"\") = %d: %s", rec.Code, rec.Body.String())
	}
	if g := h.store.GetGraphResponse(); len(g.Insertions) != 0 {
		t.Fatalf("無グループも消えるはず: %+v", g.Insertions)
	}
	if got, _ := os.ReadFile(src); string(got) != "one\ntwo\nthree" {
		t.Fatalf("復元されていない: %q", got)
	}
}

// トグルの核心は往復の可逆性: OFF はインデントの直後に // を入れるだけ、
// ON で挿入直後とバイト同一に戻る。行数が変わらないのでシフトも起きない。
func TestToggleRoundTrip(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("one\ntwo\nthree"), 0o644)

	rec := doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":1,"lines":["\tprintf(\"hit\");"]}`)
	if rec.Code != 200 {
		t.Fatalf("insert = %d: %s", rec.Code, rec.Body.String())
	}
	afterInsert, _ := os.ReadFile(src)

	rec = doInsertionsReq(h, "POST", "/api/insertions/toggle", `{"id":"GN1","enabled":false}`)
	if rec.Code != 200 {
		t.Fatalf("toggle off = %d: %s", rec.Code, rec.Body.String())
	}
	if got, _ := os.ReadFile(src); string(got) != "one\n\t//printf(\"hit\");\ntwo\nthree" {
		t.Fatalf("OFF はインデント直後に // が入るはず: %q", got)
	}
	g := h.store.GetGraphResponse()
	if len(g.Insertions) != 1 || g.Insertions[0].Enabled {
		t.Fatalf("enabled=false になっていない: %+v", g.Insertions)
	}
	if g.Insertions[0].Sites[0].Text != "\t//printf(\"hit\");" {
		t.Fatalf("Sites[].Text はディスクの行を写すはず: %q", g.Insertions[0].Sites[0].Text)
	}

	rec = doInsertionsReq(h, "POST", "/api/insertions/toggle", `{"id":"GN1","enabled":true}`)
	if rec.Code != 200 {
		t.Fatalf("toggle on = %d: %s", rec.Code, rec.Body.String())
	}
	if got, _ := os.ReadFile(src); !bytes.Equal(got, afterInsert) {
		t.Fatalf("ON で挿入直後に戻るはず: %q -> %q", afterInsert, got)
	}
	if g := h.store.GetGraphResponse(); !g.Insertions[0].Enabled {
		t.Fatalf("enabled=true に戻っていない: %+v", g.Insertions)
	}
}

// OFF 中でも撤去できること (Sites[].Text がディスクを写しているので照合が通る)。
func TestToggleOffThenRemoveAllRestoresOriginal(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	original := []byte("one\ntwo\nthree")
	os.WriteFile(src, original, 0o644)

	doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":2,"lines":["x"]}`)
	rec := doInsertionsReq(h, "POST", "/api/insertions/toggle", `{"enabled":false}`)
	if rec.Code != 200 {
		t.Fatalf("toggle = %d: %s", rec.Code, rec.Body.String())
	}
	rec = doInsertionsReq(h, "POST", "/api/insertions/removeall", "{}")
	if rec.Code != 200 {
		t.Fatalf("removeall = %d: %s", rec.Code, rec.Body.String())
	}
	if got, _ := os.ReadFile(src); !bytes.Equal(got, original) {
		t.Fatalf("OFF 中の撤去で復元されるはず: %q", got)
	}
}

// group フィルタは removeall と同じポインタ規約 (省略=全部、""=無グループ)。
func TestToggleGroupFilter(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("one\ntwo\nthree"), 0o644)

	doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":1,"group":"A","lines":["a"]}`)
	doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":3,"group":"B","lines":["b"]}`)

	rec := doInsertionsReq(h, "POST", "/api/insertions/toggle", `{"group":"A","enabled":false}`)
	if rec.Code != 200 {
		t.Fatalf("toggle(A) = %d: %s", rec.Code, rec.Body.String())
	}
	var res struct {
		Toggled []string `json:"toggled"`
	}
	decodeJSON(t, rec, &res)
	if len(res.Toggled) != 1 || res.Toggled[0] != "GN1" {
		t.Fatalf("A の1件だけトグルされるはず: %+v", res.Toggled)
	}
	for _, ins := range h.store.GetGraphResponse().Insertions {
		if ins.Group == "A" && ins.Enabled {
			t.Errorf("A が無効化されていない: %+v", ins)
		}
		if ins.Group == "B" && !ins.Enabled {
			t.Errorf("B まで無効化された: %+v", ins)
		}
	}
}

// 手動変更された行はトグルせず skipped に積む (409 と同じ「止まる」規約)。
// 対象外の他のデバッグ行は巻き添えにしない。
func TestToggleSkipsManuallyModifiedLine(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("one\ntwo"), 0o644)

	doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":1,"lines":["x"]}`)
	doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":3,"lines":["y"]}`)
	// GN1 の行 (2行目) を手で書き換える
	os.WriteFile(src, []byte("one\nMODIFIED\ntwo\ny"), 0o644)

	rec := doInsertionsReq(h, "POST", "/api/insertions/toggle", `{"enabled":false}`)
	if rec.Code != 200 {
		t.Fatalf("toggle = %d: %s", rec.Code, rec.Body.String())
	}
	var res struct {
		Toggled []string           `json:"toggled"`
		Skipped []skippedInsertion `json:"skipped"`
	}
	decodeJSON(t, rec, &res)
	if len(res.Toggled) != 1 || res.Toggled[0] != "GN2" {
		t.Fatalf("無事な GN2 はトグルされるはず: %+v", res.Toggled)
	}
	if len(res.Skipped) != 1 || res.Skipped[0].ID != "GN1" {
		t.Fatalf("GN1 は skipped に積まれるはず: %+v", res.Skipped)
	}
}

// 囲みは「選択範囲の前後に1行ずつ挿入」なので、撤去すれば完全に元へ戻る。
// ガード行のタグはずれた時の完全一致探索を一意にするための印。
func TestWrapAndDeleteRestoresFile(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	original := []byte("one\ntwo\nthree\nfour")
	os.WriteFile(src, original, 0o644)

	rec := doInsertionsReq(h, "POST", "/api/insertions/wrap",
		`{"file":"`+jsonPath(src)+`","start_line":2,"end_line":3,"group":"G"}`)
	if rec.Code != 200 {
		t.Fatalf("wrap = %d: %s", rec.Code, rec.Body.String())
	}
	if got, _ := os.ReadFile(src); string(got) != "one\n#if 0 /* GN1 */\ntwo\nthree\n#endif /* GN1 */\nfour" {
		t.Fatalf("囲み後のファイル: %q", got)
	}
	g := h.store.GetGraphResponse()
	if len(g.Insertions) != 1 {
		t.Fatalf("記録は1件のはず: %+v", g.Insertions)
	}
	sites := g.Insertions[0].Sites
	if len(sites) != 2 || sites[0].Line != 2 || sites[1].Line != 5 {
		t.Fatalf("sites は 2行目と5行目のはず: %+v", sites)
	}
	if g.Insertions[0].Group != "G" {
		t.Fatalf("group が記録されていない: %+v", g.Insertions[0])
	}

	recDel := doInsertionsReq(h, "DELETE", "/api/insertions/GN1", "")
	if recDel.Code != 200 {
		t.Fatalf("delete = %d: %s", recDel.Code, recDel.Body.String())
	}
	if got, _ := os.ReadFile(src); !bytes.Equal(got, original) {
		t.Fatalf("撤去で復元されるはず: %q", got)
	}
}

// 囲みの2回の ShiftLines が正しい座標系で呼ばれること: 囲み範囲より下の
// 既存デバッグ行は2行 (上下のガード分) 下がる。
func TestWrapShiftsExistingRecords(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("a\nb\nc\nd"), 0o644)

	doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":4,"lines":["x"]}`)
	rec := doInsertionsReq(h, "POST", "/api/insertions/wrap",
		`{"file":"`+jsonPath(src)+`","start_line":2,"end_line":3}`)
	if rec.Code != 200 {
		t.Fatalf("wrap = %d: %s", rec.Code, rec.Body.String())
	}
	for _, ins := range h.store.GetGraphResponse().Insertions {
		if ins.ID == "GN1" && ins.Sites[0].Line != 7 {
			t.Errorf("GN1 は5行目から7行目へ2行下がるはず: %+v", ins.Sites)
		}
	}
}

// 囲みのトグル: ガード2行の行頭に // が入って囲みが無力化され、ON で戻る。
func TestWrapToggleNeutralizesGuards(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("one\ntwo"), 0o644)

	doInsertionsReq(h, "POST", "/api/insertions/wrap",
		`{"file":"`+jsonPath(src)+`","start_line":1,"end_line":2}`)
	afterWrap, _ := os.ReadFile(src)

	rec := doInsertionsReq(h, "POST", "/api/insertions/toggle", `{"id":"GN1","enabled":false}`)
	if rec.Code != 200 {
		t.Fatalf("toggle = %d: %s", rec.Code, rec.Body.String())
	}
	if got, _ := os.ReadFile(src); string(got) != "//#if 0 /* GN1 */\none\ntwo\n//#endif /* GN1 */" {
		t.Fatalf("ガード2行が同時にコメントアウトされるはず: %q", got)
	}
	rec = doInsertionsReq(h, "POST", "/api/insertions/toggle", `{"id":"GN1","enabled":true}`)
	if rec.Code != 200 {
		t.Fatalf("toggle on = %d: %s", rec.Code, rec.Body.String())
	}
	if got, _ := os.ReadFile(src); !bytes.Equal(got, afterWrap) {
		t.Fatalf("ON で囲み直後に戻るはず: %q", got)
	}
}

// グループの付け替えはメタデータだけの操作。撒き終わってから単位を決められる
// ことが目的なので、無グループ↔名前付きの両方向が通り、ファイルは動かない。
func TestSetGroupMovesRecordWithoutTouchingFile(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("one\ntwo"), 0o644)

	doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":1,"lines":["x"]}`)
	before, _ := os.ReadFile(src)

	rec := doInsertionsReq(h, "POST", "/api/insertions/group", `{"id":"GN1","group":"probe"}`)
	if rec.Code != 200 {
		t.Fatalf("set group = %d: %s", rec.Code, rec.Body.String())
	}
	if g := h.store.GetGraphResponse(); g.Insertions[0].Group != "probe" {
		t.Fatalf("グループが付いていない: %+v", g.Insertions[0])
	}
	// 空文字は「無グループへ戻す」。removeall/toggle の "" と同じ意味にそろえる。
	rec = doInsertionsReq(h, "POST", "/api/insertions/group", `{"id":"GN1","group":""}`)
	if rec.Code != 200 {
		t.Fatalf("clear group = %d: %s", rec.Code, rec.Body.String())
	}
	if g := h.store.GetGraphResponse(); g.Insertions[0].Group != "" {
		t.Fatalf("無グループへ戻っていない: %+v", g.Insertions[0])
	}
	if after, _ := os.ReadFile(src); !bytes.Equal(before, after) {
		t.Errorf("ファイルが変わった: %q -> %q", before, after)
	}
}

// 変更後のグループが撤去・ON/OFF の絞り込みに効くことまで見る
// （付け替えても記録が繋がっていなければ意味がない）。
func TestSetGroupThenRemoveAllByNewGroup(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	original := []byte("one\ntwo\nthree")
	os.WriteFile(src, original, 0o644)

	doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":1,"lines":["a"]}`)
	doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":3,"lines":["b"]}`)
	doInsertionsReq(h, "POST", "/api/insertions/group", `{"id":"GN1","group":"keep"}`)

	rec := doInsertionsReq(h, "POST", "/api/insertions/removeall", `{"group":"keep"}`)
	if rec.Code != 200 {
		t.Fatalf("removeall = %d: %s", rec.Code, rec.Body.String())
	}
	g := h.store.GetGraphResponse()
	if len(g.Insertions) != 1 || g.Insertions[0].ID != "GN2" {
		t.Fatalf("付け替えた GN1 だけ消えるはず: %+v", g.Insertions)
	}
}

// 付け替えは絞り込みから外れる方向も効かないと意味がない
// （移した先だけ消えて、元のグループ指定では残る）。
func TestSetGroupRemovesRecordFromOldGroupFilter(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("one\ntwo"), 0o644)

	doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":1,"group":"old","lines":["x"]}`)
	doInsertionsReq(h, "POST", "/api/insertions/group", `{"id":"GN1","group":"new"}`)

	rec := doInsertionsReq(h, "POST", "/api/insertions/removeall", `{"group":"old"}`)
	if rec.Code != 200 {
		t.Fatalf("removeall(old) = %d: %s", rec.Code, rec.Body.String())
	}
	var res struct {
		Removed []string `json:"removed"`
	}
	decodeJSON(t, rec, &res)
	if len(res.Removed) != 0 {
		t.Fatalf("旧グループ指定では消えないはず: %+v", res.Removed)
	}
	// ON/OFF も同じ絞り込みを使うので、そちらも新グループ側で拾えることを見る。
	rec = doInsertionsReq(h, "POST", "/api/insertions/toggle", `{"group":"new","enabled":false}`)
	var tg struct {
		Toggled []string `json:"toggled"`
	}
	decodeJSON(t, rec, &tg)
	if len(tg.Toggled) != 1 || tg.Toggled[0] != "GN1" {
		t.Fatalf("新グループ指定で ON/OFF できるはず: %+v", tg.Toggled)
	}
}

func TestSetGroupTrimsName(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("one\n"), 0o644)
	doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":1,"lines":["x"]}`)

	doInsertionsReq(h, "POST", "/api/insertions/group", `{"id":"GN1","group":"  probe  "}`)
	if g := h.store.GetGraphResponse(); g.Insertions[0].Group != "probe" {
		t.Fatalf("前後の空白は落とすはず: %q", g.Insertions[0].Group)
	}
}

func TestSetGroupMethodAndWriteGuards(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("one\n"), 0o644)
	doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":1,"lines":["x"]}`)

	if rec := doInsertionsReq(h, "GET", "/api/insertions/group", ""); rec.Code != 405 {
		t.Errorf("GET status = %d, want 405", rec.Code)
	}
	h.fileWrites = false
	rec := doInsertionsReq(h, "POST", "/api/insertions/group", `{"id":"GN1","group":"x"}`)
	if rec.Code != 403 {
		t.Errorf("書き込み無効時 status = %d, want 403", rec.Code)
	}
	if g := h.store.GetGraphResponse(); g.Insertions[0].Group != "" {
		t.Errorf("403 なのに記録が変わった: %+v", g.Insertions[0])
	}
}

func TestSetGroupRejectsBadInput(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("one\n"), 0o644)
	doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+jsonPath(src)+`","line":1,"lines":["x"]}`)

	cases := []struct {
		body string
		want int
	}{
		{`{"id":"GN1","group":"a\nb"}`, 400},
		{`{"id":"GN1","group":"` + strings.Repeat("a", 121) + `"}`, 400},
		{`{"group":"x"}`, 400},
		{`{"id":"GN99","group":"x"}`, 404},
	}
	for _, c := range cases {
		rec := doInsertionsReq(h, "POST", "/api/insertions/group", c.body)
		if rec.Code != c.want {
			t.Errorf("body %s: status = %d, want %d", c.body, rec.Code, c.want)
		}
	}
	if g := h.store.GetGraphResponse(); g.Insertions[0].Group != "" {
		t.Errorf("弾いた入力でグループが変わった: %+v", g.Insertions[0])
	}
}

func TestWrapRejectsInvalidRange(t *testing.T) {
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	os.WriteFile(src, []byte("one\ntwo"), 0o644)

	for _, body := range []string{
		`{"file":"` + jsonPath(src) + `","start_line":0,"end_line":1}`,
		`{"file":"` + jsonPath(src) + `","start_line":2,"end_line":1}`,
		`{"file":"` + jsonPath(src) + `","start_line":1,"end_line":99}`,
	} {
		rec := doInsertionsReq(h, "POST", "/api/insertions/wrap", body)
		if rec.Code != 400 {
			t.Errorf("body %s: status = %d, want 400", body, rec.Code)
		}
	}
	if got, _ := os.ReadFile(src); string(got) != "one\ntwo" {
		t.Fatalf("不正入力でファイルが変わった: %q", got)
	}
}
