package search

import (
	"testing"
)

func TestPreferDefinitionHits(t *testing.T) {
	tests := []struct {
		name     string
		hits     []DefHit
		wantFiles []string // 残るべきファイル名（順不同）
	}{
		{
			name: "宣言と定義が両方ある場合、定義だけ残る",
			hits: []DefHit{
				{File: "foo.h", Line: 5,  Text: "void foo(int x);",   Kind: "func"}, // 宣言
				{File: "foo.c", Line: 10, Text: "void foo(int x) {",  Kind: "func"}, // 定義
			},
			wantFiles: []string{"foo.c"},
		},
		{
			name: "宣言のみの場合は全件返す",
			hits: []DefHit{
				{File: "foo.h", Line: 5, Text: "void foo(int x);", Kind: "func"},
			},
			wantFiles: []string{"foo.h"},
		},
		{
			name: "定義が .h のみの場合（インライン実装）はそのまま返す",
			hits: []DefHit{
				{File: "foo.h", Line: 5,  Text: "void foo(int x);",          Kind: "func"}, // 宣言
				{File: "bar.h", Line: 20, Text: "inline void foo(int x) {",  Kind: "func"}, // 定義（ヘッダ内）
			},
			wantFiles: []string{"bar.h"},
		},
		{
			name: "#define は宣言扱いにしない",
			hits: []DefHit{
				{File: "foo.h", Line: 3, Text: "#define MAX_SIZE 100", Kind: "define"},
			},
			wantFiles: []string{"foo.h"},
		},
		{
			name: "宣言に末尾コメントがあっても宣言と判定できる",
			hits: []DefHit{
				{File: "foo.c", Line: 3,  Text: "static int foo(int x);   /* forward decl */", Kind: "func"}, // 宣言（コメント付き）
				{File: "foo.c", Line: 10, Text: "static int foo(int x) {",                     Kind: "func"}, // 定義
			},
			wantFiles: []string{"foo.c"},
		},
		{
			name: "宣言に /**/ コメントがあっても宣言と判定できる",
			hits: []DefHit{
				{File: "foo.c", Line: 3,  Text: "static int foo(int x);/**/", Kind: "func"}, // 宣言（/**/ 付き）
				{File: "foo.c", Line: 10, Text: "static int foo(int x) {",    Kind: "func"}, // 定義
			},
			wantFiles: []string{"foo.c"},
		},
		{
			name: "定義あり: .c と .h の定義が両方ある場合 .c を優先",
			hits: []DefHit{
				{File: "foo.h", Line: 5,  Text: "void foo(int x);",           Kind: "func"}, // 宣言
				{File: "bar.h", Line: 20, Text: "inline void foo(int x) {",   Kind: "func"}, // 定義ヘッダ
				{File: "foo.c", Line: 10, Text: "void foo(int x) {",          Kind: "func"}, // 定義実装
			},
			wantFiles: []string{"foo.c"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := preferDefinitionHits(tt.hits)
			if len(got) != len(tt.wantFiles) {
				t.Errorf("got %d hits, want %d: %v", len(got), len(tt.wantFiles), got)
				return
			}
			wantSet := map[string]bool{}
			for _, f := range tt.wantFiles {
				wantSet[f] = true
			}
			for _, h := range got {
				if !wantSet[h.File] {
					t.Errorf("unexpected file %q in result", h.File)
				}
			}
		})
	}
}

func TestIsDefinitionHit_MultilineSignature(t *testing.T) {
	// 複数行シグネチャのテスト。
	// CachedLines を使わずに lines を直接渡すため、
	// isDefinitionHitLines という内部ヘルパーでテストする。
	tests := []struct {
		name  string
		lines []string
		line  int // 1-indexed ヒット行
		want  bool
	}{
		{
			name: "通常の1行宣言は宣言と判定",
			lines: []string{
				"int foo(int x);",
			},
			line: 1,
			want: false,
		},
		{
			name: "1行定義は定義と判定",
			lines: []string{
				"int foo(int x) {",
				"    return x;",
				"}",
			},
			line: 1,
			want: true,
		},
		{
			name: "複数行シグネチャで末尾が ; なら宣言",
			lines: []string{
				"int foo(",
				"    const char*",
				"    int",
				"              name,",
				"              size);",
			},
			line: 1,
			want: false,
		},
		{
			name: "複数行シグネチャで { が出れば定義",
			lines: []string{
				"int foo(",
				"    const char* name,",
				"    int         size)",
				"{",
				"    return 0;",
				"}",
			},
			line: 1,
			want: true,
		},
		{
			name: "次行に { がある K&R スタイルは定義",
			lines: []string{
				"void foo()",
				"{",
				"    return;",
				"}",
			},
			line: 1,
			want: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := DefHit{File: "", Line: tt.line, Text: tt.lines[tt.line-1], Kind: "func"}
			got := isDefinitionHitLines(h, tt.lines)
			if got != tt.want {
				t.Errorf("isDefinitionHit = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestClassifyDefKind(t *testing.T) {
	tests := []struct {
		name string
		text string
		word string
		want string
	}{
		// #define
		{
			name: "#define",
			text: "#define MAX_SIZE 100",
			word: "MAX_SIZE",
			want: "define",
		},
		{
			name: "#define with spaces",
			text: "# define MY_FLAG  1",
			word: "MY_FLAG",
			want: "define",
		},
		// struct
		{
			name: "struct definition",
			text: "typedef struct ST_FOO {",
			word: "ST_FOO",
			want: "struct",
		},
		{
			name: "struct without typedef",
			text: "struct MyStruct {",
			word: "MyStruct",
			want: "struct",
		},
		// union
		{
			name: "union definition",
			text: "union DataVal {",
			word: "DataVal",
			want: "union",
		},
		// enum
		{
			name: "enum definition",
			text: "typedef enum LV_STATE {",
			word: "LV_STATE",
			want: "enum",
		},
		// typedef_close
		{
			name: "typedef closing brace",
			text: "} MY_TYPE;",
			word: "MY_TYPE",
			want: "typedef_close",
		},
		// func - 通常スタイル（同一行に(）
		{
			name: "normal function",
			text: "static int foo(int x) {",
			word: "foo",
			want: "func",
		},
		{
			name: "static function",
			text: "static void widget_show_error(Widget* self)",
			word: "widget_show_error",
			want: "func",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := classifyDefKind(tt.text, tt.word)
			if got != tt.want {
				t.Errorf("classifyDefKind(%q, %q) = %q, want %q", tt.text, tt.word, got, tt.want)
			}
		})
	}
}
