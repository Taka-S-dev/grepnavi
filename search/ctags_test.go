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
