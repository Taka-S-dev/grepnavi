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
	var condStack []deadFrame
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

// deadFrame は #if 系ブロック1段のうち、構成に依らず結果が決まる部分。
type deadFrame struct {
	dead  bool // この分岐は構成に依らず必ず捨てられる
	taken bool // `#if 1` のように、この分岐が必ず採られる（＝裏が必ず死ぬ）
}

// applyCondDirective は前処理ディレクティブ1行ぶんだけ条件スタックを進める。
//
// 落とすのは構成に依らず death が確定するものだけ。`#ifdef CONFIG_X` の
// 有効・無効はビルド構成次第なので、落とすと本物のコードを隠してしまう。
func applyCondDirective(stack []deadFrame, stripped string) []deadFrame {
	t := strings.TrimSpace(stripped)
	if !strings.HasPrefix(t, "#") {
		return stack
	}
	body := strings.TrimSpace(t[1:])
	switch {
	case strings.HasPrefix(body, "ifdef"), strings.HasPrefix(body, "ifndef"):
		return append(stack, deadFrame{})
	case strings.HasPrefix(body, "if"):
		cond := strings.TrimSpace(strings.TrimPrefix(body, "if"))
		return append(stack, deadFrame{dead: cond == "0", taken: cond == "1"})
	case strings.HasPrefix(body, "elif"), strings.HasPrefix(body, "else"):
		// `#if 1` の裏は `#if 0` の表と同じで、必ず捨てられる。ここを生かすと
		// 両方の分岐のブレースを数えることになり、深度がずれてファイルの
		// 残り全部の関数が見えなくなる（openssl の gcm128.c で実際に起きた）。
		if n := len(stack); n > 0 {
			stack[n-1].dead = stack[n-1].taken
		}
		return stack
	case strings.HasPrefix(body, "endif"):
		if n := len(stack); n > 0 {
			return stack[:n-1]
		}
	}
	return stack
}

func anyDead(stack []deadFrame) bool {
	for _, f := range stack {
		if f.dead {
			return true
		}
	}
	return false
}

// codeOnlyCache は1リクエスト内で同じファイルを何度も走査しないための一時キャッシュ。
// 除去済みの行と、そこから求めた関数の範囲を同じ寿命で持つ。
type codeOnlyCache map[string]*codeOnlyEntry

type codeOnlyEntry struct {
	code  []string
	spans []funcSpan
}

func (c codeOnlyCache) entry(file string, lines []string) *codeOnlyEntry {
	if v, ok := c[file]; ok {
		return v
	}
	code := codeOnlyLines(lines)
	v := &codeOnlyEntry{code: code, spans: scanFuncSpans(code)}
	c[file] = v
	return v
}

func (c codeOnlyCache) get(file string, lines []string) []string {
	return c.entry(file, lines).code
}

// containingFunc は file の line 行を囲む関数の名前と開始行を返す（""=関数の外）。
// ファイルごとに範囲表を1回だけ作り、あとは二分探索で引く。
func (c codeOnlyCache) containingFunc(file string, lines []string, line int) (string, int) {
	sp, ok := enclosingSpan(c.entry(file, lines).spans, line)
	if !ok {
		return "", 0
	}
	return sp.Name, sp.Start
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
