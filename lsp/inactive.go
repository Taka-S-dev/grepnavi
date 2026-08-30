package lsp

import (
	"grepnavi/search"
)

// 無効領域: 構成（grepnavi.defines）で偽になる #if ブロックと `#if 0` を、
// GUI のグレーアウトと同じ評価器で求め、拡張へ通知する。clangd はビルド設定が
// 正しいときにしか出せないが、こちらは利用者が書いた条件だけで決まるので、
// ビルドできないツリーでも「この分岐は今の構成では死んでいる」が見える。
//
// 通知は独自メソッド grepnavi/inactiveRegions。同梱の拡張がこれを受けて
// 薄く塗る。他のエディタは無視するだけで害はない。

const methodInactiveRegions = "grepnavi/inactiveRegions"

type inactiveRegionsParams struct {
	URI    string     `json:"uri"`
	Ranges []lspRange `json:"ranges"`
}

// publishInactive は文書が開かれた・変わったときに無効領域を送る。
// 評価は保存済みのファイルに対して行う（GUI と同じ。未保存の編集は
// 次の保存で反映される）。
func (s *server) publishInactive(uri string) {
	if uri == "" {
		return
	}
	lines, err := search.ComputeInactiveLines(uriToPath(uri), s.defines)
	if err != nil {
		return
	}
	_ = s.notify(methodInactiveRegions, inactiveRegionsParams{URI: uri, Ranges: lineRuns(lines)})
}

// lineRuns は 1-indexed の行番号の並びを、連続する区間（0-indexed）に畳む。
func lineRuns(lines []int) []lspRange {
	out := []lspRange{}
	for i := 0; i < len(lines); {
		j := i
		for j+1 < len(lines) && lines[j+1] == lines[j]+1 {
			j++
		}
		out = append(out, lspRange{
			Start: position{Line: lines[i] - 1},
			End:   position{Line: lines[j] - 1, Character: 9999},
		})
		i = j + 1
	}
	return out
}
