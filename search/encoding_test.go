package search

import "testing"

func TestDetectEncoding(t *testing.T) {
	for _, tt := range []struct {
		name string
		b    []byte
		want Encoding
	}{
		{"utf8", []byte("int foo;\n"), EncUTF8},
		{"utf8 bom", []byte{0xEF, 0xBB, 0xBF, 'a'}, EncUTF8BOM},
		{"utf16 le", []byte{0xFF, 0xFE, 'a', 0x00}, EncUTF16LE},
		{"utf16 be", []byte{0xFE, 0xFF, 0x00, 'a'}, EncUTF16BE},
		// "あ" in Shift-JIS
		{"sjis", []byte{0x82, 0xA0, 0x0A}, EncSJIS},
		// "日本語" in EUC-JP. Decoded as Shift-JIS this produces a U+FFFD
		// (0xfc is not a valid SJIS trail byte after lead 0xcb), while EUC-JP
		// decodes it cleanly, so the substitution-count scoring picks EUC-JP.
		{"eucjp", []byte{0xC6, 0xFC, 0xCB, 0xDC, 0xB8, 0xEC, 0x0A}, EncEUCJP},
	} {
		if got := DetectEncoding(tt.b); got != tt.want {
			t.Errorf("%s: DetectEncoding = %v, want %v", tt.name, got, tt.want)
		}
	}
}
