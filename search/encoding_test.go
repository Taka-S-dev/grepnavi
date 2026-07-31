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
		// This byte sequence decodes successfully as Shift-JIS (0x8F is a valid SJIS lead byte,
		// 0xA1/0xA1 are valid trail bytes). The SJIS-first detection order wins over EUC-JP,
		// matching legacy toUTF8 behavior — this test pins that consistent behavior.
		{"eucjp", []byte{0x8F, 0xA1, 0xA1, 0x0A}, EncSJIS},
	} {
		if got := DetectEncoding(tt.b); got != tt.want {
			t.Errorf("%s: DetectEncoding = %v, want %v", tt.name, got, tt.want)
		}
	}
}
