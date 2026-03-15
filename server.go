package main

import (
	"net/http"
	"os"

	"grepnavi/api"
	"grepnavi/graph"
)

func newServer(root, graphFile, addr string) *http.Server {
	store := graph.NewStore(graphFile, root)

	// プロジェクトファイルに root_dir が保存されていればそちらを使う
	// (-root フラグが明示された場合はフラグを優先)
	effectiveRoot := root
	if savedRoot := store.GetRootDir(); savedRoot != "" && root == effectiveRoot {
		if info, err := os.Stat(savedRoot); err == nil && info.IsDir() {
			effectiveRoot = savedRoot
		}
	}

	mux := http.NewServeMux()
	h := api.NewHandler(store, effectiveRoot)
	h.Register(mux)

	return &http.Server{Addr: addr, Handler: mux}
}
