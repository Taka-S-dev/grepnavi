package lsp

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"

	"grepnavi/search"
)

// documentHighlight は同じ語の出現 1 件。Kind は LSP の DocumentHighlightKind。
type documentHighlight struct {
	Range lspRange `json:"range"`
	Kind  int      `json:"kind,omitempty"`
}

const (
	highlightRead  = 2
	highlightWrite = 3
)

// handleDocumentHighlight はカーソル下の語の出現を現在の文書から返す。
// コメントと文字列の中は除く。書き込み（`x = ...` `x++`）は Write、他は Read。
// 索引は引かない: 1 ファイルの字面だけで決まり、カーソルが動くたびに来る要求なので
// 速さが要る。
func (s *server) handleDocumentHighlight(ctx context.Context, raw json.RawMessage) (any, *responseError) {
	var p textDocumentPositionParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &responseError{Code: codeInvalidRequest, Message: err.Error()}
	}
	out := []documentHighlight{}
	word, _ := s.wordAt(p.TextDocument.URI, p.Position)
	if word == "" {
		return out, nil
	}
	content, ok := s.documentText(p.TextDocument.URI)
	if !ok {
		return out, nil
	}
	re := regexp.MustCompile(`\b` + regexp.QuoteMeta(word) + `\b`)
	lines := strings.Split(content, "\n")
	masked := maskNonCode(lines)
	// ローカル変数や引数はその関数の中だけを光らせる。`s` のような 1 文字の名前を
	// ファイル全域で拾うと、openssl の ssl_lib.c で 1,026 件になって意味を失う。
	// 「囲む関数の中に宣言の形（型名 *word;）がある」ときだけ絞る。宣言が
	// 見つからなければグローバルとしてファイル全体を対象にする
	first, last := 0, len(masked)-1
	if fr, ok := enclosingFuncRange(lines, p.Position.Line+1); ok && declaredWithin(masked[fr.Start-1:fr.End], word) {
		first, last = fr.Start-1, fr.End-1
	}
	for i := first; i <= last; i++ {
		l := masked[i]
		for _, m := range re.FindAllStringIndex(l, -1) {
			kind := highlightRead
			if search.IsAssignmentAt(word, l, m[0]) {
				kind = highlightWrite
			}
			out = append(out, documentHighlight{
				Range: lspRange{
					Start: position{Line: i, Character: utf16Len(l[:m[0]])},
					End:   position{Line: i, Character: utf16Len(l[:m[1]])},
				},
				Kind: kind,
			})
		}
	}
	return out, nil
}

// enclosingFuncRange は line（1-indexed）を含む関数の範囲を返す。
func enclosingFuncRange(lines []string, line int) (search.FuncRange, bool) {
	for _, fr := range search.FunctionRanges(lines) {
		if fr.Start <= line && line <= fr.End {
			return fr, true
		}
	}
	return search.FuncRange{}, false
}

// declaredWithin は lines（コメント除去済み）に word の宣言の形があるかを返す:
// 直前が型名（識別子）で、後ろが `;` `,` `=` `)` `[` のいずれか。
// `SSL *s,` `int n = 0;` は宣言、`return s;` `x = s;` は違う。
func declaredWithin(lines []string, word string) bool {
	re := regexp.MustCompile(`([A-Za-z_]\w*)\s*\**\s*\b` + regexp.QuoteMeta(word) + `\b\s*[;,=)\[]`)
	for _, l := range lines {
		for _, m := range re.FindAllStringSubmatch(l, -1) {
			if !cKeywords[m[1]] || isTypeKeyword(m[1]) {
				return true
			}
		}
	}
	return false
}

// isTypeKeyword は宣言の型として現れるキーワード（`int n;` の int）。
func isTypeKeyword(w string) bool {
	switch w {
	case "int", "char", "long", "short", "unsigned", "signed", "float", "double", "void", "const", "volatile", "struct", "union", "enum":
		return true
	}
	return false
}

// maskNonCode はコメントと文字列リテラルの中身を空白に置き換える。
// 列を変えないので、結果の位置がそのまま元の行の位置になる。
// search.codeOnlyLines は列を詰めるので、位置を返す用途にはこちらを使う。
func maskNonCode(lines []string) []string {
	out := make([]string, len(lines))
	inBlock := false
	for i, line := range lines {
		b := []byte(line)
		inStr, inChar := false, false
		for j := 0; j < len(b); j++ {
			c := b[j]
			switch {
			case inBlock:
				if c == '*' && j+1 < len(b) && b[j+1] == '/' {
					inBlock = false
					b[j], b[j+1] = ' ', ' '
					j++
				} else if c != '\r' {
					b[j] = ' '
				}
			case inStr || inChar:
				if c == '\\' && j+1 < len(b) {
					b[j], b[j+1] = ' ', ' '
					j++
					continue
				}
				if (inStr && c == '"') || (inChar && c == '\'') {
					inStr, inChar = false, false
					continue
				}
				b[j] = ' '
			case c == '/' && j+1 < len(b) && b[j+1] == '*':
				inBlock = true
				b[j], b[j+1] = ' ', ' '
				j++
			case c == '/' && j+1 < len(b) && b[j+1] == '/':
				for k := j; k < len(b); k++ {
					if b[k] != '\r' {
						b[k] = ' '
					}
				}
				j = len(b)
			case c == '"':
				inStr = true
			case c == '\'':
				inChar = true
			}
		}
		out[i] = string(b)
	}
	return out
}
