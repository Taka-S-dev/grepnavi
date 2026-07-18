package api

import (
	"encoding/json"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"grepnavi/search"
)

type Project struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	GrepnaviFile string   `json:"grepnaviFile"`
	Graphs       []string `json:"graphs"`
}

var (
	projectsMu   sync.Mutex
	projectsFile string
)

func init() {
	exe, err := os.Executable()
	if err != nil {
		projectsFile = "grepnavi-projects.json"
	} else {
		projectsFile = filepath.Join(filepath.Dir(exe), "grepnavi-projects.json")
	}
}

func loadProjects() []Project {
	data, err := os.ReadFile(projectsFile)
	if err != nil {
		return []Project{}
	}
	var projects []Project
	if err := json.Unmarshal(data, &projects); err != nil {
		return []Project{}
	}
	return projects
}

func saveProjects(projects []Project) error {
	data, err := json.MarshalIndent(projects, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(projectsFile, data, 0644)
}

func randID() string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 8)
	for i := range b {
		b[i] = chars[rand.Intn(len(chars))]
	}
	return string(b)
}

func projectsWithGraphs(projects []Project) []Project {
	out := make([]Project, len(projects))
	for i, p := range projects {
		cfg := readGrepnavi(p.GrepnaviFile)
		p.Graphs = cfg.Graphs
		if p.Graphs == nil {
			p.Graphs = []string{}
		}
		out[i] = p
	}
	return out
}

func (h *Handler) handleProjects(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		projectsMu.Lock()
		projects := loadProjects()
		projectsMu.Unlock()
		jsonOK(w, projectsWithGraphs(projects))
	case http.MethodPost:
		var body struct {
			Name         string `json:"name"`
			GrepnaviFile string `json:"grepnaviFile"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" || body.GrepnaviFile == "" {
			jsonErr(w, "name and grepnaviFile are required", http.StatusBadRequest)
			return
		}
		clean := filepath.Clean(body.GrepnaviFile)
		projectsMu.Lock()
		defer projectsMu.Unlock()
		projects := loadProjects()
		for i, p := range projects {
			if filepath.Clean(p.GrepnaviFile) == clean {
				projects[i].Name = body.Name
				saveProjects(projects)
				jsonOK(w, projects)
				return
			}
		}
		projects = append(projects, Project{ID: randID(), Name: body.Name, GrepnaviFile: clean})
		saveProjects(projects)
		jsonOK(w, projectsWithGraphs(projects))
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (h *Handler) handleProjectByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/projects/")
	if id == "" || r.Method != http.MethodDelete {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	projectsMu.Lock()
	defer projectsMu.Unlock()
	projects := loadProjects()
	filtered := make([]Project, 0, len(projects))
	for _, p := range projects {
		if p.ID != id {
			filtered = append(filtered, p)
		}
	}
	saveProjects(filtered)
	jsonOK(w, projectsWithGraphs(filtered))
}

// PUT /api/grepnavi/graphs  body:{grepnaviFile, graphs:[...]}
func (h *Handler) handleGrepnaviGraphs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, "PUT only", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		GrepnaviFile string   `json:"grepnaviFile"`
		Graphs       []string `json:"graphs"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.GrepnaviFile == "" {
		jsonErr(w, "grepnaviFile required", http.StatusBadRequest)
		return
	}
	cfg := readGrepnavi(body.GrepnaviFile)
	cfg.Graphs = body.Graphs
	if err := writeGrepnavi(body.GrepnaviFile, cfg); err != nil {
		jsonErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jsonOK(w, cfg)
}

// POST /api/grepnavi/open  body:{path:"..."}
// 指定した .grepnavi ファイルを読み、root と graph を返す。
// サーバー側の root もそのファイルの親ディレクトリに更新する。
func (h *Handler) handleGrepnaviOpen(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Path == "" {
		jsonErr(w, "path required", http.StatusBadRequest)
		return
	}
	cfg := readGrepnavi(body.Path)
	root := cfg.Root
	if root == "" {
		root = filepath.Dir(body.Path)
	}
	root = filepath.Clean(root)
	if _, err := os.Stat(root); err != nil {
		jsonErr(w, "root directory not found: "+root, http.StatusBadRequest)
		return
	}
	h.mu.Lock()
	h.root = root
	h.mu.Unlock()
	invalidateFilesCache()
	search.GtagsWarmupAsync(root)
	jsonOK(w, map[string]interface{}{"root": root, "graphs": cfg.Graphs})
}
