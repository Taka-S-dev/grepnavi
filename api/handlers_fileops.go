package api

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"grepnavi/search"
)

// 大規模 project で rg --files が秒単位かかるため (root, glob) 単位でメモ化する。
// 無効化は root 変更時の invalidateFilesCache で行う。
var filesCache struct {
	sync.RWMutex
	root    string
	entries map[string][]string // glob → files
}

func invalidateFilesCache() {
	filesCache.Lock()
	filesCache.root = ""
	filesCache.entries = nil
	filesCache.Unlock()
}

func setFilesCache(root, glob string, files []string) {
	filesCache.Lock()
	if filesCache.root != root || filesCache.entries == nil {
		filesCache.root = root
		filesCache.entries = map[string][]string{}
	}
	filesCache.entries[glob] = files
	filesCache.Unlock()
}

// --- /api/open ---

func (h *Handler) handleOpen(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	file   := q.Get("file")
	line   := q.Get("line")
	editor := q.Get("editor")
	if file == "" {
		jsonErr(w, "file is required", http.StatusBadRequest)
		return
	}
	if err := openInEditor(file, line, editor); err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]string{"status": "ok"})
}

// --- /api/reveal ---

func (h *Handler) handleReveal(w http.ResponseWriter, r *http.Request) {
	file := r.URL.Query().Get("file")
	if file == "" {
		jsonErr(w, "file is required", http.StatusBadRequest)
		return
	}
	if err := revealInExplorer(file); err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]string{"status": "ok"})
}

// --- /api/grepnavi ---

const grepnaviFile = ".grepnavi"

func addGraphToGrepnavi(root, graphPath string) {
	if root == "" || graphPath == "" {
		return
	}
	p := filepath.Join(root, grepnaviFile)
	cfg := readGrepnavi(p)
	cfg.Root = root
	clean := filepath.Clean(graphPath)
	for _, g := range cfg.Graphs {
		if filepath.Clean(g) == clean {
			return
		}
	}
	cfg.Graphs = append(cfg.Graphs, graphPath)
	_ = writeGrepnavi(p, cfg)
}

type grepnaviCfg struct {
	Root   string   `json:"root"`
	Graphs []string `json:"graphs"`
}

func readGrepnavi(path string) grepnaviCfg {
	data, err := os.ReadFile(path)
	if err != nil {
		return grepnaviCfg{}
	}
	// new format
	var cfg grepnaviCfg
	if json.Unmarshal(data, &cfg) == nil && cfg.Graphs != nil {
		return cfg
	}
	// legacy format: {root, graph}
	var old map[string]string
	if json.Unmarshal(data, &old) == nil {
		c := grepnaviCfg{Root: old["root"]}
		if g := old["graph"]; g != "" {
			c.Graphs = []string{g}
		}
		return c
	}
	return grepnaviCfg{}
}

func writeGrepnavi(path string, cfg grepnaviCfg) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func (h *Handler) handleGrepnavi(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()

	p := filepath.Join(root, grepnaviFile)

	switch r.Method {
	case http.MethodGet:
		cfg := readGrepnavi(p)
		cfg.Root = root
		jsonOK(w, cfg)

	case http.MethodPost:
		// body: {root, graph} — graph を追加、または {graphs:[...]} で直接上書き
		var body struct {
			Root   string   `json:"root"`
			Graph  string   `json:"graph"`
			Graphs []string `json:"graphs"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonErr(w, err.Error(), http.StatusBadRequest)
			return
		}
		cfg := readGrepnavi(p)
		cfg.Root = root
		if body.Graphs != nil {
			cfg.Graphs = body.Graphs
		} else if body.Graph != "" {
			exists := false
			for _, g := range cfg.Graphs {
				if filepath.Clean(g) == filepath.Clean(body.Graph) {
					exists = true
					break
				}
			}
			if !exists {
				cfg.Graphs = append(cfg.Graphs, body.Graph)
			}
		}
		if err := writeGrepnavi(p, cfg); err != nil {
			jsonErr(w, err.Error(), http.StatusInternalServerError)
			return
		}
		jsonOK(w, cfg)

	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// --- /api/root ---

func (h *Handler) handleRoot(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.mu.RLock()
		root := h.root
		h.mu.RUnlock()
		jsonOK(w, map[string]string{"root": root})
	case http.MethodPost:
		var body struct {
			Root string `json:"root"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Root == "" {
			jsonErr(w, "root is required", http.StatusBadRequest)
			return
		}
		abs := filepath.Clean(body.Root)
		if !filepath.IsAbs(abs) {
			jsonErr(w, "absolute path required", http.StatusBadRequest)
			return
		}
		if _, err := os.Stat(abs); err != nil {
			jsonErr(w, "directory not found: "+abs, http.StatusBadRequest)
			return
		}
		h.mu.Lock()
		h.root = abs
		h.mu.Unlock()
		// pf.RootDir も in-memory で更新する（ディスク保存はしない）。これで saveas や
		// 新規グラフを保存したときに「今の検索ルート」が root_dir として書かれる。
		// 保存ありの SetRootDir を使うと、別 root のファイルを開いたまま root を変えた際に
		// そのファイルへ別 root を焼き付けてしまうため、NoSave 版を使う。
		h.store.SetRootDirNoSave(abs)
		invalidateFilesCache()
		slog.Debug("root changed", "abs", abs, "ctags_indexed", search.CtagsIndexed(abs))
		if search.CtagsIndexed(abs) {
			search.CtagsMacroWarmup(abs)
		}
		jsonOK(w, map[string]string{"root": abs})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// --- /api/has-ignore ---

// handleHasIgnore は現在の検索ルートに .gitignore / .ignore / .rgignore があるかを返す。
// ripgrep はこれらを既定で尊重して暗黙にファイルを除外するため、GUI で「除外が効いている」
// ことに気づけるよう、マーカー表示の判定に使う。
func (h *Handler) handleHasIgnore(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()
	found := []string{}
	if root != "" {
		for _, name := range []string{".gitignore", ".ignore", ".rgignore"} {
			if fi, err := os.Stat(filepath.Join(root, name)); err == nil && !fi.IsDir() {
				found = append(found, name)
			}
		}
	}
	jsonOK(w, map[string]interface{}{"has": len(found) > 0, "files": found})
}

// --- /api/files ---

// handleFiles は rg --files でプロジェクト内のファイル一覧を返す。
// ?glob=*.c,*.h のように指定すると対象を絞れる。
// ?stream=1 で NDJSON (1 ファイル 1 行) を逐次 Flush する。指定なしは JSON array。
func (h *Handler) handleFiles(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()
	if root == "" {
		root = "."
	}
	glob := r.URL.Query().Get("glob")
	stream := r.URL.Query().Get("stream") == "1"
	filesCache.RLock()
	var cached []string
	hit := filesCache.root == root && filesCache.entries != nil
	if hit {
		cached, hit = filesCache.entries[glob]
	}
	filesCache.RUnlock()
	if hit {
		if stream {
			writeFilesNDJSON(w, cached)
		} else {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(cached)
		}
		return
	}
	args := []string{"--files"}
	for _, g := range strings.FieldsFunc(glob, func(r rune) bool { return r == ',' || r == ' ' }) {
		args = append(args, "--glob", g)
	}
	args = append(args, root)
	cmd := exec.Command("rg", args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := cmd.Start(); err != nil {
		// rg が使えない場合は filepath.Walk でフォールバック
		var files []string
		filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() {
				return nil
			}
			base := filepath.Base(filepath.Dir(path))
			if base[0] == '.' || base == "node_modules" || base == "vendor" {
				return nil
			}
			rel, _ := filepath.Rel(root, path)
			files = append(files, filepath.ToSlash(rel))
			return nil
		})
		setFilesCache(root, glob, files)
		if stream {
			writeFilesNDJSON(w, files)
		} else {
			jsonOK(w, files)
		}
		return
	}

	if stream {
		w.Header().Set("Content-Type", "application/x-ndjson")
		flusher, _ := w.(http.Flusher)
		enc := json.NewEncoder(w)
		seen := map[string]bool{}
		var files []string
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 256*1024), 256*1024)
		// 1 行ごとの Flush は TCP 過剰分割を招くので 256 行単位で纏める。
		const flushEvery = 256
		batched := 0
		for scanner.Scan() {
			l := scanner.Text()
			if l == "" {
				continue
			}
			rel, relErr := filepath.Rel(root, l)
			if relErr != nil {
				rel = l
			}
			rel = filepath.ToSlash(rel)
			if seen[rel] {
				continue
			}
			seen[rel] = true
			files = append(files, rel)
			if err := enc.Encode(rel); err != nil {
				break // client disconnect
			}
			batched++
			if batched >= flushEvery && flusher != nil {
				flusher.Flush()
				batched = 0
			}
		}
		cmd.Wait()
		if flusher != nil {
			flusher.Flush()
		}
		setFilesCache(root, glob, files)
		return
	}

	// rg 出力を1行ずつ処理してメモリコピーを削減
	seen := map[string]bool{}
	var files []string
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 256*1024), 256*1024)
	for scanner.Scan() {
		l := scanner.Text()
		if l == "" {
			continue
		}
		rel, err := filepath.Rel(root, l)
		if err != nil {
			rel = l
		}
		rel = filepath.ToSlash(rel)
		if seen[rel] {
			continue
		}
		seen[rel] = true
		files = append(files, rel)
	}
	cmd.Wait()

	setFilesCache(root, glob, files)

	// json.NewEncoder で直接書き出し（json.Marshal の中間バッファを省略）
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(files)
}

func writeFilesNDJSON(w http.ResponseWriter, files []string) {
	w.Header().Set("Content-Type", "application/x-ndjson")
	enc := json.NewEncoder(w)
	for _, f := range files {
		if err := enc.Encode(f); err != nil {
			return
		}
	}
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
}

// --- /api/dirs ---

func (h *Handler) handleDirs(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()
	if root == "" {
		root = "."
	}
	var dirs []string
	filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if !info.IsDir() {
			return nil
		}
		// 隠しディレクトリ・よくある無関係ディレクトリはスキップ
		base := filepath.Base(path)
		if base != "." && (base[0] == '.' || base == "node_modules" || base == "vendor" || base == "__pycache__") {
			return filepath.SkipDir
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		dirs = append(dirs, filepath.ToSlash(rel))
		return nil
	})
	jsonOK(w, dirs)
}

// --- /api/browse ---

// handleBrowse はディレクトリ内容を返す。
// ?path=<dir>&ext=.json でファイルを拡張子フィルタリングできる。
func (h *Handler) handleBrowse(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	dir := q.Get("path")
	ext := q.Get("ext") // e.g. ".json"

	pick := q.Get("pick") == "1" // ルート選択ダイアログからの呼び出し
	explicitPath := dir != ""
	if dir == "" {
		if exe, err := os.Executable(); err == nil {
			dir = filepath.Dir(exe)
		} else {
			dir = "."
		}
	}
	dir = filepath.Clean(dir)

	if explicitPath && !pick {
		h.mu.RLock()
		root := filepath.Clean(h.root)
		h.mu.RUnlock()
		if !strings.HasPrefix(dir+string(filepath.Separator), root+string(filepath.Separator)) {
			jsonErr(w, "path outside root", http.StatusForbidden)
			return
		}
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusBadRequest)
		return
	}

	var dirs, files []string
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		if e.IsDir() {
			dirs = append(dirs, name)
		} else if ext == "" || strings.EqualFold(filepath.Ext(name), ext) {
			files = append(files, name)
		}
	}

	parent := filepath.Dir(dir)
	if parent == dir {
		parent = "" // ドライブルート等、これ以上上がれない
	}

	jsonOK(w, map[string]any{
		"path":   filepath.ToSlash(dir),
		"parent": filepath.ToSlash(parent),
		"dirs":   dirs,
		"files":  files,
	})
}

// --- /api/pick-dir ---

func (h *Handler) handlePickDir(w http.ResponseWriter, r *http.Request) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("powershell", "-NoProfile", "-Command",
			`Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'プロジェクトルートを選択'; if($d.ShowDialog() -eq 'OK'){$d.SelectedPath}`)
	case "darwin":
		cmd = exec.Command("osascript", "-e", "POSIX path of (choose folder with prompt \"プロジェクトルートを選択\")")
	default:
		// Linux: zenity を試みる
		cmd = exec.Command("zenity", "--file-selection", "--directory", "--title=プロジェクトルートを選択")
	}
	out, err := cmd.Output()
	if err != nil {
		// キャンセルまたはコマンドなし
		jsonOK(w, map[string]string{"path": ""})
		return
	}
	path := strings.TrimSpace(string(out))
	jsonOK(w, map[string]string{"path": path})
}

// --- /api/new-window ---

// handleNewWindow は空きポートで新しいプロセスを起動し URL を返す。
func (h *Handler) handleNewWindow(w http.ResponseWriter, r *http.Request) {
	port, err := findFreePort(8081)
	if err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}

	exe, err := os.Executable()
	if err != nil {
		jsonErr(w, "executable not found: "+err.Error(), http.StatusInternalServerError)
		return
	}

	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()

	graphPath := filepath.Join(filepath.Dir(exe), fmt.Sprintf("graph-%d.json", port))
	cmd := exec.Command(exe, "-port", strconv.Itoa(port), "-root", root, "-graph", graphPath, "-no-browser")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		jsonErr(w, "failed to launch: "+err.Error(), http.StatusInternalServerError)
		return
	}

	jsonOK(w, map[string]string{"url": fmt.Sprintf("http://localhost:%d", port)})
}

func findFreePort(start int) (int, error) {
	for port := start; port < start+100; port++ {
		ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
		if err == nil {
			ln.Close()
			return port, nil
		}
	}
	return 0, fmt.Errorf("no available port found in range %d-%d", start, start+99)
}

func openInEditor(file, line, editorTmpl string) error {
	if editorTmpl == "" {
		editorTmpl = "code --goto {file}:{line}"
	}
	if line == "" {
		line = "1"
	}
	quotedFile := `"` + file + `"`
	// "{file}" と書いてあっても {file} と書いてあっても両方クォート済みパスに置換
	cmdStr := strings.ReplaceAll(editorTmpl, `"{file}"`, quotedFile)
	cmdStr  = strings.ReplaceAll(cmdStr,     `{file}`,   quotedFile)
	cmdStr  = strings.ReplaceAll(cmdStr,     `{line}`,   line)
	parts := splitShellWords(cmdStr)
	if len(parts) == 0 {
		return nil
	}
	exec.Command(parts[0], parts[1:]...).Start()
	return nil
}

// splitShellWords はダブルクォートを考慮してコマンド文字列をトークンに分割する。
func splitShellWords(s string) []string {
	var parts []string
	var cur strings.Builder
	inQuote := false
	for _, r := range s {
		switch {
		case r == '"':
			inQuote = !inQuote
		case r == ' ' && !inQuote:
			if cur.Len() > 0 {
				parts = append(parts, cur.String())
				cur.Reset()
			}
		default:
			cur.WriteRune(r)
		}
	}
	if cur.Len() > 0 {
		parts = append(parts, cur.String())
	}
	return parts
}

// revealInExplorer はファイルをOSのファイルマネージャで選択状態で開く。
func revealInExplorer(file string) error {
	switch runtime.GOOS {
	case "windows":
		cmd := exec.Command("explorer", "/select,"+filepath.FromSlash(file))
		cmd.Start()
	case "darwin":
		cmd := exec.Command("open", "-R", file)
		cmd.Start()
	default:
		cmd := exec.Command("xdg-open", filepath.Dir(file))
		cmd.Start()
	}
	return nil
}

func sanitizeUTF8(s string) string {
	if utf8.ValidString(s) {
		return s
	}
	b := []byte(s)
	var out strings.Builder
	for len(b) > 0 {
		r, size := utf8.DecodeRune(b)
		if r == utf8.RuneError && size == 1 {
			out.WriteRune('?')
		} else {
			out.WriteRune(r)
		}
		b = b[size:]
	}
	return out.String()
}
