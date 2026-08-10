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

	"grepnavi/graph"
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

	// エンジン優先順の決定。engines=ctags,gtags,rg（UI の並べ替え設定、上から順に試行）。
	// 使えないエンジン（未インストール・未インデックス）は順序から除外する。
	gtagsUsable := search.GtagsInPath() && search.GtagsIndexed(hroot)
	ctagsUsable := search.CtagsIndexed(hroot)
	var order []string
	seenEng := map[string]bool{}
	addEngine := func(name string, usable bool) {
		if usable && !seenEng[name] {
			seenEng[name] = true
			order = append(order, name)
		}
	}
	if enginesParam := q.Get("engines"); enginesParam != "" {
		for _, name := range strings.Split(enginesParam, ",") {
			switch strings.TrimSpace(name) {
			case "gtags":
				addEngine("gtags", gtagsUsable)
			case "ctags":
				addEngine("ctags", ctagsUsable)
			case "rg":
				addEngine("rg", true)
			}
		}
	} else {
		// 旧クライアント互換: gtags= / ctags= フラグから従来のチェーンを組み立てる
		if q.Get("gtags") != "0" && gtagsUsable {
			addEngine("gtags", true)
			addEngine("ctags", ctagsUsable) // 従来動作: gtags 主のとき ctags は中間フォールバック
		} else if q.Get("ctags") != "0" {
			addEngine("ctags", ctagsUsable)
		}
		addEngine("rg", true)
	}
	if len(order) == 0 {
		order = []string{"rg"} // 指定エンジンが全滅でもジャンプ自体は機能させる
	}
	orderKey := strings.Join(order, ",")
	slog.Debug("definition", "word", word, "currentFile", currentFile, "dir", dir, "glob", glob, "hroot", hroot, "engines", orderKey)
	cacheKey := word + "\x00" + dir + "\x00" + glob + "\x00" + orderKey
	if cached, ok := defCacheGet(cacheKey); ok {
		slog.Debug("definition cache hit", "word", word, "engine", cached.engine)
		h.writeDefinitionResponse(w, word, hroot, cached, q.Get("tag"))
		return
	}
	// 同一キーの並行リクエストは1回の検索で済ませる（in-flight dedup）
	res, err := defInflightDo(cacheKey, func() (defResult, error) {
		// キャッシュを再チェック（待機中に別のリクエストが完了した可能性）
		if cached, ok := defCacheGet(cacheKey); ok {
			return cached, nil
		}
		var h []search.DefHit
		var e error
		// rg は暗黙の全域スキャンなのでタイムアウトの天井を付ける。
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
		// 優先順に試行し、最初にヒットしたエンジンで確定する
		eng := order[0]
		gtagsTried := false
		gtagsAnswered := false // gtags が索引を引けて、エラー無しで答えた
		for _, engName := range order {
			t0 := time.Now()
			switch engName {
			case "gtags":
				gtagsTried = true
				h, e = search.GtagsFindDefinitions(r.Context(), word, hroot)
				if e != nil {
					slog.Warn("definition gtags error, falling back", "word", word, "err", e)
					e = nil
				} else {
					gtagsAnswered = true
				}
			case "ctags":
				h, e = search.CtagsFindDefinitions(word, hroot)
				if e != nil {
					slog.Warn("definition ctags error, falling back", "word", word, "err", e)
					e = nil
				}
			case "rg":
				// rg を gtags より先に置く設定は意図的な全文検索なのでスキップしない
				if gtagsTried && authoritativeGtagsMiss(gtagsAnswered, search.GtagsIsStale(),
					search.GtagsDefsPreloaded(hroot), search.GtagsQueriesDirect()) {
					slog.Debug("definition authoritative miss, rg skipped", "word", word)
					continue
				}
				h, e = rgFallback()
			}
			eng = engName
			slog.Debug("definition engine result", "engine", engName, "word", word, "hits", len(h), "elapsed", time.Since(t0))
			if len(h) > 0 {
				break
			}
		}
		if e != nil {
			return defResult{}, e
		}
		// エンジン名を書き込む前に複製する。検索層は結果をキャッシュしていて、
		// 返ってくるスライスがその実体であることがある（gtags の非プリロード経路）。
		// 直接書くと、同じ語の並行リクエストが共有データを書き換え合う。
		hits := make([]search.DefHit, len(h))
		copy(hits, h)
		for i := range hits {
			hits[i].Engine = eng
		}
		out := defResult{hits: hits, engine: eng}
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
	h.writeDefinitionResponse(w, word, hroot, res, q.Get("tag"))
}

// authoritativeGtagsMiss は gtags の空振りを「索引に無い」と確定してよいかを返す。
// 確定できるなら全域スキャンを省ける。
//
// 索引が古ければ確定できない（追加されたばかりの定義を取りこぼす）。
// プリロード表は直接起動が使えない環境でしか作らないので、それだけを条件に
// すると健全な環境では一度も成立せず、索引が答えているのに毎回全域スキャンへ
// 落ちていた。ビルド生成物を含む大きなツリー（1.3GB の openssl で rg が3分半）
// では、定義の無い語を引くたびに打ち切りまで待たされる。
func authoritativeGtagsMiss(answered, stale, preloaded, direct bool) bool {
	if !answered || stale {
		return false
	}
	return preloaded || direct
}

// headerSafe は HTTP ヘッダ値に載せられる形に直す。
// ヘッダ値は latin-1 として読まれるため、UTF-8 のまま入れた非 ASCII 文字は
// 受け取り側で化ける（em ダッシュ1つで "â€"" になり、文章全体が読めなくなる）。
// よく使う約物は見た目の近い ASCII に置き換え、それ以外は落とす。
func headerSafe(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r < 0x80:
			b.WriteRune(r)
		case r == '—' || r == '–': // em / en ダッシュ
			b.WriteString("-")
		case r == '‘' || r == '’': // 引用符
			b.WriteString("'")
		case r == '“' || r == '”':
			b.WriteString("\"")
		}
	}
	return strings.TrimSpace(b.String())
}

// writeDefinitionResponse は X-Engine と（0件時の）X-Definition-Hint を添えて hits を返す。
// 新規検索・キャッシュヒット・in-flight 待機のどの経路でも同じヘッダが付くよう一本化。
func (h *Handler) writeDefinitionResponse(w http.ResponseWriter, word, hroot string, res defResult, tag string) {
	w.Header().Set("X-Engine", res.engine)
	if len(res.hits) == 0 {
		if hint := headerSafe(definitionEmptyHint(word, hroot)); hint != "" {
			w.Header().Set("X-Definition-Hint", hint)
		}
	}
	// 着地点の補正はキャッシュより後に置く。キャッシュへ入れる前に直すと、
	// その後の編集でまたずれた値が固定されてしまう。
	hits := h.healDefHits(append([]search.DefHit(nil), res.hits...))
	// tag は呼び出し位置ごとに変わるのでキャッシュには載せず、応答直前に整列する。
	jsonOK(w, search.RankDefHitsByTag(hits, tag))
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
			return "No definition for '" + word + "' - ctags has it as a #define/enum constant but without a line number. Regenerate the index with ctags --fields=+n, or grep for the #define site."
		}
	}
	if reIdentifier.MatchString(word) && !search.GtagsIsStale() &&
		(search.GtagsDefsPreloaded(root) || (search.GtagsIndexed(root) && search.GtagsQueriesDirect())) {
		return "No definition for '" + word + "' - it is not in the gtags index, so the whole-tree text scan was skipped. Update the index if it was added recently."
	}
	if !search.CtagsIndexed(root) && !search.GtagsIndexed(root) {
		return "No definition found - this tree has no ctags/gtags index, so only the ripgrep heuristics ran. Building an index can surface more."
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
			"hint":    "no ctags index (tags file) for this root; symbol name search requires it. Generate with: ctags -R --output-format=e-ctags --fields=+n . (run at the root)",
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
		r.Context(), pattern, hroot, q.Get("kind"), q.Get("case") == "1", limit, q.Get("path"))
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
	// 並べ替えはキャッシュ格納後に行う。tag は同じ単語でも呼び出し位置ごとに
	// 変わるので、キャッシュキーには含めず表示直前の整列だけに使う。
	jsonOK(w, search.RankHoverHitsByTag(hits, q.Get("tag")))
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
	hits, engine, truncated, err := search.FindRefSites(r.Context(), search.RefQuery{
		Word:        word,
		Root:        hroot,
		Scope:       dir,
		Glob:        q.Get("glob"),
		CallersOnly: true,
		NoIndex:     q.Get("gtags") == "0",
		// 呼び出し元は「これで全部か」を見る一覧なので上限は高く取り、
		// 触れたときは X-Truncated で伝える
		Limit: 1000,
	})
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if hits == nil {
		hits = []search.CallSite{}
	}
	// 呼び出し元が上限で切られたかを伝える。黙って切ると「これで全部」と誤解される。
	// gtags は全件返すので、打ち切りが起きるのは rg 経路だけ。
	w.Header().Set("X-Engine", engine)
	if truncated {
		w.Header().Set("X-Truncated", "true")
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
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()
	hits, funcName, truncated, err := search.FindCallees(r.Context(), file, line, root)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if hits == nil {
		hits = []search.CalleeHit{}
	}
	// どの関数の呼び先を出したのかを返す。カーソル位置の語ではなく囲む関数を
	// 使うので、名前を見せないと利用者は別の関数の結果と受け取る
	if funcName != "" {
		w.Header().Set("X-Func", funcName)
	}
	// 全件そろっているかは呼び出し側の判断に効く（「これで全部」と言えるか）
	if truncated {
		w.Header().Set("X-Truncated", "true")
	}
	jsonOK(w, hits)
}

// --- /api/references ---

// handleReferences は word が使われている箇所を返す。
// callers は関数呼び出し専用なので、構造体メンバ・グローバル変数・マクロの
// 使用箇所はこちらでしか追えない。
func (h *Handler) handleReferences(w http.ResponseWriter, r *http.Request) {
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
	limit, _ := strconv.Atoi(q.Get("limit"))

	// assign=1 で「その語へ書き込んでいる行」だけに絞る
	// filter は解決の前に掛かるので、索引が返した全件に届く
	refs, truncated, engine, err := search.FindReferences(r.Context(), word, dir, limit,
		q.Get("assign") == "1", q.Get("filter"))
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if refs == nil {
		refs = []search.Reference{}
	}
	w.Header().Set("X-Engine", engine)
	if truncated {
		w.Header().Set("X-Truncated", "true")
	}
	jsonOK(w, refs)
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

// handleIfdefStack は file:line を囲む #ifdef / #if の入れ子を返す。
// 「この行はどの条件付きコンパイルの中にあるか」を単体で引くための入口。
// 検索結果には ifdef_stack が付くが、定義ジャンプやコールツリーの結果には
// 付かないため、そこから辿った行の条件を知る手段がなかった。
func (h *Handler) handleIfdefStack(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	file := q.Get("file")
	if file == "" {
		jsonErr(w, "file required", http.StatusBadRequest)
		return
	}
	line, err := strconv.Atoi(q.Get("line"))
	if err != nil || line < 1 {
		jsonErr(w, "line must be a positive integer", http.StatusBadRequest)
		return
	}
	if !filepath.IsAbs(file) {
		h.mu.RLock()
		root := h.root
		h.mu.RUnlock()
		file = filepath.Join(root, file)
	}
	stack, err := search.ExtractIfdefStack(file, line)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if stack == nil {
		stack = []graph.IfdefFrame{}
	}
	jsonOK(w, stack)
}

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

// --- /api/macro-values ---

// 電卓の識別子解決。names= のマクロ名（カンマ区切り）を整数値まで評価して
// {"NAME": "64"} で返す。決まらない名前はキーごと出さない — 間違った値を
// 見せるくらいなら出さない方針はホバーの値注釈と同じ。
func (h *Handler) handleMacroValues(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	var names []string
	for _, n := range strings.Split(q.Get("names"), ",") {
		n = strings.TrimSpace(n)
		if n != "" && reIdentifier.MatchString(n) {
			names = append(names, n)
		}
	}
	if len(names) == 0 {
		jsonErr(w, "names required", http.StatusBadRequest)
		return
	}
	// 名前数の上限は式として現実的な数まで。解決1件ごとに索引検索が走る
	if len(names) > 16 {
		names = names[:16]
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
	jsonOK(w, search.EvalMacroValues(r.Context(), names, dir, glob))
}
