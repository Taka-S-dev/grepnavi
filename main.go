package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"grepnavi/api"
	"grepnavi/desktop"
	"grepnavi/proc"
)

// defaultTray / defaultMCP はビルド時に -ldflags "-X main.defaultTray=1" で焼き込む
// フラグ既定値。windowsgui ビルド（grepnaviw.exe）はダブルクリック起動で引数を渡せず、
// コンソールも無いため、既定値そのものを実行ファイル側に持たせる。
// コマンドラインで明示指定すれば通常どおり上書きできる。
var (
	defaultTray string
	defaultMCP  string
)

func main() {
	root := flag.String("root", ".", "C source root directory to search")
	graphFile := flag.String("graph", "graph.json", "Path to graph JSON file")
	port := flag.Int("port", 8080, "HTTP server port")
	host := flag.String("host", "127.0.0.1", "bind address (use 0.0.0.0 for LAN access)")
	noBrowser := flag.Bool("no-browser", false, "suppress automatic browser launch")
	logLevel := flag.String("log-level", "info", "log level: debug, info, warn, error")
	debug := flag.Bool("debug", false, "enable /debug/pprof endpoint")
	mcp := flag.Bool("mcp", defaultMCP == "1", "allow non-browser API access (required for external bridges like grepnavi-mcp)")
	mcpInsert := flag.Bool("mcp-insert", false, "let external clients (AI agents) insert and remove debug lines; implies -mcp. Off by default: the bridge is read-only on source without it")
	tray := flag.Bool("tray", defaultTray == "1", "run resident in the system tray; open windows on demand (Windows only)")
	resetGraph := flag.Bool("reset-graph", false, "internal: start from an empty graph even when -graph is given (used when spawning a new window)")
	view := flag.String("view", "", "internal: open a WebView2 viewer at this URL without starting a server (used by -tray)")
	flag.Parse()

	// slog セットアップ
	var level slog.Level
	switch *logLevel {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level})))
	// log.Printf も slog に流す（サードパーティライブラリ対応）
	log.SetFlags(0)
	log.SetOutput(os.Stderr)

	// -view: ビューア専用プロセス（-tray が起動する）。URL を WebView2 窓で表示するだけで、
	// サーバ起動も graph/root への参照もしない。
	if *view != "" {
		if err := desktop.OpenWindow(*view); err != nil {
			slog.Error("view mode failed", "err", err)
			os.Exit(1)
		}
		return
	}

	rootExplicit := *root != "."
	// -graph を明示したときは利用者がファイルを指定した = 名前を付けたのと同じなので
	// そのまま読み込む。既定の作業ファイルは毎回空から始める（前回分は退避される）。
	graphExplicit := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "graph" {
			graphExplicit = true
		}
	})
	if *resetGraph {
		graphExplicit = false // 新しいウィンドウは常に空から始める
	}
	absRoot, err := absPath(*root)
	if err != nil {
		slog.Error("invalid root", "err", err)
		os.Exit(1)
	}

	addr := fmt.Sprintf("%s:%d", *host, *port)
	url := fmt.Sprintf("http://localhost:%d", *port)

	// 同じポートで grepnavi が既に動いていれば、二重起動せず既存インスタンスの
	// 窓（またはブラウザ）を開くだけで終了する。windowsgui ビルドはコンソールが
	// 無く、ポート衝突でエラー表示のないまま終了すると「ダブルクリックしたのに
	// 何も起きない」ように見えるため、再起動操作を「窓をもう1枚開く」として扱う。
	if grepnaviRunningAt(url) {
		slog.Info("already running, opening a window on the existing instance", "url", url)
		if *tray {
			if err := desktop.OpenWindow(url); err != nil {
				openBrowser(url)
			}
		} else if !*noBrowser {
			openBrowser(url)
		}
		return
	}

	if *host != "127.0.0.1" && *host != "localhost" {
		fmt.Fprintf(os.Stderr, "\n============================================================\n")
		fmt.Fprintf(os.Stderr, "  [WARNING] SECURITY RISK\n")
		fmt.Fprintf(os.Stderr, "============================================================\n")
		fmt.Fprintf(os.Stderr, "  grepnavi is listening on %s (NOT localhost).\n", addr)
		fmt.Fprintf(os.Stderr, "  This tool has NO authentication.\n")
		fmt.Fprintf(os.Stderr, "  Anyone on the network can read your files.\n")
		fmt.Fprintf(os.Stderr, "============================================================\n")
		fmt.Fprintf(os.Stderr, "  Type \"yes\" to continue, or press Ctrl+C to abort: ")
		ans, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		ans = strings.TrimSpace(ans)
		if ans != "yes" {
			fmt.Fprintln(os.Stderr, "Aborted.")
			os.Exit(1)
		}
		fmt.Fprintln(os.Stderr)
	}

	// -mcp-insert は書き込みの許可なので、API アクセス自体も当然許す。
	// 別々に指定させると -mcp の付け忘れで黙って 403 になる。
	if *mcpInsert {
		*mcp = true
	}
	srv := newServer(absRoot, rootExplicit, *graphFile, graphExplicit, addr, *debug, *mcp, *mcpInsert, *tray)

	slog.Info("grepnavi started", "root", absRoot, "graph", *graphFile, "build", api.BuildStamp())
	if *mcp {
		slog.Warn("--mcp enabled: non-browser (Origin-less) API access is allowed")
	}
	slog.Info("listening", "url", url)

	// -tray: サーバをバックグラウンドで動かしトレイに常駐する。窓は必要に応じて
	// 別プロセスの -view として開く（desktop.RunTray を参照）。
	if *tray {
		go func() {
			if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				slog.Error("server error", "err", err)
				os.Exit(1)
			}
		}()
		if err := desktop.RunTray(url); err != nil {
			slog.Error("tray mode failed", "err", err)
			os.Exit(1)
		}
		return
	}

	if !*noBrowser {
		go openBrowser(url)
	}

	if err := srv.ListenAndServe(); err != nil {
		slog.Error("server error", "err", err)
		os.Exit(1)
	}
}

func absPath(p string) (string, error) {
	if p == "." {
		return os.Getwd()
	}
	return p, nil
}

// grepnaviRunningAt は url で grepnavi が応答するかを短いタイムアウトで確認する。
// localhost 自己プローブ専用で、外部への通信は行わない。
// Origin を付けるのは csrfMiddleware 対策: 既存インスタンスが -mcp なしでも、
// localhost origin のリクエストは常に許可されるため mcp 設定に関わらず判定できる。
func grepnaviRunningAt(url string) bool {
	req, err := http.NewRequest("GET", url+"/api/root", nil)
	if err != nil {
		return false
	}
	req.Header.Set("Origin", url)
	client := &http.Client{Timeout: 500 * time.Millisecond}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	// 他アプリが同じポートに居る場合の誤認を避け、応答の形まで確認する
	var body struct {
		Root string `json:"root"`
	}
	return json.NewDecoder(resp.Body).Decode(&body) == nil && body.Root != ""
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = proc.Command("cmd", "/c", "start", url)
	case "darwin":
		cmd = proc.Command("open", url)
	default:
		cmd = proc.Command("xdg-open", url)
	}
	_ = cmd.Start()
}
