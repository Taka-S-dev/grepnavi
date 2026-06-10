package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
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

	enc := q.Get("enc")
	// 許可するエンコーディングのみ通す
	switch enc {
	case "sjis", "euc-jp", "utf-16le", "utf-16be":
	default:
		enc = ""
	}
	opts := search.Options{
		Pattern:       pattern,
		Dir:           dir,
		CaseSensitive: q.Get("case") == "1",
		WordRegexp:    q.Get("word") == "1",
		Regex:         q.Get("regex") == "1",
		FileGlob:      q.Get("glob"),
		ContextLines:  8,
		Encoding:      enc,
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
	offset := 0
	if ofs := q.Get("offset"); ofs != "" {
		fmt.Sscanf(ofs, "%d", &offset)
	}
	if offset < 0 {
		offset = 0
	}

	if _, err := os.Stat(dir); err != nil {
		jsonErr(w, "search dir does not exist: "+dir, http.StatusBadRequest)
		return
	}

	enc := q.Get("enc")
	// 許可するエンコーディングのみ通す
	switch enc {
	case "sjis", "euc-jp", "utf-16le", "utf-16be":
	default:
		enc = ""
	}

	// limit > 0 のときは 1 件多めに取って has_more を判定する。
	maxFetch := 0
	if limit > 0 {
		maxFetch = offset + limit + 1
	}
	opts := search.Options{
		Pattern:       pattern,
		Dir:           dir,
		CaseSensitive: q.Get("case") == "1",
		WordRegexp:    q.Get("word") == "1",
		Regex:         q.Get("regex") == "1",
		FileGlob:      q.Get("glob"),
		ContextLines:  8,
		MaxResults:    maxFetch,
		Encoding:      enc,
	}

	matches, err := search.Search(r.Context(), opts)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}

	hasMore := false
	if limit > 0 && len(matches) > offset+limit {
		hasMore = true
		matches = matches[:offset+limit]
	}
	if offset > len(matches) {
		offset = len(matches)
	}
	matches = matches[offset:]

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

	annotateEnclosingFuncs(matches)

	if matches == nil {
		matches = []graph.Match{}
	}
	resp := map[string]interface{}{
		"matches": matches,
		"count":   len(matches),
	}
	if limit > 0 {
		resp["has_more"] = hasMore
		if hasMore {
			resp["next_offset"] = offset + limit
		}
	}
	if len(matches) == 0 {
		if hint := searchEmptyHint(r.Context(), opts); hint != "" {
			resp["hint"] = hint
		}
	}
	jsonOK(w, resp)
}

// annotateEnclosingFuncs は各マッチに「どの関数の中のヒットか」を付加する（C 系のみ）。
// クライアントがヒットを関数単位でグループ化し、重複なく func-body を読めるようにする。
// 無制限検索でファイル数が爆発した場合に備えてシンボル抽出は上限ファイル数で打ち切る。
const _enclosingFuncMaxFiles = 100

func annotateEnclosingFuncs(matches []graph.Match) {
	symsByFile := map[string][]search.Symbol{}
	for i := range matches {
		m := &matches[i]
		if !isCLike(m.File) {
			continue
		}
		syms, ok := symsByFile[m.File]
		if !ok {
			if len(symsByFile) >= _enclosingFuncMaxFiles {
				continue
			}
			syms, _ = search.ExtractSymbols(m.File)
			symsByFile[m.File] = syms
		}
		for _, s := range syms {
			if s.StartLine <= m.Line && m.Line <= s.EndLine {
				m.EnclosingFunc = &graph.EnclosingFunc{Name: s.Name, StartLine: s.StartLine}
				break
			}
		}
	}
}

// searchEmptyHint は 0 件時に「なぜ見つからなかったか」のヒントを返す。
// AI クライアントが「本当に存在しない」と「検索条件のミス」を区別できるようにする
// （/api/definition の X-Definition-Hint と同じ思想）。空文字なら hint 無し。
func searchEmptyHint(ctx context.Context, opts search.Options) string {
	if opts.FileGlob != "" && !search.GlobMatchesAnyFile(ctx, opts.Dir, opts.FileGlob) {
		return "glob '" + opts.FileGlob + "' matched no files under '" + opts.Dir +
			"'; the pattern was never tested against any file. Fix the glob before concluding the text does not exist."
	}
	if !opts.Regex && looksLikeRegexPattern(opts.Pattern) {
		return "pattern was treated as a LITERAL string (regex=false) but contains regex-like syntax (e.g. '.*', '\\b'); pass regex=true if you meant a regular expression."
	}
	return ""
}

// looksLikeRegexPattern は literal 検索のパターンが「正規表現のつもり」で書かれて
// いそうかを判定する。`(` や `|` `[` は C コードの literal 検索に普通に現れるため、
// 誤検知の少ない強いシグナルだけを見る。
func looksLikeRegexPattern(p string) bool {
	for _, sig := range []string{".*", ".+", `\b`, `\d`, `\w`, `\s`, "(?"} {
		if strings.Contains(p, sig) {
			return true
		}
	}
	return strings.HasPrefix(p, "^") || strings.HasSuffix(p, "$")
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
