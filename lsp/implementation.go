package lsp

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"

	"grepnavi/search"
)

// handleImplementation は「実装へ移動」。関数ならその定義。構造体メンバ
// （関数ポインタ）なら、そのメンバに関数を入れている行 — `.read = my_read` の
// 初期化子や `ops->read = fn` の代入 — を返す。呼び出し `s->method->ssl_read(...)`
// で名前だけから実体を決めることはできないので、決めずに候補の集合を出す。
// 位置指定や マクロで組む表（OpenSSL のメソッド表）は字面に名前が無く、出ない。
func (s *server) handleImplementation(ctx context.Context, raw json.RawMessage) (any, *responseError) {
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
	// `p->read(` の read はメンバ。同名の関数 read が索引にあっても、それは
	// この呼び出しの実装ではない（bio_ssl.c の static ssl_read に飛んでいた）
	if !memberAccessAt(content, p.Position) {
		for _, h := range s.findDefinitions(ctx, word, path) {
			if h.Kind == "func" {
				locs = append(locs, location{URI: pathToURI(h.File), Range: wordRange(h.File, h.Line, word)})
			}
		}
		if len(locs) > 0 {
			return locs, nil
		}
	}
	ctx, cancel := s.requestContext(ctx)
	defer cancel()
	// assign 指定は索引で答えられず rg の全走査になる（openssl で cold 118 秒、
	// warm 1.2 秒を実測）。参照一覧は索引が 10ms で返すので、そちらを取ってから
	// 代入の形の行だけを手元で残す
	refs, _, _, err := search.FindReferences(ctx, word, s.root, 2000, false, "")
	if err != nil {
		return nil, &responseError{Code: codeInvalidRequest, Message: err.Error()}
	}
	// 受け手 `file->f_op` の struct が分かれば、その struct の初期化子にある
	// `.read = fn` だけを残す。linux の `read` は 1,294 行に代入されていて、
	// 型で絞らないと一覧が役に立たない。初期化子の型は、その行から上に
	// `struct X ... = {` を探して字面で決める（見つからない行は残す）
	owner := ""
	if chain := receiverChainAt(content, p.Position); len(chain) > 0 {
		owner, _ = search.ChainStructInText(s.root, content, p.Position.Line+1, chain)
	}
	re := regexp.MustCompile(`\b` + regexp.QuoteMeta(word) + `\b`)
	for _, r := range refs {
		for _, m := range re.FindAllStringIndex(r.Text, -1) {
			if !search.IsAssignmentAt(word, r.Text, m[0]) {
				continue
			}
			if owner != "" {
				if o := initializerStructAt(r.File, r.Line, word); o != "" && o != owner {
					break
				}
			}
			locs = append(locs, location{URI: pathToURI(r.File), Range: wordRange(r.File, r.Line, word)})
			break
		}
	}
	return locs, nil
}

// receiverChainAt はカーソル位置の識別子の受け手（`file->f_op` → ["file","f_op"]）。
func receiverChainAt(content string, pos position) []string {
	lines := strings.Split(content, "\n")
	if pos.Line < 0 || pos.Line >= len(lines) {
		return nil
	}
	line := strings.TrimSuffix(lines[pos.Line], "\r")
	at := utf16ByteOffset(line, pos.Character)
	if at > len(line) {
		at = len(line)
	}
	if at > 0 && (at >= len(line) || !isIdentByte(line[at])) && isIdentByte(line[at-1]) {
		at--
	}
	for at > 0 && isIdentByte(line[at-1]) {
		at--
	}
	return receiverChainBefore(line, at)
}

// 初期化子の型: `struct X x = {` と、複合リテラル `= (struct X) {` の両方
var reInitializerStruct = regexp.MustCompile(`\b(?:struct|union)\s+([A-Za-z_]\w*)\b(?:[^;{}()]*=\s*\{|\s*\)\s*\{)`)

// initializerStructAt は file の line 行を含む初期化子 `struct X ... = { ... }` の
// X を返す。行から上へ最大 200 行、`;` で文が切れるまで遡る。見つからなければ ""。
func initializerStructAt(file string, line int, word string) string {
	lines, err := search.CachedLines(file)
	if err != nil || line < 1 || line > len(lines) {
		return ""
	}
	depth := 0
	for i := line - 1; i >= 0 && line-1-i < 300; i-- {
		l := lines[i]
		if i == line-1 {
			// 開始行は語より前だけを見る。`x = { .read = fn };` のように 1 行に
			// 収まった初期化子で、後ろの `}` を先に数えないため
			if m := regexp.MustCompile(`\b` + regexp.QuoteMeta(word) + `\b`).FindStringIndex(l); m != nil {
				l = l[:m[0]]
			}
		}
		for j := len(l) - 1; j >= 0; j-- {
			switch l[j] {
			case '}':
				depth++
			case '{':
				depth--
				if depth < 0 {
					// この `{` が初期化子の始まり。`struct X x = {` は同じ行か、
					// 長い宣言なら直前の 2 行以内にある
					head := l[:j]
					for k := i - 1; k >= 0 && k >= i-2; k-- {
						head = lines[k] + " " + head
					}
					if m := reInitializerStruct.FindStringSubmatch(head + "{"); m != nil {
						return m[1]
					}
					return ""
				}
			case ';':
				if depth == 0 && i < line-1 {
					return "" // 初期化子の外に出た（単独の代入文）
				}
			}
		}
	}
	return ""
}

// memberAccessAt はカーソル位置の識別子が `->` か `.` の直後にあるかを返す。
func memberAccessAt(content string, pos position) bool {
	lines := strings.Split(content, "\n")
	if pos.Line < 0 || pos.Line >= len(lines) {
		return false
	}
	line := strings.TrimSuffix(lines[pos.Line], "\r")
	at := utf16ByteOffset(line, pos.Character)
	if at > len(line) {
		at = len(line)
	}
	// カーソルが識別子の直後にあるときも、その識別子を見る
	if at > 0 && (at >= len(line) || !isIdentByte(line[at])) && isIdentByte(line[at-1]) {
		at--
	}
	for at > 0 && isIdentByte(line[at-1]) {
		at--
	}
	return memberAccessBefore(line, at)
}
