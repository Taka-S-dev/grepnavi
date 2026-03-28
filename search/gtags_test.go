package search

import "testing"

func TestGtagsClassifyKind(t *testing.T) {
	tests := []struct {
		line string
		want string
	}{
		// 関数定義（戻り値に struct/enum/union を含む場合も func）
		{"int foo(void)", "func"},
		{"static int bar(int x, int y)", "func"},
		{"struct task_struct *schedule(void)", "func"},
		{"struct foo *alloc_foo(gfp_t gfp)", "func"},
		{"enum state get_state(struct dev *d)", "func"},
		{"union val compute(int x)", "func"},
		{"static inline struct page *alloc_page(gfp_t gfp)", "func"},
		{"asmlinkage long sys_read(unsigned int fd, char __user *buf, size_t count)", "func"},

		// 構造体定義
		{"struct foo {", "struct"},
		{"typedef struct {", "struct"},
		{"struct task_struct {", "struct"},

		// 列挙体定義
		{"enum state {", "enum"},
		{"typedef enum {", "enum"},

		// 共用体定義
		{"union val {", "union"},

		// マクロ定義
		{"#define MAX 100", "define"},
		{"#define MACRO(x) ((x) + 1)", "define"},
	}

	for _, tt := range tests {
		t.Run(tt.line, func(t *testing.T) {
			got := gtagsClassifyKind(tt.line)
			if got != tt.want {
				t.Errorf("gtagsClassifyKind(%q) = %q, want %q", tt.line, got, tt.want)
			}
		})
	}
}
