package lsp

import (
	"regexp"
	"strings"

	"grepnavi/search"
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
	re := declRegexp(word)
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

// declarationBlock は line（1-indexed）にある宣言を、文として完結する範囲で返す。
// ctags が指す行は名前のある 1 行だけで、
//
//	enum {SSL_HRR_NONE = 0, SSL_HRR_PENDING, SSL_HRR_COMPLETE}
//	    hello_retry_request;
//
// のように型が前の行にある宣言では、その行だけを見せても型が分からない。
// 上へは文の切れ目（`;` `{` `*/` 空行 `#`）まで、`}` で終わる行は無名の
// enum / struct なので対応する `{` まで遡る。下へは `;` が出るまで（最大 12 行）。
// 読めなければ fallback（ctags の行の字面）を返す。
func declarationBlock(file string, line int, fallback string) string {
	lines, err := search.CachedLines(file)
	if err != nil || line < 1 || line > len(lines) {
		return strings.TrimSpace(fallback)
	}
	start, end := line-1, line-1
	for end < len(lines)-1 && end-(line-1) < 12 && !strings.Contains(lines[end], ";") {
		end++
	}
	for start > 0 && (line-1)-start < 12 {
		prev := strings.TrimSpace(strings.TrimSuffix(lines[start-1], "\r"))
		if prev == "" || strings.HasPrefix(prev, "#") || strings.HasSuffix(prev, ";") ||
			strings.HasSuffix(prev, "{") || strings.HasSuffix(prev, "*/") || strings.HasPrefix(prev, "//") {
			break
		}
		start--
		if strings.HasSuffix(prev, "}") {
			// 無名 enum / struct の本体: 対応する `{` の行まで含める
			depth := 0
			for start >= 0 {
				l := lines[start]
				depth += strings.Count(l, "}") - strings.Count(l, "{")
				if depth <= 0 {
					break
				}
				start--
			}
			if start < 0 {
				start = 0
			}
			// `{` だけの行なら、その上の `enum` / `struct` の行も宣言の一部
			if t := strings.TrimSpace(lines[start]); t == "{" && start > 0 {
				start--
			}
			break
		}
	}
	var b strings.Builder
	for i := start; i <= end; i++ {
		if i > start {
			b.WriteByte('\n')
		}
		b.WriteString(strings.TrimRight(lines[i], "\r"))
	}
	return dedent(b.String())
}

// dedent は共通の先頭空白を落とす（ホバーの中で左に寄せる）。
func dedent(s string) string {
	lines := strings.Split(s, "\n")
	indent := -1
	for _, l := range lines {
		if strings.TrimSpace(l) == "" {
			continue
		}
		n := len(l) - len(strings.TrimLeft(l, " \t"))
		if indent < 0 || n < indent {
			indent = n
		}
	}
	if indent <= 0 {
		return s
	}
	for i, l := range lines {
		if len(l) >= indent {
			lines[i] = l[indent:]
		}
	}
	return strings.Join(lines, "\n")
}

// declRegexp は word の宣言の形に当たる正規表現。第 1 群は型の語。
//
//	T *word;              型名の直後
//	T *a, *word;          宣言子の並びの 2 つ目以降（`SSL3_RECORD *rr, *thisrr;`）
//	T a = 0, b[4], word;  初期化子や添字を挟んでも同じ
//
// 並びの形は「型名 + 識別子」で始まることを要求するので、関数呼び出しの引数
// `f(a, word)` やカンマ演算子には当たらない。
func declRegexp(word string) *regexp.Regexp {
	w := regexp.QuoteMeta(word)
	declarator := `[A-Za-z_]\w*(?:\s*\[[^\]]*\])*(?:\s*=\s*[^,;]+)?`
	// 型と宣言子の間には空白か * が要る。無いと `SSL_AD_RECORD_OVERFLOW, word` を
	// `SSL_AD_RECORD_OVERFLO` + `W` に切って宣言と読んでしまう
	return regexp.MustCompile(
		`\b([A-Za-z_]\w*)(?:\s+\**\s*|\s*\*+\s*)` +
			`(?:` + declarator + `(?:\s*,\s*\**\s*` + declarator + `)*\s*,\s*\**\s*)?` +
			`\b` + w + `\b\s*[;,=)\[]`)
}
