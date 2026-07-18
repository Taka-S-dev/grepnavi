package api

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"grepnavi/search"
)

const (
	_hoverSearchTimeout    = 8 * time.Second // hover シンボル検索の全体タイムアウト
	_defSearchTimeout      = 8 * time.Second // definition の rg フォールバック全体タイムアウト（巨大リポジトリ・ネットワークドライブの天井）
	_defaultSnippetContext = 15              // /api/snippet で行番号周辺を返す文脈行数の既定値
)

var reIdentifier = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

// --- /api/file ---

// 拡張子だけでバイナリと確定できるもの。拡張子なしの判定はここに入れない
// （Makefile / README / LICENSE / Dockerfile 等の拡張子なしテキストが巻き添えになる）。
var binaryExts = map[string]bool{
	".o": true, ".a": true, ".so": true, ".dll": true, ".exe": true,
	".bin": true, ".elf": true, ".out": true,
	".zip": true, ".tar": true, ".gz": true, ".xz": true, ".bz2": true,
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".bmp": true, ".ico": true,
	".pdf": true, ".pyc": true, ".class": true,
}

// 拡張子なしで既知のバイナリファイル名
var binaryNames = map[string]bool{
	"GTAGS": true, "GRTAGS": true, "GPATH": true, "tags": true,
}

const (
	maxFileSize      = 10 * 1024 * 1024 // 10MB
	binarySniffBytes = 512              // content-based バイナリ判定で読む先頭バイト数
)

// looksBinaryContent はファイルの先頭バイトを見て中身がバイナリか判定する。
// 通常のテキスト（UTF-8 / Shift-JIS / EUC-JP / UTF-16 BOM）は NUL を含まない/
// BOM で始まるため、NUL バイトの存在を主たるシグナルにする。
func looksBinaryContent(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	buf := make([]byte, binarySniffBytes)
	n, _ := f.Read(buf)
	if n == 0 {
		return false
	}
	buf = buf[:n]
	// UTF-16 BOM はテキスト扱い（中身に NUL が頻出するため早めに除外）
	if bytes.HasPrefix(buf, []byte{0xFF, 0xFE}) || bytes.HasPrefix(buf, []byte{0xFE, 0xFF}) {
		return false
	}
	return bytes.IndexByte(buf, 0) >= 0
}

func (h *Handler) handleFile(w http.ResponseWriter, r *http.Request) {
	file := r.URL.Query().Get("file")
	if file == "" {
		http.Error(w, "file required", http.StatusBadRequest)
		return
	}
	if !filepath.IsAbs(file) {
		h.mu.RLock()
		root := h.root
		h.mu.RUnlock()
		file = filepath.Join(root, file)
	}

	base := filepath.Base(file)
	ext := strings.ToLower(filepath.Ext(file))
	if binaryNames[base] || binaryExts[ext] {
		http.Error(w, "binary file not supported", http.StatusUnsupportedMediaType)
		return
	}

	if info, err := os.Stat(file); err == nil && info.Size() > maxFileSize {
		http.Error(w, "file too large", http.StatusRequestEntityTooLarge)
		return
	}

	if looksBinaryContent(file) {
		http.Error(w, "binary file not supported", http.StatusUnsupportedMediaType)
		return
	}

	lines, err := search.CachedLines(file)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	var sb strings.Builder
	for i, l := range lines {
		if i > 0 {
			sb.WriteByte('\n')
		}
		sb.WriteString(sanitizeUTF8(l))
	}
	w.Write([]byte(sb.String()))
}

// --- /api/file/mtime ---

func (h *Handler) handleFileMtime(w http.ResponseWriter, r *http.Request) {
	file := r.URL.Query().Get("file")
	if file == "" {
		http.Error(w, "file required", http.StatusBadRequest)
		return
	}
	info, err := os.Stat(file)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	fmt.Fprintf(w, "%d", info.ModTime().UnixMilli())
}

// --- /api/func-body ---

func (h *Handler) handleFuncBody(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	file := q.Get("file")
	lineStr := q.Get("line")
	if file == "" || lineStr == "" {
		http.Error(w, "file and line required", http.StatusBadRequest)
		return
	}
	line, err := strconv.Atoi(lineStr)
	if err != nil || line < 1 {
		http.Error(w, "invalid line", http.StatusBadRequest)
		return
	}
	body, startLine, endLine, err := search.ExtractFuncBody(file, line)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]any{"body": body, "start_line": startLine, "end_line": endLine})
}

// --- /api/symbols ---

func (h *Handler) handleSymbols(w http.ResponseWriter, r *http.Request) {
	file := r.URL.Query().Get("file")
	if file == "" {
		jsonErr(w, "file required", http.StatusBadRequest)
		return
	}
	if !filepath.IsAbs(file) {
		h.mu.RLock()
		root := h.root
		h.mu.RUnlock()
		file = filepath.Join(root, file)
	}
	symbols, err := search.ExtractSymbols(file)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if symbols == nil {
		symbols = []search.Symbol{}
	}
	jsonOK(w, symbols)
}

// --- /api/definition ---

func (h *Handler) handleDefinition(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	word := q.Get("word")
	if word == "" {
		jsonErr(w, "word required", http.StatusBadRequest)
		return
	}
	if !reIdentifier.MatchString(word) {
		jsonOK(w, []search.DefHit{})
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
	glob := q.Get("glob")
	currentFile := q.Get("file")
	gtagsParam     := q.Get("gtags") != "0"
	gtagsInstalled := search.GtagsInPath()
	gtagsIndexed   := search.GtagsIndexed(hroot)
	useGtags := gtagsParam && gtagsInstalled && gtagsIndexed
	useCtagsParam := q.Get("ctags") != "0"
	ctagsIndexed  := search.CtagsIndexed(hroot)
	useCtags := useCtagsParam && ctagsIndexed && !useGtags
	slog.Debug("definition", "word", word, "currentFile", currentFile, "dir", dir, "glob", glob, "hroot", hroot, "gtags_param", gtagsParam, "installed", gtagsInstalled, "indexed", gtagsIndexed, "useGtags", useGtags, "ctagsIndexed", ctagsIndexed, "useCtags", useCtags)
	engine := "rg"
	if useGtags {
		engine = "gtags"
	} else if useCtags {
		engine = "ctags"
	}
	cacheKey := word + "\x00" + dir + "\x00" + glob + "\x00" + engine
	if cached, ok := defCacheGet(cacheKey); ok {
		slog.Debug("definition cache hit", "word", word, "engine", cached.engine)
		writeDefinitionResponse(w, word, hroot, cached)
		return
	}
	// 同一キーの並行リクエストは1回の検索で済ませる（in-flight dedup）
	res, err := defInflightDo(cacheKey, func() (defResult, error) {
		// キャッシュを再チェック（待機中に別のリクエストが完了した可能性）
		if cached, ok := defCacheGet(cacheKey); ok {
			return cached, nil
		}
		t0 := time.Now()
		var h []search.DefHit
		var e error
		eng := engine
		// rg フォールバックは暗黙の全域スキャンなのでタイムアウトの天井を付ける。
		// タイムアウトで空になった結果は「なし」と確定していないのでキャッシュしない。
		rgTimedOut := false
		rgFallback := func() ([]search.DefHit, error) {
			rgCtx, cancel := context.WithTimeout(r.Context(), _defSearchTimeout)
			defer cancel()
			var hits []search.DefHit
			var err error
			if currentFile != "" {
				hits, err = search.FindDefinitionsSmart(rgCtx, word, currentFile, hroot, glob)
			} else {
				hits, err = search.FindDefinitions(rgCtx, word, dir, glob)
			}
			if len(hits) == 0 && rgCtx.Err() != nil && r.Context().Err() == nil {
				rgTimedOut = true
				slog.Debug("definition rg fallback timed out", "word", word)
			}
			return hits, err
		}
		if useGtags {
			slog.Debug("definition gtags", "hroot", hroot, "dir", dir)
			h, e = search.GtagsFindDefinitions(r.Context(), word, hroot)
			if e != nil {
				slog.Warn("definition gtags error, falling back", "word", word, "err", e)
				e = nil
			}
			slog.Debug("definition gtags result", "word", word, "hits", len(h), "dir", dir, "elapsed", time.Since(t0))
			if len(h) == 0 {
				// gtags miss/error → ctags fallback
				if search.CtagsIndexed(hroot) {
					slog.Debug("definition gtags miss, fallback to ctags", "word", word)
					t0 = time.Now()
					h, e = search.CtagsFindDefinitions(word, hroot)
					eng = "ctags"
					slog.Debug("definition ctags fallback result", "word", word, "hits", len(h), "elapsed", time.Since(t0))
				}
			}
			if len(h) == 0 && e == nil {
				if search.GtagsDefsPreloaded(hroot) && !search.GtagsIsStale() {
					// プリロード表がインデックス全体を保持している = 「無い」が確定情報。
					// 保険の rg 全域スキャンは走らせない（stale 時は取りこぼし防止で従来通り）。
					slog.Debug("definition authoritative miss, rg fallback skipped", "word", word)
				} else {
					// ctags も miss → rg fallback
					slog.Debug("definition gtags+ctags miss, fallback to rg", "word", word)
					t0 = time.Now()
					h, e = rgFallback()
					eng = "rg"
					slog.Debug("definition rg fallback result", "word", word, "hits", len(h), "elapsed", time.Since(t0))
				}
			}
		} else if useCtags {
			slog.Debug("definition ctags", "hroot", hroot)
			h, e = search.CtagsFindDefinitions(word, hroot)
			slog.Debug("definition ctags result", "word", word, "hits", len(h), "elapsed", time.Since(t0))
			if len(h) == 0 && e == nil {
				slog.Debug("definition ctags miss, fallback to rg", "word", word)
				t0 = time.Now()
				h, e = rgFallback()
				eng = "rg"
				slog.Debug("definition rg fallback result", "word", word, "hits", len(h), "elapsed", time.Since(t0))
			}
		} else {
			h, e = rgFallback()
			slog.Debug("definition rg result", "word", word, "engine", eng, "smart", currentFile != "", "hits", len(h), "elapsed", time.Since(t0))
		}
		if e != nil {
			return defResult{}, e
		}
		if h == nil {
			h = []search.DefHit{}
		}
		for i := range h {
			h[i].Engine = eng
		}
		out := defResult{hits: h, engine: eng}
		// タイムアウト・クライアント中断で途切れた検索は「なし」と確定していないので
		// キャッシュしない（次のリクエストで再検索させる）
		if !rgTimedOut && r.Context().Err() == nil {
			defCacheSet(cacheKey, out)
		}
		return out, nil
	})
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeDefinitionResponse(w, word, hroot, res)
}

// writeDefinitionResponse は X-Engine と（0件時の）X-Definition-Hint を添えて hits を返す。
// 新規検索・キャッシュヒット・in-flight 待機のどの経路でも同じヘッダが付くよう一本化。
func writeDefinitionResponse(w http.ResponseWriter, word, hroot string, res defResult) {
	w.Header().Set("X-Engine", res.engine)
	if len(res.hits) == 0 {
		if hint := definitionEmptyHint(word, hroot); hint != "" {
			w.Header().Set("X-Definition-Hint", hint)
		}
	}
	jsonOK(w, res.hits)
}

// definitionEmptyHint は 0 件返却時に「なぜ見つからなかったか」のヒントを返す。
// クライアントが「macro なのか / index 未整備なのか / 本当に存在しないのか」を
// 区別できるようにする目的。空文字なら hint 無し (= 単純な見つからない)。
func definitionEmptyHint(word, root string) string {
	if root == "" {
		return ""
	}
	macros := search.CtagsMacroNames(root)
	// HTTP ヘッダ値に word を埋め込むため識別子のみ許可（非 ASCII の文字化け防止）。
	if macros.Ready && reIdentifier.MatchString(word) {
		// Symbols.Macros は ctagsParseSymbols がソート済みで返す（SymbolsInFile と同じ前提）
		names := macros.Symbols.Macros
		if i := sort.SearchStrings(names, word); i < len(names) && names[i] == word {
			return "'" + word + "' is indexed by ctags as a #define/enum constant, but no definition location could be resolved — the tags file may lack line numbers (regenerate with ctags --fields=+n). A text search for the #define site will find it."
		}
	}
	if reIdentifier.MatchString(word) && search.GtagsDefsPreloaded(root) && !search.GtagsIsStale() {
		return "'" + word + "' is not in the gtags index (checked against the full preloaded definition table; text scan skipped). If it was added recently, update the index."
	}
	if !search.CtagsIndexed(root) && !search.GtagsIndexed(root) {
		return "no ctags/gtags index for this root; only ripgrep heuristics ran. Building an index can surface more results."
	}
	return ""
}

// --- /api/symbol-search ---

// handleSymbolSearch はシンボル名のパターン検索（プロジェクト全体）。
// 「正確な識別子名を知らない」段階で候補を絞り込むためのエンドポイントで、
// 名前が確定したら /api/definition に引き継ぐ想定。ctags 索引が前提。
func (h *Handler) handleSymbolSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	pattern := q.Get("pattern")
	if pattern == "" {
		jsonErr(w, "pattern is required", http.StatusBadRequest)
		return
	}
	if _, err := regexp.Compile(pattern); err != nil {
		jsonErr(w, "invalid pattern regex: "+err.Error(), http.StatusBadRequest)
		return
	}
	h.mu.RLock()
	hroot := h.root
	h.mu.RUnlock()
	if !search.CtagsIndexed(hroot) {
		jsonOK(w, map[string]interface{}{
			"symbols": []search.DefHit{},
			"count":   0,
			"hint":    "no ctags index (tags file) for this root; symbol name search requires it. Generate with: ctags -R --fields=+n",
		})
		return
	}

	limit := 50
	if ls := q.Get("limit"); ls != "" {
		fmt.Sscanf(ls, "%d", &limit)
	}
	if limit < 1 {
		limit = 50
	} else if limit > 200 {
		limit = 200
	}

	hits, truncated, err := search.CtagsSearchSymbolNames(
		r.Context(), pattern, hroot, q.Get("kind"), q.Get("case") == "1", limit)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if hits == nil {
		hits = []search.DefHit{}
	}
	jsonOK(w, map[string]interface{}{
		"symbols":   hits,
		"count":     len(hits),
		"truncated": truncated,
	})
}

// --- /api/hover ---

func (h *Handler) handleHover(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	word := q.Get("word")
	if word == "" {
		jsonErr(w, "word required", http.StatusBadRequest)
		return
	}
	if !reIdentifier.MatchString(word) {
		jsonOK(w, []search.HoverHit{})
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
	glob := q.Get("glob")
	if glob == "" {
		glob = "*.c,*.h,*.cpp,*.hpp,*.cc"
	}
	file := q.Get("file")
	hoverKey := word + "\x00" + file + "\x00" + dir + "\x00" + glob
	if cached, ok := hoverCacheGet(hoverKey); ok {
		slog.Debug("hover cache hit", "word", word)
		jsonOK(w, cached)
		return
	}
	t0 := time.Now()
	// 現在開いているファイルのインクルードチェーンを取得（優先ソート用・TTLキャッシュ済み）
	var includeChain map[string]bool
	if file != "" {
		incs, _ := search.GetFileIncludes(file, hroot)
		includeChain = make(map[string]bool, len(incs)+1)
		for _, f := range incs {
			includeChain[f.ID] = true
		}
		includeChain[file] = true
	}
	tInc := time.Since(t0)
	ctx, cancel := context.WithTimeout(r.Context(), _hoverSearchTimeout)
	defer cancel()
	hits, hoverEngine, err := search.FindHover(ctx, word, dir, glob, hroot, includeChain)
	slog.Debug("hover", "word", word, "hits", len(hits), "engine", hoverEngine, "include", tInc, "search", time.Since(t0)-tInc, "total", time.Since(t0))
	if err != nil {
		if ctx.Err() != nil {
			jsonOK(w, []search.HoverHit{})
			return
		}
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("X-Engine", hoverEngine)
	if hits == nil {
		hits = []search.HoverHit{}
	}
	hoverCacheSet(hoverKey, hits)
	jsonOK(w, hits)
}

// --- /api/callers ---

func (h *Handler) handleCallers(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	word := q.Get("word")
	if word == "" {
		jsonErr(w, "word required", http.StatusBadRequest)
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
	useGtags := q.Get("gtags") != "0" && search.GtagsAvailable(hroot)
	var hits []search.CallSite
	var err error
	if useGtags {
		hits, err = search.GtagsFindRefs(r.Context(), word, hroot)
		if err != nil || len(hits) == 0 {
			err = nil
			hits, err = search.FindCallers(r.Context(), word, dir, q.Get("glob"))
		}
	} else {
		hits, err = search.FindCallers(r.Context(), word, dir, q.Get("glob"))
	}
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if hits == nil {
		hits = []search.CallSite{}
	}
	jsonOK(w, hits)
}

// --- /api/callees ---

func (h *Handler) handleCallees(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	file := q.Get("file")
	lineStr := q.Get("line")
	if file == "" || lineStr == "" {
		jsonErr(w, "file and line required", http.StatusBadRequest)
		return
	}
	line := 0
	fmt.Sscanf(lineStr, "%d", &line)
	hits, err := search.FindCallees(r.Context(), file, line)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if hits == nil {
		hits = []search.CalleeHit{}
	}
	jsonOK(w, hits)
}

// --- /api/snippet ---

func (h *Handler) handleSnippet(w http.ResponseWriter, r *http.Request) {
	file := r.URL.Query().Get("file")
	lineStr := r.URL.Query().Get("line")
	ctxStr := r.URL.Query().Get("ctx")
	if file == "" || lineStr == "" {
		jsonErr(w, "file and line are required", http.StatusBadRequest)
		return
	}
	line := 0
	fmt.Sscanf(lineStr, "%d", &line)
	ctx := _defaultSnippetContext
	fmt.Sscanf(ctxStr, "%d", &ctx)

	lines, err := search.CachedLines(file)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}

	start := line - ctx - 1
	if start < 0 {
		start = 0
	}
	end := line + ctx
	if end > len(lines) {
		end = len(lines)
	}

	type SnipLine struct {
		Line    int    `json:"line"`
		Text    string `json:"text"`
		IsMatch bool   `json:"is_match"`
	}
	result := make([]SnipLine, 0, end-start)
	for i := start; i < end; i++ {
		result = append(result, SnipLine{
			Line:    i + 1,
			Text:    sanitizeUTF8(lines[i]),
			IsMatch: i+1 == line,
		})
	}
	jsonOK(w, result)
}

// --- /api/ifdef ---

func (h *Handler) handleIfdef(w http.ResponseWriter, r *http.Request) {
	file := r.URL.Query().Get("file")
	defStr := r.URL.Query().Get("defines")
	if file == "" {
		jsonErr(w, "file required", http.StatusBadRequest)
		return
	}
	defines := search.ParseDefines(defStr)
	lines, err := search.ComputeInactiveLines(file, defines)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if lines == nil {
		lines = []int{}
	}
	jsonOK(w, lines)
}
