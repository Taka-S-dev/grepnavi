package main

import (
	"net/http"
	_ "net/http/pprof"
	"os"
	"strings"

	"grepnavi/api"
	"grepnavi/graph"
)

func newServer(root string, rootExplicit bool, graphFile, addr string) *http.Server {
	store := graph.NewStore(graphFile, root)

	// -root フラグが明示されていない場合のみ、保存済みの root_dir を優先する
	effectiveRoot := root
	if !rootExplicit {
		if savedRoot := store.GetRootDir(); savedRoot != "" {
			if info, err := os.Stat(savedRoot); err == nil && info.IsDir() {
				effectiveRoot = savedRoot
			}
		}
	}

	mux := http.NewServeMux()
	h := api.NewHandler(store, effectiveRoot)
	h.Register(mux)
	// pprof（診断用）
	mux.Handle("/debug/pprof/", http.DefaultServeMux)

	return &http.Server{Addr: addr, Handler: csrfMiddleware(mux)}
}

// csrfMiddleware は /api/* へのリクエストに対して Origin ヘッダーを検証する。
// Origin が存在する場合、localhost または 127.0.0.1 からのリクエストのみ許可する。
// ブラウザは cross-origin リクエスト時に必ず Origin を付与するため、
// 悪意あるサイトからの CSRF を防げる。
func csrfMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			origin := r.Header.Get("Origin")
			if origin != "" &&
				!strings.HasPrefix(origin, "http://localhost") &&
				!strings.HasPrefix(origin, "http://127.0.0.1") {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
