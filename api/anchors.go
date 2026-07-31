package api

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"grepnavi/graph"
	"grepnavi/search"
)

// ノードは「ピンした瞬間の行テキスト」を Match.Text に持っている。
// 外部の編集（git pull・別エディタ）で行がずれても grepnavi は気づかず、
// 古い行番号を指したまま普通に見える。ここでは直さずに、
// ずれていることだけを返す。何をどう直すかは利用者が決める。

// _anchorMaxNodes は1回の点検で見るノード数の上限。
// グラフが巨大でも UI をブロックしないための天井。
const _anchorMaxNodes = 500

// DriftedAnchor はピン位置と現在の行が食い違っている1件。
// ノードなら node_id、行メモなら memo_key が入る。
type DriftedAnchor struct {
	NodeID   string `json:"node_id,omitempty"`
	MemoKey  string `json:"memo_key,omitempty"`
	File     string `json:"file"`
	Line     int    `json:"line"`
	Expected string `json:"expected"` // ピンしたときの行
	Actual   string `json:"actual"`   // 今その行にあるもの（範囲外なら空）
	Missing  bool   `json:"missing"`  // 行が読めない（末尾超過またはファイル自体が読めない）
	FileGone bool   `json:"file_gone,omitempty"` // ファイル自体が読めない（削除・リネーム等）
}

// absFromRoot は相対パスを root 基準の絶対パスにする。
// MCP 経由のノードは相対パス（grepnavi_root 基準）で来ることがあり、
// 生のまま os で開くと cwd 依存で失敗する。他ハンドラの IsAbs+Join と同じ規約。
func (h *Handler) absFromRoot(file string) string {
	if file == "" || filepath.IsAbs(file) {
		return file
	}
	h.mu.RLock()
	root := h.root
	h.mu.RUnlock()
	return filepath.Join(root, file)
}

// lineTextAt は file の line 行目（1-indexed）を返す。file は絶対パス前提
// （呼び出し側で absFromRoot を通す）。
func lineTextAt(file string, line int) (string, bool) {
	if file == "" || line < 1 {
		return "", false
	}
	lines, err := search.CachedLines(file)
	if err != nil || line > len(lines) {
		return "", false
	}
	return lines[line-1], true
}

// fileUnreadable は「行が無い」のと「ファイル自体が読めない」を区別する。
// 削除・リネームされたファイルに「行が末尾を超えた」と言うのは嘘になる。
func fileUnreadable(file string) bool {
	_, err := search.CachedLines(file)
	return err != nil
}

// sameAnchorText は空白の差を無視して比較する。
// インデントだけの変更で「ずれた」と言われても実用にならない。
func sameAnchorText(a, b string) bool {
	return strings.TrimSpace(a) == strings.TrimSpace(b)
}

// collectDrifted はピン位置がずれている項目を列挙する。fileFilter 非空なら
// そのファイルの項目だけを見る（対象外はどのカウンタにも入れない —
// skipped は「見たが判定できない」の意味を保つ）。
func (h *Handler) collectDrifted(g *graph.GraphResponse, fileFilter string) ([]DriftedAnchor, int, int) {
	drifted := []DriftedAnchor{}
	checked, skipped := 0, 0
	for _, n := range g.Nodes {
		if fileFilter != "" && !graph.SamePathLoose(h.absFromRoot(n.Match.File), h.absFromRoot(fileFilter)) {
			continue
		}
		// Text が無いノード（古いグラフ・手で作ったノード）は判定材料が無い
		if n.Match.File == "" || n.Match.Line < 1 || strings.TrimSpace(n.Match.Text) == "" {
			skipped++
			continue
		}
		if checked >= _anchorMaxNodes {
			skipped++
			continue
		}
		checked++
		path := h.absFromRoot(n.Match.File)
		actual, ok := lineTextAt(path, n.Match.Line)
		if ok && sameAnchorText(actual, n.Match.Text) {
			continue
		}
		drifted = append(drifted, DriftedAnchor{
			NodeID:   n.ID,
			File:     n.Match.File,
			Line:     n.Match.Line,
			Expected: strings.TrimSpace(n.Match.Text),
			Actual:   strings.TrimSpace(actual),
			Missing:  !ok,
			FileGone: !ok && fileUnreadable(path),
		})
	}
	// 行メモも同じ扱いにする。ノードだけ印が出てメモは出ない、では
	// どちらを信じてよいか分からなくなる。
	texts := g.LineMemoTexts
	for key := range g.LineMemos {
		file, line, ok := splitMemoKey(key)
		if !ok {
			skipped++
			continue
		}
		if fileFilter != "" && !graph.SamePathLoose(h.absFromRoot(file), h.absFromRoot(fileFilter)) {
			continue
		}
		pinned, has := texts[key]
		// 旧データのメモは記録が無く判定できない。無いことを skipped で伝える。
		if !has || strings.TrimSpace(pinned) == "" {
			skipped++
			continue
		}
		if checked >= _anchorMaxNodes*2 {
			skipped++
			continue
		}
		checked++
		path := h.absFromRoot(file)
		actual, ok := lineTextAt(path, line)
		if ok && sameAnchorText(actual, pinned) {
			continue
		}
		drifted = append(drifted, DriftedAnchor{
			MemoKey:  key,
			File:     file,
			Line:     line,
			Expected: strings.TrimSpace(pinned),
			Actual:   strings.TrimSpace(actual),
			Missing:  !ok,
			FileGone: !ok && fileUnreadable(path),
		})
	}
	return drifted, checked, skipped
}

// handleGraphAnchors はピン位置がずれているノード・行メモを列挙する。
func (h *Handler) handleGraphAnchors(w http.ResponseWriter, r *http.Request) {
	drifted, checked, skipped := h.collectDrifted(h.store.GetGraphResponse(), "")
	jsonOK(w, map[string]any{
		"drifted": drifted,
		"checked": checked,
		"skipped": skipped, // 判定材料が無い / 上限超過。0 でないことが「全部見た訳ではない」の合図
	})
}

// splitMemoKey は行メモのキー "file::line" を分解する。
// Windows のパスは "C:" を含むので、必ず末尾側の "::" で切る。
func splitMemoKey(key string) (string, int, bool) {
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

// captureMemoAnchors は「メモを付けた時点の行テキスト」を維持・記録する。
//
// このリクエストで新しく現れたキー（prevMemos に無いキー）だけ現在の行を
// 読んで記録し、既存メモの記録はそのまま持ち越す。「新しいか」を記録
// (prevTexts) の有無で判定してはいけない: 記録を持たない旧データのメモが
// 全部「新規」扱いになり、既にずれているかもしれない行を正解として
// 凍結してしまう。旧メモは記録なし（= 判定不能）のまま残す。
// 消えたメモのエントリは落とす。
func (h *Handler) captureMemoAnchors(prevMemos, prevTexts, memos map[string]string) map[string]string {
	if len(memos) == 0 {
		return nil
	}
	out := make(map[string]string, len(memos))
	for k := range memos {
		if t, ok := prevTexts[k]; ok {
			out[k] = t
			continue
		}
		if _, existed := prevMemos[k]; existed {
			continue
		}
		file, line, ok := splitMemoKey(k)
		if !ok {
			continue
		}
		if t, ok := lineTextAt(h.absFromRoot(file), line); ok {
			out[k] = t
		}
	}
	return out
}

// uniqueAnchorLine は anchor と一致する行がちょうど1行のときだけ行番号を返す。
// 複数一致（`}` など）や0件で動かないことが「推測で再アンカーしない」の要。
func uniqueAnchorLine(lines []string, anchor string) (int, bool) {
	found, lineNo := 0, 0
	for i, l := range lines {
		if sameAnchorText(l, anchor) {
			found++
			if found > 1 {
				return 0, false
			}
			lineNo = i + 1
		}
	}
	return lineNo, found == 1
}

// --- /api/graph/anchors/heal ---

// HealedAnchor は自動追従で移動した1件。
type HealedAnchor struct {
	NodeID   string `json:"node_id,omitempty"`
	MemoKey  string `json:"memo_key,omitempty"`
	File     string `json:"file"`
	FromLine int    `json:"from_line"`
	ToLine   int    `json:"to_line"`
}

// handleGraphAnchorsHeal はアンカーテキストが一意に1行だけ一致する項目を
// 自動で追従させる。曖昧（0件・複数件）なものは触らず drifted に残す。
//
// notifyGraphChange に包んではいけない: graph.updated → loadGraph → heal →
// graph.updated のループになる。移動の反映は呼び出し元クライアントが行う。
func (h *Handler) handleGraphAnchorsHeal(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		File string `json:"file"`
	}
	json.NewDecoder(r.Body).Decode(&req) // 空 body = 全体対象
	drifted, _, _ := h.collectDrifted(h.store.GetGraphResponse(), req.File)

	healed := []HealedAnchor{}
	memoMoves := map[string]int{} // 旧 key → 新行
	for _, d := range drifted {
		if d.FileGone {
			continue // 探す先が無い
		}
		lines, err := search.CachedLines(h.absFromRoot(d.File))
		if err != nil {
			continue
		}
		to, ok := uniqueAnchorLine(lines, d.Expected)
		if !ok || to == d.Line {
			continue
		}
		// collectDrifted の2つのループはノード側/メモ側を MemoKey の有無で
		// 判別する（NodeID は手作りノードなどで空になり得るため、有無の判定には使えない）。
		if d.MemoKey != "" {
			memoMoves[d.MemoKey] = to
		} else {
			if _, err := h.store.UpdateNode(d.NodeID, func(n *graph.Node) {
				n.Match.Line = to
				n.Match.Text = lines[to-1] // 手動の行変更と同じくテキストも取り直す
			}); err != nil {
				continue
			}
			healed = append(healed, HealedAnchor{NodeID: d.NodeID, File: d.File, FromLine: d.Line, ToLine: to})
		}
	}
	if len(memoMoves) > 0 {
		moved, err := h.applyMemoMoves(memoMoves)
		if err != nil {
			jsonErr(w, err.Error(), http.StatusInternalServerError)
			return
		}
		healed = append(healed, moved...)
	}
	remaining, checked, skipped := h.collectDrifted(h.store.GetGraphResponse(), req.File)
	jsonOK(w, map[string]any{
		"healed":  healed,
		"drifted": remaining,
		"checked": checked,
		"skipped": skipped,
	})
}

// applyMemoMoves は行メモのキー移動を4マップへ一括適用する。
// 移動先キーが占有されている移動はスキップ（手動移動と同じ規則）。
func (h *Handler) applyMemoMoves(moves map[string]int) ([]HealedAnchor, error) {
	g := h.store.GetGraphResponse()
	memos := copyStrMap(g.LineMemos)
	applied := map[string]string{} // 旧 key → 新 key
	healed := []HealedAnchor{}
	for from, to := range moves {
		file, fromLine, ok := splitMemoKey(from)
		if !ok {
			continue
		}
		toKey := file + "::" + strconv.Itoa(to)
		if _, occupied := memos[toKey]; occupied {
			continue
		}
		v, ok := memos[from]
		if !ok {
			continue
		}
		memos[toKey] = v
		delete(memos, from)
		applied[from] = toKey
		healed = append(healed, HealedAnchor{MemoKey: from, File: file, FromLine: fromLine, ToLine: to})
	}
	if len(applied) == 0 {
		return nil, nil
	}
	texts := moveStrMapKeys(g.LineMemoTexts, applied)
	for _, toKey := range applied {
		file, line, _ := splitMemoKey(toKey)
		if t, ok := lineTextAt(h.absFromRoot(file), line); ok {
			texts[toKey] = t // 移動先の行で取り直す（ノードの行変更と同じ規則）
		}
	}
	return healed, h.store.UpdateMemos(graph.MemoSnapshot{
		LineMemos:          memos,
		LineMemoCategories: moveStrMapKeys(g.LineMemoCategories, applied),
		LineMemoSources:    moveStrMapKeys(g.LineMemoSources, applied),
		LineMemoTexts:      texts,
		RangeMemos:         g.RangeMemos,
		Bookmarks:          g.Bookmarks,
	})
}

func copyStrMap(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// moveStrMapKeys は applied (旧key→新key) に従ってキーを差し替えたコピーを返す。
func moveStrMapKeys(m, applied map[string]string) map[string]string {
	out := copyStrMap(m)
	for from, to := range applied {
		if v, ok := out[from]; ok {
			out[to] = v
			delete(out, from)
		}
	}
	return out
}
