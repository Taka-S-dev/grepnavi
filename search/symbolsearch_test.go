package search

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func writeTestTags(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	content := "!_TAG_FILE_FORMAT\t2\t/extended/\n" +
		"!_TAG_FILE_SORTED\t1\t/0=unsorted, 1=sorted, 2=foldcase/\n" +
		"RECIPE_MAX\tinclude/recipe.h\t/^#define RECIPE_MAX 10$/;\"\td\tline:3\n" +
		"recipe_load\tsrc/recipe.c\t/^int recipe_load(void)$/;\"\tf\tline:10\n" +
		"recipe_save\tsrc/recipe.c\t/^int recipe_save(void)$/;\"\tf\tline:42\n" +
		"recipe_t\tinclude/recipe.h\t/^} recipe_t;$/;\"\tt\tline:20\n" +
		"unrelated_func\tsrc/other.c\t/^void unrelated_func(void)$/;\"\tf\tline:5\n"
	if err := os.WriteFile(filepath.Join(dir, "tags"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func requireRg(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not in PATH")
	}
}

func TestCtagsSearchSymbolNames(t *testing.T) {
	requireRg(t)
	dir := writeTestTags(t)

	hits, truncated, err := CtagsSearchSymbolNames(context.Background(), "recipe", dir, "", false, 50, "")
	if err != nil {
		t.Fatal(err)
	}
	if truncated {
		t.Error("expected truncated=false")
	}
	if len(hits) != 4 {
		t.Fatalf("expected 4 hits, got %d: %+v", len(hits), hits)
	}
	// kind ランク順: func 2件 → define → typedef
	wantOrder := []string{"recipe_load", "recipe_save", "RECIPE_MAX", "recipe_t"}
	for i, want := range wantOrder {
		if hits[i].Name != want {
			t.Errorf("hits[%d] = %q, want %q", i, hits[i].Name, want)
		}
	}
	// Name はシンボル名、Text は定義行。両方揃っていないと
	// 一覧では名前で選び、選んだ先で中身を見る、という流れが作れない。
	if hits[0].Text != "int recipe_load(void)" {
		t.Errorf("Text = %q, want the definition line", hits[0].Text)
	}
	// file は dir 起点の絶対パスに解決される
	if !filepath.IsAbs(hits[0].File) {
		t.Errorf("expected absolute path, got %q", hits[0].File)
	}
}

func TestCtagsSearchSymbolNamesExactFirst(t *testing.T) {
	requireRg(t)
	dir := writeTestTags(t)

	// 完全一致 (case-insensitive) は kind ランクより優先される
	hits, _, err := CtagsSearchSymbolNames(context.Background(), "recipe_t", dir, "", false, 50, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) == 0 || hits[0].Name != "recipe_t" {
		t.Fatalf("expected exact match 'recipe_t' first, got %+v", hits)
	}
}

func TestCtagsSearchSymbolNamesKindFilter(t *testing.T) {
	requireRg(t)
	dir := writeTestTags(t)

	hits, _, err := CtagsSearchSymbolNames(context.Background(), "recipe", dir, "func", false, 50, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 2 {
		t.Fatalf("expected 2 func hits, got %d: %+v", len(hits), hits)
	}
	for _, h := range hits {
		if h.Kind != "func" {
			t.Errorf("expected kind=func, got %q", h.Kind)
		}
	}
}

func TestCtagsSearchSymbolNamesLimit(t *testing.T) {
	requireRg(t)
	dir := writeTestTags(t)

	hits, truncated, err := CtagsSearchSymbolNames(context.Background(), "recipe", dir, "", false, 2, "")
	if err != nil {
		t.Fatal(err)
	}
	if !truncated {
		t.Error("expected truncated=true")
	}
	if len(hits) != 2 {
		t.Fatalf("expected 2 hits, got %d", len(hits))
	}
}

func TestCtagsSearchSymbolNamesBadRegex(t *testing.T) {
	dir := writeTestTags(t)
	if _, _, err := CtagsSearchSymbolNames(context.Background(), "recipe[", dir, "", false, 50, ""); err == nil {
		t.Error("expected error for invalid regex")
	}
}

// パス絞り込み: 空白区切りの部分一致、"-" 始まりは除外。区切り文字の向きと
// 大文字小文字は正規化して比べる（tags の記録形式に依存しないように）。
func TestCtagsSearchSymbolNamesPathFilter(t *testing.T) {
	requireRg(t)
	dir := writeTestTags(t)

	names := func(pathFilter string) []string {
		t.Helper()
		hits, _, err := CtagsSearchSymbolNames(context.Background(), "recipe", dir, "", false, 50, pathFilter)
		if err != nil {
			t.Fatal(err)
		}
		out := make([]string, len(hits))
		for i, h := range hits {
			out[i] = h.Name
		}
		return out
	}

	got := names("include/")
	if len(got) != 2 {
		t.Errorf("include/ の絞り込み = %v, want RECIPE_MAX と recipe_t", got)
	}
	got = names("-include/")
	if len(got) != 2 {
		t.Errorf("-include/ の除外 = %v, want src の2件", got)
	}
	// Windows 由来の \ 区切り指定でも同じ結果になる
	got = names(`INCLUDE\`)
	if len(got) != 2 {
		t.Errorf(`INCLUDE\ (大文字・逆区切り) = %v, want 2件`, got)
	}
	if got := names("src/ -other"); len(got) != 2 {
		t.Errorf("src/ -other = %v, want recipe.c の2件", got)
	}
}

// 拡張子は末尾一致（".c" が ".cpp" に当たらない）、"|" は OR、glob も受ける。
func TestCtagsSearchSymbolNamesExtensionFilter(t *testing.T) {
	requireRg(t)
	dir := writeTestTags(t)

	names := func(pathFilter string) int {
		t.Helper()
		hits, _, err := CtagsSearchSymbolNames(context.Background(), "recipe", dir, "", false, 50, pathFilter)
		if err != nil {
			t.Fatal(err)
		}
		return len(hits)
	}

	if got := names(".c"); got != 2 {
		t.Errorf(".c = %d 件, want recipe.c の2件（.h は末尾一致で外れる）", got)
	}
	if got := names(".c|.h"); got != 4 {
		t.Errorf(".c|.h = %d 件, want 全4件", got)
	}
	if got := names("*.h"); got != 2 {
		t.Errorf("*.h = %d 件, want recipe.h の2件", got)
	}
	if got := names("-.h"); got != 2 {
		t.Errorf("-.h = %d 件, want .c 側の2件", got)
	}
}
