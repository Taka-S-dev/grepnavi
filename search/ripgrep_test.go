package search

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func argsIndex(args []string, flag, value string) int {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == flag && args[i+1] == value {
			return i
		}
	}
	return -1
}

func TestBuildArgsExcludesIndexFiles(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"tags", "GTAGS"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	args := buildArgs(Options{Pattern: "foo", Dir: dir})
	if argsIndex(args, "--glob", "!tags") < 0 {
		t.Errorf("expected !tags exclusion, args: %v", args)
	}
	if argsIndex(args, "--glob", "!GTAGS") < 0 {
		t.Errorf("expected !GTAGS exclusion, args: %v", args)
	}
	// 存在しない索引ファイルは除外 glob を出さない
	// (GRTAGS は大小無視 FS でも他の名前と衝突しない)
	if argsIndex(args, "--glob", "!GRTAGS") >= 0 {
		t.Errorf("unexpected !GRTAGS exclusion, args: %v", args)
	}
}

func TestBuildArgsKeepsTagsDirectory(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "tags"), 0o755); err != nil {
		t.Fatal(err)
	}
	args := buildArgs(Options{Pattern: "foo", Dir: dir})
	if argsIndex(args, "--glob", "!tags") >= 0 {
		t.Errorf("tags directory must not be excluded, args: %v", args)
	}
}

func TestBuildArgsUserGlobOverridesIndexExclusion(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "tags"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	args := buildArgs(Options{Pattern: "foo", Dir: dir, FileGlob: "tags"})
	excl := argsIndex(args, "--glob", "!tags")
	user := argsIndex(args, "--glob", "tags")
	if excl < 0 || user < 0 {
		t.Fatalf("expected both globs present, args: %v", args)
	}
	// rg は後勝ちなので、ユーザー glob が既定除外より後ろにあれば上書きできる
	if user < excl {
		t.Errorf("user glob must come after default exclusion, args: %v", args)
	}
}

func TestSearchSkipsTagsFile(t *testing.T) {
	requireRg(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "tags"),
		[]byte("needle_xyz\tsrc/a.c\t/^int needle_xyz(void)$/;\"\tf\tline:1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.c"),
		[]byte("int needle_xyz(void) { return 0; }\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	matches, err := Search(context.Background(), Options{Pattern: "needle_xyz", Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 1 {
		t.Fatalf("expected 1 match (a.c only), got %d: %+v", len(matches), matches)
	}
	if !strings.HasSuffix(matches[0].File, "a.c") {
		t.Errorf("expected match in a.c, got %q", matches[0].File)
	}
}
