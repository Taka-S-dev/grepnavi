package search

// プロジェクト全体のシンボル名検索
//
// tags ファイルのシンボル名フィールドに対して正規表現マッチを行う。
// 「正確な識別子名を知らない」状態から候補を絞り込むための機能で、
// 名前が確定したら CtagsFindDefinitions / gtags に引き継ぐ想定。

import (
	"bufio"
	"context"
	"grepnavi/proc"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// CtagsSearchSymbolNames は tags ファイルからシンボル名が pattern（正規表現）に
// マッチする定義を返す。kind が非空ならその kind（"func" 等、ctagsKindToKind 後の値）に限定する。
// pathFilter は空白区切りの部分一致（大文字小文字・区切り文字の向きは不問）で、
// "-" 始まりは除外条件。limit 件を超えた場合は打ち切り、truncated=true を返す。
//
// rg はパス等にマッチした行も拾うため行レベルの粗いフィルタとして使い、
// 名前フィールドだけを Go 側の正規表現で検証する2段構え。
func CtagsSearchSymbolNames(ctx context.Context, pattern, dir, kind string, caseSensitive bool, limit int, pathFilter string) (hits []DefHit, truncated bool, err error) {
	matchPath := buildPathFilter(pathFilter)
	tagsPath := filepath.Join(dir, "tags")
	rePattern := pattern
	if !caseSensitive {
		rePattern = "(?i)" + rePattern
	}
	re, err := regexp.Compile(rePattern)
	if err != nil {
		return nil, false, err
	}

	// 必要件数が集まり次第 cancel して rg を止める（tags は数百 MB になりうる）
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	rgArgs := []string{"--no-line-number", "--no-filename", "--no-heading", "--color=never"}
	if !caseSensitive {
		rgArgs = append(rgArgs, "-i")
	}
	rgArgs = append(rgArgs, "--", pattern, tagsPath)
	cmd := proc.CommandContext(ctx, "rg", rgArgs...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, false, err
	}
	if err := cmd.Start(); err != nil {
		return nil, false, err
	}

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 256*1024), 256*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" || strings.HasPrefix(line, "!") {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) < 3 || !re.MatchString(fields[0]) {
			continue
		}
		h := ctagsParseLine(line, fields[0], dir)
		if h == nil || (kind != "" && h.Kind != kind) {
			continue
		}
		if !matchPath(h.File) {
			continue
		}
		hits = append(hits, *h)
		if limit > 0 && len(hits) > limit {
			truncated = true
			hits = hits[:limit]
			cancel()
			break
		}
	}

	// cancel による kill は正常系。それ以外も exit 1 (no match) があるので
	// scanner がエラーなく読めていれば Wait のエラーは無視してよい。
	_ = cmd.Wait()
	if ctx.Err() == nil && scanner.Err() != nil {
		return nil, false, scanner.Err()
	}

	sortSymbolNameHits(hits, pattern)
	return hits, truncated, nil
}

// sortSymbolNameHits は完全一致 > kind (func > define > typedef > その他) > 名前順 で並べる。
// AI クライアントが先頭から読んで早期に当たりを引けるようにするための正規化。
func sortSymbolNameHits(hits []DefHit, pattern string) {
	kindRank := func(k string) int {
		switch k {
		case "func":
			return 3
		case "define":
			return 2
		case "typedef":
			return 1
		}
		return 0
	}
	sort.SliceStable(hits, func(i, j int) bool {
		ei, ej := strings.EqualFold(hits[i].Name, pattern), strings.EqualFold(hits[j].Name, pattern)
		if ei != ej {
			return ei
		}
		ri, rj := kindRank(hits[i].Kind), kindRank(hits[j].Kind)
		if ri != rj {
			return ri > rj
		}
		return hits[i].Name < hits[j].Name
	})
}

// buildPathFilter は空白区切りのパス条件を判定関数へまとめる。
// 各条件は "|" 区切りの選択肢（いずれか一致で真）で、"-" 始まりは条件全体の除外。
// 選択肢の解釈は3通り: "*" か "?" を含めば glob（"/" を含まなければファイル名に、
// 含めば全体に適用）、"." 始まりで "/" を含まなければ拡張子（末尾一致 —— 部分一致だと
// ".c" が ".cpp" にも当たってしまう）、それ以外は部分一致。
// 比較前に区切りをスラッシュへ・小文字へ正規化する（tags の記録形式に依存しない）。
func buildPathFilter(filter string) func(string) bool {
	type term struct {
		alts    []string
		exclude bool
	}
	var terms []term
	for _, raw := range strings.Fields(filter) {
		t := term{}
		if strings.HasPrefix(raw, "-") {
			t.exclude = true
			raw = raw[1:]
		}
		for _, alt := range strings.Split(raw, "|") {
			alt = strings.ToLower(strings.ReplaceAll(alt, "\\", "/"))
			if alt != "" {
				t.alts = append(t.alts, alt)
			}
		}
		if len(t.alts) > 0 {
			terms = append(terms, t)
		}
	}
	if len(terms) == 0 {
		return func(string) bool { return true }
	}
	matchAlt := func(f, alt string) bool {
		switch {
		case strings.ContainsAny(alt, "*?"):
			target := f
			if !strings.Contains(alt, "/") {
				target = path.Base(f)
			}
			ok, err := path.Match(alt, target)
			return err == nil && ok
		case strings.HasPrefix(alt, ".") && !strings.Contains(alt, "/"):
			return strings.HasSuffix(f, alt)
		default:
			return strings.Contains(f, alt)
		}
	}
	return func(file string) bool {
		f := strings.ToLower(strings.ReplaceAll(file, "\\", "/"))
		for _, t := range terms {
			hit := false
			for _, alt := range t.alts {
				if matchAlt(f, alt) {
					hit = true
					break
				}
			}
			if hit == t.exclude {
				return false
			}
		}
		return true
	}
}
