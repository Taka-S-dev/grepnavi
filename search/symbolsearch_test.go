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

	hits, truncated, err := CtagsSearchSymbolNames(context.Background(), "recipe", dir, "", false, 50)
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
		if hits[i].Text != want {
			t.Errorf("hits[%d] = %q, want %q", i, hits[i].Text, want)
		}
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
	hits, _, err := CtagsSearchSymbolNames(context.Background(), "recipe_t", dir, "", false, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) == 0 || hits[0].Text != "recipe_t" {
		t.Fatalf("expected exact match 'recipe_t' first, got %+v", hits)
	}
}

func TestCtagsSearchSymbolNamesKindFilter(t *testing.T) {
	requireRg(t)
	dir := writeTestTags(t)

	hits, _, err := CtagsSearchSymbolNames(context.Background(), "recipe", dir, "func", false, 50)
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

	hits, truncated, err := CtagsSearchSymbolNames(context.Background(), "recipe", dir, "", false, 2)
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
	if _, _, err := CtagsSearchSymbolNames(context.Background(), "recipe[", dir, "", false, 50); err == nil {
		t.Error("expected error for invalid regex")
	}
}
