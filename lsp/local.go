package lsp

import (
	"regexp"
	"strings"
)

// localDeclaration は pos を含む関数の中で word が宣言されている行を返す
// （0-indexed の行番号と、その行の字面）。引数の宣言も本体の宣言も対象。
// 見つかったら、ホバーと定義ジャンプはツリー全体の同名シンボルを引かない:
// ssl3_get_record の `version` にホバーして crypto/ec の `int32_t version;` が
// 13 件出るのは、字面上ここに宣言があるのに索引を見に行くから。
//
// 宣言の形は「型名（識別子）+ 任意の * + word + `;` `,` `=` `)` `[`」。
// `return s;` や `x = s;` は直前が識別子でないか予約語なので当たらない。
// 同じ名前が入れ子ブロックで再宣言されていても、カーソル以前の最後の宣言を取る。
func localDeclaration(content string, pos position, word string) (int, string, bool) {
	// `s->version` の version はメンバ。同名のローカルがあっても別物
	if memberAccessAt(content, pos) {
		return 0, "", false
	}
	lines := strings.Split(content, "\n")
	fr, ok := enclosingFuncRange(lines, pos.Line+1)
	if !ok {
		return 0, "", false
	}
	masked := maskNonCode(lines[fr.Start-1 : fr.End])
	re := regexp.MustCompile(`([A-Za-z_]\w*)\s*\**\s*\b` + regexp.QuoteMeta(word) + `\b\s*[;,=)\[]`)
	found := -1
	for i, l := range masked {
		abs := fr.Start - 1 + i
		if abs > pos.Line && found >= 0 {
			break
		}
		for _, m := range re.FindAllStringSubmatch(l, -1) {
			if !cKeywords[m[1]] || isTypeKeyword(m[1]) {
				found = abs
				break
			}
		}
	}
	if found < 0 {
		return 0, "", false
	}
	return found, strings.TrimSpace(strings.TrimSuffix(lines[found], "\r")), true
}
