package search

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestMacroSidecarRoundTrip(t *testing.T) {
	dir := t.TempDir()
	mtime := time.Unix(1700000000, 123456789)
	size := int64(1024)
	syms := SymbolsByKind{Macros: []string{"MAX_SIZE", "MY_FLAG", "SSL_EARLY_DATA_NONE"}}

	saveMacroSidecar(dir, mtime, size, syms)

	got, ok := loadMacroSidecar(dir, mtime, size)
	if !ok {
		t.Fatal("expected sidecar to load with matching mtime/size")
	}
	if len(got.Macros) != 3 || got.Macros[0] != "MAX_SIZE" || got.Macros[2] != "SSL_EARLY_DATA_NONE" {
		t.Errorf("macros = %v, want original 3 entries", got.Macros)
	}

	// mtime / size が違えば古いキャッシュとして拒否される
	if _, ok := loadMacroSidecar(dir, mtime.Add(time.Second), size); ok {
		t.Error("stale mtime should be rejected")
	}
	if _, ok := loadMacroSidecar(dir, mtime, size+1); ok {
		t.Error("stale size should be rejected")
	}
}

func TestMacroSidecarCorrupted(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(macroSidecarPath(dir), []byte("not a sidecar\njunk\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, ok := loadMacroSidecar(dir, time.Now(), 1); ok {
		t.Error("corrupted sidecar must be rejected, not loaded")
	}
}

func TestMacroSidecarMissing(t *testing.T) {
	if _, ok := loadMacroSidecar(t.TempDir(), time.Now(), 1); ok {
		t.Error("missing sidecar must report ok=false")
	}
}

func TestLruFileCacheClear(t *testing.T) {
	c := &lruFileCache{budget: 1000, items: map[string]*cacheEntry{}}
	c.put("a", time.Now(), []string{"x"}, 10)
	c.put("b", time.Now(), []string{"y"}, 20)
	c.clear()
	if c.total != 0 || len(c.items) != 0 || c.order.Len() != 0 {
		t.Errorf("clear left state behind: total=%d items=%d order=%d", c.total, len(c.items), c.order.Len())
	}
	// クリア後も普通に使える
	mt := time.Now()
	c.put("c", mt, []string{"z"}, 5)
	if _, ok := c.get("c", mt); !ok {
		t.Error("cache should be usable after clear")
	}
}

func TestMacroSidecarPathStaysInRoot(t *testing.T) {
	p := macroSidecarPath(`C:\repo`)
	if filepath.Dir(p) != `C:\repo` {
		t.Errorf("sidecar must live in the root dir, got %s", p)
	}
}

func TestCtagsPatternText(t *testing.T) {
	tests := []struct {
		name string
		addr string
		want string
	}{
		{"function", `/^static struct blkcg_gq *blkg_alloc(struct blkcg *blkcg,$/;"`, `static struct blkcg_gq *blkg_alloc(struct blkcg *blkcg,`},
		{"indentation and column padding collapse to single spaces", "/^\tblkcg_pol_alloc_pd_fn\t\t*pd_alloc_fn;$/;\"", `blkcg_pol_alloc_pd_fn *pd_alloc_fn;`},
		{"no extension fields", `/^#define FOO 1$/`, `#define FOO 1`},
		{"escaped slash", `/^\/* comment *\/$/;"`, `/* comment */`},
		{"semicolon-quote inside pattern", `/^	foo(";");$/;"`, `foo(";");`},
		{"line number address has no pattern", `182;"`, ``},
		{"unanchored pattern", `/foo/;"`, `foo`},
		{"garbage", `x`, ``},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ctagsPatternText(tt.addr); got != tt.want {
				t.Errorf("ctagsPatternText(%q) = %q, want %q", tt.addr, got, tt.want)
			}
		})
	}
}

// 実際の tags では検索パターンが定義行のインデントタブをそのまま含む。
// タブ分割でフィールドを取ると壊れる（構造体メンバはほぼ必ずこの形）。
func TestCtagsParseLine(t *testing.T) {
	// 絶対パスは実行中の OS の形式で組み立てる。"C:/..." をベタ書きすると
	// Windows でしか通らない（他 OS では相対パス扱いになり dir と連結される）。
	dir := t.TempDir()
	t.Run("pattern containing tabs", func(t *testing.T) {
		// tags は絶対パスもスラッシュ区切りで書くため、区切りを揃えて渡す
		line := "pd_alloc_fn\t" + filepath.ToSlash(filepath.Join(dir, "blk-cgroup.h")) + "\t" +
			"/^\tblkcg_pol_alloc_pd_fn\t\t*pd_alloc_fn;$/;\"\tm\tline:182\tstruct:blkcg_policy"
		h := ctagsParseLine(line, "pd_alloc_fn", dir)
		if h == nil {
			t.Fatal("returned nil")
		}
		if h.Text != "blkcg_pol_alloc_pd_fn *pd_alloc_fn;" {
			t.Errorf("Text = %q, want the definition line", h.Text)
		}
		if h.Name != "pd_alloc_fn" {
			t.Errorf("Name = %q", h.Name)
		}
		if h.Kind != "member" {
			t.Errorf("Kind = %q, want member", h.Kind)
		}
		if h.Line != 182 {
			t.Errorf("Line = %d, want 182", h.Line)
		}
		// tags は絶対パスをスラッシュ区切りで持つ。gtags 経由のヒットと
		// 同じファイルが別物にならないよう OS の区切りに揃える。
		if h.File != filepath.Join(dir, "blk-cgroup.h") {
			t.Errorf("File = %q, want the OS-normalized form", h.File)
		}
	})

	t.Run("relative path is resolved against dir", func(t *testing.T) {
		h := ctagsParseLine("recipe_load\tsrc/recipe.c\t/^int recipe_load(void)$/;\"\tf\tline:10", "recipe_load", dir)
		if h == nil {
			t.Fatal("returned nil")
		}
		if h.File != filepath.Join(dir, "src", "recipe.c") {
			t.Errorf("File = %q", h.File)
		}
		if h.Text != "int recipe_load(void)" {
			t.Errorf("Text = %q", h.Text)
		}
	})

	t.Run("line number address falls back to the symbol name", func(t *testing.T) {
		h := ctagsParseLine("FOO\tsrc/a.h\t42;\"\td", "FOO", dir)
		if h == nil {
			t.Fatal("returned nil")
		}
		if h.Line != 42 {
			t.Errorf("Line = %d, want 42", h.Line)
		}
		if h.Text != "FOO" {
			t.Errorf("Text = %q, want the symbol name fallback", h.Text)
		}
	})

	t.Run("unresolvable line is dropped", func(t *testing.T) {
		if h := ctagsParseLine("FOO\tsrc/a.h\t/^#define FOO$/", "FOO", dir); h != nil {
			t.Errorf("want nil for a hit with no line number, got %+v", h)
		}
	})

	t.Run("malformed lines are dropped", func(t *testing.T) {
		for _, line := range []string{"", "FOO", "FOO\tsrc/a.h"} {
			if h := ctagsParseLine(line, "FOO", dir); h != nil {
				t.Errorf("ctagsParseLine(%q) = %+v, want nil", line, h)
			}
		}
	})
}
