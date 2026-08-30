package lsp

import (
	"context"
	"encoding/json"
	"os"
	"strconv"
	"strings"

	"grepnavi/search"
)

// CodeLens は関数の上に「呼び出し元 3（登録 1）」を常時出す。clangd には無く、
// grepnavi の索引にはある情報（テーブル登録行を含む呼び出し元）を、開くだけで
// 見せる口。クリックすると呼び出し行の一覧が Peek で開く。
//
// 位置と件数は分けて答える。textDocument/codeLens は関数の範囲から 1ms で作れる
// が、件数は関数ごとに索引を引く。VSCode は画面に見えているレンズだけ
// codeLens/resolve してくるので、300 関数のファイルでも数えるのは見えている分だけ。

type codeLens struct {
	Range   lspRange     `json:"range"`
	Command *lensCommand `json:"command,omitempty"`
	Data    *lensData    `json:"data,omitempty"`
}

type lensCommand struct {
	Title     string `json:"title"`
	Command   string `json:"command"`
	Arguments []any  `json:"arguments,omitempty"`
}

// lensData は resolve のときに戻ってくる。何を数えるかをここで運ぶ。
type lensData struct {
	Name string `json:"name"`
	File string `json:"file"`
	Line int    `json:"line"` // 関数定義の行（1-indexed）
}

type resolvedLens struct {
	title string
	locs  []location
}

// lensCallerLimit は 1 レンズで数える上限。超えたら「200+」と出す。
const lensCallerLimit = 200

func (s *server) handleCodeLens(ctx context.Context, raw json.RawMessage) (any, *responseError) {
	var p struct {
		TextDocument struct {
			URI string `json:"uri"`
		} `json:"textDocument"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &responseError{Code: codeInvalidRequest, Message: err.Error()}
	}
	out := []codeLens{}
	content, ok := s.documentText(p.TextDocument.URI)
	if !ok {
		return out, nil
	}
	file := uriToPath(p.TextDocument.URI)
	for _, fr := range search.FunctionRanges(strings.Split(content, "\n")) {
		if fr.Name == "" {
			continue
		}
		out = append(out, codeLens{
			Range: wordRange(file, fr.Start, fr.Name),
			Data:  &lensData{Name: fr.Name, File: file, Line: fr.Start},
		})
	}
	return out, nil
}

func (s *server) handleCodeLensResolve(ctx context.Context, raw json.RawMessage) (any, *responseError) {
	var lens codeLens
	if err := json.Unmarshal(raw, &lens); err != nil {
		return nil, &responseError{Code: codeInvalidRequest, Message: err.Error()}
	}
	if lens.Data == nil || lens.Data.Name == "" {
		lens.Command = &lensCommand{Title: "", Command: ""}
		return lens, nil
	}
	r := s.resolveCallers(ctx, lens.Data)
	uri := pathToURI(lens.Data.File)
	lens.Command = &lensCommand{
		Title:   r.title,
		Command: "editor.action.showReferences",
		Arguments: []any{
			uri,
			position{Line: lens.Range.Start.Line, Character: 0},
			r.locs,
		},
	}
	return lens, nil
}

// resolveCallers は関数の呼び出し元を数える。結果はファイルの mtime と関数名で
// キャッシュし、スクロールで同じ関数が見えるたびに索引を引かない。
func (s *server) resolveCallers(ctx context.Context, d *lensData) resolvedLens {
	key := d.File + "\x00" + d.Name
	if fi, err := os.Stat(d.File); err == nil {
		key += "\x00" + strconv.FormatInt(fi.ModTime().UnixNano(), 10)
	}
	s.lensMu.Lock()
	if s.lensCache == nil {
		s.lensCache = map[string]resolvedLens{}
	}
	if r, ok := s.lensCache[key]; ok {
		s.lensMu.Unlock()
		return r
	}
	s.lensMu.Unlock()

	rctx, cancel := s.requestContext(ctx)
	defer cancel()
	sites, _, truncated, err := search.FindRefSites(rctx, search.RefQuery{
		Word: d.Name, Root: s.root, CallersOnly: true, Limit: lensCallerLimit,
	})
	if err != nil || rctx.Err() != nil {
		// 期限切れや失敗は数えられなかったことを見せ、キャッシュしない
		return resolvedLens{title: "呼び出し元 ?"}
	}
	registrations := 0
	locs := make([]location, 0, len(sites))
	for _, c := range sites {
		// 呼び出しの形 `helper(` を持たない参照 = 関数ポインタとして渡した・
		// テーブルに登録した箇所。呼び出し元一覧はこれを「誰が呼ぶか」の答えとして
		// 残しているので、件数の中で区別して見せる
		if c.Indirect {
			registrations++
		}
		locs = append(locs, location{URI: pathToURI(c.File), Range: wordRange(c.File, c.CallLine, d.Name)})
	}
	title := "呼び出し元 " + strconv.Itoa(len(sites))
	if truncated {
		title += "+"
	}
	if registrations > 0 {
		title += "（登録 " + strconv.Itoa(registrations) + "）"
	}
	if len(sites) == 0 {
		title = "呼び出し元なし"
	}
	r := resolvedLens{title: title, locs: locs}
	s.lensMu.Lock()
	s.lensCache[key] = r
	s.lensMu.Unlock()
	return r
}
