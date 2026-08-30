package lsp

import (
	"context"
	"encoding/json"

	"grepnavi/search"
)

// handleTypeDefinition は変数の上で「型定義へ移動」を答える。変数の型を
// struct / union の名前まで辿り（typedef は索引で解く）、その定義位置を返す。
// カーソルの語が型名そのものなら、その定義を返す。
func (s *server) handleTypeDefinition(ctx context.Context, raw json.RawMessage) (any, *responseError) {
	var p textDocumentPositionParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &responseError{Code: codeInvalidRequest, Message: err.Error()}
	}
	locs := []location{}
	word, path := s.wordAt(p.TextDocument.URI, p.Position)
	if word == "" {
		return locs, nil
	}
	content, _ := s.documentText(p.TextDocument.URI)
	// `file->f_op` の f_op なら受け手から辿る（file の型 → そのメンバ f_op の型）。
	// 変数なら宣言から
	chain := append(receiverChainAt(content, p.Position), word)
	owner, ok := search.ChainStructInText(s.root, content, p.Position.Line+1, chain)
	if !ok {
		// 変数ではない: 型名として辿る。辿れなければ語そのものの型定義を探す
		if o, ok := search.ResolveStructName(s.root, word); ok {
			owner = o
		} else {
			owner = word
		}
	}
	for _, name := range uniqueStrings(owner, word) {
		for _, h := range s.findDefinitions(ctx, name, path) {
			if isTypeKind(h.Kind) {
				locs = append(locs, location{URI: pathToURI(h.File), Range: wordRange(h.File, h.Line, name)})
			}
		}
		if len(locs) > 0 {
			break
		}
	}
	return locs, nil
}

func isTypeKind(kind string) bool {
	switch kind {
	case "struct", "union", "typedef", "enum":
		return true
	}
	return false
}

func uniqueStrings(a, b string) []string {
	if a == b {
		return []string{a}
	}
	return []string{a, b}
}
