package lsp

import (
	"context"
	"encoding/json"
	"os"
	"sort"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"grepnavi/search"
)

// セマンティックトークン: ctags 索引にあるマクロ・enum メンバの使用箇所を
// "macro"、typedef / struct / union / enum の名前を "type" として返す。
// マクロは GUI の editor-c.js の定数ハイライトと同じ情報源・同じ規則
// （大文字を含まない名前は除外して likely のような誤検知を抑える）。
// エディタの文法ハイライトは #define の定義行と struct キーワードしか色を付けず、
// 使用箇所の色付けはこの経路でしか出ない。

var semanticLegend = map[string]any{
	"tokenTypes":     []string{"macro", "type"},
	"tokenModifiers": []string{},
}

const (
	tokenMacro = 0
	tokenType  = 1
)

// symbolNames は索引のマクロ名・型名（各ソート済み）。未構築なら少し待つ:
// 初回はサイドカーの読み込み中なので、空を返して色なしで確定させるより待つ方がよい。
func (s *server) symbolNames() search.SymbolsByKind {
	deadline := time.Now().Add(3 * time.Second)
	for {
		st := search.CtagsMacroNames(s.root)
		if st.Ready {
			return st.Symbols
		}
		if !st.Loading || time.Now().After(deadline) {
			return search.SymbolsByKind{}
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (s *server) handleSemanticTokensFull(ctx context.Context, raw json.RawMessage) (any, *responseError) {
	var p struct {
		TextDocument struct {
			URI string `json:"uri"`
		} `json:"textDocument"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &responseError{Code: codeInvalidRequest, Message: err.Error()}
	}
	content, err := os.ReadFile(uriToPath(p.TextDocument.URI))
	if err != nil {
		return map[string]any{"data": []int{}}, nil
	}
	syms := s.symbolNames()
	if len(syms.Macros) == 0 && len(syms.Types) == 0 {
		return map[string]any{"data": []int{}}, nil
	}
	return map[string]any{"data": symbolTokens(content, syms)}, nil
}

// symbolTokens は LSP の相対エンコード（deltaLine, deltaStart, length, type, modifiers）
// でトークン列を返す。コメントと文字列リテラルの中は対象外。
func symbolTokens(src []byte, syms search.SymbolsByKind) []int {
	data := []int{}
	prevLine, prevCol := 0, 0
	line, col := 0, 0 // col は UTF-16 単位
	i := 0
	n := len(src)
	isIdent := func(b byte) bool {
		return b == '_' || b >= '0' && b <= '9' || b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z'
	}
	advance := func(from, to int) {
		// from..to のバイト列を読み飛ばしながら行・列を進める
		for from < to {
			r, size := utf8.DecodeRune(src[from:])
			if r == '\n' {
				line++
				col = 0
			} else {
				col += len(utf16.Encode([]rune{r}))
			}
			from += size
		}
	}
	for i < n {
		c := src[i]
		switch {
		case c == '/' && i+1 < n && src[i+1] == '/':
			j := i
			for j < n && src[j] != '\n' {
				j++
			}
			advance(i, j)
			i = j
		case c == '/' && i+1 < n && src[i+1] == '*':
			j := i + 2
			for j+1 < n && !(src[j] == '*' && src[j+1] == '/') {
				j++
			}
			if j+1 < n {
				j += 2
			} else {
				j = n
			}
			advance(i, j)
			i = j
		case c == '"' || c == '\'':
			q := c
			j := i + 1
			for j < n && src[j] != q && src[j] != '\n' {
				if src[j] == '\\' {
					j++
				}
				j++
			}
			if j < n && src[j] == q {
				j++
			}
			advance(i, j)
			i = j
		case isIdent(c) && !(c >= '0' && c <= '9'):
			j := i + 1
			for j < n && isIdent(src[j]) {
				j++
			}
			name := string(src[i:j])
			kind := -1
			if hasUpper(name) && contains(syms.Macros, name) {
				kind = tokenMacro
			} else if contains(syms.Types, name) && inTypePosition(src, i, j) {
				kind = tokenType
			}
			if kind >= 0 {
				data = append(data, line-prevLine, relStart(col, prevCol, line, prevLine), j-i, kind, 0)
				prevLine, prevCol = line, col
			}
			col += j - i
			i = j
		default:
			_, size := utf8.DecodeRune(src[i:])
			advance(i, i+size)
			i += size
		}
	}
	return data
}

// inTypePosition は src[i:j] の識別子が型として使われている位置かを判定する。
// 型名は名前だけで決めると変数名と衝突する（md や version のような小文字の
// struct がツリーのどこかにあるだけで、同名の変数が全部型の色になる）。
// C で型名が立つ位置は限られる: 直後が * か識別子（宣言 "T x" / "T *x"）、
// または直前が struct / union / enum。キャストや sizeof(T) は見送る
// （f(x) と (T) を安く区別できないので、取りこぼす側に倒す）。
func inTypePosition(src []byte, i, j int) bool {
	k := j
	for k < len(src) && (src[k] == ' ' || src[k] == '\t') {
		k++
	}
	if k < len(src) {
		c := src[k]
		if c == '*' || c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' {
			return true
		}
	}
	b := i
	for b > 0 && (src[b-1] == ' ' || src[b-1] == '\t') {
		b--
	}
	for _, kw := range []string{"struct", "union", "enum"} {
		if b >= len(kw) && string(src[b-len(kw):b]) == kw && (b-len(kw) == 0 || !isIdentByte(src[b-len(kw)-1])) {
			return true
		}
	}
	return false
}

func isIdentByte(c byte) bool {
	return c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

// contains はソート済みの名前表を二分探索する。
func contains(sorted []string, name string) bool {
	k := sort.SearchStrings(sorted, name)
	return k < len(sorted) && sorted[k] == name
}

func relStart(col, prevCol, line, prevLine int) int {
	if line == prevLine {
		return col - prevCol
	}
	return col
}

func hasUpper(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 'A' && s[i] <= 'Z' {
			return true
		}
	}
	return false
}
