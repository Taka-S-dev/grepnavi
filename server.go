package main

import (
	"net/http"
	_ "net/http/pprof"
	"os"
	"strings"

	"grepnavi/api"
	"grepnavi/graph"
)

func newServer(root string, rootExplicit bool, graphFile, addr string, debug, mcpEnabled bool) *http.Server {
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
	if debug {
		mux.Handle("/debug/pprof/", http.DefaultServeMux)
	}

	return &http.Server{Addr: addr, Handler: api.CspMiddleware(csrfMiddleware(mux, mcpEnabled))}
}

// csrfMiddleware は /api/* へのリクエストの呼び出し元を検証する。
//
//   - Origin あり: localhost / 127.0.0.1 origin のみ許可（cross-site CSRF 対策）。
//   - Origin なし + Sec-Fetch-Site あり: ブラウザの same-origin GET/HEAD は仕様上
//     Origin を付けないが、Fetch Metadata の Sec-Fetch-Site は全 fetch に付与
//     される。ブラウザ起源と判定して許可。
//   - Origin なし + Sec-Fetch-Site なし: 非ブラウザクライアント（curl, MCP bridge
//     等）。--mcp で opt-in した場合のみ通す。
//
// 限界: これは「CSRF 対策 + 外部ツール利用の明示 opt-in gate」であって、
// 同一 UID で動く同一マシン上のプロセスに対する認証境界ではない。
// 「localhost 上の同一ユーザのプロセスは信頼する」trust model を前提とする。
// 強い分離が必要な場合は token 認証 / Unix socket / SSH tunnel を検討。
func csrfMiddleware(next http.Handler, mcpEnabled bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			origin := r.Header.Get("Origin")
			if origin == "" {
				// Sec-Fetch-Site があれば browser 起源とみなす (Chrome 76+ / Firefox 90+ / Safari 16+)
				if r.Header.Get("Sec-Fetch-Site") == "" && !mcpEnabled {
					http.Error(w, "forbidden: external API access requires --mcp flag", http.StatusForbidden)
					return
				}
			} else if !strings.HasPrefix(origin, "http://localhost") &&
				!strings.HasPrefix(origin, "http://127.0.0.1") {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
