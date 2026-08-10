package search

import (
	"bytes"
	"strings"
)

// codeOnlyLines は各行からコメント・文字列リテラル・`#if 0` ブロックを取り除いた
// 「生きているコードだけ」の行を返す（行数と行番号は元のまま保つ）。
//
// 呼び出し元の用途は参照箇所の絞り込み。gtags の参照インデックスも ripgrep も
// コメント内・文字列内・無効化ブロック内の識別子を拾うため、これを通さないと
// 「/* ... foo() ... */」のような説明文が呼び出し元として現れる。
//
// 除外するのは `#if 0` だけに留める。`#ifdef CONFIG_X` の有効・無効はビルド構成
// 次第で、除外すると本物の呼び出しを隠してしまう。`#if 0` は構成に依らず必ず
// 捨てられるので、これだけが安全に落とせる。
//
// ブロックコメントと条件ブロックは行をまたぐので、必ずファイル先頭から順に処理すること。
// 実装メモ: 行ごとに文字列を作ると1行につき1回確保することになり、
// 8千行のファイルで8千回を超える。全行をひとつのバッファに詰めてから
// 一度だけ文字列にし、各行はその部分文字列として切り出す。
func codeOnlyLines(lines []string) []string {
	total := 0
	for _, l := range lines {
		total += len(l)
	}
	buf := make([]byte, 0, total)
	type span struct{ start, end int }
	spans := make([]span, len(lines))

	inBlock := false
	var condStack []bool // 各 #if 系ブロックが `#if 0` 由来か
	for i, line := range lines {
		start := len(buf)
		inStr, inChar := false, false
		for j := 0; j < len(line); j++ {
			c := line[j]
			switch {
			case inBlock:
				if c == '*' && j+1 < len(line) && line[j+1] == '/' {
					inBlock = false
					j++
				}
			case inStr, inChar:
				if c == '\\' {
					j++ // エスケープは次の1文字ごと読み飛ばす
					continue
				}
				if (inStr && c == '"') || (inChar && c == '\'') {
					inStr, inChar = false, false
				}
			case c == '/' && j+1 < len(line) && line[j+1] == '*':
				inBlock = true
				j++
			case c == '/' && j+1 < len(line) && line[j+1] == '/':
				j = len(line) // 行コメント: 以降は捨てる
			case c == '"':
				inStr = true
			case c == '\'':
				inChar = true
			default:
				buf = append(buf, c)
			}
		}
		end := len(buf)
		// 条件スタックを進めるのはディレクティブ行だけ。ここで文字列にすると
		// 結局1行1回の確保に戻るので、`#` で始まる行に限って作る
		if isDirectiveLine(buf[start:end]) {
			condStack = applyCondDirective(condStack, string(buf[start:end]))
		}
		if anyDead(condStack) {
			end = start // `#if 0` の中身は構成に依らず捨てられる
		}
		spans[i] = span{start, end}
	}

	all := string(buf) // 全行ぶんの確保はこの1回だけ
	out := make([]string, len(lines))
	for i, sp := range spans {
		out[i] = all[sp.start:sp.end]
	}
	return out
}

// isDirectiveLine は前処理ディレクティブ行かを、文字列を作らずに判定する。
func isDirectiveLine(b []byte) bool {
	t := bytes.TrimSpace(b)
	return len(t) > 0 && t[0] == '#'
}

// applyCondDirective は前処理ディレクティブ1行ぶんだけ条件スタックを進める。
// スタックの各要素は「そのブロックが `#if 0` で無効化されているか」を持つ。
func applyCondDirective(stack []bool, stripped string) []bool {
	t := strings.TrimSpace(stripped)
	if !strings.HasPrefix(t, "#") {
		return stack
	}
	body := strings.TrimSpace(t[1:])
	switch {
	case strings.HasPrefix(body, "ifdef"), strings.HasPrefix(body, "ifndef"):
		return append(stack, false)
	case strings.HasPrefix(body, "if"):
		// 条件が定数 0 のときだけ無効ブロックとして扱う
		return append(stack, strings.TrimSpace(strings.TrimPrefix(body, "if")) == "0")
	case strings.HasPrefix(body, "elif"), strings.HasPrefix(body, "else"):
		// `#if 0` の裏側は生きている。逆に生きている側の裏は不明なので生かす。
		if n := len(stack); n > 0 {
			stack[n-1] = false
		}
		return stack
	case strings.HasPrefix(body, "endif"):
		if n := len(stack); n > 0 {
			return stack[:n-1]
		}
	}
	return stack
}

func anyDead(stack []bool) bool {
	for _, dead := range stack {
		if dead {
			return true
		}
	}
	return false
}

// codeOnlyCache は1リクエスト内で同じファイルを何度も走査しないための一時キャッシュ。
type codeOnlyCache map[string][]string

func (c codeOnlyCache) get(file string, lines []string) []string {
	if v, ok := c[file]; ok {
		return v
	}
	v := codeOnlyLines(lines)
	c[file] = v
	return v
}

// mentionsInCode は file の line 行のコード部分に word が現れるかを返す。
// コメント内・文字列内だけの出現は false になる。
func (c codeOnlyCache) mentionsInCode(file string, lines []string, line int, word string) bool {
	code := c.get(file, lines)
	if line < 1 || line > len(code) {
		return false
	}
	return strings.Contains(code[line-1], word)
}
