package api

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"unicode/utf8"
)

// --- /api/open ---

func (h *Handler) handleOpen(w http.ResponseWriter, r *http.Request) {
	file := r.URL.Query().Get("file")
	line := r.URL.Query().Get("line")
	if file == "" {
		jsonErr(w, "file is required", http.StatusBadRequest)
		return
	}
	target := file
	if line != "" {
		target = file + ":" + line
	}
	if err := openInEditor(target); err != nil {
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
		h.store.SetRootDir(abs)
		jsonOK(w, map[string]string{"root": abs})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// --- /api/files ---

// handleFiles は rg --files でプロジェクト内のファイル一覧を返す。
// ?glob=*.c,*.h のように指定すると対象ファイルを絞れる。
func (h *Handler) handleFiles(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()
	if root == "" {
		root = "."
	}
	args := []string{"--files"}
	for _, g := range strings.FieldsFunc(r.URL.Query().Get("glob"), func(r rune) bool { return r == ',' || r == ' ' }) {
		args = append(args, "--glob", g)
	}
	args = append(args, root)
	cmd := exec.Command("rg", args...)
	out, err := cmd.Output()
	if err != nil {
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
		jsonOK(w, files)
		return
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	files := make([]string, 0, len(lines))
	for _, l := range lines {
		if l == "" {
			continue
		}
		rel, err := filepath.Rel(root, l)
		if err != nil {
			rel = l
		}
		files = append(files, filepath.ToSlash(rel))
	}
	jsonOK(w, files)
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

	if dir == "" {
		if exe, err := os.Executable(); err == nil {
			dir = filepath.Dir(exe)
		} else {
			dir = "."
		}
	}
	dir = filepath.Clean(dir)

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

func openInEditor(target string) error {
	cmd := exec.Command("code", "--goto", target)
	cmd.Start()
	return nil
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
