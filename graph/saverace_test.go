package graph

import (
	"path/filepath"
	"testing"
	"time"
)

// save の「古い pending を捨てて最新を送る」は saveLoop と競走する。
// 捨てる側の受信がブロッキングだと、満杯を見てから受信するまでの隙間に
// saveLoop が取り出したとき、受信者2人・送信者ゼロで永久に固まる
// （CI の Linux ランナーで実際に発生し、テスト全体を 10 分タイムアウトさせた）。
// このテストは修正の退行をウォッチドッグ付きで検出する。競合の窓は狭いので
// 発生は確率的だが、正しい実装なら常に数秒で完走する。
func TestSaveDrainDoesNotDeadlock(t *testing.T) {
	s := NewStore(filepath.Join(t.TempDir(), "g.json"), t.TempDir())
	defer s.Close()

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 20000; i++ {
			s.mu.Lock()
			_ = s.save()
			s.mu.Unlock()
		}
	}()

	select {
	case <-done:
	case <-time.After(60 * time.Second):
		t.Fatal("save が saveLoop との競合で固まった（drain の受信がブロックしている）")
	}
}
