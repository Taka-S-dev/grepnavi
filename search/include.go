package search

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

var reLocalInclude = regexp.MustCompile(`#\s*include\s*"([^"]+)"`)
var reSystemInclude = regexp.MustCompile(`#\s*include\s*<([^>]+)>`)

// IncludeNode はインクルードグラフのノード（ファイル）。
type IncludeNode struct {
	ID    string `json:"id"`    // dir からの相対パス
	Label string `json:"label"` // ファイル名のみ
}

// IncludeEdge はインクルード関係（from が to を #include）。
type IncludeEdge struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// IncludeGraph はファイル間の #include 依存グラフ。
type IncludeGraph struct {
	Nodes     []IncludeNode `json:"nodes"`
	Edges     []IncludeEdge `json:"edges"`
	Truncated bool          `json:"truncated"` // 上限でカットされた場合 true
}

// buildHeaderSuffixIndex は dir 以下の全ヘッダファイルを収集し、
// パスサフィックスから相対パスを引けるインデックスを返す。
// <openssl/bio.h> → "ssl/bio.h", "bio.h" などのサフィックスで引ける。
func buildHeaderSuffixIndex(ctx context.Context, dir string) map[string]string {
	args := []string{"--files", "--glob", "*.h", "--glob", "*.hpp", dir}
	cmd := exec.CommandContext(ctx, "rg", args...)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Run() // エラーは無視（ヘッダがない場合もある）

	index := map[string]string{} // suffix → relpath（最初に見つかったもの）
	scanner := bufio.NewScanner(&stdout)
	for scanner.Scan() {
		absPath := strings.TrimSpace(scanner.Text())
		relPath, err := filepath.Rel(dir, absPath)
		if err != nil {
			continue
		}
		relPath = filepath.ToSlash(relPath)
		parts := strings.Split(relPath, "/")
		for i := range parts {
			suffix := strings.Join(parts[i:], "/")
			if _, exists := index[suffix]; !exists {
				index[suffix] = relPath
			}
		}
	}
	return index
}

// parseIncludeLine は #include 行からパスと種別（system か否か）を返す。
func parseIncludeLine(line string) (path string, isSystem bool, ok bool) {
	if m := reLocalInclude.FindStringSubmatch(line); m != nil {
		return m[1], false, true
	}
	if m := reSystemInclude.FindStringSubmatch(line); m != nil {
		return m[1], true, true
	}
	return "", false, false
}

// BuildIncludeGraph は dir 以下の C/H ファイルの #include を解析して
// ファイル依存グラフを返す。glob で対象ファイルを絞れる。
// "..." スタイルと <...> スタイルの両方を対象とし、<...> はプロジェクト内に
// 存在するファイルのみグラフに含める。
func BuildIncludeGraph(ctx context.Context, dir, glob string) (*IncludeGraph, error) {
	if glob == "" {
		glob = "*.c,*.h,*.cpp,*.hpp,*.cc"
	}

	// プロジェクト内ヘッダのサフィックスインデックスを構築
	headerIndex := buildHeaderSuffixIndex(ctx, dir)

	args := []string{"--json"}
	for _, g := range strings.FieldsFunc(glob, func(r rune) bool { return r == ' ' || r == ',' }) {
		args = append(args, "--glob", strings.TrimSpace(g))
	}
	// "..." と <...> の両方をマッチ
	args = append(args, "--", `#\s*include\s*(?:"[^"]+"|<[^>]+>)`, dir)

	cmd := exec.CommandContext(ctx, "rg", args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, nil
		}
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return &IncludeGraph{Nodes: []IncludeNode{}, Edges: []IncludeEdge{}}, nil
		}
		return nil, fmt.Errorf("rg failed: %v\n%s", err, stderr.String())
	}

	type rgText struct{ Text string `json:"text"` }
	type rgData struct {
		Path  rgText `json:"path"`
		Lines rgText `json:"lines"`
	}
	type rgEvent struct {
		Type string          `json:"type"`
		Data json.RawMessage `json:"data"`
	}

	nodesSet := map[string]bool{}
	edgeSet := map[string]bool{}
	var edges []IncludeEdge

	scanner := bufio.NewScanner(&stdout)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		var ev rgEvent
		if err := json.Unmarshal(scanner.Bytes(), &ev); err != nil {
			continue
		}
		if ev.Type != "match" {
			continue
		}

		var d rgData
		if err := json.Unmarshal(ev.Data, &d); err != nil {
			continue
		}

		fromAbs := d.Path.Text
		included, isSystem, ok := parseIncludeLine(d.Lines.Text)
		if !ok {
			continue
		}

		fromRel, err := filepath.Rel(dir, fromAbs)
		if err != nil {
			continue
		}
		fromRel = filepath.ToSlash(fromRel)

		var toRel string
		if isSystem {
			// <...> はプロジェクト内サフィックスマッチで解決
			resolved, found := headerIndex[filepath.ToSlash(included)]
			if !found {
				continue // プロジェクト外のシステムヘッダは除外
			}
			toRel = resolved
		} else {
			// "..." は相対パスで解決
			fromDir := filepath.Dir(fromAbs)
			toAbs := filepath.Clean(filepath.Join(fromDir, included))
			rel, err := filepath.Rel(dir, toAbs)
			if err != nil || strings.HasPrefix(rel, "..") {
				continue
			}
			toRel = filepath.ToSlash(rel)
		}

		nodesSet[fromRel] = true
		nodesSet[toRel] = true

		key := fromRel + "→" + toRel
		if !edgeSet[key] {
			edgeSet[key] = true
			edges = append(edges, IncludeEdge{From: fromRel, To: toRel})
		}
	}

	const maxNodes = 100
	const maxEdges = 200

	nodes := make([]IncludeNode, 0, len(nodesSet))
	for id := range nodesSet {
		nodes = append(nodes, IncludeNode{
			ID:    id,
			Label: filepath.Base(id),
		})
		if len(nodes) >= maxNodes {
			break
		}
	}
	truncated := len(nodesSet) > maxNodes

	if len(edges) > maxEdges {
		edges = edges[:maxEdges]
		truncated = true
	}
	if edges == nil {
		edges = []IncludeEdge{}
	}

	return &IncludeGraph{Nodes: nodes, Edges: edges, Truncated: truncated}, nil
}

// GetFileIncludes は1ファイルの #include を解析して
// インクルード先のファイルリストを返す。root からの相対パスで表現する。
// "..." と <...> の両方を対象とし、<...> はプロジェクト内に存在するもののみ返す。
func GetFileIncludes(absFile, root string) ([]IncludeNode, error) {
	lines, err := CachedLines(absFile)
	if err != nil {
		return nil, err
	}

	// <...> 解決用にヘッダインデックスを構築
	headerIndex := buildHeaderSuffixIndex(context.Background(), root)

	fileDir := filepath.Dir(absFile)
	seen := map[string]bool{}
	var result []IncludeNode

	for _, line := range lines {
		included, isSystem, ok := parseIncludeLine(line)
		if !ok {
			continue
		}

		var toRel string
		if isSystem {
			resolved, found := headerIndex[filepath.ToSlash(included)]
			if !found {
				continue
			}
			toRel = resolved
		} else {
			toAbs := filepath.Clean(filepath.Join(fileDir, included))
			rel, err := filepath.Rel(root, toAbs)
			if err != nil || strings.HasPrefix(rel, "..") {
				continue
			}
			toRel = filepath.ToSlash(rel)
		}

		if seen[toRel] {
			continue
		}
		seen[toRel] = true
		result = append(result, IncludeNode{ID: toRel, Label: filepath.Base(toRel)})
	}
	return result, nil
}

// GetIncludedBy はファイル名（basename）を #include しているファイルを ripgrep で検索する。
// "..." と <...> の両方を対象とする。
func GetIncludedBy(absFile, root, glob string) ([]IncludeNode, error) {
	base := filepath.Base(absFile)
	if glob == "" {
		glob = "*.c,*.h,*.cpp,*.hpp,*.cc"
	}

	quotedBase := regexp.QuoteMeta(base)
	pattern := `#\s*include\s*(?:"` + quotedBase + `"|<[^>]*` + quotedBase + `>)`
	args := []string{"--json", "--no-heading"}
	for _, g := range strings.FieldsFunc(glob, func(r rune) bool { return r == ' ' || r == ',' }) {
		args = append(args, "--glob", strings.TrimSpace(g))
	}
	args = append(args, "--", pattern, root)

	cmd := exec.Command("rg", args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return []IncludeNode{}, nil
		}
		return nil, fmt.Errorf("rg: %v\n%s", err, stderr.String())
	}

	type rgText struct{ Text string `json:"text"` }
	type rgData struct{ Path rgText `json:"path"` }
	type rgEvent struct {
		Type string          `json:"type"`
		Data json.RawMessage `json:"data"`
	}

	seen := map[string]bool{}
	var result []IncludeNode

	scanner := bufio.NewScanner(&stdout)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		var ev rgEvent
		if err := json.Unmarshal(scanner.Bytes(), &ev); err != nil || ev.Type != "match" {
			continue
		}
		var d rgData
		if err := json.Unmarshal(ev.Data, &d); err != nil {
			continue
		}
		fromAbs := d.Path.Text
		fromRel, err := filepath.Rel(root, fromAbs)
		if err != nil {
			continue
		}
		fromRel = filepath.ToSlash(fromRel)
		if seen[fromRel] {
			continue
		}
		seen[fromRel] = true
		result = append(result, IncludeNode{ID: fromRel, Label: filepath.Base(fromRel)})
	}
	return result, nil
}
