package api

import (
	"net/http"
	"strings"
)

// グラフを変更したのにブラウザへ通知しないハンドラが大半で、
// 特にノードのメモ更新 (PUT /api/graph/node/<id>) が漏れていた。
// MCP の add_node は POST（通知あり）→ PUT でメモ設定（通知なし）の順に呼ぶため、
// ブラウザはメモが入る前に再読込して終わり、吹き出しが出なかった。
//
// 個別ハンドラに Publish を書き足す方式は、次にハンドラを足したとき必ず忘れる。
// ルータ側で「グラフを変更する要求が成功したら通知する」を一律に掛ける。
// 忘れたときに起きるのが「余計な再読込」であって「更新が見えない」ではない向きに倒す。

// _graphReadOnlyPOST は POST だがグラフを変更しないエンドポイント。
// ここに載せ忘れても実害は再読込が1回増えるだけ。
var _graphReadOnlyPOST = map[string]bool{
	"/api/graph/descriptions": true, // 一覧のツールチップ用に説明をまとめて取得する
	"/api/graph/export":       true, // 現在の内容を書き出すだけ
}

// notifyGraphChange は 2xx/3xx で終わった非 GET 要求のあとに graph.updated を流す。
func (h *Handler) notifyGraphChange(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet || r.Method == http.MethodHead ||
			_graphReadOnlyPOST[strings.TrimSuffix(r.URL.Path, "/")] {
			next(w, r)
			return
		}
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next(rec, r)
		if rec.status < 400 {
			h.events.Publish("graph.updated", map[string]any{"path": r.URL.Path})
		}
	}
}

// statusRecorder は書き込まれたステータスコードを覚えるだけの ResponseWriter。
type statusRecorder struct {
	http.ResponseWriter
	status  int
	written bool
}

func (w *statusRecorder) WriteHeader(code int) {
	if !w.written {
		w.status = code
		w.written = true
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusRecorder) Write(b []byte) (int, error) {
	w.written = true // 明示的な WriteHeader が無い = 200
	return w.ResponseWriter.Write(b)
}
