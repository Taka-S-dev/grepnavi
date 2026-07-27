package search

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFindContainingFunc(t *testing.T) {
	// Linux カーネル形式（{ は列0）。呼び出しがネストしたブロック内にある。
	kernelStyle := []string{
		`static int helper(void)`, // 1
		`{`,                       // 2
		`	return 0;`,              // 3
		`}`,                       // 4
		``,                        // 5
		`static bool btrfs_submit_chunk(struct btrfs_bio *bbio, int mirror_num)`, // 6
		`{`,                                 // 7
		`	if (a && b) {`,                    // 8
		`		if (should_async_write(bbio) &&`, // 9
		`		    btrfs_wq_submit_bio(bbio, bioc, &smap, mirror_num))`, // 10
		`			goto done;`, // 11
		`	}`,            // 12
		`	return true;`, // 13
		`}`,             // 14
	}

	tests := []struct {
		name     string
		lines    []string
		callLine int
		wantFunc string
		wantDef  int
	}{
		{
			// 実際に取りこぼしていたケース: if の二重ネスト内の呼び出し
			name: "call nested in if blocks", lines: kernelStyle, callLine: 10,
			wantFunc: "btrfs_submit_chunk", wantDef: 6,
		},
		{
			name: "call at function top level", lines: kernelStyle, callLine: 13,
			wantFunc: "btrfs_submit_chunk", wantDef: 6,
		},
		{
			name: "earlier function is not confused", lines: kernelStyle, callLine: 3,
			wantFunc: "helper", wantDef: 1,
		},
		{
			// K&R でない { が行末に来るスタイル
			name: "brace on signature line", lines: []string{
				`void caller(void) {`,
				`	while (x) {`,
				`		target();`,
				`	}`,
				`}`,
			}, callLine: 3, wantFunc: "caller", wantDef: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotFunc, gotDef := findContainingFunc(tt.lines, tt.callLine)
			if gotFunc != tt.wantFunc || gotDef != tt.wantDef {
				t.Errorf("findContainingFunc(line %d) = (%q, %d), want (%q, %d)",
					tt.callLine, gotFunc, gotDef, tt.wantFunc, tt.wantDef)
			}
		})
	}
}

func TestFindCalleesStopsAtFunctionEnd(t *testing.T) {
	// カーネル形式: 関数の直後に EXPORT_SYMBOL_GPL が続く。
	// 閉じ } の次の行を本体に含めると、これが呼び出し先として現れる。
	file := filepath.Join(t.TempDir(), "xdp.c")
	src := `void __acquires(&lock->lock)
__libeth_xdpsq_lock(struct libeth_xdpsq_lock *lock)
{
	spin_lock(&lock->lock);
}
EXPORT_SYMBOL_GPL(__libeth_xdpsq_lock);
`
	if err := os.WriteFile(file, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	hits, err := FindCallees(t.Context(), file, 2, "")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, h := range hits {
		got[h.Name] = true
	}
	if !got["spin_lock"] {
		t.Errorf("spin_lock is in the body and must be a callee, got %v", got)
	}
	if got["EXPORT_SYMBOL_GPL"] {
		t.Errorf("EXPORT_SYMBOL_GPL sits after the closing brace and must not be a callee, got %v", got)
	}
}
