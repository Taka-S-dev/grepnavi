package api

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// editorStateFreshWindow は最後の PUT からこの時間以内なら fresh=true として返す。
// 20 秒に設定した根拠:
//   - browser side は 10 秒ごとに heartbeat PUT する (foreground タブのみ)
//   - 2 回連続で失敗してから初めて stale 判定 = 一時的ラグや packet drop で
//     誤って stale 化しない
//   - 一方で background タブ / 閉じたタブを 60 秒も「アクティブ」と誤認しない
const editorStateFreshWindow = 20 * time.Second

// CursorPosition は Monaco の cursor 位置 (1-based)。
type CursorPosition struct {
	Line   int `json:"line"`
	Column int `json:"column"`
}

// SelectionRange は明示的に範囲選択されたエリア (1-based, end inclusive)。
type SelectionRange struct {
	StartLine   int `json:"start_line"`
	StartColumn int `json:"start_column"`
	EndLine     int `json:"end_line"`
	EndColumn   int `json:"end_column"`
}

// Viewport は現在画面に表示されている行範囲。getVisibleRanges() ベース。
type Viewport struct {
	TopLine    int `json:"top_line"`
	BottomLine int `json:"bottom_line"`
}

// EditorState は browser の Monaco editor の現在状態のスナップショット。
// browser が定期 PUT し、bridge / AI が GET で参照する。
type EditorState struct {
	Root       string          `json:"root,omitempty"`
	ActiveFile string          `json:"active_file,omitempty"`
	Cursor     *CursorPosition `json:"cursor,omitempty"`
	Selection  *SelectionRange `json:"selection,omitempty"`
	Viewport   *Viewport       `json:"viewport,omitempty"`
}

// editorStateCache は最新の EditorState とその受信時刻を保持する。
// 読み書きが頻繁 (cursor 移動 / 10s heartbeat) なため RWMutex。
type editorStateCache struct {
	mu          sync.RWMutex
	state       EditorState
	lastUpdated time.Time
}

func newEditorStateCache() *editorStateCache {
	return &editorStateCache{}
}

func (c *editorStateCache) snapshot() (state EditorState, age time.Duration, fresh bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.lastUpdated.IsZero() {
		return EditorState{}, 0, false
	}
	age = time.Since(c.lastUpdated)
	fresh = age < editorStateFreshWindow
	return c.state, age, fresh
}

func (c *editorStateCache) set(s EditorState) {
	c.mu.Lock()
	c.state = s
	c.lastUpdated = time.Now()
	c.mu.Unlock()
}

// --- /api/editor-state ---

// handleEditorState は GET で最新スナップショット (+ fresh / age) を返し、
// PUT で browser からの状態更新を受け付ける。
//
// fresh が false でも state フィールドは直近の値を返す。判断 (stale 上で
// 操作するか user に聞き直すか) は呼び出し側 AI に委ねる。bridge 側 tool
// description で「fresh=false なら user に確認」を強制する設計。
func (h *Handler) handleEditorState(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		state, age, fresh := h.editorState.snapshot()
		resp := map[string]interface{}{
			"fresh":               fresh,
			"last_updated_ms_ago": age.Milliseconds(),
		}
		if state.Root != "" {
			resp["root"] = state.Root
		}
		if state.ActiveFile != "" {
			resp["active_file"] = state.ActiveFile
		}
		if state.Cursor != nil {
			resp["cursor"] = state.Cursor
		}
		if state.Selection != nil {
			resp["selection"] = state.Selection
		}
		if state.Viewport != nil {
			resp["viewport"] = state.Viewport
		}
		jsonOK(w, resp)
	case http.MethodPut:
		var req EditorState
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			jsonErr(w, err.Error(), http.StatusBadRequest)
			return
		}
		h.editorState.set(req)
		jsonOK(w, map[string]bool{"ok": true})
	default:
		http.Error(w, "GET or PUT only", http.StatusMethodNotAllowed)
	}
}
