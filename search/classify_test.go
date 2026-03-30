package search

import (
	"testing"

	"grepnavi/graph"
)

func TestClassifyKind(t *testing.T) {
	snip := func(lines ...string) []graph.SnippetLine {
		s := make([]graph.SnippetLine, len(lines))
		for i, l := range lines {
			s[i] = graph.SnippetLine{Line: i + 2, Text: l}
		}
		return s
	}

	tests := []struct {
		name      string
		text      string
		snippet   []graph.SnippetLine
		matchLine int
		want      string
	}{
		// ===== func =====
		{
			name:    "通常関数定義（同行 {）",
			text:    "void foo(int x) {",
			snippet: snip(),
			want:    "func",
		},
		{
			name:    "通常関数定義（次行 {）",
			text:    "void foo(int x)",
			snippet: snip("{"),
			want:    "func",
		},
		{
			name:    "通常関数定義（引数複数行 → {）",
			text:    "int bar(int a,",
			snippet: snip("int b)", "{"),
			want:    "func",
		},
		{
			name:      "K&R スタイル: 次行が ( で始まり { が来る",
			text:      "int process_data",
			matchLine: 1,
			snippet: snip(
				"(",
				"    unsigned char  flag",
				"  , unsigned short count",
				")",
				"{",
			),
			want: "func",
		},
		{
			name:      "K&R スタイル: 宣言（; で終わる）",
			text:      "int process_data",
			matchLine: 1,
			snippet: snip(
				"(",
				"    unsigned char flag",
				");",
			),
			want: "",
		},
		{
			name:      "K&R スタイル: 次行が ( でない → func ではない",
			text:      "int process_data",
			matchLine: 1,
			snippet:   snip("int x;"),
			want:      "",
		},
		{
			name:      "K&R 誤検知防止: 引数行（, 含む）+ 次行がキャスト ( で始まる",
			text:      "MODE,",
			matchLine: 1,
			snippet:   snip("(int)ptr->val,", "NULL);"),
			want:      "",
		},
		{
			name:      "K&R 誤検知防止: 引数行（; 含む）",
			text:      "NULL);",
			matchLine: 1,
			snippet:   snip("}", "}", "{"),
			want:      "",
		},
		// ===== 非 func =====
		{
			name:      "引数が多くコンテキスト外に { が出る関数定義",
			text:      "static int open_dialog(",
			matchLine: 1,
			snippet: snip(
				"void*   self,",
				"int     type,",
				"char*   title,",
				"char*   message,",
				"short   priority,",
				"short   id,",
				// ここまでが6行コンテキスト — ) と { はコンテキスト外
			),
			want: "func",
		},
		{
			name:      "誤検知防止: 関数呼び出し + 末尾コメントに ( がある",
			text:      `call_func(obj);     /* see (note */`,
			matchLine: 1,
			snippet:   snip("}"),
			want:      "",
		},
		{
			name:      "誤検知防止: if 文 + 末尾コメント",
			text:      `if (x == NEW)    /* update (redraw) */`,
			matchLine: 1,
			snippet:   snip("{", "}"),
			want:      "",
		},
		{
			name:    "関数宣言（; 終わり）",
			text:    "void foo(int x);",
			snippet: snip(),
			want:    "",
		},
		{
			name:    "if 文",
			text:    "if (x > 0) {",
			snippet: snip(),
			want:    "",
		},
		{
			name:    "代入式",
			text:    "result = func(x);",
			snippet: snip(),
			want:    "",
		},
		{
			name:    "メソッド呼び出し（->）",
			text:    "obj->method(x);",
			snippet: snip(),
			want:    "",
		},
		// ===== 他の種別 =====
		{
			name:    "#define",
			text:    "#define FOO 1",
			snippet: snip(),
			want:    "define",
		},
		{
			name:    "struct",
			text:    "struct Foo {",
			snippet: snip(),
			want:    "struct",
		},
		{
			name:    "enum",
			text:    "enum Color {",
			snippet: snip(),
			want:    "enum",
		},
		{
			name:    "typedef",
			text:    "typedef unsigned int uint32_t;",
			snippet: snip(),
			want:    "typedef",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ClassifyKind(tt.text, tt.snippet, tt.matchLine)
			if got != tt.want {
				t.Errorf("ClassifyKind(%q) = %q, want %q", tt.text, got, tt.want)
			}
		})
	}
}
