package api

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"grepnavi/graph"
)

// newAgentTestSetup はテスト用のツリーに実体のあるソースを1つ置く。
func newAgentTestSetup(t *testing.T) (*Handler, string) {
	t.Helper()
	h, dir := newInsertionsTestHandler(t)
	src := filepath.Join(dir, "a.c")
	if err := os.WriteFile(src, []byte("one\ntwo\nthree\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return h, jsonPath(src)
}

// doAgentReq は MCP ブリッジ等（ブラウザ以外）からの要求を再現する。
// ブラウザなら必ず付く Origin / Sec-Fetch-Site をどちらも付けない。
func doAgentReq(h *Handler, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	switch {
	case path == "/api/insertions":
		h.handleInsertions(rec, req)
	case path == "/api/insertions/removeall":
		h.handleInsertionsRemoveAll(rec, req)
	default:
		h.handleInsertionByID(rec, req)
	}
	return rec
}

// 既定でエージェントからの書き込みは通らない。-mcp だけを付けた利用者にとって
// 「ブリッジはソース read-only」は既存の約束なので、黙って書けるようにしない。
func TestAgentWriteBlockedWithoutFlag(t *testing.T) {
	h, src := newAgentTestSetup(t)
	rec := doAgentReq(h, "POST", "/api/insertions", `{"file":"`+src+`","line":1,"lines":["  x();"],"group":"g"}`)
	if rec.Code != 403 {
		t.Fatalf("status = %d, want 403 (body=%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "-mcp-insert") {
		t.Errorf("有効化の方法が伝わらない: %s", rec.Body.String())
	}
	// GUI からは同じ操作が通る（塞いだのはエージェント経路だけ）
	if rec := doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+src+`","line":1,"lines":["  x();"]}`); rec.Code != 200 {
		t.Fatalf("GUI insert = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
}

// 許可したうえで入れた分には出所が残る。GUI の一覧で「AI が撒いた行」を
// 見分けられないと、消し忘れの原因になる。
func TestAgentInsertRecordsSource(t *testing.T) {
	h, src := newAgentTestSetup(t)
	h.EnableMCPWrites()
	rec := doAgentReq(h, "POST", "/api/insertions", `{"file":"`+src+`","line":1,"lines":["  x();"],"group":"path-A"}`)
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
	var res struct {
		Insertion graph.Insertion `json:"insertion"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.Insertion.Source != graph.InsertionSourceMCP {
		t.Errorf("source = %q, want %q", res.Insertion.Source, graph.InsertionSourceMCP)
	}
	// GUI 経由は空のまま（既存の記録と同じ形）
	doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+src+`","line":1,"lines":["  y();"]}`)
	for _, ins := range h.store.GetGraphResponse().Insertions {
		if ins.Source != "" && ins.Source != graph.InsertionSourceMCP {
			t.Errorf("未知の source: %q", ins.Source)
		}
	}
}

// グループはエージェントの撒いた分を1操作で畳む単位。無グループを許すと、
// 散らばった仕込みを人が1件ずつ探すことになる。
func TestAgentInsertRequiresGroup(t *testing.T) {
	h, src := newAgentTestSetup(t)
	h.EnableMCPWrites()
	rec := doAgentReq(h, "POST", "/api/insertions", `{"file":"`+src+`","line":1,"lines":["  x();"]}`)
	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400 (body=%s)", rec.Code, rec.Body.String())
	}
	// GUI は従来どおり無グループで入れられる
	if rec := doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+src+`","line":1,"lines":["  x();"]}`); rec.Code != 200 {
		t.Errorf("GUI insert = %d, want 200", rec.Code)
	}
}

// 1コールの行数に上限を置く。人は目で見ながら足すが、ループに入った側は止まらない。
func TestAgentInsertLineCap(t *testing.T) {
	h, src := newAgentTestSetup(t)
	h.EnableMCPWrites()
	lines := make([]string, mcpMaxLinesPerInsert+1)
	for i := range lines {
		lines[i] = "  x();"
	}
	body, _ := json.Marshal(map[string]any{"file": src, "line": 1, "lines": lines, "group": "g"})
	if rec := doAgentReq(h, "POST", "/api/insertions", string(body)); rec.Code != 400 {
		t.Fatalf("status = %d, want 400 (body=%s)", rec.Code, rec.Body.String())
	}
}

// エージェントは自分が撒いたものだけ片付ける。人が見ている最中の printf が
// 消えると、消えた理由が誰にも分からなくなる。
func TestAgentRemovesOnlyItsOwn(t *testing.T) {
	h, src := newAgentTestSetup(t)
	h.EnableMCPWrites()

	guiRec := doInsertionsReq(h, "POST", "/api/insertions", `{"file":"`+src+`","line":1,"lines":["  gui();"],"group":"shared"}`)
	if guiRec.Code != 200 {
		t.Fatalf("GUI insert = %d", guiRec.Code)
	}
	var gui struct {
		Insertion graph.Insertion `json:"insertion"`
	}
	json.Unmarshal(guiRec.Body.Bytes(), &gui)

	agentRec := doAgentReq(h, "POST", "/api/insertions", `{"file":"`+src+`","line":1,"lines":["  ai();"],"group":"shared"}`)
	if agentRec.Code != 200 {
		t.Fatalf("agent insert = %d (body=%s)", agentRec.Code, agentRec.Body.String())
	}

	// 人が入れた1件をエージェントが名指しで消そうとしても通らない
	if rec := doAgentReq(h, "DELETE", "/api/insertions/"+gui.Insertion.ID, ""); rec.Code != 403 {
		t.Errorf("agent delete of GUI insertion = %d, want 403 (body=%s)", rec.Code, rec.Body.String())
	}

	// 一括撤去も自分の分だけ。残した件数を返して、全部消えたと誤解させない
	rec := doAgentReq(h, "POST", "/api/insertions/removeall", `{"group":"shared"}`)
	if rec.Code != 200 {
		t.Fatalf("removeall = %d (body=%s)", rec.Code, rec.Body.String())
	}
	var out struct {
		Removed      []string `json:"removed"`
		KeptNotYours int      `json:"kept_not_yours"`
	}
	json.Unmarshal(rec.Body.Bytes(), &out)
	if len(out.Removed) != 1 || out.KeptNotYours != 1 {
		t.Fatalf("removed=%v kept_not_yours=%d, want 1 と 1", out.Removed, out.KeptNotYours)
	}
	left := h.store.GetGraphResponse().Insertions
	if len(left) != 1 || left[0].ID != gui.Insertion.ID {
		t.Errorf("人が入れた分が残っていない: %+v", left)
	}
}
