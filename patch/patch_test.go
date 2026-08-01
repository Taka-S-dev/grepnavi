package patch

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"golang.org/x/text/encoding/japanese"
	"golang.org/x/text/transform"

	"grepnavi/search"
)

func write(t *testing.T, b []byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "a.c")
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func read(t *testing.T, p string) []byte {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func roundtrip(t *testing.T, p string, fn func(f *File) error) {
	t.Helper()
	f, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := fn(f); err != nil {
		t.Fatal(err)
	}
	if err := f.Save(); err != nil {
		t.Fatal(err)
	}
}

func TestInsertDeleteRestoresBytes(t *testing.T) {
	// 挿入 → 削除でバイト列が完全に元へ戻ること (golden 比較)。
	// CRLF / 末尾改行なし / タブインデントを1ファイルに同居させる。
	orig := []byte("int a;\r\n\tint b;\r\nlast")
	p := write(t, orig)
	roundtrip(t, p, func(f *File) error { return f.InsertAfter(1, []string{"\tprintf(\"[GN1]\\n\");"}) })
	mid := read(t, p)
	want := []byte("int a;\r\n\tprintf(\"[GN1]\\n\");\r\n\tint b;\r\nlast")
	if string(mid) != string(want) {
		t.Fatalf("挿入結果が違う:\n got %q\nwant %q", mid, want)
	}
	roundtrip(t, p, func(f *File) error { return f.DeleteLine(2, "\tprintf(\"[GN1]\\n\");") })
	if got := read(t, p); string(got) != string(orig) {
		t.Fatalf("削除後に元へ戻らない:\n got %q\nwant %q", got, orig)
	}
}

func TestInsertAtEOFKeepsNoTrailingNewline(t *testing.T) {
	p := write(t, []byte("one\ntwo"))
	roundtrip(t, p, func(f *File) error { return f.InsertAfter(2, []string{"three"}) })
	if got := read(t, p); string(got) != "one\ntwo\nthree" {
		t.Fatalf("got %q", got)
	}
}

func TestInsertAtTop(t *testing.T) {
	p := write(t, []byte("one\n"))
	roundtrip(t, p, func(f *File) error { return f.InsertAfter(0, []string{"zero"}) })
	if got := read(t, p); string(got) != "zero\none\n" {
		t.Fatalf("got %q", got)
	}
}

func TestSJISInsertConvertsSnippetOnly(t *testing.T) {
	// SJIS ファイルへ日本語込みの行を挿入 → 挿入行だけ SJIS になり、
	// 既存バイトは 1 byte も変わらないこと。
	enc := func(s string) []byte {
		b, _, err := transform.Bytes(japanese.ShiftJIS.NewEncoder(), []byte(s))
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	orig := append(enc("int a; /* あ */"), '\n')
	p := write(t, orig)
	roundtrip(t, p, func(f *File) error { return f.InsertAfter(1, []string{"printf(\"ここ\\n\");"}) })
	want := append(append(append([]byte{}, orig...), enc("printf(\"ここ\\n\");")...), '\n')
	if got := read(t, p); string(got) != string(want) {
		t.Fatalf("got % X\nwant % X", got, want)
	}
	// 読み戻しの照合 (UTF-8 で一致すること)
	f, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if s, ok := f.LineUTF8(2); !ok || s != "printf(\"ここ\\n\");" {
		t.Fatalf("LineUTF8 = %q, %v", s, ok)
	}
}

func TestUnencodableRejected(t *testing.T) {
	enc, _, _ := transform.Bytes(japanese.ShiftJIS.NewEncoder(), []byte("あ"))
	p := write(t, append(enc, '\n'))
	f, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	// ✓ (U+2713) は Shift-JIS に無い
	if err := f.InsertAfter(1, []string{"// ✓"}); !errors.Is(err, ErrUnencodable) {
		t.Fatalf("err = %v, want ErrUnencodable", err)
	}
}

func TestDeleteMismatch(t *testing.T) {
	p := write(t, []byte("one\ntwo\n"))
	f, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.DeleteLine(2, "TWO"); !errors.Is(err, ErrMismatch) {
		t.Fatalf("err = %v, want ErrMismatch", err)
	}
}

func TestReplaceLine(t *testing.T) {
	p := write(t, []byte("one\nold\n"))
	roundtrip(t, p, func(f *File) error { return f.ReplaceLine(2, "old", "new") })
	if got := read(t, p); string(got) != "one\nnew\n" {
		t.Fatalf("got %q", got)
	}
}

func TestUTF16Rejected(t *testing.T) {
	p := write(t, []byte{0xFF, 0xFE, 'a', 0x00, '\n', 0x00})
	if _, err := Load(p); !errors.Is(err, ErrUnsupportedEncoding) {
		t.Fatalf("err = %v, want ErrUnsupportedEncoding", err)
	}
}

func TestBOMlessUTF16Rejected(t *testing.T) {
	// BOM 無し UTF-16LE の "a\n"。utf8.Valid は NUL バイトを許すため、明示的な
	// NUL チェックが無いと EncUTF8 と誤判定され、文字の途中に現れる 0x0A で
	// InsertAfter が行を切ってファイルを壊してしまう。
	p := write(t, []byte{'a', 0x00, '\n', 0x00})
	if _, err := Load(p); !errors.Is(err, ErrUnsupportedEncoding) {
		t.Fatalf("err = %v, want ErrUnsupportedEncoding", err)
	}
}

func TestEUCJPRoundTripsThroughEUCJPNotSJIS(t *testing.T) {
	// 到達不能だった EncEUCJP 分岐の回帰テスト: EUC-JP のファイルは EUC-JP と
	// して復号・符号化されねばならない。EUC-JP の「日本語」を Shift-JIS として
	// 復号すると置換文字が混ざる。DetectEncoding の修正前は EncSJIS と誤判定
	// され、挿入行が誤ったエンコーディングで書き込まれていた。
	orig := append([]byte{0xC6, 0xFC, 0xCB, 0xDC, 0xB8, 0xEC}, '\n') // "日本語\n" in EUC-JP
	p := write(t, orig)
	f, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if f.enc != search.EncEUCJP {
		t.Fatalf("enc = %v, want EncEUCJP", f.enc)
	}
	if s, ok := f.LineUTF8(1); !ok || s != "日本語" {
		t.Fatalf("LineUTF8 = %q, %v, want 日本語", s, ok)
	}
	if err := f.InsertAfter(1, []string{"追加行"}); err != nil {
		t.Fatal(err)
	}
	if err := f.Save(); err != nil {
		t.Fatal(err)
	}
	wantAdded, _, err := transform.Bytes(japanese.EUCJP.NewEncoder(), []byte("追加行"))
	if err != nil {
		t.Fatal(err)
	}
	want := append(append(append([]byte{}, orig...), wantAdded...), '\n')
	if got := read(t, p); string(got) != string(want) {
		t.Fatalf("got % X\nwant % X", got, want)
	}
}

func TestMatchGuardRejectsLossyDecode(t *testing.T) {
	// 異なる SJIS バイト列が同じ置換文字混じりの UTF-8 文字列に復号され得る。
	// U+FFFD を含む復号結果は完全一致比較の根拠にならないので、
	// DeleteLine / ReplaceLine は一致して見えても拒否しなければならない
	// with ErrMismatch instead of risking touching the wrong line.
	//
	// 0x81 0x3F is not a valid SJIS sequence (0x3F is not a valid trail
	// byte), so it decodes with a replacement character.
	p := write(t, []byte{0x82, 0xA0, 0x0A, 0x81, 0x3F, 0x0A}) // "あ\n" + invalid-SJIS line + \n
	f, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	line2, ok := f.LineUTF8(2)
	if !ok {
		t.Fatal("LineUTF8(2) not ok")
	}
	if !strings.ContainsRune(line2, utf8.RuneError) {
		t.Fatalf("expected line 2 to contain a replacement char, got %q", line2)
	}
	// 復号結果と同じ文字列を渡し返しても拒否されること: 文字列の一致は
	// 元のバイト列が一致する証拠にならない。
	if err := f.DeleteLine(2, line2); !errors.Is(err, ErrMismatch) {
		t.Fatalf("DeleteLine err = %v, want ErrMismatch", err)
	}
	if err := f.ReplaceLine(2, line2, "new"); !errors.Is(err, ErrMismatch) {
		t.Fatalf("ReplaceLine err = %v, want ErrMismatch", err)
	}
}

func TestSaveOnReadOnlyFile(t *testing.T) {
	// Save が制限されたパーミッションのファイルを黙って 0644 に広げないこと。
	// POSIX では Save 後の Stat().Mode().Perm() が read-only のままであることを
	// 直接確認できる。Windows の os.FileMode は書込可/読取専用の2値しか区別
	// せず (chmod 0600/0644/0666 はどれも -rw-rw-rw- に見える)、os.Rename は
	// 読取専用ファイルへの上書きを拒否するため、真に読取専用な元ファイルでの
	// 往復は Windows では検証できない (rename 段階の失敗はこの修正と無関係な
	// 既存の制約)。両プラットフォームで検証できるのは「rename 直前に書く
	// 一時ファイルが固定の 0644 ではなく元ファイルのパーミッションを引き継ぐ
	// こと」で、それがこの修正の実挙動そのもの。
	p := write(t, []byte("one\ntwo\n"))
	if err := os.Chmod(p, 0o444); err != nil {
		t.Fatal(err)
	}
	f, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.InsertAfter(1, []string{"mid"}); err != nil {
		t.Fatal(err)
	}
	saveErr := f.Save()
	tmp := p + ".gn.tmp"
	if saveErr == nil {
		// POSIX: rename が成功した場合、最終ファイルは read-only のままのはず。
		fi, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm()&0o200 != 0 {
			t.Fatalf("Save widened permissions: got %v, want read-only", fi.Mode())
		}
		return
	}
	// Windows: 読取専用の元ファイルへの rename は失敗し、一時ファイルが残る。
	// その一時ファイルが固定の 0644 ではなく元ファイルの (この場合は読取専用の)
	// パーミッションで作られていることを確認する。
	fi, err := os.Stat(tmp)
	if err != nil {
		t.Fatalf("Save failed (%v) and tmp file %s is also missing: %v", saveErr, tmp, err)
	}
	if fi.Mode().Perm()&0o200 != 0 {
		t.Fatalf("tmp file mode = %v, want read-only (inherited from source)", fi.Mode())
	}
	os.Chmod(tmp, 0o644)
	os.Remove(tmp)
}
