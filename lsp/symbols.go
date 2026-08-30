package lsp

import (
	"context"
	"encoding/json"
	"regexp"
	"sort"
	"strings"

	"grepnavi/search"
)

// シンボル一覧。textDocument/documentSymbol はアウトライン・パンくず・Ctrl+Shift+O、
// workspace/symbol は Ctrl+T が呼ぶ。どちらも ctags の索引をそのまま写す
// （GUI の ƒ パネル / Alt+Shift+T と同じ情報源）。索引が無ければ空。

// LSP SymbolKind
const (
	symbolKindStruct     = 23
	symbolKindEnum       = 10
	symbolKindEnumMember = 22
	symbolKindField      = 8
	symbolKindVariable   = 13
	symbolKindClass      = 5 // typedef はこれで出す（エディタのアイコンが「型」になる）
)

func symbolKindOf(kind string) int {
	switch kind {
	case "func":
		return symbolKindFunction
	case "define":
		return symbolKindConstant
	case "struct", "union":
		return symbolKindStruct
	case "enum":
		return symbolKindEnum
	case "enum_member":
		return symbolKindEnumMember
	case "typedef":
		return symbolKindClass
	case "member":
		return symbolKindField
	case "var":
		return symbolKindVariable
	}
	return symbolKindVariable
}

func (s *server) handleDocumentSymbol(ctx context.Context, raw json.RawMessage) (any, *responseError) {
	var p struct {
		TextDocument struct {
			URI string `json:"uri"`
		} `json:"textDocument"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &responseError{Code: codeInvalidParams, Message: err.Error()}
	}
	path := uriToPath(p.TextDocument.URI)
	hits, _ := search.CtagsSymbolsForFile(path, s.root)
	type documentSymbol struct {
		Name           string   `json:"name"`
		Kind           int      `json:"kind"`
		Range          lspRange `json:"range"`
		SelectionRange lspRange `json:"selectionRange"`
	}
	out := []documentSymbol{}
	// 開いている文書の関数は、未保存の内容から取る。ctags の行は保存時点のもので、
	// 編集中は書いたばかりの関数がアウトラインに出ず、行もずれる。マクロや struct
	// は索引のまま（字面だけで安く取れるのは関数の範囲だけ）
	if text, ok := s.openDocument(p.TextDocument.URI); ok {
		kept := hits[:0]
		for _, h := range hits {
			if h.Kind != "func" {
				kept = append(kept, h)
			}
		}
		hits = kept
		for _, fr := range search.FunctionRanges(strings.Split(text, "\n")) {
			out = append(out, documentSymbol{
				Name: fr.Name, Kind: symbolKindFunction,
				Range:          lspRange{Start: position{Line: fr.Start - 1}, End: position{Line: fr.End - 1, Character: 9999}},
				SelectionRange: wordRange(path, fr.Start, fr.Name),
			})
		}
	}
	sort.Slice(hits, func(i, j int) bool { return hits[i].Line < hits[j].Line })
	for _, h := range hits {
		name := h.Name
		if name == "" {
			name = h.Text
		}
		if name == "" {
			continue
		}
		out = append(out, documentSymbol{
			Name: name, Kind: symbolKindOf(h.Kind),
			Range: wordRange(uriToPath(p.TextDocument.URI), h.Line, name), SelectionRange: wordRange(uriToPath(p.TextDocument.URI), h.Line, name),
		})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Range.Start.Line < out[j].Range.Start.Line })
	return out, nil
}

const workspaceSymbolLimit = 200

func (s *server) handleWorkspaceSymbol(ctx context.Context, raw json.RawMessage) (any, *responseError) {
	var p struct {
		Query string `json:"query"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &responseError{Code: codeInvalidParams, Message: err.Error()}
	}
	if p.Query == "" {
		return []any{}, nil
	}
	// 部分一致・大文字小文字無視。エディタ側がさらに絞り込むので広めに返す
	hits, _, err := search.CtagsSearchSymbolNames(ctx, regexp.QuoteMeta(p.Query), s.root, "", false, workspaceSymbolLimit, "")
	if err != nil {
		return []any{}, nil
	}
	type symbolInformation struct {
		Name     string   `json:"name"`
		Kind     int      `json:"kind"`
		Location location `json:"location"`
	}
	out := make([]symbolInformation, 0, len(hits))
	for _, h := range hits {
		// tags が他言語（doxygen の HTML/JS 等）を含んでいても C/C++ だけ返す
		if !search.IsCSourceFile(h.File) {
			continue
		}
		name := h.Name
		if name == "" {
			name = h.Text
		}
		out = append(out, symbolInformation{
			Name: name, Kind: symbolKindOf(h.Kind),
			Location: location{URI: pathToURI(h.File), Range: wordRange(h.File, h.Line, name)},
		})
	}
	return out, nil
}
