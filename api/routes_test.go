package api

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
)

// 挿入系の固定パス (/removeall /toggle /wrap /group) は、末尾スラッシュの
// "/api/insertions/" (= ID 指定) と同じ前置きを持つ。ServeMux の最長一致で
// 固定パス側が勝つ前提だが、他のテストはハンドラを直接呼ぶのでその前提自体は
// どこも見ていなかった。登録の綴りを間違えても気づけるよう、実際の mux を通す。
func TestInsertionRoutesReachTheirHandlers(t *testing.T) {
	h, _ := newInsertionsTestHandler(t)
	mux := http.NewServeMux()
	h.Register(mux)

	// ID 指定ハンドラに吸われていれば 404 か 405 になる。固定パスへ届いていれば
	// それぞれの入力検証まで進む。
	cases := []struct {
		name   string
		method string
		path   string
		body   string
		want   int
	}{
		{"group", "POST", "/api/insertions/group", `{}`, 400},                          // id required
		{"toggle", "POST", "/api/insertions/toggle", `{}`, 400},                        // enabled required
		{"wrap", "POST", "/api/insertions/wrap", `{"start_line":0,"end_line":0}`, 400}, // invalid range
		{"removeall", "POST", "/api/insertions/removeall", `{}`, 200},                  // 対象ゼロでも成功
		{"by id", "DELETE", "/api/insertions/GN404", "", 404},                          // ID 指定は従来どおり
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(c.method, c.path, bytes.NewBufferString(c.body))
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)
			if rec.Code != c.want {
				t.Errorf("%s %s: status = %d, want %d (body=%s)", c.method, c.path, rec.Code, c.want, rec.Body.String())
			}
		})
	}
}
