package api

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// 状態表示のたびに ctags を起動しない。起動 1 回が秒単位になる機械では、
// それが「索引」のラベルが出るまでの待ち時間になる。
func TestFindCtagsBinDoesNotSpawnTwice(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "ctags.exe")
	if err := os.WriteFile(bin, []byte("stub"), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("PATHEXT", ".EXE")
	t.Setenv("USERPROFILE", dir) // Scoop のシムを探しに行かせない

	spawns := 0
	orig := ctagsVersionProbe
	ctagsVersionProbe = func(p string) ([]byte, error) { spawns++; return []byte("Universal Ctags 6.1"), nil }
	defer func() { ctagsVersionProbe = orig; ctagsBinCache.ok = false; ctagsBinCache.checkedAt = time.Time{} }()
	ctagsBinCache.ok = false
	ctagsBinCache.checkedAt = time.Time{}

	p, universal, ok := findCtagsBin()
	if !ok || !universal || p != bin {
		t.Fatalf("1 回目の判定が違う: %q %v %v", p, universal, ok)
	}
	for i := 0; i < 5; i++ {
		findCtagsBin()
	}
	if spawns != 1 {
		t.Fatalf("ctags を %d 回起動した（1 回で覚えるはず）", spawns)
	}

	// バイナリが消えたら覚えた結果を捨てて判定し直す
	os.Remove(bin)
	if _, _, ok := findCtagsBin(); ok {
		t.Fatal("消えた ctags をまだ有効扱いしている")
	}
	if spawns != 1 {
		t.Fatalf("候補が無いのに起動した: %d", spawns)
	}
}
