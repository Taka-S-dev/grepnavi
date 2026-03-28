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
			name: "STATIC function",
			text: "STATIC void lvSFXdrvOpe_ShowErrDlg(lvSFXdrvOpe* pThis)",
			word: "lvSFXdrvOpe_ShowErrDlg",
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
