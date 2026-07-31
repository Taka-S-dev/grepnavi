// Package patch は grepnavi が挿入した行の追加・削除・差し替えを、
// ファイルの生バイト列への行スプライスとして行う。既存行のバイトには
// 一切触れない。これがエンコーディング往復問題を構造的に回避する要:
// ファイル全体を再エンコードしないので、読めるファイルなら壊さない。
//
// 前提: 対応エンコーディング (UTF-8 / UTF-8 BOM / Shift-JIS / EUC-JP) は
// いずれも 0x0A が行区切り以外に現れない (SJIS の trail byte は
// 0x40-0x7E,0x80-0xFC、EUC-JP の構成バイトは 0x8E/0x8F/0xA1-0xFE)。
// このためバイト列を 0x0A で切っても文字を壊さない。
// UTF-16 はこの前提が成り立たないため対象外。
package patch

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/japanese"
	"golang.org/x/text/transform"

	"grepnavi/search"
)

var (
	ErrUnsupportedEncoding = errors.New("patch: unsupported encoding (UTF-16)")
	ErrUnencodable         = errors.New("patch: text not representable in file encoding")
	ErrMismatch            = errors.New("patch: line does not match recorded text")
)

// File は行単位に分解したファイル。terms は各行の元の終端 ("\n" / "\r\n" /
// 末尾行のみ "") をそのまま保持する。Save はこれを再連結するだけなので、
// 触っていない行の改行コードが正規化されることはない。
type File struct {
	path    string
	enc     search.Encoding
	bom     []byte
	lines   [][]byte // 終端を含まない生バイト
	terms   []string
	newline string // 挿入行に使う支配的な改行
}

func Load(path string) (*File, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	enc := search.DetectEncoding(raw)
	if enc == search.EncUTF16LE || enc == search.EncUTF16BE {
		return nil, ErrUnsupportedEncoding
	}
	// BOM 無し UTF-16 は utf8.Valid が NUL を許してしまうため EncUTF8 に化ける
	// ことがある。UTF-16 は 0x0A が行区切り以外にも現れうる (前提が崩れる)
	// ので、NUL バイトを含むファイルは同じ理由で一律に拒否する。バイナリ
	// 判定に使っているのと同じヒューリスティック (api/handlers_analysis.go)。
	if bytes.IndexByte(raw, 0) >= 0 {
		return nil, ErrUnsupportedEncoding
	}
	f := &File{path: path, enc: enc, newline: "\n"}
	if enc == search.EncUTF8BOM {
		f.bom = raw[:3]
		raw = raw[3:]
	}
	if bytes.Contains(raw, []byte("\r\n")) {
		f.newline = "\r\n"
	}
	for len(raw) > 0 {
		i := bytes.IndexByte(raw, '\n')
		if i < 0 {
			f.lines = append(f.lines, raw)
			f.terms = append(f.terms, "")
			break
		}
		line, term := raw[:i], "\n"
		if len(line) > 0 && line[len(line)-1] == '\r' {
			line, term = line[:len(line)-1], "\r\n"
		}
		f.lines = append(f.lines, line)
		f.terms = append(f.terms, term)
		raw = raw[i+1:]
	}
	return f, nil
}

func (f *File) LineCount() int { return len(f.lines) }

func (f *File) LineUTF8(line int) (string, bool) {
	if line < 1 || line > len(f.lines) {
		return "", false
	}
	return f.decode(f.lines[line-1]), true
}

func (f *File) decode(b []byte) string {
	switch f.enc {
	case search.EncSJIS:
		if out, _, err := transform.Bytes(japanese.ShiftJIS.NewDecoder(), b); err == nil {
			return string(out)
		}
	case search.EncEUCJP:
		if out, _, err := transform.Bytes(japanese.EUCJP.NewDecoder(), b); err == nil {
			return string(out)
		}
	}
	return string(b)
}

// decodeForMatch は DeleteLine/ReplaceLine の完全一致照合専用のデコードで、
// 置換文字 (U+FFFD) を含む結果は ok=false を返す。SJIS/EUC-JP のデコーダは
// 不正バイト列をエラーにせず U+FFFD で置換するため、2つの異なる元バイト列
// が同じ文字列にデコードされ得る。置換文字を含む復号結果は同値比較の根拠に
// ならないので、比較せず ErrMismatch 扱いにする (誤った行を消す/差し替える
// 事故を避ける)。LineUTF8 の表示用途ではこの制約は不要なので decode を使う。
func (f *File) decodeForMatch(b []byte) (string, bool) {
	s := f.decode(b)
	if f.enc == search.EncSJIS || f.enc == search.EncEUCJP {
		if strings.ContainsRune(s, utf8.RuneError) {
			return "", false
		}
	}
	return s, true
}

// encode は挿入・差し替えテキストをファイルのエンコーディングへ変換する。
// SJIS/EUC-JP は専用エンコーダを通し、それ以外 (UTF-8/UTF-8 BOM) はそのまま
// 通す。変換不能な文字があれば ErrUnencodable を返す。
func (f *File) encode(s string) ([]byte, error) {
	switch f.enc {
	case search.EncSJIS:
		out, _, err := transform.Bytes(japanese.ShiftJIS.NewEncoder(), []byte(s))
		if err != nil {
			return nil, fmt.Errorf("%w: %q", ErrUnencodable, s)
		}
		return out, nil
	case search.EncEUCJP:
		out, _, err := transform.Bytes(japanese.EUCJP.NewEncoder(), []byte(s))
		if err != nil {
			return nil, fmt.Errorf("%w: %q", ErrUnencodable, s)
		}
		return out, nil
	default:
		return []byte(s), nil
	}
}

// InsertAfter は line 行目 (1-indexed) の直後に textsUTF8 を挿入する。
// line=0 は先頭挿入。末尾行に終端が無いファイルでは、その性質を挿入後も
// 保つ (末尾に足す場合は旧末尾行に改行を与え、新しい末尾行を終端なしにする)。
func (f *File) InsertAfter(line int, textsUTF8 []string) error {
	if line < 0 || line > len(f.lines) {
		return fmt.Errorf("patch: line %d out of range (1..%d)", line, len(f.lines))
	}
	encoded := make([][]byte, len(textsUTF8))
	for i, s := range textsUTF8 {
		b, err := f.encode(s)
		if err != nil {
			return err
		}
		encoded[i] = b
	}
	newLines := append([][]byte{}, f.lines[:line]...)
	newTerms := append([]string{}, f.terms[:line]...)
	atEOF := line == len(f.lines)
	// 「末尾改行なし」を引き継ぐのは、元の末尾行が本当に無終端だった場合だけ。
	// atEOF かどうかだけで判定すると、元々改行済みのファイルへの追記からも
	// 改行を奪ってしまう (SJIS 挿入テストが検出)。
	noTrailingNewline := atEOF && line > 0 && f.terms[line-1] == ""
	if noTrailingNewline {
		newTerms[line-1] = f.newline
	}
	for i, b := range encoded {
		term := f.newline
		if noTrailingNewline && i == len(encoded)-1 {
			term = "" // 末尾改行なしの性質を保つ
		}
		newLines = append(newLines, b)
		newTerms = append(newTerms, term)
	}
	f.lines = append(newLines, f.lines[line:]...)
	f.terms = append(newTerms, f.terms[line:]...)
	return nil
}

func (f *File) DeleteLine(line int, expectUTF8 string) error {
	if line < 1 || line > len(f.lines) {
		return fmt.Errorf("%w: line %d out of range", ErrMismatch, line)
	}
	if got, ok := f.decodeForMatch(f.lines[line-1]); !ok || got != expectUTF8 {
		return ErrMismatch
	}
	// 削除で末尾行になった行の終端は元のまま残す。挿入時に旧末尾行へ
	// 与えた改行までは取り消さない (無害で、判別もできないため)。
	f.lines = append(f.lines[:line-1], f.lines[line:]...)
	f.terms = append(f.terms[:line-1], f.terms[line:]...)
	return nil
}

func (f *File) ReplaceLine(line int, expectUTF8, newUTF8 string) error {
	if line < 1 || line > len(f.lines) {
		return fmt.Errorf("%w: line %d out of range", ErrMismatch, line)
	}
	if got, ok := f.decodeForMatch(f.lines[line-1]); !ok || got != expectUTF8 {
		return ErrMismatch
	}
	b, err := f.encode(newUTF8)
	if err != nil {
		return err
	}
	f.lines[line-1] = b
	return nil
}

func (f *File) Save() error {
	var buf bytes.Buffer
	buf.Write(f.bom)
	for i, l := range f.lines {
		buf.Write(l)
		buf.WriteString(f.terms[i])
	}
	// tmp+rename でも元ファイルの権限は自動的には引き継がれない
	// (os.WriteFile は常に新規作成扱いで mode を適用する)。0644 固定だと
	// 0600/0444 だった元ファイルが world-readable になってしまうので、
	// 元ファイルの perm を明示的に引き継ぐ。
	perm := os.FileMode(0o644)
	if fi, err := os.Stat(f.path); err == nil {
		perm = fi.Mode().Perm()
	}
	tmp := f.path + ".gn.tmp"
	if err := os.WriteFile(tmp, buf.Bytes(), perm); err != nil {
		return err
	}
	return os.Rename(tmp, f.path)
}
