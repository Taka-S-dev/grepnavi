package graph

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// save() は s.pf を JSON にするので、ロックを手放してから呼ぶと、同時に走る
// 別の書き込み (ノード追加など) と s.pf の map を巡って競合する。
// -race で走らせると、ロックを外して save() を呼ぶ実装ではここで落ちる。
func TestMemoAndNodeWritesDoNotRace(t *testing.T) {
	s := NewStore(filepath.Join(t.TempDir(), "g.json"), t.TempDir())
	defer s.Close()

	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			_ = s.UpdateMemos(MemoSnapshot{LineMemos: map[string]string{fmt.Sprintf("f::%d", i): "m"}})
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			_, _ = s.AddNode(&Node{ID: fmt.Sprintf("n%d", i), Match: Match{File: "a.c", Line: i + 1}})
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			_ = s.SetDescription(fmt.Sprintf("d%d", i))
			s.SetRootDir(fmt.Sprintf("r%d", i))
		}
	}()
	wg.Wait()
}

// 非同期の書き込みが失敗したことは、次に応答を組み立てるときに見えなければならない。
// save() は JSON 化してキューに入れた時点で nil を返すので、ここで黙ると
// 「保存できたつもりで消えている」になる。
func TestSaveFailureIsReported(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "no-such-dir", "g.json")
	s := NewStore(missing, t.TempDir())
	if err := s.SetDescription("x"); err != nil {
		t.Fatalf("save() はキュー投入で成功扱いのはず: %v", err)
	}
	s.Close() // 書き込みが終わるまで待つ
	if got := s.LastSaveError(); got == "" {
		t.Fatal("書き込み失敗が記録されていない")
	}
	if _, err := os.Stat(missing); err == nil {
		t.Fatal("存在しないディレクトリに書けてしまっている")
	}
}
