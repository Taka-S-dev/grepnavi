package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"runtime"
)

func main() {
	root := flag.String("root", ".", "C source root directory to search")
	graphFile := flag.String("graph", "graph.json", "Path to graph JSON file")
	port := flag.Int("port", 8080, "HTTP server port")
	flag.Parse()

	rootExplicit := *root != "."
	absRoot, err := absPath(*root)
	if err != nil {
		log.Fatalf("invalid root: %v", err)
	}

	addr := fmt.Sprintf(":%d", *port)
	url := fmt.Sprintf("http://localhost:%d", *port)
	srv := newServer(absRoot, rootExplicit, *graphFile, addr)

	log.Printf("grepnavi: root=%s graph=%s", absRoot, *graphFile)
	log.Printf("Listening on %s", url)

	go openBrowser(url)

	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
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
