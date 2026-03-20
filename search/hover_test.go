package search

import (
	"testing"
)

func TestExtractLeadingComment(t *testing.T) {
	tests := []struct {
		name      string
		lines     []string
		startLine int // 1-indexed
		want      string
	}{
		{
			name: "single line comment",
			lines: []string{
				"// foo does something",
				"void foo() {",
			},
			startLine: 2,
			want:      "// foo does something",
		},
		{
			name: "multi line // comment",
			lines: []string{
				"// foo does something",
				"// it takes no args",
				"void foo() {",
			},
			startLine: 3,
			want:      "// foo does something\n// it takes no args",
		},
		{
			name: "block comment /* */",
			lines: []string{
				"/*",
				" * foo does something",
				" */",
				"void foo() {",
			},
			startLine: 4,
			want:      "/*\n * foo does something\n */",
		},
		{
			name: "no comment",
			lines: []string{
				"void foo() {",
			},
			startLine: 1,
			want:      "",
		},
		{
			name: "blank line stops search",
			lines: []string{
				"// unrelated",
				"",
				"// this is the comment",
				"void foo() {",
			},
			startLine: 4,
			want:      "// this is the comment",
		},
		{
			name: "non-comment line stops search",
			lines: []string{
				"int x;",
				"// this is the comment",
				"void foo() {",
			},
			startLine: 3,
			want:      "// this is the comment",
		},
		{
			name: "struct with doxygen",
			lines: []string{
				"/**",
				" * @brief represents a point",
				" */",
				"struct Point {",
			},
			startLine: 4,
			want:      "/**\n * @brief represents a point\n */",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractLeadingComment(tt.lines, tt.startLine)
			if got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}
