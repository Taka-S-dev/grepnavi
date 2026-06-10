package search

// プロジェクト全体のシンボル名検索
//
// tags ファイルのシンボル名フィールドに対して正規表現マッチを行う。
// 「正確な識別子名を知らない」状態から候補を絞り込むための機能で、
// 名前が確定したら CtagsFindDefinitions / gtags に引き継ぐ想定。

import (
	"bufio"
	"context"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// CtagsSearchSymbolNames は tags ファイルからシンボル名が pattern（正規表現）に
// マッチする定義を返す。kind が非空ならその kind（"func" 等、ctagsKindToKind 後の値）に限定する。
// limit 件を超えた場合は打ち切り、truncated=true を返す。
//
// rg はパス等にマッチした行も拾うため行レベルの粗いフィルタとして使い、
// 名前フィールドだけを Go 側の正規表現で検証する2段構え。
func CtagsSearchSymbolNames(ctx context.Context, pattern, dir, kind string, caseSensitive bool, limit int) (hits []DefHit, truncated bool, err error) {
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
	cmd := exec.CommandContext(ctx, "rg", rgArgs...)
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
		h := ctagsParseFields(fields, fields[0], dir)
		if h == nil || (kind != "" && h.Kind != kind) {
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
		ei, ej := strings.EqualFold(hits[i].Text, pattern), strings.EqualFold(hits[j].Text, pattern)
		if ei != ej {
			return ei
		}
		ri, rj := kindRank(hits[i].Kind), kindRank(hits[j].Kind)
		if ri != rj {
			return ri > rj
		}
		return hits[i].Text < hits[j].Text
	})
}
