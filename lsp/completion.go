package lsp

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"unicode/utf16"

	"grepnavi/search"
)

// ---- 文書ストア ----
//
// 補完はエディタの未保存バッファを見ないと成立しない（"s->" と打った瞬間、
// ディスクにはまだ無い）。textDocumentSync を full で受け、開いている文書の
// 内容を持つ。他のハンドラ（hover / definition）も開いていればこちらを優先する。
// 索引（定義位置など）は保存済みのファイルが基準のまま。

// handleDidOpen / handleDidChange は反映した文書の URI を返す（無効領域の再計算に使う）。
func (s *server) handleDidOpen(raw json.RawMessage) string {
	var p struct {
		TextDocument struct {
			URI  string `json:"uri"`
			Text string `json:"text"`
		} `json:"textDocument"`
	}
	if json.Unmarshal(raw, &p) == nil && p.TextDocument.URI != "" {
		s.setDocument(p.TextDocument.URI, p.TextDocument.Text)
		return p.TextDocument.URI
	}
	return ""
}

// 文書の表は読み取りループが書き、要求の goroutine が読む。
func (s *server) setDocument(uri, text string) {
	s.docsMu.Lock()
	defer s.docsMu.Unlock()
	if s.docs == nil {
		s.docs = map[string]string{}
	}
	s.docs[uri] = text
}

func (s *server) handleDidChange(raw json.RawMessage) string {
	var p struct {
		TextDocument struct {
			URI string `json:"uri"`
		} `json:"textDocument"`
		ContentChanges []struct {
			Text string `json:"text"`
		} `json:"contentChanges"`
	}
	if json.Unmarshal(raw, &p) == nil && p.TextDocument.URI != "" && len(p.ContentChanges) > 0 {
		// full sync なので最後の要素が文書全体
		s.setDocument(p.TextDocument.URI, p.ContentChanges[len(p.ContentChanges)-1].Text)
		return p.TextDocument.URI
	}
	return ""
}

func (s *server) handleDidClose(raw json.RawMessage) {
	var p struct {
		TextDocument struct {
			URI string `json:"uri"`
		} `json:"textDocument"`
	}
	if json.Unmarshal(raw, &p) == nil {
		s.docsMu.Lock()
		delete(s.docs, p.TextDocument.URI)
		s.docsMu.Unlock()
	}
}

// documentText は開いていればバッファ、無ければディスクの内容を返す。
func (s *server) documentText(uri string) (string, bool) {
	s.docsMu.RLock()
	t, ok := s.docs[uri]
	s.docsMu.RUnlock()
	if ok {
		return t, true
	}
	b, err := os.ReadFile(uriToPath(uri))
	if err != nil {
		return "", false
	}
	return string(b), true
}

// ---- 補完 ----

// LSP CompletionItemKind
const (
	completionKindText     = 1
	completionKindFunction = 3
	completionKindField    = 5
	completionKindVariable = 6
	completionKindConstant = 21
	completionKindStruct   = 22
)

func completionKind(kind string) int {
	switch kind {
	case "field":
		return completionKindField
	case "local", "global":
		return completionKindVariable
	case "function":
		return completionKindFunction
	case "macro":
		return completionKindConstant
	case "type":
		return completionKindStruct
	}
	return completionKindText
}

func (s *server) handleCompletion(ctx context.Context, raw json.RawMessage) (any, *responseError) {
	var p textDocumentPositionParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &responseError{Code: codeInvalidParams, Message: err.Error()}
	}
	content, ok := s.documentText(p.TextDocument.URI)
	if !ok {
		return nil, nil
	}
	lines := strings.Split(content, "\n")
	if p.Position.Line < 0 || p.Position.Line >= len(lines) {
		return nil, nil
	}
	lineText := strings.TrimSuffix(lines[p.Position.Line], "\r")
	before := lineText[:utf16ByteOffset(lineText, p.Position.Character)]

	res := search.CompleteInText(s.root, content, p.Position.Line+1, before)
	if len(res.Items) == 0 {
		return map[string]any{"isIncomplete": false, "items": []any{}}, nil
	}

	// 置換範囲: 入力途中の識別子（Prefix）をまるごと候補で置き換える
	startChar := p.Position.Character - utf16Len(res.Prefix)
	replaceRange := lspRange{Start: position{Line: p.Position.Line, Character: startChar}, End: p.Position}

	// ポインタに "." を打っていたら、その "." を "->" に直す追加編集を全候補に付ける
	// （clangd と同じ方式。候補を確定した瞬間に直る）
	var extra []map[string]any
	if res.MemberAccess && res.BasePointer && strings.HasSuffix(strings.TrimSuffix(before, res.Prefix), ".") {
		dot := startChar - 1
		extra = []map[string]any{{
			"range":   lspRange{Start: position{Line: p.Position.Line, Character: dot}, End: position{Line: p.Position.Line, Character: dot + 1}},
			"newText": "->",
		}}
	}

	items := make([]map[string]any, 0, len(res.Items))
	for i, it := range res.Items {
		item := map[string]any{
			"label":    it.Label,
			"kind":     completionKind(it.Kind),
			"detail":   it.Detail,
			"sortText": sortKey(i),
			"textEdit": map[string]any{"range": replaceRange, "newText": it.Label},
		}
		if extra != nil {
			item["additionalTextEdits"] = extra
		}
		items = append(items, item)
	}
	return map[string]any{"isIncomplete": res.Incomplete, "items": items}, nil
}

// sortKey はエンジンの並び（ローカル→グローバル→マクロ）をエディタにも守らせる。
func sortKey(i int) string {
	const digits = "0123456789"
	return string([]byte{digits[i/1000%10], digits[i/100%10], digits[i/10%10], digits[i%10]})
}

// utf16ByteOffset は UTF-16 単位の列をバイト位置に直す。
func utf16ByteOffset(line string, ch int) int {
	u := 0
	for i, r := range line {
		if u >= ch {
			return i
		}
		u += len(utf16.Encode([]rune{r}))
	}
	return len(line)
}

func utf16Len(s string) int {
	return len(utf16.Encode([]rune(s)))
}
