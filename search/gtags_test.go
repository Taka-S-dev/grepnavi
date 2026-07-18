package search

import "testing"

// windowsToCygwinPath は initBashRun が実行時判定した _cygDrivePrefix に従って
// 変換する。Cygwin (/cygdrive/) と Git for Windows/MSYS2 (/) で形式が異なり、
// 誤った形式だと bash 側で exit 127 (command not found) になる。
func TestWindowsToCygwinPath(t *testing.T) {
	saved := _cygDrivePrefix
	defer func() { _cygDrivePrefix = saved }()

	tests := []struct {
		name   string
		prefix string
		in     string
		want   string
	}{
		{"cygwin drive path", "/cygdrive/", `C:\foo\bar`, "/cygdrive/c/foo/bar"},
		{"msys2 drive path", "/", `C:\grepnavi\bin\global.exe`, "/c/grepnavi/bin/global.exe"},
		{"msys2 lowercases drive letter", "/", `D:\Work`, "/d/Work"},
		// 未確定 ("") は Cygwin 形式が既定（従来動作の後方互換）
		{"unset prefix defaults to cygwin", "", `C:\foo`, "/cygdrive/c/foo"},
		// ドライブレターなしのパスは変換せずスラッシュ化のみ
		{"non-drive path passes through", "/", `\\server\share\dir`, "//server/share/dir"},
		{"relative path passes through", "/cygdrive/", `foo\bar`, "foo/bar"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_cygDrivePrefix = tt.prefix
			if got := windowsToCygwinPath(tt.in); got != tt.want {
				t.Errorf("windowsToCygwinPath(%q) with prefix %q = %q, want %q", tt.in, tt.prefix, got, tt.want)
			}
		})
	}
}

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
