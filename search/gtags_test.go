package search

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseTransportState(t *testing.T) {
	tests := []struct {
		in     string
		want   int32
		wantOK bool
	}{
		{"bash\n", _transportBash, true},
		{"file", _transportFile, true},
		{"  bash  ", _transportBash, true},
		{"direct", _transportDirect, false}, // direct は永続化しない（ファイル削除で表す）
		{"garbage", _transportDirect, false},
		{"", _transportDirect, false},
	}
	for _, tt := range tests {
		got, ok := parseTransportState(tt.in)
		if got != tt.want || ok != tt.wantOK {
			t.Errorf("parseTransportState(%q) = (%d, %v), want (%d, %v)", tt.in, got, ok, tt.want, tt.wantOK)
		}
	}
}

func TestPersistTransportRoundTrip(t *testing.T) {
	defer persistTransport(_transportDirect) // 後片付け（ファイル削除）

	persistTransport(_transportBash)
	data, err := os.ReadFile(transportStatePath())
	if err != nil {
		t.Fatalf("state file not written: %v", err)
	}
	if tr, ok := parseTransportState(string(data)); !ok || tr != _transportBash {
		t.Errorf("round trip = (%d, %v), want (%d, true)", tr, ok, _transportBash)
	}

	persistTransport(_transportDirect)
	if _, err := os.Stat(transportStatePath()); !os.IsNotExist(err) {
		t.Errorf("direct should remove the state file, stat err = %v", err)
	}
}

func TestGtagsParseAllDefs(t *testing.T) {
	out := []byte(strings.Join([]string{
		"foo 10 src/foo.c int foo(void) {",
		"foo 20 src/foo.h int foo(void);",
		"BAR 5 src/bar.c #define BAR 1",
		"malformed",
		"badline x src/baz.c int baz()",
	}, "\n"))
	dir := `C:\proj`
	defs := gtagsParseAllDefs(out, dir)

	if len(defs) != 2 {
		t.Fatalf("symbols = %d, want 2 (got %v)", len(defs), defs)
	}
	if len(defs["foo"]) != 2 {
		t.Errorf("foo hits = %d, want 2", len(defs["foo"]))
	}
	if got, want := defs["foo"][0].File, filepath.Join(dir, "src/foo.c"); got != want {
		t.Errorf("foo file = %q, want %q", got, want)
	}
	if defs["BAR"][0].Line != 5 || defs["BAR"][0].Text != "#define BAR 1" {
		t.Errorf("BAR hit = %+v", defs["BAR"][0])
	}
}

// プリロード済みスナップショットがあれば GtagsFindDefinitions はプロセス起動なしで
// 返し、かつ kind 分類の書き換えが共有スナップショットを汚染しないこと。
func TestGtagsFindDefinitionsUsesPreloadedSnapshot(t *testing.T) {
	dir := t.TempDir()
	defs := map[string][]DefHit{
		"MYMACRO": {{File: filepath.Join(dir, "a.c"), Line: 3, Text: "#define MYMACRO 1", Kind: "func"}},
	}
	_gtagsDefsAll.Store(&gtagsDefsSnapshot{dir: dir, defs: defs})
	defer func() {
		_gtagsDefsAll.Store(nil)
		gtagsClearResultCaches()
	}()

	hits, err := GtagsFindDefinitions(context.Background(), "MYMACRO", dir)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(hits) != 1 || hits[0].Line != 3 {
		t.Fatalf("hits = %+v, want 1 hit at line 3", hits)
	}
	if hits[0].Kind != "define" {
		t.Errorf("kind = %q, want %q (reclassified from text)", hits[0].Kind, "define")
	}
	if defs["MYMACRO"][0].Kind != "func" {
		t.Errorf("snapshot polluted: kind = %q, want untouched %q", defs["MYMACRO"][0].Kind, "func")
	}

	// スナップショットに無いシンボルは起動なしで「なし」と確定する
	miss, err := GtagsFindDefinitions(context.Background(), "no_such_symbol", dir)
	if err != nil || len(miss) != 0 {
		t.Errorf("miss = %+v, err = %v, want empty and nil", miss, err)
	}
}

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
