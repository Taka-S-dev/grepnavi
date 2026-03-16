package graph

import (
	"crypto/rand"
	"encoding/hex"
	"time"
)

// IfdefFrame は #ifdef/#ifndef/#if などの1段分の条件コンパイルブロックを表す。
type IfdefFrame struct {
	Line      int    `json:"line"`
	Directive string `json:"directive"`
	Condition string `json:"condition"`
	Active    bool   `json:"active"`
}

// Match は ripgrep の1件のマッチ結果。
type Match struct {
	ID         string        `json:"id"`
	File       string        `json:"file"`
	Line       int           `json:"line"`
	Col        int           `json:"col"`
	Text       string        `json:"text"`
	Snippet    []SnippetLine `json:"snippet"`
	IfdefStack []IfdefFrame  `json:"ifdef_stack"`
	Query      string        `json:"query"`
}

// SnippetLine はスニペットの1行。
type SnippetLine struct {
	Line    int    `json:"line"`
	Text    string `json:"text"`
	IsMatch bool   `json:"is_match"`
}

// Node はグラフ上の1ノード。
type Node struct {
	ID       string   `json:"id"`
	Match    Match    `json:"match"`
	Label    string   `json:"label"`
	Memo     string   `json:"memo"`
	Tags     []string `json:"tags"`
	PosX     float64  `json:"pos_x"`
	PosY     float64  `json:"pos_y"`
	Expanded bool     `json:"expanded"`
	Children []string `json:"children"`
}

// Edge はノード間の有向エッジ。
type Edge struct {
	ID    string `json:"id"`
	From  string `json:"from"`
	To    string `json:"to"`
	Label string `json:"label"`
}

// Tree はプロジェクト内の1調査ツリー。
type Tree struct {
	ID        string           `json:"id"`
	Name      string           `json:"name"`
	Nodes     map[string]*Node `json:"nodes"`
	Edges     []*Edge          `json:"edges"`
	RootOrder []string         `json:"root_order,omitempty"`
	CreatedAt time.Time        `json:"created_at"`
	UpdatedAt time.Time        `json:"updated_at"`
}

// ProjectFile はプロジェクトファイルのトップレベル構造（複数ツリー対応）。
type ProjectFile struct {
	Version      int               `json:"version"`
	RootDir      string            `json:"root_dir"`
	ActiveTreeID string            `json:"active_tree_id"`
	Trees        []*Tree           `json:"trees"`
	LineMemos    map[string]string `json:"line_memos,omitempty"`
	UpdatedAt    time.Time         `json:"updated_at"`
}

// TreeMeta はツリー一覧用の軽量メタデータ。
type TreeMeta struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// GraphResponse はアクティブツリーの API レスポンス。
type GraphResponse struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Nodes        map[string]*Node  `json:"nodes"`
	Edges        []*Edge           `json:"edges"`
	RootDir      string            `json:"root_dir"`
	UpdatedAt    time.Time         `json:"updated_at"`
	Trees        []TreeMeta        `json:"trees"`
	ActiveTreeID string            `json:"active_tree_id"`
	LineMemos    map[string]string `json:"line_memos,omitempty"`
	RootOrder    []string          `json:"root_order,omitempty"`
}

func NewProjectFile(rootDir string) *ProjectFile {
	t := NewTree("ツリー1")
	return &ProjectFile{
		Version:      2,
		RootDir:      rootDir,
		ActiveTreeID: t.ID,
		Trees:        []*Tree{t},
	}
}

func NewTree(name string) *Tree {
	now := time.Now()
	return &Tree{
		ID:        GenID(),
		Name:      name,
		Nodes:     make(map[string]*Node),
		Edges:     []*Edge{},
		CreatedAt: now,
		UpdatedAt: now,
	}
}

func GenID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
