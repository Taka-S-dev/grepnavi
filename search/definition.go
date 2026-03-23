package search

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"strings"
	"sync"
	"time"
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
	return FindDefinitionsN(ctx, word, dir, glob, 50)
}

// FindDefinitionsN は maxPerQuery で各クエリの上限を指定できる FindDefinitions。
//
// 実行戦略:
//   - Phase1: #define / struct / enum / typedef 系（軽量）を並列実行
//   - Phase2: func（全ソース走査）は Phase1 がゼロのときのみ実行
func FindDefinitionsN(ctx context.Context, word, dir, glob string, maxPerQuery int) ([]DefHit, error) {
	if word == "" || dir == "" {
		return nil, nil
	}

	type query struct {
		pattern string
		kind    string
	}
	esc := regexp.QuoteMeta(word)

	phase1 := []query{
		{`#\s*define\s+` + esc + `\b`, "define"},
		{`^\s*(typedef\s+)?(struct|union)\s+` + esc + `\s*(\{|$)`, "struct"},
		{`^\s*(typedef\s+)?enum\s+` + esc + `\s*(\{|$)`, "enum"},
		{`\btypedef\b.+\b` + esc + `\b\s*;`, "typedef"},
		{`^\s*\}\s*` + esc + `\s*;`, "typedef_close"},
		{`^\s+` + esc + `\b\s*[,=]`, "enum_member"},
	}
	phase2 := []query{
		{`^[^\s#/*].*\b` + esc + `\s*\(`, "func"},
	}

	runQueries := func(qs []query, baseIdx int) []DefHit {
		type partialResult struct {
			idx  int
			hits []DefHit
		}
		ch := make(chan partialResult, len(qs))
		var wg sync.WaitGroup
		for i, q := range qs {
			wg.Add(1)
			go func(idx int, q query) {
				defer wg.Done()
				if ctx.Err() != nil {
					return
				}
				opts := Options{
					Pattern:       q.pattern,
					Dir:           dir,
					FileGlob:      glob,
					Regex:         true,
					CaseSensitive: true,
					ContextLines:  -1,
					MaxResults:    maxPerQuery,
				}
				matches, err := Search(ctx, opts)
				if err != nil {
					return
				}
				var hits []DefHit
				for _, m := range matches {
					hits = append(hits, DefHit{
						File: m.File,
						Line: m.Line,
						Text: strings.TrimSpace(m.Text),
						Kind: q.kind,
					})
				}
				ch <- partialResult{baseIdx + idx, hits}
			}(i, q)
		}
		wg.Wait()
		close(ch)

		buckets := make([][]DefHit, len(qs))
		for pr := range ch {
			buckets[pr.idx-baseIdx] = pr.hits
		}
		seen := map[string]bool{}
		var results []DefHit
		for _, hits := range buckets {
			for _, h := range hits {
				key := fmt.Sprintf("%s:%d", h.File, h.Line)
				if !seen[key] {
					seen[key] = true
					results = append(results, h)
				}
			}
		}
		return results
	}

	// Phase1 実行
	t1 := time.Now()
	results := runQueries(phase1, 0)
	log.Printf("[FindDefinitionsN] word=%q phase1 hits=%d elapsed=%s", word, len(results), time.Since(t1)) // DEBUG

	// Phase1 でヒットしなかった場合のみ Phase2（func）を実行
	if len(results) == 0 && ctx.Err() == nil {
		t2 := time.Now()
		results = runQueries(phase2, len(phase1))
		log.Printf("[FindDefinitionsN] word=%q phase2(func) hits=%d elapsed=%s", word, len(results), time.Since(t2)) // DEBUG
	}

	return results, nil
}
