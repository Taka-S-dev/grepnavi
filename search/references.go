package search

import (
	"context"
	"regexp"
	"strings"
)

// Reference は word が使われている1箇所。
//
// CallSite（呼び出し元）と違い、包含関数が特定できない箇所も落とさない。
// 構造体メンバ・グローバル変数・マクロはファイルスコープや初期化子の中で
// 参照されることが多く、それらこそ「誰が触っているか」を知りたい対象になる。
type Reference struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Text string `json:"text"`           // 参照行のソース（呼び出しか代入かを呼び出し側で判断できるように）
	Func string `json:"func,omitempty"` // 包含関数（分かる場合のみ）
}

// FindReferences は word が使われている箇所を返す。
// 戻り値の第2要素は上限で打ち切ったか、第3要素は使用したエンジン。
//
// gtags の参照インデックスがあればそれを使い、無ければ ripgrep で単語検索する。
// どちらの経路でも、コメント内・文字列内・`#if 0` 内だけの出現は除外する。
func FindReferences(ctx context.Context, word, dir string, limit int) ([]Reference, bool, string, error) {
	if limit <= 0 {
		limit = 100
	}
	if GtagsAvailable(dir) {
		refs, truncated, err := gtagsReferences(ctx, word, dir, limit)
		if err == nil && len(refs) > 0 {
			return refs, truncated, "gtags", nil
		}
	}
	refs, truncated, err := rgReferences(ctx, word, dir, limit)
	return refs, truncated, "rg", err
}

func gtagsReferences(ctx context.Context, word, dir string, limit int) ([]Reference, bool, error) {
	hits, err := GtagsFindRefs(ctx, word, dir)
	if err != nil {
		return nil, false, err
	}
	refs := make([]Reference, 0, len(hits))
	for _, h := range hits {
		if len(refs) >= limit {
			return refs, true, nil
		}
		refs = append(refs, Reference{File: h.File, Line: h.CallLine, Text: h.Text, Func: h.Func})
	}
	return refs, false, nil
}

func rgReferences(ctx context.Context, word, dir string, limit int) ([]Reference, bool, error) {
	matches, err := Search(ctx, Options{
		Pattern:       `\b` + regexp.QuoteMeta(word) + `\b`,
		Dir:           dir,
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
	refs := make([]Reference, 0, limit)
	for _, m := range matches {
		lines, lerr := CachedLines(m.File)
		if lerr != nil {
			continue
		}
		// コメント・文字列・#if 0 の中だけの出現は参照ではない
		if !code.mentionsInCode(m.File, lines, m.Line, word) {
			continue
		}
		if len(refs) >= limit {
			return refs, true, nil
		}
		fn, _ := code.containingFunc(m.File, lines, m.Line)
		refs = append(refs, Reference{
			File: m.File,
			Line: m.Line,
			Text: strings.TrimSpace(callSiteText(lines, m.Line)),
			Func: fn,
		})
	}
	return refs, false, nil
}
