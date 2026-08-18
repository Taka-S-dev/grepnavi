package api

import (
	"encoding/json"
	"net/http"
	"reflect"
	"runtime"
	"sync"

	"grepnavi/graph"
	"grepnavi/search"
)

// Handler はすべての REST ハンドラをまとめる。
type Handler struct {
	store       *graph.Store
	root        string
	events      *EventBus
	editorState *editorStateCache
	mu          sync.RWMutex
	// fileWrites がfalseの間は挿入系APIを全て403にする。-host でLAN公開した
	// 場合は EnableFileWrites が呼ばれず、任意ファイル書き込みの口を開かない。
	fileWrites bool
	// insMu は挿入系API (POST/PUT/DELETE/removeall) の
	// load-modify-save + store 更新をまたいで直列化する。ファイルの
	// read-modify-write と store 更新をまたぐため、store 自体のロックだけ
	// では直列化できない（NextInsertionTag 採番から AddInsertion までの
	// 間に別リクエストが割り込むとタグ重複や行番号の食い違いが起きる）。
	insMu sync.Mutex
	// lastRemoved / lastMoved は直前の撤去・移動1件の控え (insMu が守る)。
	// Ctrl+Z の復元専用で、履歴スタックは持たない。戻せるのは常に直前の1操作
	// だけなので、片方を立てるときにもう片方は捨てる。
	lastRemoved *removedInsertion
	lastMoved   *movedInsertion
}

func NewHandler(store *graph.Store, root string) *Handler {
	h := &Handler{store: store, root: root, events: NewEventBus(), editorState: newEditorStateCache()}
	applyProjectSettings(root)
	if search.GtagsAvailable(root) {
		search.GtagsCheckStaleAsync(root)
		search.GtagsWarmupAsync(root)
	}
	if search.CtagsIndexed(root) {
		search.CtagsMacroWarmup(root)
	}
	startIdleTrimmer(h.events)
	return h
}

func (h *Handler) Register(mux *http.ServeMux) {
	// static
	mux.HandleFunc("/", h.serveStatic)

	// search
	mux.HandleFunc("/api/search", h.handleSearch)
	mux.HandleFunc("/api/search/stream", h.handleSearchStream) // SSE

	// graph
	mux.HandleFunc("/api/graph", h.notifyGraphChange(h.handleGraph))
	mux.HandleFunc("/api/graph/node", h.notifyGraphChange(h.handleNode))
	mux.HandleFunc("/api/graph/node/", h.notifyGraphChange(h.handleNodeByID))
	mux.HandleFunc("/api/graph/edge", h.notifyGraphChange(h.handleEdge))
	mux.HandleFunc("/api/graph/edge/delete", h.notifyGraphChange(h.handleEdgeDelete))
	mux.HandleFunc("/api/graph/expand", h.notifyGraphChange(h.handleExpand))
	mux.HandleFunc("/api/graph/reparent", h.notifyGraphChange(h.handleReparent))
	mux.HandleFunc("/api/graph/tree/move-node", h.notifyGraphChange(h.handleTreeMoveNode))
	mux.HandleFunc("/api/graph/undo", h.notifyGraphChange(h.handleUndo))
	mux.HandleFunc("/api/graph/rootorder", h.notifyGraphChange(h.handleRootOrder))
	mux.HandleFunc("/api/graph/clear", h.notifyGraphChange(h.handleGraphClear))
	mux.HandleFunc("/api/graph/saveas", h.notifyGraphChange(h.handleGraphSaveAs))
	mux.HandleFunc("/api/graph/openfile", h.notifyGraphChange(h.handleGraphOpenFile))
	mux.HandleFunc("/api/graph/recover", h.notifyGraphChange(h.handleGraphRecover))
	mux.HandleFunc("/api/graph/anchors", h.handleGraphAnchors)
	// notifyGraphChange に包まない: graph.updated → loadGraph → heal → graph.updated のループになる。
	mux.HandleFunc("/api/graph/anchors/heal", h.handleGraphAnchorsHeal)
	mux.HandleFunc("/api/graph/memos", h.notifyGraphChange(h.handleGraphMemos))
	mux.HandleFunc("/api/graph/description", h.notifyGraphChange(h.handleGraphDescription))
	mux.HandleFunc("/api/graph/descriptions", h.handleGraphDescriptions)
	mux.HandleFunc("/api/graph/export", h.notifyGraphChange(h.handleGraphExport))
	mux.HandleFunc("/api/graph/import", h.notifyGraphChange(h.handleGraphImport))
	mux.HandleFunc("/api/trees", h.notifyGraphChange(h.handleTrees))
	mux.HandleFunc("/api/trees/", h.notifyGraphChange(h.handleTreeByID))
	mux.HandleFunc("/api/open", h.handleOpen)
	mux.HandleFunc("/api/reveal", h.handleReveal)
	mux.HandleFunc("/api/snippet", h.handleSnippet)
	mux.HandleFunc("/api/file", h.handleFile)
	mux.HandleFunc("/api/file/mtime", h.handleFileMtime)
	mux.HandleFunc("/api/func-body", h.handleFuncBody)
	mux.HandleFunc("/api/symbols", h.handleSymbols)
	mux.HandleFunc("/api/ifdef", h.handleIfdef)
	mux.HandleFunc("/api/ifdef-stack", h.handleIfdefStack)
	mux.HandleFunc("/api/definition", h.handleDefinition)
	mux.HandleFunc("/api/state-machine", h.handleStateMachine)
	mux.HandleFunc("/api/symbol-search", h.handleSymbolSearch)
	mux.HandleFunc("/api/heal-line", h.handleHealLine)
	mux.HandleFunc("/api/hover", h.handleHover)
	mux.HandleFunc("/api/macro-values", h.handleMacroValues)
	mux.HandleFunc("/api/new-window", h.handleNewWindow)
	mux.HandleFunc("/api/browse", h.handleBrowse)
	mux.HandleFunc("/api/dirs", h.handleDirs)
	mux.HandleFunc("/api/pick-dir", h.handlePickDir)
	mux.HandleFunc("/api/root", h.handleRoot)
	mux.HandleFunc("/api/projects", h.handleProjects)
	mux.HandleFunc("/api/projects/", h.handleProjectByID)
	mux.HandleFunc("/api/grepnavi/open", h.handleGrepnaviOpen)
	mux.HandleFunc("/api/grepnavi/graphs", h.handleGrepnaviGraphs)
	mux.HandleFunc("/api/grepnavi", h.handleGrepnavi)
	mux.HandleFunc("/api/files", h.handleFiles)
	mux.HandleFunc("/api/has-ignore", h.handleHasIgnore)
	// call tree
	mux.HandleFunc("/api/callers", h.handleCallers)
	mux.HandleFunc("/api/callees", h.handleCallees)
	mux.HandleFunc("/api/references", h.handleReferences)
	mux.HandleFunc("/api/structure", h.handleStructure)
	mux.HandleFunc("/api/structure/status", h.handleStructureStatus)
	mux.HandleFunc("/api/structure/build", h.handleStructureBuild)
	mux.HandleFunc("/api/structure/children", h.handleStructureChildren)
	// [GNU Global] 以下の4行を削除し、definition/hover/callersの分岐を除去で取り外し可能
	mux.HandleFunc("/api/gtags/status", h.handleGtagsStatus)
	mux.HandleFunc("/api/gtags/index", h.handleGtagsIndex)
	mux.HandleFunc("/api/gtags/update", h.handleGtagsUpdate)
	mux.HandleFunc("/api/gtags/rebuild", h.handleGtagsRebuild)
	mux.HandleFunc("/api/gtags/stream", h.handleGtagsStream)
	mux.HandleFunc("/api/ctags/status", h.handleCtagsStatus)
	mux.HandleFunc("/api/ctags/index", h.handleCtagsIndex)
	mux.HandleFunc("/api/ctags/file-symbols", h.handleCtagsFileSymbols)
	mux.HandleFunc("/api/ctags/macros", h.handleCtagsMacros)
	// [C言語アドオン] 以下の3行を削除するとインクルードグラフAPIが無効になります
	mux.HandleFunc("/api/include-graph", h.handleIncludeGraph)
	mux.HandleFunc("/api/include-file", h.handleIncludeFile)
	mux.HandleFunc("/api/include-by", h.handleIncludeBy)
	mux.HandleFunc("/api/memstats", h.handleMemStats)
	// ブラウザ向け SSE push チャンネル (graph / memo 更新通知)。
	mux.HandleFunc("/api/events", h.handleEvents)
	mux.HandleFunc("/api/editor-state", h.handleEditorState)
	// デバッグ仕込み。grepnavi のグラフ状態も変わるので notifyGraphChange で包む
	// （heal と違い、これらのハンドラは loadGraph を再帰的に呼ばないのでループしない）。
	mux.HandleFunc("/api/insertions", h.notifyGraphChange(h.handleInsertions))
	mux.HandleFunc("/api/insertions/removeall", h.notifyGraphChange(h.handleInsertionsRemoveAll))
	// 固定パスは ServeMux の最長一致で末尾スラッシュのプレフィックス
	// ("/api/insertions/{id}") より優先される。ID は GN 連番なので衝突しない。
	mux.HandleFunc("/api/insertions/toggle", h.notifyGraphChange(h.handleInsertionsToggle))
	mux.HandleFunc("/api/insertions/wrap", h.notifyGraphChange(h.handleInsertionsWrap))
	mux.HandleFunc("/api/insertions/group", h.notifyGraphChange(h.handleInsertionsGroup))
	mux.HandleFunc("/api/insertions/restore", h.notifyGraphChange(h.handleInsertionsRestore))
	mux.HandleFunc("/api/insertions/move", h.notifyGraphChange(h.handleInsertionsMove))
	mux.HandleFunc("/api/insertions/", h.notifyGraphChange(h.handleInsertionByID))
}

func (h *Handler) handleMemStats(w http.ResponseWriter, r *http.Request) {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	jsonOK(w, map[string]uint64{
		"HeapAlloc":    ms.HeapAlloc,
		"HeapInuse":    ms.HeapInuse,
		"HeapSys":      ms.HeapSys,
		"HeapIdle":     ms.HeapIdle,
		"HeapReleased": ms.HeapReleased,
		"Sys":          ms.Sys,
		"NumGC":        uint64(ms.NumGC),
	})
}

// cspMiddleware はすべてのレスポンスに Content-Security-Policy ヘッダーを付与する。
// connect-src 'self' により、フロントエンドが localhost 以外へ fetch/XHR/WebSocket を
// 送ることをブラウザレベルでブロックする。
func CspMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; "+
				"connect-src 'self'; "+
				"script-src 'self' 'unsafe-inline' blob:; "+
				"style-src 'self' 'unsafe-inline'; "+
				"font-src 'self' data:; "+
				"img-src 'self' data:; "+
				"worker-src blob:;",
		)
		next.ServeHTTP(w, r)
	})
}

func (h *Handler) serveStatic(w http.ResponseWriter, r *http.Request) {
	// Cache-Control 無しだとヒューリスティックキャッシュ（Last-Modified 経過の約10%）で
	// 更新後も古い JS/CSS が数日使われ続ける（WebView2 の再起動でも再検証されない）。
	// no-cache = 毎回 If-Modified-Since で再検証。未変更なら 304 で済み、
	// localhost 配信なので実コストはほぼゼロ。
	w.Header().Set("Cache-Control", "no-cache")
	if r.URL.Path == "/" || r.URL.Path == "/index.html" {
		http.ServeFile(w, r, "static/index.html")
		return
	}
	http.ServeFile(w, r, "static"+r.URL.Path)
}

// jsonOK は v を JSON で返す。空のスライスは null ではなく [] として返す。
// nil スライスは JSON では null になり、受け取る側の `hits.length` が例外に
// なる。ブラウザ側は「結果0件」と「壊れた応答」を区別できないまま止まるので、
// 一覧を返す口が空を表す形を1つに揃える。
func jsonOK(w http.ResponseWriter, v interface{}) {
	if rv := reflect.ValueOf(v); rv.Kind() == reflect.Slice && rv.IsNil() {
		v = reflect.MakeSlice(rv.Type(), 0, 0).Interface()
	}
	data, err := json.Marshal(v)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(data)
}

func jsonErr(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
