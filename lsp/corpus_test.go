package lsp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"grepnavi/search"
)

// 実物のツリーで、どのツリーでも成り立つべき不変条件を確かめる。
//
//	GREPNAVI_CORPUS=C:\path\to\some-c-tree go test ./lsp/ -run Corpus -v
//
// 手書きのフィクスチャは思いついた形しか守れない。ローカル変数が索引のメンバに
// 化ける、`SSL_AD_RECORD_OVERFLO`+`W` の誤宣言、メンバ呼び出しが同名関数へ飛ぶ、は
// いずれも実ツリーでのみ現れた種類なので、同じ種類を先に捕まえる。
//
// 見るもの（関数ごと、ファイルは先頭から最大 corpusFiles 本）:
//   - シグネチャの引数 `T *name` にホバーすると local で、その関数の行を指す
//   - 引数のハイライトは関数の範囲から出ない
//   - `x->name(` / `x.name` のメンバに F12 しても `name(` の関数定義行には着地しない
//   - キーワードの F12 は空で 1 秒未満
func TestCorpusEditorAnswers(t *testing.T) {
	root := os.Getenv("GREPNAVI_CORPUS")
	if root == "" {
		t.Skip("GREPNAVI_CORPUS 未設定")
	}
	const corpusFiles = 100
	s := &server{root: root}
	init, _ := json.Marshal(map[string]string{"rootUri": pathToURI(root)})
	s.handleInitialize(init)
	defer search.SetExcludes("", nil)

	reParam := regexp.MustCompile(`\b([A-Za-z_]\w*)\s*\*+\s*([A-Za-z_]\w*)\s*[,)]`)
	reMember := regexp.MustCompile(`\b[A-Za-z_]\w*(?:->|\.)([A-Za-z_]\w*)\s*\(`)
	var files []string
	filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() && strings.HasSuffix(p, ".c") && len(files) < corpusFiles {
			files = append(files, p)
		}
		return nil
	})
	checked := map[string]int{}
	var bad []string
	report := func(kind, msg string) {
		checked[kind]++
		if msg != "" && len(bad) < 40 {
			bad = append(bad, kind+": "+msg)
		}
	}
	ctx := context.Background()
	for _, f := range files {
		content, ok := s.documentText(pathToURI(f))
		if !ok {
			continue
		}
		lines := strings.Split(content, "\n")
		uri := pathToURI(f)
		for _, fr := range search.FunctionRanges(lines) {
			if fr.End-fr.Start < 3 || fr.End-fr.Start > 400 {
				continue
			}
			sig := lines[fr.Start-1]
			// 関数の範囲をまとめて塗る: 1 行ずつでは複数行コメントの中を見抜けない
			fmasked := maskNonCode(lines[fr.Start-1 : fr.End])
			// 引数のホバーとハイライト（1 関数につき最初の引数だけ）
			if m := reParam.FindStringSubmatchIndex(sig); m != nil && !cKeywords[sig[m[2]:m[3]]] {
				name := sig[m[4]:m[5]]
				use, at := -1, 0
				reName := regexp.MustCompile(`\b` + regexp.QuoteMeta(name) + `\b`)
				for i := fr.Start; i < fr.End && i < len(lines) && use < 0; i++ {
					masked := fmasked[i-(fr.Start-1)]
					for _, m := range reName.FindAllStringIndex(masked, -1) {
						// `ino->sbi = sbi;` の左は同名のメンバ。変数としての出現を選ぶ
						if !memberAccessBefore(masked, m[0]) {
							use, at = i, m[0]
							break
						}
					}
				}
				if use >= 0 {
					col := utf16Len(lines[use][:at])
					res, _ := s.handleHover(ctx, posParams(uri, use, col))
					msg := ""
					if hv, ok := res.(map[string]any); !ok || !strings.HasPrefix(hv["contents"].(map[string]string)["value"], "**local**") {
						msg = f + ":" + itoa(use+1) + " " + name + " -> " + strings.SplitN(hoverValue(res), "\n", 2)[0]
					}
					report("param-hover-is-local", msg)
					res, _ = s.handleDocumentHighlight(ctx, posParams(uri, use, col))
					msg = ""
					for _, h := range res.([]documentHighlight) {
						if h.Range.Start.Line < fr.Start-1 || h.Range.Start.Line > fr.End-1 {
							msg = f + ":" + itoa(use+1) + " " + name + " highlighted outside its function at line " + itoa(h.Range.Start.Line+1)
							break
						}
					}
					report("param-highlight-in-function", msg)
				}
			}
			// メンバ呼び出しの F12（1 関数につき最初の 1 件）
			for i := fr.Start; i < fr.End && i < len(lines); i++ {
				l := fmasked[i-(fr.Start-1)]
				m := reMember.FindStringSubmatchIndex(l)
				if m == nil {
					continue
				}
				name := l[m[2]:m[3]]
				res, _ := s.handleDefinition(ctx, posParams(uri, i, utf16Len(l[:m[2]])))
				msg := ""
				for _, loc := range res.([]location) {
					tl, err := search.CachedLines(uriToPath(loc.URI))
					if err != nil || loc.Range.Start.Line >= len(tl) {
						continue
					}
					text := tl[loc.Range.Start.Line]
					if regexp.MustCompile(`^\s*(?:static\s+)?[A-Za-z_][\w\s\*]*\b`+regexp.QuoteMeta(name)+`\s*\(`).MatchString(text) && !strings.Contains(text, "(*") {
						msg = f + ":" + itoa(i+1) + " ->" + name + "( landed on a function definition: " + strings.TrimSpace(text)
					}
				}
				report("member-f12-not-function", msg)
				break
			}
		}
	}
	// キーワード
	if len(files) > 0 {
		f := files[0]
		content, _ := s.documentText(pathToURI(f))
		for i, l := range strings.Split(content, "\n") {
			if idx := strings.Index(l, "return "); idx >= 0 {
				t0 := time.Now()
				res, _ := s.handleDefinition(ctx, posParams(pathToURI(f), i, utf16Len(l[:idx])+1))
				msg := ""
				if len(res.([]location)) != 0 || time.Since(t0) > time.Second {
					msg = "return -> " + itoa(len(res.([]location))) + " items in " + time.Since(t0).String()
				}
				report("keyword-f12-empty-and-fast", msg)
				break
			}
		}
	}
	t.Logf("files=%d checks=%v", len(files), checked)
	if len(bad) > 0 {
		t.Errorf("%d violations:\n%s", len(bad), strings.Join(bad, "\n"))
	}
}

func hoverValue(res any) string {
	hv, ok := res.(map[string]any)
	if !ok {
		return "(nil)"
	}
	return hv["contents"].(map[string]string)["value"]
}
