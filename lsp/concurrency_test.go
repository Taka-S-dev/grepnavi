package lsp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// safeBuf は goroutine から書かれる応答を受ける。
type safeBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (w *safeBuf) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.b.Write(p)
}

func (w *safeBuf) frames(t *testing.T) []map[string]any {
	t.Helper()
	w.mu.Lock()
	defer w.mu.Unlock()
	var out []map[string]any
	r := bufio.NewReader(bytes.NewReader(w.b.Bytes()))
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return out
		}
		if !strings.HasPrefix(line, "Content-Length:") {
			continue
		}
		var n int
		fmt.Sscanf(strings.TrimSpace(strings.TrimPrefix(line, "Content-Length:")), "%d", &n)
		r.ReadString('\n')
		body := make([]byte, n)
		if _, err := io.ReadFull(r, body); err != nil {
			return out
		}
		var m map[string]any
		json.Unmarshal(body, &m)
		out = append(out, m)
	}
}

func frame(msg string) string { return fmt.Sprintf("Content-Length: %d\r\n\r\n%s", len(msg), msg) }

// 読み取りループは要求ごとに goroutine を起こし、応答は要求の順に依らず返る。
// 通知（didOpen）はループ内で先に反映されるので、後続の要求はその文書を見る。
func TestRunServesRequestsConcurrently(t *testing.T) {
	dir := writeTestProject(t)
	pr, pw := io.Pipe()
	out := &safeBuf{}
	s := newServer(dir, bufio.NewReader(pr), out)
	done := make(chan error, 1)
	go func() { done <- s.run() }()

	mainURI := pathToURI(filepath.Join(dir, "main.c"))
	send := func(msg string) { pw.Write([]byte(frame(msg))) }
	send(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"rootUri":"` + pathToURI(dir) + `"}}`)
	send(`{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"` + mainURI + `","text":"int helper(int x);\nint run(void) {\n\treturn helper(41);\n}\n"}}}`)
	for id := 2; id <= 5; id++ {
		send(fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"textDocument/definition","params":{"textDocument":{"uri":"%s"},"position":{"line":2,"character":9}}}`, id, mainURI))
	}
	send(`{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":999}}`) // 知らない ID は無視
	send(`{"jsonrpc":"2.0","id":6,"method":"shutdown"}`)
	send(`{"jsonrpc":"2.0","method":"exit"}`)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("run did not return")
	}
	got := map[float64]map[string]any{}
	for _, f := range out.frames(t) {
		if id, ok := f["id"].(float64); ok {
			got[id] = f
		}
	}
	for id := 1.0; id <= 6; id++ {
		if _, ok := got[id]; !ok {
			t.Errorf("no response for id %v", id)
		}
	}
	for id := 2.0; id <= 5; id++ {
		locs, _ := got[id]["result"].([]any)
		if len(locs) == 0 {
			t.Errorf("definition %v returned nothing: %v", id, got[id])
		}
	}
}

// 処理待ちの要求を $/cancelRequest で取り消すと、RequestCancelled で応答して終わる。
func TestCancelRequestWhileQueued(t *testing.T) {
	dir := writeTestProject(t)
	out := &safeBuf{}
	s := newServer(dir, bufio.NewReader(strings.NewReader("")), out)
	for i := 0; i < maxInFlight; i++ {
		s.sem <- struct{}{} // 枠を全部埋めて、次の要求を待たせる
	}
	req := &request{ID: json.RawMessage("7"), Method: "textDocument/hover", Params: json.RawMessage(`{}`)}
	s.wg.Add(1)
	go s.serveRequest(req)
	deadline := time.Now().Add(5 * time.Second)
	for {
		s.cancelMu.Lock()
		_, registered := s.cancels["7"]
		s.cancelMu.Unlock()
		if registered || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	s.cancelRequest(json.RawMessage(`{"id":7}`))
	s.wg.Wait()
	fs := out.frames(t)
	if len(fs) != 1 {
		t.Fatalf("frames = %d, want 1", len(fs))
	}
	e, _ := fs[0]["error"].(map[string]any)
	if e == nil || e["code"].(float64) != codeRequestCancelled {
		t.Errorf("response = %v, want RequestCancelled", fs[0])
	}
	if _, still := s.cancels["7"]; still {
		t.Error("cancel entry was not removed")
	}
}

// 取り消された context はハンドラの検索を止める（期限つき context の親になる）。
func TestRequestContextInheritsCancellation(t *testing.T) {
	s := &server{}
	parent, cancel := context.WithCancel(context.Background())
	ctx, c2 := s.requestContext(parent)
	defer c2()
	cancel()
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Error("request context did not follow the parent's cancellation")
	}
}
