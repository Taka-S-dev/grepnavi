package search

import (
	"context"
	"fmt"
	"regexp"
	"strings"
)

// DefHit は定義箇所の1件。
type DefHit struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Text string `json:"text"`
	Kind string `json:"kind"` // "define" / "struct" / "enum" / "union" / "typedef"
}

// FindDefinitions は word の定義候補を ripgrep で検索して返す。
// glob が空なら全ファイルが対象。
func FindDefinitions(ctx context.Context, word, dir, glob string) ([]DefHit, error) {
	if word == "" || dir == "" {
		return nil, nil
	}

	type query struct {
		pattern string
		kind    string
	}
	esc := regexp.QuoteMeta(word)
	queries := []query{
		{`#\s*define\s+` + esc + `\b`, "define"},
		{`^\s*(typedef\s+)?(struct|union)\s+` + esc + `\s*(\{|$)`, "struct"},
		{`^\s*(typedef\s+)?enum\s+` + esc + `\s*(\{|$)`, "enum"},
		{`\btypedef\b.+\b` + esc + `\b`, "typedef"},
		{`^\s*\}\s*` + esc + `\s*;`, "typedef_close"},
		{`^[^\s#/*].*\b` + esc + `\s*\(`, "func"},
	}

	seen := map[string]bool{}
	var results []DefHit

	for _, q := range queries {
		opts := Options{
			Pattern:       q.pattern,
			Dir:           dir,
			FileGlob:      glob,
			Regex:         true,
			CaseSensitive: true,
			ContextLines:  0,
		}
		matches, err := Search(ctx, opts)
		if err != nil {
			continue
		}
		for _, m := range matches {
			key := fmt.Sprintf("%s:%d", m.File, m.Line)
			if seen[key] {
				continue
			}
			seen[key] = true
			results = append(results, DefHit{
				File: m.File,
				Line: m.Line,
				Text: strings.TrimSpace(m.Text),
				Kind: q.kind,
			})
		}
	}
	return results, nil
}
