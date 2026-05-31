package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// EventBus は in-process pub/sub。HTTP API ハンドラから Publish、
// /api/events SSE クライアントへ fan-out する。
// 購読者が遅い場合は drop (バッファ 16)。配送保証が必要な用途には向かない。
type EventBus struct {
	mu   sync.RWMutex
	subs map[chan Event]struct{}
}

type Event struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

func NewEventBus() *EventBus {
	return &EventBus{subs: make(map[chan Event]struct{})}
}

func (b *EventBus) Subscribe() (<-chan Event, func()) {
	ch := make(chan Event, 16)
	b.mu.Lock()
	b.subs[ch] = struct{}{}
	b.mu.Unlock()
	cancel := func() {
		b.mu.Lock()
		if _, ok := b.subs[ch]; ok {
			delete(b.subs, ch)
			close(ch)
		}
		b.mu.Unlock()
	}
	return ch, cancel
}

func (b *EventBus) Publish(evType string, payload interface{}) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	ev := Event{Type: evType, Data: data}
	b.mu.RLock()
	defer b.mu.RUnlock()
	for ch := range b.subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

// --- /api/events (SSE) ---

func (h *Handler) handleEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	ch, cancel := h.events.Subscribe()
	defer cancel()

	// 接続確認用の hello。クライアント側で onopen より確実に検知できる。
	fmt.Fprint(w, "event: hello\ndata: {}\n\n")
	flusher.Flush()

	ctx := r.Context()
	// プロキシ越しの idle timeout 切断を避けるための ping
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		case ev, ok := <-ch:
			if !ok {
				return
			}
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Type, ev.Data)
			flusher.Flush()
		}
	}
}
