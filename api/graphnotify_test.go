package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// 変更が通知されないとブラウザは古いまま。特にノードのメモ更新 (PUT) が
// 漏れていて、AI がメモを付けても画面に出なかった。
func TestNotifyGraphChange(t *testing.T) {
	tests := []struct {
		name   string
		method string
		path   string
		status int
		want   bool
	}{
		{"ノード追加", http.MethodPost, "/api/graph/node", 200, true},
		{"ノードのメモ更新", http.MethodPut, "/api/graph/node/abc", 200, true},
		{"ノード削除", http.MethodDelete, "/api/graph/node/abc", 200, true},
		{"読み取りは通知しない", http.MethodGet, "/api/graph", 200, false},
		{"失敗は通知しない", http.MethodPost, "/api/graph/node", 500, false},
		{"POST だが読み取り専用", http.MethodPost, "/api/graph/descriptions", 200, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := &Handler{events: NewEventBus()}
			ch, cancel := h.events.Subscribe()
			defer cancel()

			handler := h.notifyGraphChange(func(w http.ResponseWriter, r *http.Request) {
				if tt.status != 200 {
					w.WriteHeader(tt.status)
				}
				w.Write([]byte("{}"))
			})
			handler(httptest.NewRecorder(), httptest.NewRequest(tt.method, tt.path, nil))

			select {
			case ev := <-ch:
				if !tt.want {
					t.Errorf("通知されないはずが %q が流れた", ev.Type)
				} else if ev.Type != "graph.updated" {
					t.Errorf("Type = %q, want graph.updated", ev.Type)
				}
			case <-time.After(100 * time.Millisecond):
				if tt.want {
					t.Error("graph.updated が流れなかった")
				}
			}
		})
	}
}
