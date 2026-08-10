package search

import (
	"context"
	"path/filepath"
	"regexp"
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
			if q.AssignOnly {
				sites = keepAssignments(sites)
			}
			if len(sites) > 0 {
				sites, truncated := capSites(sites, q.Limit)
				return sites, "gtags", truncated || cut, nil
			}
		}
	}

	// 索引が無い・答えられない場合。索引が拾わないファイル種別からの参照も
	// あり得るので、0 件でもここまで来る
	if q.CallersOnly {
		sites, truncated, err := FindCallers(ctx, q.Word, q.Scope, q.Glob)
		return sites, "rg", truncated, err
	}
	sites, truncated, err := rgRefSites(ctx, q.Word, q.Scope, q.Glob, q.Limit)
	if terms := parseRefFilter(q.Filter); len(terms) > 0 {
		sites = filterResolved(sites, terms)
	}
	if q.AssignOnly {
		sites = keepAssignments(sites)
	}
	return sites, "rg", truncated, err
}

// keepCallers は呼び出し元一覧の形に整える。囲む関数が分からない箇所を落とし、
// 同じ関数からの複数の参照を1件にまとめ、自分自身への参照を除く。
func keepCallers(sites []CallSite, word string) []CallSite {
	out := sites[:0:0]
	seen := map[string]bool{}
	for _, s := range sites {
		if s.Func == "" || s.Func == word {
			continue
		}
		key := s.File + ":" + s.Func
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

// filterResolved は解決済みの結果に同じ条件を掛ける（ripgrep 経路用）。
// 囲む関数も対象に含められる点だけ生ヒット側と違う。
func filterResolved(sites []CallSite, terms []refTerm) []CallSite {
	out := sites[:0:0]
next:
	for _, s := range sites {
		path := strings.ToLower(filepath.ToSlash(filepath.Clean(s.File)))
		all := path + " " + strings.ToLower(s.Func) + " " + strings.ToLower(s.Text)
		for _, t := range terms {
			hay := all
			if t.pathOnly {
				hay = path
			}
			if strings.Contains(hay, t.text) == t.neg {
				continue next
			}
		}
		out = append(out, s)
	}
	return out
}

func keepAssignments(sites []CallSite) []CallSite {
	out := sites[:0:0]
	for _, s := range sites {
		if s.Assign {
			out = append(out, s)
		}
	}
	return out
}

func capSites(sites []CallSite, limit int) ([]CallSite, bool) {
	if len(sites) <= limit {
		return sites, false
	}
	return sites[:limit], true
}

func rgRefSites(ctx context.Context, word, dir, glob string, limit int) ([]CallSite, bool, error) {
	matches, err := Search(ctx, Options{
		Pattern:       `\b` + regexp.QuoteMeta(word) + `\b`,
		Dir:           dir,
		FileGlob:      glob,
		Regex:         true,
		CaseSensitive: true,
		ContextLines:  -1,
		MaxResults:    limit * 3, // コメント除外で減るぶんを見込む
		MaxThreads:    _defRgThreads,
	})
	if err != nil {
		return nil, false, err
	}
	code := codeOnlyCache{}
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
		if len(sites) >= limit {
			return sites, true, nil
		}
		fn, defLine := code.containingFunc(m.File, lines, m.Line)
		sites = append(sites, CallSite{
			Func:     fn,
			File:     m.File,
			Line:     defLine,
			CallLine: m.Line,
			Text:     strings.TrimSpace(callSiteText(lines, m.Line)),
		})
	}
	MarkIndirectCalls(sites, word)
	MarkAssignments(sites, word)
	return sites, false, nil
}
