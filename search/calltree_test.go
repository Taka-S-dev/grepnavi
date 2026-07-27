package search

import "testing"

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
