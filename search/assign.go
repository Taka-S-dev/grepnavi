package search

import (
	"regexp"
	"strings"
)

// MarkAssignments は参照のうち「その語へ書き込んでいる行」に印を付ける。
//
// 「この変数を誰が書き換えているか」はデバッグで最も多い問いだが、参照一覧では
// 読み出しに埋もれる。`s->state` の参照が 200 件あっても、知りたいのは代入して
// いる数件だけ、ということが起きる。
//
// 判定するのは行の字面だけで、値の流れは追わない。どの値が入るか・どこから
// 来たかを推定すると、条件分岐や fall-through の解釈を誤ったときに黙って
// 嘘をつく。ここでは「書いている行かどうか」しか答えない。
func MarkAssignments(sites []CallSite, word string) {
	re := assignMatcher(word)

	// 判定はコメント・文字列を落とした行で行う。生の行を見ると
	// `TEST_info("nid = %s", ...)` の書式文字列が代入に見える
	code := codeOnlyCache{}
	for i := range sites {
		text := sites[i].Text
		if lines, err := CachedLines(sites[i].File); err == nil {
			c := code.get(sites[i].File, lines)
			if n := sites[i].CallLine; n >= 1 && n <= len(c) {
				text = c[n-1]
			}
		}
		sites[i].Assign = re.MatchString(text)
	}
}

// assignMatcher は「その語へ書き込む行か」を判定する検査器を1つ組む。
// 語ごとに1回だけ組めるよう切り出してある（1行ずつ判定する呼び出し側が、
// 行の数だけ正規表現を組み直さずに済む）。
//
// 名前が構造体メンバか同名のローカルかは、その行だけでは決まらない。
// 「ファイル内にメンバ形が一度でも出たら裸の代入を無視する」という規則を
// 置いていたが、`curves[n].nid` が1行あるだけで同じファイルのローカル
// `nid = NID_...` が全部消えた（openssl の ecparam.c で30件）。
// ファイル全体を見て決めるのは推論であり、外したときに黙って取りこぼす。
// どちらの名前への書き込みも出し、区別は行の字面を見た人に任せる。
func assignMatcher(word string) *regexp.Regexp {
	return assignRe(regexp.QuoteMeta(word), `(?:(?:->|\.)\s*)?`)
}

// assignRe は「その語へ書き込む」形にマッチする正規表現を組む。
// 単純代入・複合代入・前後の ++ / -- を見る。`==` や `<=` は等値比較なので外す
// （`=` の直前が語か空白のときしか通らないので、`!=` `<=` `>=` は自然に外れる）。
func assignRe(quotedWord, prefix string) *regexp.Regexp {
	w := prefix + `\b` + quotedWord + `\b`
	return regexp.MustCompile(strings.Join([]string{
		w + `\s*(?:\+|-|\*|/|%|&|\||\^|<<|>>)?=(?:[^=]|$)`, // x = / x += ...
		w + `\s*(?:\+\+|--)`, // x++ / x--
		// `++x` は x への書き込みだが、`++p->n` が増やすのは n なので、
		// 語のあとにメンバ参照や添字が続く形は除く
		`(?:\+\+|--)\s*` + w + `(?:[^A-Za-z0-9_.\[-]|$)`, // ++x / --x
	}, "|"))
}
