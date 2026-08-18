package search

import (
	"path/filepath"
	"testing"
)

// 生のまま返すと openssl の hand_state で 34.8 KB あり、受け取る側が読めない。
// 遷移元で畳み、関数名を表に逃がすと 14.6 KB になる。
func TestSummarizeStateMachine(t *testing.T) {
	// パスは OS 固有の区切りで組む。Windows 表記で直書きすると、relToRoot の
	// filepath.Rel が Linux では `\` を区切りと見なさず、関数表が root 相対に
	// 縮まないまま比較されて落ちる (CI は Linux)。
	root := t.TempDir()
	xc := filepath.Join(root, "x.c")
	yc := filepath.Join(root, "y.c")
	m := StateMachine{
		Var:    "st",
		Family: "enum",
		States: []StateInfo{
			{Name: "A", Assigned: true}, {Name: "B", Observed: true},
			{Name: "DEAD"}, // 一度も代入も比較もされない
		},
		Transitions: []StateTransition{
			{From: []string{"A"}, To: "B", FromKind: "case", Func: "f", File: xc, Line: 10},
			{From: []string{"A"}, To: "B", FromKind: "case", Func: "f", File: xc, Line: 12},
			{From: []string{"A"}, To: "C", FromKind: "case", Func: "f", File: xc, Line: 20},
			{From: []string{"B"}, To: "A", FromKind: "if", Func: "g", File: yc, Line: 30},
			{To: "A", Func: "h", File: yc, Line: 40}, // 遷移元不明
		},
	}
	s := SummarizeStateMachine(m, root)

	if s.Total != 5 || s.UnknownFrom != 1 {
		t.Errorf("total=%d unknown=%d, want 5 / 1", s.Total, s.UnknownFrom)
	}
	// 同じ (from,to,関数) は1本に畳み、行番号は全部残す
	if len(s.From) != 3 {
		t.Fatalf("遷移元 = %d, want 3（A / B / 不明）: %+v", len(s.From), s.From)
	}
	if s.From[0].From != "A" || len(s.From[0].Edges) != 2 {
		t.Fatalf("A からの辺 = %+v, want 2本", s.From[0])
	}
	if got := s.From[0].Edges[0].Lines; len(got) != 2 {
		t.Errorf("A->B の行 = %v, want 2行", got)
	}
	// 遷移元不明は捨てずに最後へ（捨てると「代入が無い」に見える）
	if s.From[2].From != "" {
		t.Errorf("不明が最後に来ていない: %+v", s.From)
	}
	// 関数名は表に逃がす
	if len(s.Funcs) != 3 {
		t.Fatalf("関数表 = %v, want 3", s.Funcs)
	}
	if s.Funcs[s.From[0].Edges[0].Fn] != "x.c:f" {
		t.Errorf("添字が指す関数 = %q", s.Funcs[s.From[0].Edges[0].Fn])
	}
	// 一度も現れない状態は「到達なし」として出す（黙って消さない）
	if len(s.Unreached) != 1 || s.Unreached[0] != "DEAD" {
		t.Errorf("unreached = %v, want [DEAD]", s.Unreached)
	}
}
