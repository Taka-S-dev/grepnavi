package search

import (
	"testing"
	"time"
)

func TestLruFileCacheByteBudget(t *testing.T) {
	c := &lruFileCache{budget: 100, items: map[string]*cacheEntry{}}
	mt := time.Now()
	put := func(path string, size int) { c.put(path, mt, []string{path}, size) }

	put("a", 40)
	put("b", 40)
	if _, ok := c.get("a", mt); !ok {
		t.Fatal("a should be cached")
	}
	// a を触った直後に c を入れると予算超過で LRU 末尾の b が追い出される
	put("c", 40)
	if _, ok := c.get("b", mt); ok {
		t.Error("b should be evicted (budget exceeded)")
	}
	if _, ok := c.get("a", mt); !ok {
		t.Error("a should survive (recently used)")
	}
	if _, ok := c.get("c", mt); !ok {
		t.Error("c should be cached")
	}
	if c.total > c.budget {
		t.Errorf("total %d exceeds budget %d", c.total, c.budget)
	}

	// 同一パスの更新はサイズ差分だけ total に反映される
	put("a", 10)
	if want := 40 + 10; c.total != want {
		t.Errorf("total = %d, want %d (c=40 + a=10)", c.total, want)
	}

	// mtime 不一致はミス（古い内容を返さない）
	if _, ok := c.get("a", mt.Add(time.Second)); ok {
		t.Error("stale mtime must miss")
	}
}
