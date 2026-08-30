package lsp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"testing"
	"time"
)

// runServer は読み取りループを起動し、送信関数と応答の取得関数を返す。
func runServer(t *testing.T, dir string) (send func(string), responses func() map[float64]map[string]any, wait func(), s *server) {
	t.Helper()
	pr, pw := io.Pipe()
	out := &safeBuf{}
	s = newServer(dir, bufio.NewReader(pr), out)
	done := make(chan error, 1)
	go func() { done <- s.run() }()
	send = func(msg string) { pw.Write([]byte(frame(msg))) }
	responses = func() map[float64]map[string]any {
		got := map[float64]map[string]any{}
		for _, f := range out.frames(t) {
			if id, ok := f["id"].(float64); ok {
				got[id] = f
			}
		}
		return got
	}
	wait = func() {
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(30 * time.Second):
			t.Fatal("run did not return")
		}
	}
	return send, responses, wait, s
}

func errorCode(f map[string]any) float64 {
	e, _ := f["error"].(map[string]any)
	if e == nil {
		return 0
	}
	return e["code"].(float64)
}

// 要求の直後に届いた $/cancelRequest も効く。取り消し口は要求の goroutine を
// 起こす前に登録されていなければならない: 後だと、goroutine が動き出す前に届いた
// 取り消しが「知らない ID」として捨てられ、要求は走り続ける。
func TestCancelArrivingRightAfterTheRequest(t *testing.T) {
	dir := writeTestProject(t)
	send, responses, wait, s := runServer(t, dir)
	send(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"rootUri":"` + pathToURI(dir) + `"}}`)
	for i := 0; i < maxInFlight; i++ {
		s.sem <- struct{}{} // 枠を全部埋める: 要求は枠待ちで止まり、取り消しだけが解放する
	}
	mainURI := pathToURI(filepath.Join(dir, "main.c"))
	send(`{"jsonrpc":"2.0","id":2,"method":"textDocument/hover","params":{"textDocument":{"uri":"` + mainURI + `"},"position":{"line":2,"character":9}}}`)
	send(`{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":2}}`)
	send(`{"jsonrpc":"2.0","id":3,"method":"shutdown"}`)
	send(`{"jsonrpc":"2.0","method":"exit"}`)
	wait()
	got := responses()
	if errorCode(got[2]) != codeRequestCancelled {
		t.Errorf("response to the cancelled request = %v, want RequestCancelled", got[2])
	}
	if _, ok := got[3]; !ok {
		t.Error("shutdown was not answered")
	}
}

// shutdown は処理中の要求を待つが、その間も $/cancelRequest を読む。
// 待つのが読み取りループ自身だと、待たれている要求を取り消す手段が無い。
func TestShutdownStillReadsCancellations(t *testing.T) {
	dir := writeTestProject(t)
	send, responses, wait, s := runServer(t, dir)
	send(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"rootUri":"` + pathToURI(dir) + `"}}`)
	for i := 0; i < maxInFlight; i++ {
		s.sem <- struct{}{}
	}
	mainURI := pathToURI(filepath.Join(dir, "main.c"))
	send(`{"jsonrpc":"2.0","id":2,"method":"textDocument/hover","params":{"textDocument":{"uri":"` + mainURI + `"},"position":{"line":2,"character":9}}}`)
	send(`{"jsonrpc":"2.0","id":3,"method":"shutdown"}`)
	send(`{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":2}}`)
	// shutdown の応答が出るまで待ってから exit（エディタもそうする）
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, ok := responses()[3]; ok || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	send(`{"jsonrpc":"2.0","method":"exit"}`)
	wait()
	got := responses()
	if errorCode(got[2]) != codeRequestCancelled {
		t.Errorf("request during shutdown = %v, want RequestCancelled", got[2])
	}
	if _, ok := got[3]; !ok {
		t.Error("shutdown was not answered after the request was cancelled")
	}
}

// initialize 前の要求は ServerNotInitialized、2 回目の initialize は InvalidRequest、
// shutdown 後の要求も InvalidRequest。
func TestLifecycleRejectsOutOfOrderRequests(t *testing.T) {
	dir := writeTestProject(t)
	send, responses, wait, _ := runServer(t, dir)
	mainURI := pathToURI(filepath.Join(dir, "main.c"))
	def := func(id int) string {
		return fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"textDocument/definition","params":{"textDocument":{"uri":"%s"},"position":{"line":2,"character":9}}}`, id, mainURI)
	}
	send(def(1))
	send(`{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"rootUri":"` + pathToURI(dir) + `"}}`)
	send(`{"jsonrpc":"2.0","id":3,"method":"initialize","params":{"rootUri":"` + pathToURI(dir) + `"}}`)
	send(def(4))
	send(`{"jsonrpc":"2.0","id":5,"method":"shutdown"}`)
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, ok := responses()[5]; ok || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	send(def(6))
	send(`{"jsonrpc":"2.0","method":"exit"}`)
	wait()
	got := responses()
	if errorCode(got[1]) != codeServerNotInitialized {
		t.Errorf("request before initialize = %v, want ServerNotInitialized", got[1])
	}
	if got[2]["result"] == nil {
		t.Errorf("initialize = %v, want capabilities", got[2])
	}
	if errorCode(got[3]) != codeInvalidRequest {
		t.Errorf("second initialize = %v, want InvalidRequest", got[3])
	}
	if locs, _ := got[4]["result"].([]any); len(locs) == 0 {
		t.Errorf("definition after initialize = %v, want a location", got[4])
	}
	if errorCode(got[6]) != codeInvalidRequest {
		t.Errorf("request after shutdown = %v, want InvalidRequest", got[6])
	}
}

// 引数の形が違う要求は InvalidParams（InvalidRequest ではない）。
func TestMalformedParamsReturnInvalidParams(t *testing.T) {
	s := &server{root: t.TempDir()}
	for _, method := range []string{"textDocument/definition", "textDocument/references", "textDocument/hover", "textDocument/documentSymbol", "textDocument/completion"} {
		_, rerr := s.dispatch(context.Background(), &request{Method: method, Params: json.RawMessage(`[1, 2]`)})
		if rerr == nil || rerr.Code != codeInvalidParams {
			t.Errorf("%s with array params -> %+v, want InvalidParams", method, rerr)
		}
	}
}
