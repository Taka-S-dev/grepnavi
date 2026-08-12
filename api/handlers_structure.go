package api

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"grepnavi/search"
)

// GET /api/structure?depth=1          … 全域を depth 階層で畳んだ参照マップ
// GET /api/structure?focus=ssl/record … 1モジュールの周辺だけを詳細に
//
// どちらも gtags の索引から計算する。索引が古いままでも地図は返るので、
// 位置情報と同じく stale を添えて「いつの地図か」を判断できるようにする。
func (h *Handler) handleStructure(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()

	q := r.URL.Query()
	search.GtagsRefreshStaleAsync(root)

	var payload any
	var err error
	if focus := q.Get("focus"); focus != "" {
		payload, err = search.StructMapFocus(r.Context(), root, focus)
	} else {
		depth, _ := strconv.Atoi(q.Get("depth"))
		payload, err = search.StructMapOverview(r.Context(), root, depth)
	}
	if errors.Is(err, search.ErrRefMapNotBuilt) {
		// 押した瞬間に数十秒使わない。状態と見込みを返して、生成は選ばせる
		st := search.RefMapStat(root)
		w.WriteHeader(http.StatusConflict)
		jsonOK(w, map[string]any{"root": root, "status": st})
		return
	}
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	jsonOK(w, map[string]any{
		"root":  root,
		"map":   payload,
		"stale": search.GtagsIsStale(),
	})
}

// GET /api/structure/status … 表があるか、無いなら生成にどれくらいかかるか
func (h *Handler) handleStructureStatus(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()
	jsonOK(w, search.RefMapStat(root))
}

// GET /api/structure/build … 生成しながら進捗を SSE で流す。
// gtags 索引の生成 (/api/gtags/stream) と同じ形。
func (h *Handler) handleStructureBuild(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	send := func(event, data string) {
		if event != "" {
			fmt.Fprintf(w, "event: %s\n", event)
		}
		fmt.Fprintf(w, "data: %s\n\n", data)
		flusher.Flush()
	}

	send("", "--- 参照マップの生成を開始: "+root+" ---")
	err := search.BuildRefMap(r.Context(), root, func(line string) { send("", line) })
	if err != nil {
		send("refmap-error", err.Error())
		return
	}
	send("refmap-done", "ok")
}
