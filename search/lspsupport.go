package search

import (
	"regexp"
	"strings"
)

// このファイルは lsp パッケージが使う薄い口。中身は既存の非公開関数で、
// ここで新しい判定は足さない（GUI・MCP・LSP で答えがずれないように）。

// IsAssignmentAt は line の byte 位置 at から始まる word の出現が書き込みかを返す。
// 行全体ではなく出現位置から見るので、`x = x + 1` の右辺の x は読みになる。
func IsAssignmentAt(word, line string, at int) bool {
	if at < 0 || at > len(line) {
		return false
	}
	re := assignRe(regexp.QuoteMeta(word), ``)
	loc := re.FindStringIndex(line[at:])
	return loc != nil && loc[0] == 0
}

// FuncRange は関数定義 1 つが占める行範囲（1-indexed）。
type FuncRange struct {
	Name  string
	Start int
	End   int
}

// FunctionRanges は lines に含まれる関数定義の範囲を Start 昇順で返す。
func FunctionRanges(lines []string) []FuncRange {
	spans := scanFuncSpans(codeOnlyLines(lines))
	out := make([]FuncRange, 0, len(spans))
	for _, sp := range spans {
		out = append(out, FuncRange(sp))
	}
	return out
}

// VariableStructInText は content の line 行目で見える変数 name の型を
// struct / union の名前まで辿る（"SSL *s" → typedef → "ssl_st"）。
// 索引の型表で解けないときは、その行までの宣言文 `struct X *name` を字面で探す。
// 字面にあるものしか返さないので推定は含まない。
func VariableStructInText(root, content string, line int, name string) (string, bool) {
	syms := completionSymbols(root)
	lines := splitLines(content)
	if typ, _, ok := variableType(syms, lines, line, name); ok {
		if owner, ok := resolveStruct(syms, typ); ok {
			return owner, true
		}
	}
	re := regexp.MustCompile(`\b(?:struct|union)\s+([A-Za-z_]\w*)\s*\**\s*\b` + regexp.QuoteMeta(name) + `\b\s*[;,=)\[]`)
	if line > len(lines) {
		line = len(lines)
	}
	for i := line - 1; i >= 0; i-- {
		if m := re.FindStringSubmatch(lines[i]); m != nil {
			return m[1], true
		}
	}
	return "", false
}

// ChainStructInText は `file->f_op` のような式（変数名とメンバ名の列）の末尾の型を
// struct / union の名前まで辿る。`file` の型 → そのメンバ `f_op` の型 → struct 名。
// メンバの型は ctags の表かソースの struct 本体から読む。
func ChainStructInText(root, content string, line int, chain []string) (string, bool) {
	if len(chain) == 0 {
		return "", false
	}
	syms := completionSymbols(root)
	lines := splitLines(content)
	if typ, _, ok := resolveChainType(syms, root, lines, line, chain); ok {
		if owner, ok := resolveStruct(syms, typ); ok {
			return owner, true
		}
	}
	// 索引の型表で解けないとき（tags が無い、サイドカーの読み込み中）は字面で辿る:
	// 宣言文 `struct file *file` → struct file の本体にある `f_op` の型 → その struct
	owner, ok := VariableStructInText(root, content, line, chain[0])
	if !ok {
		return "", false
	}
	for _, member := range chain[1:] {
		next := ""
		for _, m := range membersOf(syms, root, owner) {
			if m.Name == member {
				next = m.Type
				break
			}
		}
		if next == "" {
			return "", false
		}
		if owner, ok = resolveStruct(syms, next); !ok {
			return "", false
		}
	}
	return owner, true
}

// ResolveStructName は型名（typedef 名や "struct x"）を struct / union の名前に辿る。
func ResolveStructName(root, typ string) (string, bool) {
	return resolveStruct(completionSymbols(root), strings.TrimSpace(typ))
}
