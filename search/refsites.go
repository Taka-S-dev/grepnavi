package search

import (
	"context"
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
		sites, err := gtagsRefSites(ctx, q.Word, q.Root)
		if err == nil {
			sites = FilterCallSites(sites, q.Scope, q.Glob)
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
				return sites, "gtags", truncated, nil
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
