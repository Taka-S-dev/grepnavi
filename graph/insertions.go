package graph

import (
	"fmt"
	"path"
	"strconv"
	"strings"
	"time"
)

// SamePathLoose はスラッシュ方向と大小文字を吸収して比較する。
// filepath.FromSlash は Linux では no-op で `\` を吸収できないため、
// 実行 OS に依存しない明示的な置換で寄せる（クライアントの _samePath と同じ規約）。
func SamePathLoose(a, b string) bool {
	norm := func(p string) string {
		return path.Clean(strings.ReplaceAll(p, `\`, `/`))
	}
	return strings.EqualFold(norm(a), norm(b))
}

// NextInsertionTag は既存の仕込み ID (GN連番) の最大+1を返す。
func (s *Store) NextInsertionTag() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	max := 0
	for _, ins := range s.pf.Insertions {
		if n, err := strconv.Atoi(strings.TrimPrefix(ins.ID, "GN")); err == nil && n > max {
			max = n
		}
	}
	return fmt.Sprintf("GN%d", max+1)
}

func (s *Store) AddInsertion(ins Insertion) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pf.Insertions = append(s.pf.Insertions, ins)
	return s.save()
}

func (s *Store) RemoveInsertion(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.pf.Insertions[:0]
	found := false
	for _, ins := range s.pf.Insertions {
		if ins.ID == id {
			found = true
			continue
		}
		out = append(out, ins)
	}
	if !found {
		return fmt.Errorf("insertion %s not found", id)
	}
	s.pf.Insertions = out
	return s.save()
}

func (s *Store) UpdateInsertion(id string, fn func(*Insertion)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.pf.Insertions {
		if s.pf.Insertions[i].ID == id {
			fn(&s.pf.Insertions[i])
			return s.save()
		}
	}
	return fmt.Errorf("insertion %s not found", id)
}

// ShiftResult は ShiftLines が動かした項目。クライアントが localStorage 側の
// メモ・ブックマークへ同じ移動を適用するために返す。
// *Dropped 系は「行そのものが削除区間に入っていて追従先が無い」項目 — 動いた
// のではなく消えたので Moves とは別に報告する。
type ShiftResult struct {
	NodeMoves           map[string]int    `json:"node_moves,omitempty"`
	MemoKeyMoves        map[string]string `json:"memo_key_moves,omitempty"`
	MemoKeysDropped     []string          `json:"memo_keys_dropped,omitempty"`
	BookmarkKeyMoves    map[string]string `json:"bookmark_key_moves,omitempty"`
	BookmarkKeysDropped []string          `json:"bookmark_keys_dropped,omitempty"`
	RangeMoves          map[string][2]int `json:"range_moves,omitempty"`
	RangesDropped       []string          `json:"ranges_dropped,omitempty"`
}

// splitLineKey は "file::line" 形式のキーを分解する。Windows のパスは "C:" を
// 含むので、必ず末尾側の "::" で切る。
func splitLineKey(key string) (string, int, bool) {
	i := strings.LastIndex(key, "::")
	if i < 0 {
		return "", 0, false
	}
	line, err := strconv.Atoi(key[i+2:])
	if err != nil || line < 1 {
		return "", 0, false
	}
	return key[:i], line, true
}

// shiftKeyedMap は file::line キーのマップのうち、対象ファイル・fromLine 以降の
// キーだけを付け替えた新しいマップを返す。衝突順の事故を避けるため、mutate せず
// 新しい map に詰め替える。moves には旧キー→新キーを積む。
//
// delta < 0 (削除) のとき、[fromLine+delta, fromLine) の行は削除された行その
// ものなので、そこにあったキーは移動先が無い — drop に積んで捨てる。この
// 「削除区間を先に抜く」処理をしてから残りをシフトすることで、shift 後のキーが
// 生き残ったキーと衝突する可能性を構造的に無くしている（衝突判定・上書き順を
// 気にする必要がない）。delta > 0 のときは削除区間が空なので、シフト後のキーは
// 常に生存キーより大きい行番号側に動き、衝突しない。
func shiftKeyedMap(m map[string]string, file string, fromLine, delta int, moves map[string]string, dropped *[]string) map[string]string {
	if m == nil {
		return nil
	}
	removedFrom, removedTo := fromLine+delta, fromLine // [removedFrom, removedTo) が削除区間（delta<0 のときのみ意味を持つ）
	out := make(map[string]string, len(m))
	for k, v := range m {
		f, line, ok := splitLineKey(k)
		if !ok || !SamePathLoose(f, file) {
			out[k] = v
			continue
		}
		if delta < 0 && line >= removedFrom && line < removedTo {
			if dropped != nil {
				*dropped = append(*dropped, k)
			}
			continue
		}
		if line < fromLine {
			out[k] = v
			continue
		}
		newKey := fmt.Sprintf("%s::%d", f, line+delta)
		out[newKey] = v
		moves[k] = newKey
	}
	return out
}

// ShiftLines は file の fromLine 行目以降 (>= fromLine) を delta 行ずらす。
// 挿入・撤去の行シフトは量が正確に分かるので、heal の推測に頼らず
// ここで決定的に追従させる。全 tree のノード・行メモ4マップ・
// ブックマーク・範囲メモ・他の仕込みが対象。
//
// 呼び出し順の注意: 対象ファイルの既存の仕込み全ての sites もシフト対象に
// 含む。挿入をまだ AddInsertion していない時点で呼ぶこと — 登録後に呼ぶと、
// 今追加したばかりの仕込み自身の sites まで二重にシフトされてしまう。
func (s *Store) ShiftLines(file string, fromLine, delta int) ShiftResult {
	s.mu.Lock()
	defer s.mu.Unlock()

	res := ShiftResult{
		NodeMoves:        map[string]int{},
		MemoKeyMoves:     map[string]string{},
		BookmarkKeyMoves: map[string]string{},
		RangeMoves:       map[string][2]int{},
	}

	for _, t := range s.pf.Trees {
		moved := false
		for id, n := range t.Nodes {
			if n.Match.Line >= fromLine && SamePathLoose(n.Match.File, file) {
				n.Match.Line += delta
				res.NodeMoves[id] = n.Match.Line
				moved = true
			}
		}
		if moved {
			t.UpdatedAt = time.Now()
		}
	}

	s.pf.LineMemos = shiftKeyedMap(s.pf.LineMemos, file, fromLine, delta, res.MemoKeyMoves, &res.MemoKeysDropped)
	// Categories/Sources/Texts はキーを LineMemos と共有するので、同じ移動/削除を
	// 別 map・使い捨て drop 先に適用する（moves/dropped への二重積みを避けるため。
	// 報告は LineMemos の1回分だけで、4マップぶん重複させない）。
	s.pf.LineMemoCategories = shiftKeyedMap(s.pf.LineMemoCategories, file, fromLine, delta, map[string]string{}, nil)
	s.pf.LineMemoSources = shiftKeyedMap(s.pf.LineMemoSources, file, fromLine, delta, map[string]string{}, nil)
	s.pf.LineMemoTexts = shiftKeyedMap(s.pf.LineMemoTexts, file, fromLine, delta, map[string]string{}, nil)
	s.pf.Bookmarks = shiftKeyedMap(s.pf.Bookmarks, file, fromLine, delta, res.BookmarkKeyMoves, &res.BookmarkKeysDropped)

	// [removedFrom, removedTo) が削除区間。delta>=0 では removedFrom>=removedTo
	// となり空区間なので、以下の startInRegion/endInRegion は常に false になり
	// 正シフトの挙動には影響しない。
	removedFrom, removedTo := fromLine+delta, fromLine
	rangeMemos := s.pf.RangeMemos[:0]
	for i := range s.pf.RangeMemos {
		rm := s.pf.RangeMemos[i]
		if !SamePathLoose(rm.File, file) {
			rangeMemos = append(rangeMemos, rm)
			continue
		}
		startInRegion := removedFrom <= rm.StartLine && rm.StartLine < removedTo
		endInRegion := removedFrom <= rm.EndLine && rm.EndLine < removedTo

		// delta<0 のときの4分岐（削除区間に対して排他的・網羅的）:
		//   1. 両端が削除区間の中 → 追従先が無い。消して報告する。
		//   2. 開始行だけ削除区間の中 → 開始行は「削除後にそこへ来る内容」の
		//      行 (removedFrom) に付け替え、終了行は通常どおり delta シフト。
		//   3. 終了行だけ削除区間の中 → 終了行は削除区間の直前 (removedFrom-1)
		//      まで巻き戻す。開始行は不動。
		//   4. どちらも削除区間に掛からない → 従来どおり（丸ごと/末尾のみ/不動）。
		switch {
		case startInRegion && endInRegion:
			res.RangesDropped = append(res.RangesDropped, rm.ID)
			continue // rangeMemos に積まない
		case startInRegion:
			rm.StartLine = removedFrom
			rm.EndLine += delta
			res.RangeMoves[rm.ID] = [2]int{rm.StartLine, rm.EndLine}
		case endInRegion:
			rm.EndLine = removedFrom - 1
			res.RangeMoves[rm.ID] = [2]int{rm.StartLine, rm.EndLine}
		case rm.StartLine >= fromLine:
			// 範囲全体が挿入点より下 → 丸ごと追従
			rm.StartLine += delta
			rm.EndLine += delta
			res.RangeMoves[rm.ID] = [2]int{rm.StartLine, rm.EndLine}
		case rm.EndLine >= fromLine:
			// 挿入点が範囲の途中（削除区間には掛からない）→ 終了行だけ追従。
			// この分岐に来る時点で EndLine+delta >= removedFrom > StartLine が
			// 保証される（開始行が削除区間より前で残っているケースのため）ので
			// 反転はしない。念のための安全網として floor を残す。
			rm.EndLine += delta
			if rm.EndLine < rm.StartLine {
				rm.EndLine = rm.StartLine
			}
			res.RangeMoves[rm.ID] = [2]int{rm.StartLine, rm.EndLine}
		}
		rangeMemos = append(rangeMemos, rm)
	}
	s.pf.RangeMemos = rangeMemos

	for i := range s.pf.Insertions {
		ins := &s.pf.Insertions[i]
		if !SamePathLoose(ins.File, file) {
			continue
		}
		for j := range ins.Sites {
			if ins.Sites[j].Line >= fromLine {
				ins.Sites[j].Line += delta
			}
		}
	}

	_ = s.save()
	return res
}
