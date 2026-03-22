package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"

	"grepnavi/graph"
	"grepnavi/search"
)

// --- /api/search/stream (SSE) ---

func (h *Handler) handleSearchStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	q := r.URL.Query()
	pattern := q.Get("q")
	if pattern == "" {
		http.Error(w, "q is required", http.StatusBadRequest)
		return
	}
	h.mu.RLock()
	hroot := h.root
	h.mu.RUnlock()
	dir := q.Get("dir")
	if dir == "" {
		dir = hroot
	} else if !filepath.IsAbs(dir) {
		dir = filepath.Join(hroot, dir)
	}

	opts := search.Options{
		Pattern:       pattern,
		Dir:           dir,
		CaseSensitive: q.Get("case") == "1",
		WordRegexp:    q.Get("word") == "1",
		Regex:         q.Get("regex") == "1",
		FileGlob:      q.Get("glob"),
		ContextLines:  8,
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	ctx := r.Context()
	count := 0
	const streamLimit = 1000

	err := search.SearchStream(ctx, opts, func(m graph.Match) error {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		if count >= streamLimit {
			return fmt.Errorf("limit")
		}

		m.IfdefStack = []graph.IfdefFrame{}

		data, err := json.Marshal(m)
		if err != nil {
			return nil
		}
		count++
		fmt.Fprintf(w, "data: %s\n\n", data)
		flusher.Flush()
		return nil
	})

	if err != nil && err != ctx.Err() {
		fmt.Fprintf(w, "event: error\ndata: %s\n\n", err.Error())
	}
	fmt.Fprintf(w, "event: done\ndata: {\"count\":%d}\n\n", count)
	flusher.Flush()
}

// --- /api/search ---

func (h *Handler) handleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	q := r.URL.Query()
	pattern := q.Get("q")
	if pattern == "" {
		jsonErr(w, "q is required", http.StatusBadRequest)
		return
	}
	h.mu.RLock()
	hroot := h.root
	h.mu.RUnlock()
	dir := q.Get("dir")
	if dir == "" {
		dir = hroot
	} else if !filepath.IsAbs(dir) {
		dir = filepath.Join(hroot, dir)
	}

	limit := 0
	if ls := q.Get("limit"); ls != "" {
		fmt.Sscanf(ls, "%d", &limit)
	}
	opts := search.Options{
		Pattern:       pattern,
		Dir:           dir,
		CaseSensitive: q.Get("case") == "1",
		WordRegexp:    q.Get("word") == "1",
		Regex:         q.Get("regex") == "1",
		FileGlob:      q.Get("glob"),
		ContextLines:  8,
		MaxResults:    limit,
	}

	matches, err := search.Search(r.Context(), opts)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// #ifdef スタックを付加（C/C++ ファイルのみ）
	for i := range matches {
		m := &matches[i]
		if isCLike(m.File) {
			stack, _ := search.ExtractIfdefStack(m.File, m.Line)
			if stack != nil {
				m.IfdefStack = stack
			} else {
				m.IfdefStack = []graph.IfdefFrame{}
			}
		} else {
			m.IfdefStack = []graph.IfdefFrame{}
		}
	}

	jsonOK(w, map[string]interface{}{
		"matches": matches,
		"count":   len(matches),
	})
}

func isCLike(path string) bool {
	lower := strings.ToLower(path)
	for _, ext := range []string{".c", ".h", ".cpp", ".cc", ".cxx", ".hpp"} {
		if strings.HasSuffix(lower, ext) {
			return true
		}
	}
	return false
}
