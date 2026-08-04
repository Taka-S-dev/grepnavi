package api

import (
	"strings"
	"unicode"

	"grepnavi/search"
)

// 索引 (gtags / ctags) は作った時点のファイルを写したもので、その後の編集
// ——デバッグ行の挿入・外部エディタでの編集・git の切り替え——では更新されない。
// 索引が持つ行番号をそのまま返すと、目的の行から静かにずれた場所へ着地する。
//
// 行数を足し引きして補正する方法は採らない。索引が挿入の前に作られたのか後
// なのかを知る必要があり、索引を作り直した後に二重補正になる。何より grepnavi
// 以外の編集には効かない。
//
// 代わりに着地点の中身を照合する。索引は行テキストも持っているので、その行が
// 今も同じ内容かを見て、違えば一致する行を探す。ちょうど1行に絞れたときだけ
// 動かし、0件でも複数件でも索引の値のまま返す（もっともらしく間違えるより、
// 動かさない方を選ぶ）。ピンの自動追従と同じ規約。
//
// 対象は定義ジャンプだけ。参照・呼び出し元にも同じ問題があるが、そちらは
// 索引のヒットを現在のファイルで絞り込む段階（コメント内の出現を除く処理）が
// 先に走り、ずれたヒットはそこで捨てられてしまう。API 層で直しても手遅れで、
// 直すなら search 側の絞り込みより前に置く必要がある。

// anchorKey は行を「索引が覚えている形」に正規化する。
//
// 索引の行テキストは元の行そのものではなく、空白の連続が1つに畳まれている
// (gtags は strings.Fields で分解して " " で連結、ctags も同様に畳む)。
// 生の行と単純比較すると、タブ揃えされた行——C では珍しくない——が常に
// 不一致になり、追従が働かないどころか、書式だけが違う双子の行に一意一致して
// 正しい着地点を壊しうる。両側を同じ形にしてから比べる。
func anchorKey(s string) string { return strings.Join(strings.Fields(s), " ") }

// usableAnchor は「その行を言い当てられるだけの手掛かりがあるか」。
//
// ctags は行番号形式のアドレスだとパターンを持たないため、DefHit.Text が
// シンボル名そのものになる (search/ctags.go の text = word)。それを手掛かりに
// 行を探すと、初期化子の中の識別子1個だけの行などに一意一致してしまい、
// 正しい定義行から引き剥がす。識別子の文字しか無いテキストは手掛かりにしない。
func usableAnchor(key string) bool {
	if key == "" {
		return false
	}
	return strings.IndexFunc(key, func(r rune) bool {
		return !(r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r))
	}) >= 0
}

// healedLine は file の line 行が text と食い違っているとき、text と一致する
// 行が1つだけ見つかればその行番号を返す。動かす必要が無い・動かせない場合は
// line をそのまま返す。
//
// ファイルを読むが、定義の経路はコメント内の出現を除くために同じファイルを
// CachedLines で先に読んでいることが多く、その場合はキャッシュに当たる。
// ずれていなければ1行の比較で終わり、全体走査は実際にずれていたときだけ走る。
func (h *Handler) healedLine(file string, line int, text string) int {
	key := anchorKey(text)
	if file == "" || line < 1 || !usableAnchor(key) {
		return line
	}
	lines, err := search.CachedLines(h.absFromRoot(file))
	if err != nil {
		return line // ファイルが読めないなら判断材料が無い
	}
	if line <= len(lines) && anchorKey(lines[line-1]) == key {
		return line // ずれていない (ファイルを直接見る rg 由来のヒットは常にここ)
	}
	to, found := 0, 0
	for i, l := range lines {
		if anchorKey(l) != key {
			continue
		}
		found++
		if found > 1 {
			return line // 行き先を1つに絞れないので動かさない
		}
		to = i + 1
	}
	if found == 1 {
		return to
	}
	return line
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
