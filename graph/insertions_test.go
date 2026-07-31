package graph

import (
	"testing"
)

func TestSamePathLoose(t *testing.T) {
	if !SamePathLoose(`C:\proj\a.c`, `c:/proj/a.c`) {
		t.Error("スラッシュ方向と大小文字は吸収するはず")
	}
	if SamePathLoose(`C:\proj\a.c`, `C:\proj\b.c`) {
		t.Error("別ファイルが同一判定された")
	}
}

func TestNextInsertionTag(t *testing.T) {
	s := newTestStore(t)
	if got := s.NextInsertionTag(); got != "GN1" {
		t.Fatalf("empty: %q", got)
	}
	s.AddInsertion(Insertion{ID: "GN3", File: "a.c", Sites: []InsertionSite{{Line: 1, Text: "x"}}, Enabled: true})
	if got := s.NextInsertionTag(); got != "GN4" {
		t.Fatalf("after GN3: %q", got)
	}
}

func TestShiftLines(t *testing.T) {
	s := newTestStore(t)
	file := `C:\proj\a.c`
	other := `C:\proj\b.c`
	n1, _, _ := s.AddMatchAsNode(&Match{ID: "n1", File: file, Line: 10, Text: "ten"}, "", "ref", "")
	n2, _, _ := s.AddMatchAsNode(&Match{ID: "n2", File: file, Line: 3, Text: "three"}, "", "ref", "")
	n3, _, _ := s.AddMatchAsNode(&Match{ID: "n3", File: other, Line: 10, Text: "ten"}, "", "ref", "")
	s.UpdateMemos(MemoSnapshot{
		LineMemos:     map[string]string{file + "::10": "m", file + "::3": "keep", other + "::10": "other"},
		LineMemoTexts: map[string]string{file + "::10": "ten"},
		Bookmarks:     map[string]string{file + "::12": "bm"},
		RangeMemos:    []RangeMemo{{ID: "r1", File: file, StartLine: 8, EndLine: 15, Memo: "range"}},
	})
	s.AddInsertion(Insertion{ID: "GN1", File: file, Sites: []InsertionSite{{Line: 20, Text: "x"}}, Enabled: true})

	// 5行目の位置に2行挿入された想定: 5行目以降 (>=5) を +2
	res := s.ShiftLines(file, 5, 2)

	g := s.GetGraphResponse()
	if g.Nodes[n1.ID].Match.Line != 12 {
		t.Error("n1 が +2 されていない")
	}
	_ = n2
	_ = n3
	if _, ok := g.LineMemos[file+"::12"]; !ok {
		t.Error("メモ ::10 が ::12 に動いていない")
	}
	if _, ok := g.LineMemos[file+"::3"]; !ok {
		t.Error("fromLine より上のメモが動いてしまった")
	}
	if _, ok := g.LineMemos[other+"::10"]; !ok {
		t.Error("別ファイルのメモが動いてしまった")
	}
	if _, ok := g.LineMemoTexts[file+"::12"]; !ok {
		t.Error("LineMemoTexts のキーが並走していない")
	}
	if _, ok := g.Bookmarks[file+"::14"]; !ok {
		t.Error("ブックマークが動いていない")
	}
	if g.RangeMemos[0].StartLine != 10 || g.RangeMemos[0].EndLine != 17 {
		t.Errorf("範囲メモ: %d-%d", g.RangeMemos[0].StartLine, g.RangeMemos[0].EndLine)
	}
	if g.Insertions[0].Sites[0].Line != 22 {
		t.Errorf("他の仕込みが動いていない: %d", g.Insertions[0].Sites[0].Line)
	}
	if res.MemoKeyMoves[file+"::10"] != file+"::12" {
		t.Errorf("MemoKeyMoves: %+v", res.MemoKeyMoves)
	}
	if res.NodeMoves["n1"] != 12 {
		t.Errorf("NodeMoves: %+v", res.NodeMoves)
	}
}

// 部分重なり: StartLine < fromLine <= EndLine のときは EndLine のみ +delta。
// 挿入点がメモの範囲の途中に入るケースで、開始行を動かすと範囲が広がって
// しまう（メモが指していた行より前に伸びる）ため、終了行だけ追従させる。
func TestShiftLinesPartialRangeOverlap(t *testing.T) {
	s := newTestStore(t)
	file := `C:\proj\a.c`
	s.UpdateMemos(MemoSnapshot{
		RangeMemos: []RangeMemo{{ID: "r1", File: file, StartLine: 8, EndLine: 15, Memo: "range"}},
	})

	// fromLine=10 で挿入 → StartLine=8 は据え置き、EndLine=15 は +delta
	res := s.ShiftLines(file, 10, 3)

	g := s.GetGraphResponse()
	if g.RangeMemos[0].StartLine != 8 {
		t.Errorf("StartLine が動いてしまった: %d", g.RangeMemos[0].StartLine)
	}
	if g.RangeMemos[0].EndLine != 18 {
		t.Errorf("EndLine が追従していない: %d", g.RangeMemos[0].EndLine)
	}
	if res.RangeMoves["r1"] != [2]int{8, 18} {
		t.Errorf("RangeMoves: %+v", res.RangeMoves)
	}
}

// 1行削除 (delta=-1): 削除区間 [fromLine+delta, fromLine) = [6,7) にあった
// キーは追従先が無いので drop され、区間より下は詰まり、上はそのまま。
func TestShiftLinesNegativeDeltaSingleLineRemoval(t *testing.T) {
	s := newTestStore(t)
	file := `C:\proj\a.c`
	s.UpdateMemos(MemoSnapshot{
		LineMemos:          map[string]string{file + "::5": "keep", file + "::6": "removed-line", file + "::7": "shift"},
		LineMemoCategories: map[string]string{file + "::6": "warn", file + "::7": "ok"},
		LineMemoSources:    map[string]string{file + "::6": "user", file + "::7": "ai"},
		LineMemoTexts:      map[string]string{file + "::7": "seven"},
		Bookmarks:          map[string]string{file + "::5": "b5", file + "::6": "b6", file + "::7": "b7"},
	})

	res := s.ShiftLines(file, 7, -1)
	g := s.GetGraphResponse()

	if _, ok := g.LineMemos[file+"::5"]; !ok {
		t.Error("fromLine より上のメモが消えた")
	}
	if _, ok := g.LineMemos[file+"::7"]; ok {
		t.Error("シフトしたはずの旧キーが残っている")
	}
	// ::6 は「削除された行のメモ」ではなく「::7 がシフトしてきたもの」であること
	// （削除区間を先に抜いてあるので衝突なく上書きできる）
	if got := g.LineMemos[file+"::6"]; got != "shift" {
		t.Errorf("::6 には ::7 の内容 (shift) が来るはずが %q", got)
	}

	if len(res.MemoKeysDropped) != 1 || res.MemoKeysDropped[0] != file+"::6" {
		t.Errorf("MemoKeysDropped: %+v", res.MemoKeysDropped)
	}
	if res.MemoKeyMoves[file+"::7"] != file+"::6" {
		t.Errorf("MemoKeyMoves: %+v", res.MemoKeyMoves)
	}
	// Categories が LineMemos と並走してキーを落としている（誤って ::7 の
	// カテゴリが残った ::6 に紐付いてはいけない）
	if _, ok := g.LineMemoCategories[file+"::6"]; !ok {
		t.Error("Categories が LineMemos と並走していない（::7 の ok が ::6 に来るはず）")
	} else if g.LineMemoCategories[file+"::6"] != "ok" {
		t.Errorf("Categories: got %q, want ok (::7 の値)", g.LineMemoCategories[file+"::6"])
	}
	if _, ok := g.LineMemoTexts[file+"::6"]; !ok {
		t.Error("Texts が LineMemos と並走していない")
	}
	// Sources も同じキーで並走・drop していること（::6 の元の user は消え、
	// ::7 の ai が ::6 に来る）
	if got, ok := g.LineMemoSources[file+"::6"]; !ok || got != "ai" {
		t.Errorf("Sources が LineMemos と並走していない: got %q, ok=%v (want ai)", got, ok)
	}

	if len(res.BookmarkKeysDropped) != 1 || res.BookmarkKeysDropped[0] != file+"::6" {
		t.Errorf("BookmarkKeysDropped: %+v", res.BookmarkKeysDropped)
	}
	if res.BookmarkKeyMoves[file+"::7"] != file+"::6" {
		t.Errorf("BookmarkKeyMoves: %+v", res.BookmarkKeyMoves)
	}
	if g.Bookmarks[file+"::6"] != "b7" {
		t.Errorf("Bookmarks ::6 の中身: got %q, want b7", g.Bookmarks[file+"::6"])
	}
	if g.Bookmarks[file+"::5"] != "b5" {
		t.Error("fromLine より上のブックマークが動いてしまった")
	}
}

// 複数行削除 (delta=-2): 削除区間 [5,7) の2キーが両方 drop され、
// 区間より下 (::7) は生存キー (::4) と衝突せず ::5 へ詰まる。
func TestShiftLinesNegativeDeltaMultiLineRemoval(t *testing.T) {
	s := newTestStore(t)
	file := `C:\proj\a.c`
	s.UpdateMemos(MemoSnapshot{
		LineMemos: map[string]string{
			file + "::4": "keep",
			file + "::5": "removed",
			file + "::6": "removed",
			file + "::7": "shift",
		},
	})

	res := s.ShiftLines(file, 7, -2)
	g := s.GetGraphResponse()

	if _, ok := g.LineMemos[file+"::4"]; !ok {
		t.Error("fromLine より上のメモが消えた")
	}
	if len(res.MemoKeysDropped) != 2 {
		t.Errorf("MemoKeysDropped: %+v", res.MemoKeysDropped)
	}
	if res.MemoKeyMoves[file+"::7"] != file+"::5" {
		t.Errorf("MemoKeyMoves: %+v", res.MemoKeyMoves)
	}
	if g.LineMemos[file+"::5"] != "shift" {
		t.Errorf("::7 の内容が ::5 に来ていない: %q", g.LineMemos[file+"::5"])
	}
}

// 範囲メモの開始行だけが削除区間の中にある大きめの削除の場合:
// 開始行は「削除後にそこへ来る内容」の行 (removedFrom) まで巻き上げ、
// 終了行は通常どおり delta シフトする。
func TestShiftLinesRangeMemoStartInRegionLargeDelta(t *testing.T) {
	s := newTestStore(t)
	file := `C:\proj\a.c`
	s.UpdateMemos(MemoSnapshot{
		RangeMemos: []RangeMemo{{ID: "r1", File: file, StartLine: 3, EndLine: 8, Memo: "range"}},
	})

	// fromLine=7, delta=-6 → 削除区間 [1,7)。StartLine=3 はその中。
	res := s.ShiftLines(file, 7, -6)
	g := s.GetGraphResponse()

	if len(g.RangeMemos) != 1 {
		t.Fatalf("範囲メモが消えてしまった: %+v", g.RangeMemos)
	}
	if g.RangeMemos[0].StartLine != 1 {
		t.Errorf("StartLine が removedFrom (1) まで巻き上がっていない: %d", g.RangeMemos[0].StartLine)
	}
	if g.RangeMemos[0].EndLine != 2 {
		t.Errorf("EndLine が通常どおりシフトしていない: %d", g.RangeMemos[0].EndLine)
	}
	if res.RangeMoves["r1"] != [2]int{1, 2} {
		t.Errorf("RangeMoves: %+v", res.RangeMoves)
	}
}

// 範囲メモの終了行だけが削除区間の中にある場合: 終了行は削除区間の直前
// (removedFrom-1) まで巻き戻す。開始行は削除区間の外（不動）。
func TestShiftLinesRangeMemoEndInRemovedRegion(t *testing.T) {
	s := newTestStore(t)
	file := `C:\proj\a.c`
	s.UpdateMemos(MemoSnapshot{
		RangeMemos: []RangeMemo{{ID: "r1", File: file, StartLine: 3, EndLine: 6, Memo: "range"}},
	})

	// fromLine=7, delta=-1 → 削除区間 [6,7)。EndLine=6 はその中、StartLine=3 は外。
	res := s.ShiftLines(file, 7, -1)
	g := s.GetGraphResponse()

	if len(g.RangeMemos) != 1 {
		t.Fatalf("範囲メモが消えてしまった: %+v", g.RangeMemos)
	}
	if g.RangeMemos[0].StartLine != 3 {
		t.Errorf("StartLine が動いてしまった: %d", g.RangeMemos[0].StartLine)
	}
	if g.RangeMemos[0].EndLine != 5 {
		t.Errorf("EndLine が削除区間の直前 (5) まで巻き戻っていない: %d", g.RangeMemos[0].EndLine)
	}
	if res.RangeMoves["r1"] != [2]int{3, 5} {
		t.Errorf("RangeMoves: %+v", res.RangeMoves)
	}
}

// 範囲メモの開始行だけが削除区間の中にある場合: 開始行は removedFrom に
// 付け替え、終了行は通常どおり delta シフトする（coordinator 指定の例）。
func TestShiftLinesRangeMemoStartInRemovedRegion(t *testing.T) {
	s := newTestStore(t)
	file := `C:\proj\a.c`
	s.UpdateMemos(MemoSnapshot{
		RangeMemos: []RangeMemo{{ID: "r1", File: file, StartLine: 6, EndLine: 9, Memo: "range"}},
	})

	// fromLine=7, delta=-1 → 削除区間 [6,7)。StartLine=6 はその中、EndLine=9 は fromLine 以降。
	res := s.ShiftLines(file, 7, -1)
	g := s.GetGraphResponse()

	if len(g.RangeMemos) != 1 {
		t.Fatalf("範囲メモが消えてしまった: %+v", g.RangeMemos)
	}
	if g.RangeMemos[0].StartLine != 6 {
		t.Errorf("StartLine が removedFrom (6) に付け替わっていない: %d", g.RangeMemos[0].StartLine)
	}
	if g.RangeMemos[0].EndLine != 8 {
		t.Errorf("EndLine が通常どおりシフトしていない: %d", g.RangeMemos[0].EndLine)
	}
	if res.RangeMoves["r1"] != [2]int{6, 8} {
		t.Errorf("RangeMoves: %+v", res.RangeMoves)
	}
}

// 範囲メモ全体が削除区間に収まる場合は drop され、RangesDropped に報告される。
func TestShiftLinesRangeMemoFullyRemoved(t *testing.T) {
	s := newTestStore(t)
	file := `C:\proj\a.c`
	s.UpdateMemos(MemoSnapshot{
		RangeMemos: []RangeMemo{{ID: "r1", File: file, StartLine: 5, EndLine: 6, Memo: "gone"}},
	})

	res := s.ShiftLines(file, 7, -2)
	g := s.GetGraphResponse()

	if len(g.RangeMemos) != 0 {
		t.Errorf("削除区間に収まる範囲メモが残っている: %+v", g.RangeMemos)
	}
	if len(res.RangesDropped) != 1 || res.RangesDropped[0] != "r1" {
		t.Errorf("RangesDropped: %+v", res.RangesDropped)
	}
}
