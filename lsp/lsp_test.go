package lsp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"grepnavi/search"
)

// ---- フレーミング ----

func TestReadMessageFraming(t *testing.T) {
	body := `{"jsonrpc":"2.0","id":1,"method":"shutdown"}`
	raw := fmt.Sprintf("Content-Length: %d\r\n\r\n%s", len(body), body)
	s := &server{in: bufio.NewReader(strings.NewReader(raw))}
	req, err := s.readMessage()
	if err != nil {
		t.Fatal(err)
	}
	if req.Method != "shutdown" || string(req.ID) != "1" {
		t.Errorf("req = %+v", req)
	}
}

func TestReplyWritesFrame(t *testing.T) {
	var buf bytes.Buffer
	s := &server{out: &buf}
	if err := s.reply(json.RawMessage("7"), map[string]int{"a": 1}, nil); err != nil {
		t.Fatal(err)
	}
	got := buf.String()
	if !strings.HasPrefix(got, "Content-Length: ") || !strings.Contains(got, `"result":{"a":1}`) {
		t.Errorf("frame = %q", got)
	}
	// ヘッダの長さが本文と一致していること（ここがずれるとクライアントは沈黙する）
	var n int
	fmt.Sscanf(got, "Content-Length: %d", &n)
	bodyIdx := strings.Index(got, "\r\n\r\n") + 4
	if len(got)-bodyIdx != n {
		t.Errorf("Content-Length %d but body is %d bytes", n, len(got)-bodyIdx)
	}
}

// ---- 位置 → 識別子 ----

func TestWordAtPosition(t *testing.T) {
	src := "int ssl3_read(SSL *s) {\n\treturn ssl3_read_internal(s, buf);\n}\n"
	cases := []struct {
		line, ch int
		want     string
	}{
		{0, 4, "ssl3_read"},  // 語頭
		{0, 12, "ssl3_read"}, // 語尾の1つ手前
		{0, 13, "ssl3_read"}, // 語の直後（F12 は行末寄りでも効いてほしい）
		{1, 10, "ssl3_read_internal"},
		{0, 0, "int"},
		{0, 21, ""}, // '{' の上
	}
	for _, c := range cases {
		if got := wordAtPosition(src, position{Line: c.line, Character: c.ch}); got != c.want {
			t.Errorf("(%d,%d) = %q, want %q", c.line, c.ch, got, c.want)
		}
	}
}

func TestWordAtPositionUTF16(t *testing.T) {
	// 日本語コメントの後ろの識別子。LSP の文字位置は UTF-16 単位なので、
	// バイト位置で数えるとずれる（「状態」= UTF-16 で2単位、UTF-8 で6バイト）。
	src := "/* 状態 */ st = READY;\n"
	// UTF-16: '/','*',' ','状','態',' ','*','/',' ','s' → s は 9 文字目
	if got := wordAtPosition(src, position{Line: 0, Character: 10}); got != "st" {
		t.Errorf("got %q, want st", got)
	}
}

// ---- URI 変換 ----

func TestURIRoundTrip(t *testing.T) {
	if runtime.GOOS == "windows" {
		p := uriToPath("file:///c%3A/work/openssl/ssl/ssl_lib.c")
		if p != `c:\work\openssl\ssl\ssl_lib.c` {
			t.Errorf("uriToPath = %q", p)
		}
		u := pathToURI(`C:\work\a.c`)
		if u != "file:///C:/work/a.c" {
			t.Errorf("pathToURI = %q", u)
		}
	}
	// 往復して同じパスに戻ること
	p := filepath.Join(string(filepath.Separator)+"tmp", "x.c")
	if runtime.GOOS == "windows" {
		p = `D:\tmp\x.c`
	}
	if got := uriToPath(pathToURI(p)); got != p {
		t.Errorf("round trip: %q -> %q", p, got)
	}
}

// ---- ハンドラ統合（rg で動く経路。gtags 依存のテストは corpus 側の流儀に従い skip） ----

func writeTestProject(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "lib.c"), []byte(
		"int helper(int x) { return x + 1; }\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "main.c"), []byte(
		"int helper(int x);\n"+
			"int run(void) {\n"+
			"\treturn helper(41);\n"+
			"}\n"), 0o644)
	return dir
}

func TestDefinitionEndToEnd(t *testing.T) {
	dir := writeTestProject(t)
	s := &server{root: dir}
	uri := pathToURI(filepath.Join(dir, "main.c"))
	params, _ := json.Marshal(map[string]any{
		"textDocument": map[string]string{"uri": uri},
		"position":     map[string]int{"line": 2, "character": 9}, // helper(41) の上
	})
	res, rerr := s.handleDefinition(params)
	if rerr != nil {
		t.Fatalf("error: %+v", rerr)
	}
	locs := res.([]location)
	if len(locs) == 0 {
		t.Fatal("no definitions")
	}
	found := false
	for _, l := range locs {
		if strings.HasSuffix(uriToPath(l.URI), "lib.c") && l.Range.Start.Line == 0 {
			found = true
		}
	}
	if !found {
		t.Errorf("lib.c:1 not in results: %+v", locs)
	}
}

func TestIncomingCallsEndToEnd(t *testing.T) {
	if !search.GtagsInPath() {
		t.Skip("gtags なし")
	}
	dir := writeTestProject(t)
	if err := search.GtagsBuildIndex(context.Background(), dir); err != nil {
		t.Fatalf("gtags: %v", err)
	}
	s := &server{root: dir}
	item, _ := json.Marshal(map[string]any{"item": map[string]any{
		"name": "helper",
		"uri":  pathToURI(filepath.Join(dir, "lib.c")),
		"selectionRange": map[string]any{
			"start": map[string]int{"line": 0, "character": 0},
			"end":   map[string]int{"line": 0, "character": 0},
		},
	}})
	res, rerr := s.handleIncomingCalls(item)
	if rerr != nil {
		t.Fatalf("error: %+v", rerr)
	}
	b, _ := json.Marshal(res)
	if !strings.Contains(string(b), `"run"`) || !strings.Contains(string(b), "main.c") {
		t.Errorf("incoming calls = %s", b)
	}
}

// .grepnavi の「対象から外すもの」は LSP でも効く。API 層を経由しないので、
// ここで読み込みを忘れると GUI と答えが食い違う（除外した生成物がヒットに混ざる）。
func TestExcludesApplyToDefinition(t *testing.T) {
	dir := writeTestProject(t)
	os.WriteFile(filepath.Join(dir, ".grepnavi"), []byte(`{"exclude":["lib.c"]}`), 0o644)
	defer search.SetExcludes("", nil)
	s := &server{root: dir}
	init, _ := json.Marshal(map[string]string{"rootUri": pathToURI(dir)})
	s.handleInitialize(init)
	params, _ := json.Marshal(map[string]any{
		"textDocument": map[string]string{"uri": pathToURI(filepath.Join(dir, "main.c"))},
		"position":     map[string]int{"line": 2, "character": 9},
	})
	res, _ := s.handleDefinition(params)
	for _, l := range res.([]location) {
		if strings.HasSuffix(uriToPath(l.URI), "lib.c") {
			t.Fatalf("excluded lib.c still resolved: %+v", res)
		}
	}
}

// 呼び出し先アイテムは位置が呼び出し行（呼び出し元の中）なので、その位置で
// 囲む関数を取ると呼び出し元に戻って同じ子が何段でも出る。展開は Data に運んだ
// 名前の定義で行い、本体に呼び出しが無ければ空で止まること。
func TestOutgoingCallsExpandTheCalleeNotTheCaller(t *testing.T) {
	dir := writeTestProject(t)
	s := &server{root: dir}
	mainURI := pathToURI(filepath.Join(dir, "main.c"))
	item, _ := json.Marshal(map[string]any{"item": map[string]any{
		"name": "run", "uri": mainURI,
		"selectionRange": map[string]any{
			"start": map[string]int{"line": 1, "character": 0},
			"end":   map[string]int{"line": 1, "character": 0},
		},
	}})
	res, rerr := s.handleOutgoingCalls(item)
	if rerr != nil {
		t.Fatalf("error: %+v", rerr)
	}
	b, _ := json.Marshal(res)
	var calls []struct {
		To callHierarchyItem `json:"to"`
	}
	json.Unmarshal(b, &calls)
	if len(calls) != 1 || calls[0].To.Name != "helper" {
		t.Fatalf("run の呼び先 = %s, want helper だけ", b)
	}
	child := calls[0].To
	if child.Data == nil || child.Data.Callee != "helper" {
		t.Fatalf("子アイテムに展開用の名前が無い: %s", b)
	}
	if uriToPath(child.URI) != filepath.Join(dir, "main.c") || child.Range.Start.Line != 2 {
		t.Errorf("子アイテムの位置は呼び出し行のまま: %+v", child)
	}

	// エディタは受け取ったアイテムをそのまま返して展開を頼む
	again, _ := json.Marshal(map[string]any{"item": child})
	res2, rerr := s.handleOutgoingCalls(again)
	if rerr != nil {
		t.Fatalf("error: %+v", rerr)
	}
	b2, _ := json.Marshal(res2)
	if string(b2) != "[]" {
		t.Errorf("helper は何も呼ばないのに子が出る（呼び出し元に戻っている）: %s", b2)
	}
}

// キーワードは定義を探さない。索引 0 件のあと rg がツリー全体を走査し、直列の
// 受付を塞ぐ（openssl で `unsigned` に F12 → 20 分待ち）。
func TestKeywordsAreNotLookedUp(t *testing.T) {
	dir := writeTestProject(t)
	s := &server{root: dir}
	uri := pathToURI(filepath.Join(dir, "main.c"))
	for _, c := range []struct{ line, ch int }{{1, 0}, {2, 3}} { // `int` / `return`
		params, _ := json.Marshal(map[string]any{
			"textDocument": map[string]string{"uri": uri},
			"position":     map[string]int{"line": c.line, "character": c.ch},
		})
		if w, _ := s.wordAt(uri, position{Line: c.line, Character: c.ch}); w != "" {
			t.Errorf("wordAt(%d,%d) = %q, want \"\"", c.line, c.ch, w)
		}
		res, _ := s.handleDefinition(params)
		if locs := res.([]location); len(locs) != 0 {
			t.Errorf("keyword resolved to %+v", locs)
		}
	}
}
