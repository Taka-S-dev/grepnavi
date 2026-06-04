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
	Kind       string        `json:"kind"` // "func" / "define" / "struct" / "enum" / "typedef" / ""
	Snippet    []SnippetLine `json:"snippet"`
	IfdefStack []IfdefFrame  `json:"ifdef_stack"`
	Query      string        `json:"query"`
	NonUTF8    bool          `json:"non_utf8,omitempty"` // ripgrep が UTF-8 として復号できず SJIS/EUC-JP フォールバックを使用
}

// SnippetLine はスニペットの1行。
type SnippetLine struct {
	Line    int    `json:"line"`
	Text    string `json:"text"`
	IsMatch bool   `json:"is_match"`
}

// DefOverride は call ↔ def sync 装飾の参照先を手動で上書きする値。
// 関数名からの自動解決 (frontend resolveNodeDef) が誤ったヒットを返すケース
// (同名関数が複数 / 識別子抽出のミス) のための救済 path。
// 設定時は frontend が自動解決をスキップして直接この file:line を使う。
type DefOverride struct {
	File string `json:"file"`
	Line int    `json:"line"`
}

// DefRef は /api/definition の解決結果を node に永続キャッシュする値。
// ctags/gtags index 再生成時に全 node 分が一括 clear される (DefOverride は不変)。
type DefRef struct {
	File string `json:"file"`
	Line int    `json:"line"`
}

// Node はグラフ上の1ノード。
type Node struct {
	ID          string       `json:"id"`
	Match       Match        `json:"match"`
	Label       string       `json:"label"`
	Memo        string       `json:"memo"`
	Tags        []string     `json:"tags"`
	PosX        float64      `json:"pos_x"`
	PosY        float64      `json:"pos_y"`
	Expanded    bool         `json:"expanded"`
	Children    []string     `json:"children"`
	BadgeColor  string       `json:"badge_color,omitempty"` // バッジの色（例: "#e05252"）
	BadgeText   string       `json:"badge_text,omitempty"`  // バッジのテキスト（省略可）
	DefOverride *DefOverride `json:"def_override,omitempty"`
	Def         *DefRef      `json:"def,omitempty"`
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

// Category / Source は line memo / range memo の分類軸。
// Category: "draft" / "ok" / "warn" / "error" / "note" / "" (未設定)
// Source:   "ai" / "user" / "" (未設定 = 旧データ互換、user 扱い)
//
// LineMemoCategories / LineMemoSources は LineMemos と key 共通 ("file::line") で
// 並列に保持する。値が空 / map に key 無し なら未設定扱い。
// 構造体化せず並列 map にした理由: 既存 graph.json との後方互換 (旧 grepnavi
// でも読み書き可能) と、フィールド追加の容易さ。

// RangeMemo は範囲メモの1件分。
type RangeMemo struct {
	ID        string `json:"id"`
	File      string `json:"file"`
	StartLine int    `json:"start_line"`
	StartCol  int    `json:"start_col"`
	EndLine   int    `json:"end_line"`
	EndCol    int    `json:"end_col"`
	Memo      string `json:"memo"`
	Category  string `json:"category,omitempty"`
	Source    string `json:"source,omitempty"`
}

// ProjectFile はプロジェクトファイルのトップレベル構造（複数ツリー対応）。
type ProjectFile struct {
	Version            int               `json:"version"`
	RootDir            string            `json:"root_dir"`
	ActiveTreeID       string            `json:"active_tree_id"`
	Trees              []*Tree           `json:"trees"`
	LineMemos          map[string]string `json:"line_memos,omitempty"`
	LineMemoCategories map[string]string `json:"line_memo_categories,omitempty"`
	LineMemoSources    map[string]string `json:"line_memo_sources,omitempty"`
	RangeMemos         []RangeMemo       `json:"range_memos,omitempty"`
	Bookmarks          map[string]string `json:"bookmarks,omitempty"`
	UpdatedAt          time.Time         `json:"updated_at"`
}

// TreeMeta はツリー一覧用の軽量メタデータ。
type TreeMeta struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// GraphResponse はアクティブツリーの API レスポンス。
type GraphResponse struct {
	ID                 string            `json:"id"`
	Name               string            `json:"name"`
	Nodes              map[string]*Node  `json:"nodes"`
	Edges              []*Edge           `json:"edges"`
	RootDir            string            `json:"root_dir"`
	FilePath           string            `json:"file_path"`
	UpdatedAt          time.Time         `json:"updated_at"`
	Trees              []TreeMeta        `json:"trees"`
	ActiveTreeID       string            `json:"active_tree_id"`
	LineMemos          map[string]string `json:"line_memos,omitempty"`
	LineMemoCategories map[string]string `json:"line_memo_categories,omitempty"`
	LineMemoSources    map[string]string `json:"line_memo_sources,omitempty"`
	RangeMemos         []RangeMemo       `json:"range_memos,omitempty"`
	Bookmarks          map[string]string `json:"bookmarks,omitempty"`
	RootOrder          []string          `json:"root_order,omitempty"`
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
