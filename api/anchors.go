package api

import (
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

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

// handleGraphAnchors はピン位置がずれているノード・行メモを列挙する。
func (h *Handler) handleGraphAnchors(w http.ResponseWriter, r *http.Request) {
	g := h.store.GetGraphResponse()
	drifted := []DriftedAnchor{}
	checked, skipped := 0, 0
	for _, n := range g.Nodes {
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
