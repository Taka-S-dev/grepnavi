package api

import (
	"net/http"
	"strconv"

	"grepnavi/search"
)

// 索引のずれを行の内容で直す規約は search/anchorheal.go にある。定義ジャンプだけ
// は検索層へ寄せずここで直す。定義の結果は検索層でキャッシュされるため、そこで
// 直すと「直した当時の位置」が残り、その後の編集でまた古くなる。応答のたびに
// 直せば現在のファイルに必ず追従する。

// healedLine は file の line 行が text と食い違っているとき、text と一致する
// 行が1つだけ見つかればその行番号を返す。file は絶対・ルート相対のどちらでもよい。
func (h *Handler) healedLine(file string, line int, text string) int {
	if file == "" {
		return line
	}
	return search.HealLine(h.absFromRoot(file), line, text)
}

// handleHealLine は「索引が覚えている file:line とその行テキスト」を受け取り、
// 現在のファイルでの行番号を返す。
//
// シンボル名検索 (Ctrl+T) の一覧はそのまま file:line へ飛ぶが、一覧の全件を
// サーバー側で直すのは高すぎる。キーを打つたびに最大100件ぶんのファイルを
// 読み直すことになるためで、実際に飛ぶ1件だけを選択時に直す。
func (h *Handler) handleHealLine(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	line, err := strconv.Atoi(q.Get("line"))
	if err != nil || line < 1 {
		jsonErr(w, "line must be a positive integer", http.StatusBadRequest)
		return
	}
	abs, ok := h.resolveWithinRoot(q.Get("file"))
	if !ok {
		jsonErr(w, "file outside root", http.StatusForbidden)
		return
	}
	to := search.HealLine(abs, line, q.Get("text"))
	jsonOK(w, map[string]any{"line": to, "healed": to != line})
}

// healDefHits は定義ヒットの着地点を現在のファイルに合わせる。
// 呼び出し側は複製を渡すこと (ヒットの実体は検索層のキャッシュと共有されうる)。
func (h *Handler) healDefHits(hits []search.DefHit) []search.DefHit {
	for i := range hits {
		to := h.healedLine(hits[i].File, hits[i].Line, hits[i].Text)
		if to != hits[i].Line {
			hits[i].Line = to
			hits[i].Healed = true
		}
	}
	return hits
}
