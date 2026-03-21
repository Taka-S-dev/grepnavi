package search

import (
	"testing"
)

func TestExtractBraceBlock(t *testing.T) {
	tests := []struct {
		name      string
		lines     []string
		startLine int // 1-indexed
		wantEmpty bool
		wantHas   string // 結果に含まれるべき文字列
	}{
		{
			name: "function with brace on same line",
			lines: []string{
				"static int foo(BIO *h) {",
				"    return 0;",
				"}",
			},
			startLine: 1,
			wantHas:   "{",
		},
		{
			name: "function with brace on next line",
			lines: []string{
				"static int foo(BIO *h)",
				"{",
				"    return 0;",
				"}",
			},
			startLine: 1,
			wantHas:   "{",
		},
		{
			name: "forward declaration should return empty (semicolon before brace)",
			lines: []string{
				"static int ssl_write(BIO *h, const char *buf, size_t size, size_t *written);",
				"static int ssl_read(BIO *b, char *buf, size_t size, size_t *readbytes);",
				"typedef struct bio_ssl_st {",
				"    int x;",
				"} BIO_SSL;",
			},
			startLine: 1,
			wantEmpty: true,
		},
		{
			name: "forward decl followed by struct brace should not be mistaken for function body",
			lines: []string{
				"static int ssl_new(BIO *h);",
				"static int ssl_free(BIO *data);",
				"struct Foo {",
				"    int x;",
				"};",
				"static int ssl_new(BIO *h)",
				"{",
				"    return 1;",
				"}",
			},
			startLine: 1,
			wantEmpty: true,
		},
		{
			name: "actual definition further down in file is found correctly",
			lines: []string{
				"static int ssl_new(BIO *h);",
				"static int ssl_free(BIO *data);",
				"struct Foo {",
				"    int x;",
				"};",
				"static int ssl_new(BIO *h)",
				"{",
				"    return 1;",
				"}",
			},
			startLine: 6,
			wantHas:   "{",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractBraceBlock(tt.lines, tt.startLine)
			if tt.wantEmpty {
				if got != "" {
					t.Errorf("expected empty, got %q", got)
				}
				return
			}
			if tt.wantHas != "" && !contains(got, tt.wantHas) {
				t.Errorf("expected result to contain %q, got %q", tt.wantHas, got)
			}
		})
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 ||
		func() bool {
			for i := 0; i <= len(s)-len(sub); i++ {
				if s[i:i+len(sub)] == sub {
					return true
				}
			}
			return false
		}())
}

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
			name: "one blank line between comment and function is allowed",
			lines: []string{
				"// this is the comment",
				"",
				"void foo() {",
			},
			startLine: 3,
			want:      "// this is the comment",
		},
		{
			name: "two blank lines stops search",
			lines: []string{
				"// unrelated",
				"",
				"",
				"void foo() {",
			},
			startLine: 4,
			want:      "",
		},
		{
			name: "blank line stops search (old behavior preserved for 2+ blanks)",
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
		{
			name: "block comment without leading * on each line",
			lines: []string{
				"/* the provided input number is 1-based but this returns the number 0-based.",
				"",
				"   returns -1 if no valid number was provided.",
				"*/",
				"static int dollarstring(const char *p, const char **end)",
			},
			startLine: 5,
			want:      "/* the provided input number is 1-based but this returns the number 0-based.\n\n   returns -1 if no valid number was provided.\n*/",
		},
		{
			name: "multiple single-line /* */ comments are collected together",
			lines: []string{
				"/*-----*/",
				"/*func*/",
				"/*arg1*/",
				"/*arg2*/",
				"/*-----*/",
				"func(void){",
				"}",
			},
			startLine: 6,
			want:      "/*-----*/\n/*func*/\n/*arg1*/\n/*arg2*/\n/*-----*/",
		},
		{
			name: "block comment without leading * with blank line before function",
			lines: []string{
				"/* does something",
				"   details here.",
				"*/",
				"",
				"static int foo(void)",
			},
			startLine: 5,
			want:      "/* does something\n   details here.\n*/",
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
