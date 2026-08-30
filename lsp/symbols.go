package lsp

import (
	"context"
	"encoding/json"
	"regexp"
	"sort"

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
		return nil, &responseError{Code: codeInvalidRequest, Message: err.Error()}
	}
	hits, err := search.CtagsSymbolsForFile(uriToPath(p.TextDocument.URI), s.root)
	if err != nil {
		return []any{}, nil
	}
	sort.Slice(hits, func(i, j int) bool { return hits[i].Line < hits[j].Line })
	type documentSymbol struct {
		Name           string   `json:"name"`
		Kind           int      `json:"kind"`
		Range          lspRange `json:"range"`
		SelectionRange lspRange `json:"selectionRange"`
	}
	out := make([]documentSymbol, 0, len(hits))
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
	return out, nil
}

const workspaceSymbolLimit = 200

func (s *server) handleWorkspaceSymbol(ctx context.Context, raw json.RawMessage) (any, *responseError) {
	var p struct {
		Query string `json:"query"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &responseError{Code: codeInvalidRequest, Message: err.Error()}
	}
	if p.Query == "" {
		return []any{}, nil
	}
	// 部分一致・大文字小文字無視。エディタ側がさらに絞り込むので広めに返す
	hits, _, err := search.CtagsSearchSymbolNames(context.Background(), regexp.QuoteMeta(p.Query), s.root, "", false, workspaceSymbolLimit, "")
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
