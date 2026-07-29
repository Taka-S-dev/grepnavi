package main

import (
	"net"
	"net/http"
	_ "net/http/pprof"
	"net/url"
	"os"
	"strings"

	"grepnavi/api"
	"grepnavi/graph"
)

func newServer(root string, rootExplicit bool, graphFile string, graphExplicit bool, addr string, debug, mcpEnabled bool) *http.Server {
	var store *graph.Store
	if graphExplicit {
		store = graph.NewStore(graphFile, root)
	} else {
		store = graph.NewWorkingStore(graphFile, root)
	}

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

	// ActivityMiddleware は csrf の内側: 拒否されたリクエストをアイドル判定に数えない
	return &http.Server{Addr: addr, Handler: api.CspMiddleware(csrfMiddleware(api.ActivityMiddleware(mux), mcpEnabled, addr))}
}

// isLoopbackHost は "host" / "host:port" のホスト部が loopback を指すかを返す。
// 文字列の前方一致で見ると localhost.evil.com のような名前を取り違えるので、
// 必ずホスト部を切り出してから判定する。
func isLoopbackHost(hostport string) bool {
	h := hostport
	if x, _, err := net.SplitHostPort(hostport); err == nil {
		h = x
	}
	h = strings.Trim(h, "[]") // IPv6 リテラルの括弧
	if strings.EqualFold(h, "localhost") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// isLoopbackOrigin は Origin ヘッダが loopback 由来かを返す。
func isLoopbackOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	return isLoopbackHost(u.Host)
}

// csrfMiddleware は /api/* へのリクエストの呼び出し元を検証する。
//
//   - Host: loopback 宛でなければ拒否。ブラウザは DNS リバインディングで
//     攻撃者のドメインを 127.0.0.1 に向けられる。その場合ブラウザから見て
//     same-origin なので Origin は付かず Sec-Fetch-Site も same-origin になり、
//     下の判定を素通りしてしまう。Host を見れば「どの名前で来たか」が分かる。
//     -host に loopback 以外を指定した場合（LAN 公開を明示的に選んだ場合）は
//     正当なホスト名を知りようがないのでこの検査を行わない。
//   - Origin あり: loopback origin のみ許可（cross-site CSRF 対策）。
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
func csrfMiddleware(next http.Handler, mcpEnabled bool, bindAddr string) http.Handler {
	// -host 0.0.0.0 等で意図的に外部公開した場合、正当な Host 名を列挙できない。
	// 明示的に選んだ構成を壊さないよう、その場合だけ Host 検査を無効にする。
	checkHost := isLoopbackHost(bindAddr)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			if checkHost && !isLoopbackHost(r.Host) {
				http.Error(w, "forbidden: unexpected Host header", http.StatusForbidden)
				return
			}
			origin := r.Header.Get("Origin")
			if origin == "" {
				// Sec-Fetch-Site があれば browser 起源とみなす (Chrome 76+ / Firefox 90+ / Safari 16+)
				if r.Header.Get("Sec-Fetch-Site") == "" && !mcpEnabled {
					http.Error(w, "forbidden: external API access requires --mcp flag", http.StatusForbidden)
					return
				}
			} else if !isLoopbackOrigin(origin) {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
