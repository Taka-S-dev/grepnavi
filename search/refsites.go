package search

import (
	"context"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// RefQuery は「word はどこで使われているか」の問い合わせ。
//
// 参照一覧と呼び出し元一覧は同じ索引を引くが、要求が違う。参照は使われている
// 箇所をすべて知りたい。呼び出し元は「どの関数から」を知りたいので、囲む関数が
// 特定できる箇所だけを関数ごとに1件へまとめる。
//
// 以前はこの2つが別々に索引と ripgrep を呼び、フォールバックの条件も絞り込みの
// 適用範囲も食い違っていた。囲む関数の解決が壊れたとき、片方は黙って
// ripgrep へ降格して成立し、片方は 0 件になる、という形で症状が分かれた。
type RefQuery struct {
	Word  string
	Root  string // 索引を引く位置（プロジェクトルート）
	Scope string // 結果を絞る範囲。空ならルート全体
	Glob  string // 含めるファイル。空なら全部
	Limit int
	// Filter は絞り込み条件。空白区切りで AND、先頭の - は除外、
	// path: / file: はパスだけに掛かる（grep の絞り込みバーと同じ語彙）。
	Filter string
	// CallersOnly は呼び出し元一覧用。囲む関数が要る＆関数ごとに1件へまとめる。
	CallersOnly bool
	// AssignOnly はその語へ書き込んでいる行だけに絞る。
	AssignOnly bool
	// NoIndex は索引を使わず ripgrep だけで引く（利用者が明示的に指定したとき）。
	NoIndex bool
}

// FindRefSites は索引で引き、答えられなければ ripgrep に落ちる。
// 第2戻り値はどちらが答えたか、第3戻り値は上限で打ち切ったか。
func FindRefSites(ctx context.Context, q RefQuery) ([]CallSite, string, bool, error) {
	if q.Limit <= 0 {
		q.Limit = 100
	}
	if q.Scope == "" {
		q.Scope = q.Root
	}
	if !q.NoIndex && GtagsAvailable(q.Root) {
		hits, err := gtagsRawRefs(ctx, q.Word, q.Root)
		if err == nil && len(hits) > 0 {
			// 絞り込みと上限は解決の前に掛ける。解決はヒットのあるファイルを
			// 読む処理なので、後ろに置くと索引が返した全件ぶん働いてしまう。
			// 先に掛ければ、絞り込みは索引が返した全件に届く（手元だけで絞ると
			// 取ってこなかった範囲は出てこない）。
			hits = filterRawRefs(hits, q.Scope, q.Glob, parseRefFilter(q.Filter))
			// 代入だけに絞るのも予算で切る前に済ませる。切ってから絞ると、
			// 先頭が読み出しで埋まっている語で「0 件・打ち切りあり」が返る
			// （openssl の hand_state で実際に起きた。代入は数百件あるのに、
			// 索引順で先頭 200 件が switch の比較で埋まっていた）
			if q.AssignOnly {
				hits = keepAssignRaw(hits, q.Word)
			}
			budget := q.Limit * 2
			if q.CallersOnly {
				budget = q.Limit * 20 // 関数ごとに1件へ畳むぶんの余裕
			}
			cut := false
			if len(hits) > budget {
				hits, cut = hits[:budget], true
			}
			sites := ResolveRefSites(hits, q.Word)
			if q.CallersOnly {
				sites = keepCallers(sites, q.Word)
			}
			MarkIndirectCalls(sites, q.Word)
			MarkAssignments(sites, q.Word)

			// 呼び出し元は 0 件でも索引の答えとして返す（0 件 = 呼び出し元
			// なし）。参照一覧は従来どおり rg へ落ちる — 索引対象外の
			// ファイル種別からの参照がありえるのは、任意の行を拾う参照の側。
			if len(sites) > 0 || q.CallersOnly {
				sites, truncated := capSites(sites, q.Limit)
				return sites, "gtags", truncated || cut, nil
			}
		}
	}

	// 索引が無い・引けない場合だけ ripgrep へ降格する。「索引は参照を返したが
	// 呼び出し元の形に整えると 0 件」は降格しない — 索引の参照は全量なので、
	// rg の再走査が足せるのは索引対象外ファイルの分だけで、実測ではそこに
	// 生成 HTML の誤パースが混ざった。0 件は「呼び出し元なし」という答え。
	if q.CallersOnly {
		sites, truncated, err := FindCallers(ctx, q.Word, q.Scope, q.Glob)
		return sites, "rg", truncated, err
	}
	sites, truncated, err := rgRefSites(ctx, q.Word, q.Scope, q.Glob, q.Limit,
		parseRefFilter(q.Filter), q.AssignOnly)
	return sites, "rg", truncated, err
}

// keepAssignRaw は解決前の生ヒットを「その語へ書き込んでいる行」だけに削る。
// 判定はコメント・文字列を落とした行で行う（生の行だと `printf("x = %d")` の
// 書式文字列が代入に見える）。読めないファイルは判定できないので残す
// ＝ 後段の解決で改めて判定される。
func keepAssignRaw(hits []DefHit, word string) []DefHit {
	re := assignMatcher(word)
	code := codeOnlyCache{}
	out := hits[:0:0]
	for _, h := range hits {
		text := h.Text
		if lines, err := CachedLines(h.File); err == nil {
			text = codeLineAt(code, h.File, lines, h.Line, h.Text)
		}
		if re.MatchString(text) {
			out = append(out, h)
		}
	}
	return out
}

// keepCallers は呼び出し元一覧の形に整える。同じ関数からの複数の参照を1件に
// まとめ、自分自身への参照とプロトタイプ宣言を除く。
//
// 囲む関数が無い（ファイルスコープの）参照は、宣言でなければ「登録箇所」として
// 残す。関数ポインタのテーブルで登録される関数（メソッドテーブル・ops 構造体）は
// 参照がテーブルの初期化子と宣言しか無く、以前はここで全滅して ripgrep の全木
// 走査へ降格していた（実測: openssl の ssl3_read_bytes で 46ms → 1.85s、しかも
// rg が返したのは doxygen 生成 HTML を誤パースした偽の呼び出し元だった）。
// 登録箇所こそが「誰が呼ぶのか」への答えで、索引はそれを最初から持っている。
func keepCallers(sites []CallSite, word string) []CallSite {
	// 宣言らしさは「語の直後に ( 」で見る。テーブルの登録は `ssl3_read_bytes,`
	// のように ( を伴わないので、この判定で宣言だけが落ちる。
	reDecl := regexp.MustCompile(`\b` + regexp.QuoteMeta(word) + `\s*\(`)
	out := sites[:0:0]
	seen := map[string]bool{}
	for _, s := range sites {
		if s.Func == word {
			continue
		}
		key := s.File + ":" + s.Func
		if s.Func == "" {
			if reDecl.MatchString(s.Text) {
				continue // 関数の外で 語( の形 = プロトタイプ宣言・定義行
			}
			// 登録箇所は場所そのものが情報なので、行ごとに残す
			// （同じファイルに別のテーブルが並ぶことがある）
			key = s.File + ":" + strconv.Itoa(s.CallLine)
			// ジャンプ先は登録の行。関数の開始行は無い
			s.Line = s.CallLine
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, s)
	}
	return out
}

// refTerm は絞り込み条件1つぶん。
type refTerm struct {
	neg      bool
	pathOnly bool
	text     string
}

// parseRefFilter は絞り込み文字列を条件に分ける。語彙は grep の絞り込みバー・
// シンボルパネル・参照ピッカーの入力欄で共通にしてある。
func parseRefFilter(q string) []refTerm {
	var terms []refTerm
	for _, tok := range strings.Fields(q) {
		neg := strings.HasPrefix(tok, "-")
		body := strings.TrimPrefix(tok, "-")
		pathOnly := false
		for _, p := range []string{"path:", "file:"} {
			if len(body) > len(p) && strings.EqualFold(body[:len(p)], p) {
				body, pathOnly = body[len(p):], true
				break
			}
		}
		if body != "" {
			terms = append(terms, refTerm{neg: neg, pathOnly: pathOnly, text: strings.ToLower(body)})
		}
	}
	return terms
}

// filterRawRefs は解決前の生ヒットを、パス・glob・絞り込み条件で削る。
// 囲む関数はまだ分からないので、条件はパスとソース行に掛かる。
func filterRawRefs(hits []DefHit, scope, glob string, terms []refTerm) []DefHit {
	globs := splitGlobs(glob)
	scopePrefix := ""
	if scope != "" {
		scopePrefix = strings.ToLower(filepath.ToSlash(filepath.Clean(scope)))
		if !strings.HasSuffix(scopePrefix, "/") {
			scopePrefix += "/"
		}
	}
	out := hits[:0:0]
next:
	for _, h := range hits {
		path := strings.ToLower(filepath.ToSlash(filepath.Clean(h.File)))
		if scopePrefix != "" && !strings.HasPrefix(path, scopePrefix) {
			continue
		}
		if len(globs) > 0 && !matchesAnyGlob(filepath.Base(h.File), globs) {
			continue
		}
		both := path + " " + strings.ToLower(h.Text)
		for _, t := range terms {
			hay := both
			if t.pathOnly {
				hay = path
			}
			if strings.Contains(hay, t.text) == t.neg {
				continue next
			}
		}
		out = append(out, h)
	}
	return out
}

// matchesTerms は1件が絞り込み条件を満たすかを返す。
// 上限で切る前に1件ずつ判定するため、一覧まとめてではなく1件単位で持つ。
func matchesTerms(s CallSite, terms []refTerm) bool {
	path := strings.ToLower(filepath.ToSlash(filepath.Clean(s.File)))
	all := path + " " + strings.ToLower(s.Func) + " " + strings.ToLower(s.Text)
	for _, t := range terms {
		hay := all
		if t.pathOnly {
			hay = path
		}
		if strings.Contains(hay, t.text) == t.neg {
			return false
		}
	}
	return true
}

func capSites(sites []CallSite, limit int) ([]CallSite, bool) {
	if len(sites) <= limit {
		return sites, false
	}
	return sites[:limit], true
}

// rgRefSites は索引が使えないときの経路。terms / assignOnly は上限で切る前に
// 掛ける。切ってから絞ると、絞り込みは「先頭 limit 件」の中しか見られない。
// gtags 経路は既にこの順序になっている。
//
// パスでの絞り込みはこれだけでは足りず、rg 自身にも渡す必要がある（下記）。
func rgRefSites(ctx context.Context, word, dir, glob string, limit int, terms []refTerm, assignOnly bool) ([]CallSite, bool, error) {
	matches, err := Search(ctx, Options{
		Pattern: `\b` + regexp.QuoteMeta(word) + `\b`,
		Dir:     dir,
		// path: 条件は rg 自身に渡す。走査してから捨てると、上限に達するまでに
		// 対象へ届かない（linux の ret を path:net/ipv4 で引くと、上限を arch/ と
		// block/ で使い切って net/ に一度も入らず 0 件になった）
		FileGlob:      joinGlobs(glob, pathGlobs(terms)),
		Regex:         true,
		CaseSensitive: true,
		ContextLines:  -1,
		// コメント除外と絞り込みで減るぶんを見込む。絞り込みがあるときは
		// 手前で大きく削られるので、素材を多めに取る
		MaxResults: rgRefBudget(limit, len(terms) > 0 || assignOnly),
		MaxThreads: _defRgThreads,
	})
	if err != nil {
		return nil, false, err
	}
	code := codeOnlyCache{}
	assignRe := assignMatcher(word)
	sites := make([]CallSite, 0, limit)
	for _, m := range matches {
		lines, lerr := CachedLines(m.File)
		if lerr != nil {
			continue
		}
		// コメント・文字列・#if 0 の中だけの出現は参照ではない
		if !code.mentionsInCode(m.File, lines, m.Line, word) {
			continue
		}
		fn, defLine := code.containingFunc(m.File, lines, m.Line)
		site := CallSite{
			Func:     fn,
			File:     m.File,
			Line:     defLine,
			CallLine: m.Line,
			Text:     strings.TrimSpace(callSiteText(lines, m.Line)),
		}
		if len(terms) > 0 && !matchesTerms(site, terms) {
			continue
		}
		// 代入の印はここで付ける。上限に達した経路で後からまとめて付けると、
		// 早期 return がそれを飛ばして、打ち切られた一覧だけ印が消える
		site.Assign = assignRe.MatchString(codeLineAt(code, m.File, lines, m.Line, site.Text))
		if assignOnly && !site.Assign {
			continue
		}
		if len(sites) >= limit {
			MarkIndirectCalls(sites, word)
			return sites, true, nil
		}
		sites = append(sites, site)
	}
	MarkIndirectCalls(sites, word)
	return sites, false, nil
}

// pathGlobs は path: / file: の肯定条件を rg の --glob へ写す。
// 否定条件は渡さない（除外は行の字面にも掛かるので、パスだけを見る rg 側へ
// 渡すと意味が変わる）。
func pathGlobs(terms []refTerm) []string {
	var out []string
	for _, t := range terms {
		if t.pathOnly && !t.neg && t.text != "" {
			out = append(out, "**/*"+t.text+"*/**", "**/*"+t.text+"*")
		}
	}
	return out
}

// joinGlobs は既存の glob 指定に条件を足す。区切りは splitGlobs と同じ。
func joinGlobs(glob string, extra []string) string {
	if len(extra) == 0 {
		return glob
	}
	return strings.Join(append(splitGlobs(glob), extra...), ",")
}

// codeLineAt はコメント・文字列を落とした側の行を返す（取れなければ生の行）。
// 代入判定を生の行で行うと、`printf("x = %d")` の書式文字列が代入に見える。
func codeLineAt(code codeOnlyCache, file string, lines []string, line int, raw string) string {
	c := code.get(file, lines)
	if line >= 1 && line <= len(c) {
		return c[line-1]
	}
	return raw
}

// rgRefBudget は rg に要求する件数。絞り込みがあると手前で大きく削られるので、
// 素材を多めに取る。青天井にすると巨大ツリーで走査自体が終わらない。
func rgRefBudget(limit int, filtered bool) int {
	if filtered {
		if n := limit * 60; n < 20000 {
			return n
		}
		return 20000
	}
	return limit * 3
}
