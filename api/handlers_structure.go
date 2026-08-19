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

	// brief=1 はエージェント向けの畳んだ形。UI 用の応答は openssl 全域で 47 KB
	// あり、そのまま渡しても読まれずに終わる（このプロジェクトで実測済み:
	// 19.3 KB の参照一覧はエージェントに捨てられ、素の grep に戻られた）
	brief := q.Get("brief") == "1"
	top, _ := strconv.Atoi(q.Get("top"))

	var payload any
	var err error
	if focus := q.Get("focus"); focus != "" {
		var f *search.StructFocus
		if f, err = search.StructMapFocus(r.Context(), root, focus); err == nil {
			payload = f
			if brief {
				payload = map[string]any{
					"module":   f.Module,
					"incoming": search.BriefEdges(f.Incoming, top),
					"internal": search.BriefEdges(f.Internal, top),
					"outgoing": search.BriefEdges(f.Outgoing, top),
					"counts": map[string]int{
						"incoming": len(f.Incoming), "internal": len(f.Internal), "outgoing": len(f.Outgoing),
					},
					"files":   map[string]int{"open": f.FilesOpen, "total": f.Files},
					"omitted": f.Omitted,
				}
			}
		}
	} else {
		depth, _ := strconv.Atoi(q.Get("depth"))
		var o *search.StructOverview
		if o, err = search.StructMapOverview(r.Context(), root, depth); err == nil {
			payload = o
			if brief {
				edges := search.BriefEdges(o.Edges, top)
				payload = search.StructBrief{
					Root: root, Edges: edges,
					Total: len(o.Edges), Shown: len(edges), Omitted: o.Omitted,
				}
			}
		}
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

// GET /api/structure/children?path=drivers … その直下のまとまり一覧。
// 地図の行は被参照順に 40 個へ絞られ、重さでの分割も入るので、そこに出ない
// ディレクトリはクリックだけでは辿り着けない。移動のための一覧なので、
// こちらは絞らずに全部返す。
func (h *Handler) handleStructureChildren(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()

	children, err := search.StructChildren(r.Context(), root, r.URL.Query().Get("path"))
	if errors.Is(err, search.ErrRefMapNotBuilt) {
		w.WriteHeader(http.StatusConflict)
		jsonOK(w, map[string]any{"root": root, "status": search.RefMapStat(root)})
		return
	}
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	jsonOK(w, map[string]any{"path": r.URL.Query().Get("path"), "children": children})
}

// GET /api/structure/edge-symbols?from=A&to=B&focus=X … 表示中の1エッジの全シンボル。
// 応答のエッジには見本 8 件しか付かない（全量を常に送ると linux の全体図で
// 応答が 10MB 級になる）ので、「残り」はここで1エッジずつ引く。
func (h *Handler) handleStructureEdgeSymbols(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()

	q := r.URL.Query()
	syms, err := search.StructEdgeSymbols(r.Context(), root, q.Get("focus"), q.Get("from"), q.Get("to"))
	if errors.Is(err, search.ErrRefMapNotBuilt) {
		w.WriteHeader(http.StatusConflict)
		jsonOK(w, map[string]any{"root": root, "status": search.RefMapStat(root)})
		return
	}
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	jsonOK(w, map[string]any{"symbols": syms})
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
