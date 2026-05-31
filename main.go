package main

import (
	"flag"
	"fmt"
	"log"
	"log/slog"
	"os"
	"bufio"
	"os/exec"
	"runtime"
	"strings"
)

func main() {
	root      := flag.String("root", ".", "C source root directory to search")
	graphFile := flag.String("graph", "graph.json", "Path to graph JSON file")
	port      := flag.Int("port", 8080, "HTTP server port")
	host      := flag.String("host", "127.0.0.1", "bind address (use 0.0.0.0 for LAN access)")
	noBrowser := flag.Bool("no-browser", false, "suppress automatic browser launch")
	logLevel  := flag.String("log-level", "info", "log level: debug, info, warn, error")
	debug     := flag.Bool("debug", false, "enable /debug/pprof endpoint")
	mcp       := flag.Bool("mcp", false, "allow non-browser API access (required for external bridges like grepnavi-mcp)")
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

	rootExplicit := *root != "."
	absRoot, err := absPath(*root)
	if err != nil {
		slog.Error("invalid root", "err", err)
		os.Exit(1)
	}

	addr := fmt.Sprintf("%s:%d", *host, *port)
	url := fmt.Sprintf("http://localhost:%d", *port)

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

	srv := newServer(absRoot, rootExplicit, *graphFile, addr, *debug, *mcp)

	slog.Info("grepnavi started", "root", absRoot, "graph", *graphFile)
	if *mcp {
		slog.Warn("--mcp enabled: non-browser (Origin-less) API access is allowed")
	}
	slog.Info("listening", "url", url)

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

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}
