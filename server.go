package main

import (
	"net/http"
	"os"

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

	return &http.Server{Addr: addr, Handler: mux}
}
