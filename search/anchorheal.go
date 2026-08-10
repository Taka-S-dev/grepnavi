package search

import (
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"
)

// 索引 (gtags / ctags) は作った時点のファイルを写したもので、その後の編集では
// 更新されない。行番号をそのまま使うと、目的の行から静かにずれた場所を指す。
//
// 行数を足し引きする補正は採らない。索引が編集の前に作られたのか後なのかを
// 知る必要があり、索引を作り直した後は二重補正になる。代わりに、索引が一緒に
// 覚えている行テキストと現在のファイルを突き合わせ、一致する行がちょうど1つの
// ときだけ位置を取り直す。0件でも複数件でも索引の値のまま返す
// （もっともらしく間違えるより、動かさない方を選ぶ）。
//
// この補正は「索引のヒットを現在のファイルで絞り込む処理」より前に置くこと。
// 参照・呼び出し元は、ずれた行にシンボルが無いという理由でヒットを捨てるため、
// 後から直そうとしても対象が残っていない。

// AnchorKey は行を「索引が覚えている形」に正規化する。
//
// 索引の行テキストは元の行そのものではなく、空白の連続が1つに畳まれている
// (gtags は strings.Fields で分解して連結、ctags も同様に畳む)。生の行と
// 単純比較すると、タブ揃えされた行——C では珍しくない——が常に不一致になり、
// 追従が働かないどころか、書式だけが違う双子の行に一意一致して正しい位置を壊す。
func AnchorKey(s string) string { return strings.Join(strings.Fields(s), " ") }

// UsableAnchor は「その行を言い当てられるだけの手掛かりがあるか」。
//
// ctags は行番号形式のアドレスだとパターンを持たず、行テキストがシンボル名
// そのものになる。それを手掛かりに探すと、識別子1個だけの行 (初期化子の中など)
// に一意一致して、正しい定義から引き剥がしてしまう。
func UsableAnchor(key string) bool {
	if key == "" {
		return false
	}
	return strings.IndexFunc(key, func(r rune) bool {
		return !(r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r))
	}) >= 0
}

// HealLine は file の line 行が text と食い違っているとき、text と一致する行が
// 1つだけ見つかればその行番号を返す。動かす必要が無い・動かせない場合は line を
// そのまま返す。file は絶対パスであること。
func HealLine(file string, line int, text string) int {
	key := AnchorKey(text)
	if file == "" || line < 1 || !UsableAnchor(key) {
		return line
	}
	lines, err := CachedLines(file)
	if err != nil {
		return line
	}
	return HealLineIn(lines, line, key)
}

// HealLineIn は読み込み済みの行スライスに対する HealLine。key は AnchorKey 済み。
// 呼び出し側が既にファイルを読んでいる場合に使う。
func HealLineIn(lines []string, line int, key string) int {
	if line < 1 || !UsableAnchor(key) {
		return line
	}
	if line <= len(lines) && AnchorKey(lines[line-1]) == key {
		return line // ずれていない (ファイルを直接見る rg 由来のヒットは常にここ)
	}
	to, found := 0, 0
	for i, l := range lines {
		if AnchorKey(l) != key {
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

// regatherDriftedRefs は参照インデックスの行番号が現在のファイルと合わなく
// なったファイルについて、そのファイルを走査して出現行を取り直す。
//
// 参照 (GRTAGS) には上の照合が使えない。定義インデックスと違って行テキストを
// 覚えておらず、global -x はそれを表示するとき現在のファイルから読み直すため、
// 「索引が覚えている姿」が手元に残らない（ずれていても必ず一致してしまう）。
//
// 一方で「どのファイルが参照しているか」は行番号よりはるかに壊れにくい。
// 索引より新しいファイルだけ走査し直せば、ずれたヒットが「その行にシンボルが
// 無い」という理由で後段の絞り込みに捨てられ、参照一覧から黙って消えるのを防げる。
//
// ずれているかを行の中身から当てようとしてはいけない。「その行にシンボルが
// 無ければずれ」はコメント内だけの言及を巻き込み、「行のどこかにあれば無事」は
// 呼び出しの真上のコメントに1行ぶんずれ込んだ場合を見逃す。C ではどちらも
// ありふれた形で、実際に取りこぼす。ファイルの更新時刻と索引の更新時刻の比較
// なら、どちらの誤りも起きない。
func regatherDriftedRefs(hits []DefHit, word, dir string, code codeOnlyCache) []DefHit {
	indexTime, ok := gtagsIndexModTime(dir)
	if !ok {
		return hits // 索引の時刻が読めないなら、ずれているかを判断できない
	}
	drifted := map[string]bool{}
	for _, h := range hits {
		if _, seen := drifted[h.File]; seen {
			continue
		}
		fi, err := os.Stat(h.File)
		drifted[h.File] = err == nil && fi.ModTime().After(indexTime)
	}
	any := false
	for _, d := range drifted {
		any = any || d
	}
	if !any {
		return hits
	}
	out := make([]DefHit, 0, len(hits))
	for _, h := range hits {
		if !drifted[h.File] {
			out = append(out, h)
		}
	}
	for file, isDrifted := range drifted {
		if !isDrifted {
			continue
		}
		lines, err := CachedLines(file)
		if err != nil {
			continue
		}
		found := 0
		for i, l := range code.get(file, lines) {
			if !containsWord(l, word) || definesWord(l, word) {
				continue
			}
			if found >= _regatherPerFileMax {
				slog.Warn("gtags-refs regather capped", "file", file, "word", word, "max", _regatherPerFileMax)
				break
			}
			found++
			out = append(out, DefHit{File: file, Line: i + 1, Kind: "ref"})
		}
	}
	// 走査し直したぶんを末尾に足したままにすると、そのファイルの参照だけが
	// 一覧の最後に固まる。索引が返す並び（パス順・行順）に合わせ直す。
	sort.Slice(out, func(i, j int) bool {
		if out[i].File != out[j].File {
			return out[i].File < out[j].File
		}
		return out[i].Line < out[j].Line
	})
	return out
}

// _regatherPerFileMax は1ファイルから取り直す参照の上限。
// ありふれた識別子と巨大なファイルが重なると、1回の問い合わせが
// ファイル全体の走査を何千回も呼ぶことになる。
const _regatherPerFileMax = 500

// gtagsIndexModTime は GTAGS（無ければ GRTAGS）の更新時刻を返す。
func gtagsIndexModTime(dir string) (time.Time, bool) {
	for _, name := range []string{"GRTAGS", "GTAGS"} {
		if fi, err := os.Stat(filepath.Join(dir, name)); err == nil {
			return fi.ModTime(), true
		}
	}
	return time.Time{}, false
}

// definesWord は行が word を #define しているかを返す。
//
// 走査で取り直すのは参照であって定義ではない。関数定義は包含関数が自分自身に
// なるので後段で落ちるが、関数の中に書かれたマクロ定義は落ちない。同じ関数から
// 1件しか残らない絞り込みと合わさると、定義行が本物の使用箇所を追い出す。
func definesWord(line, word string) bool {
	s := strings.TrimSpace(line)
	if !strings.HasPrefix(s, "#") {
		return false
	}
	s = strings.TrimLeft(s[1:], " \t")
	const kw = "define"
	if !strings.HasPrefix(s, kw) || len(s) == len(kw) || (s[len(kw)] != ' ' && s[len(kw)] != '\t') {
		return false
	}
	s = strings.TrimLeft(s[len(kw):], " \t")
	return strings.HasPrefix(s, word) && (len(s) == len(word) || !isIdentChar(s[len(word)]))
}

// containsWord は s に word が単語として現れるかを返す。
// 前後が識別子文字でないことまで見る（foo が foobar に当たらないように）。
func containsWord(s, word string) bool {
	if word == "" {
		return false
	}
	for i := 0; i+len(word) <= len(s); {
		j := strings.Index(s[i:], word)
		if j < 0 {
			return false
		}
		j += i
		if (j == 0 || !isIdentChar(s[j-1])) && (j+len(word) == len(s) || !isIdentChar(s[j+len(word)])) {
			return true
		}
		i = j + 1
	}
	return false
}
