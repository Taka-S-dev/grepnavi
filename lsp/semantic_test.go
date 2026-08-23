package lsp

import (
	"reflect"
	"testing"

	"grepnavi/search"
)

func TestMacroTokens(t *testing.T) {
	macros := []string{"FOO", "MAX_LEN", "likely"} // ソート済み前提
	src := []byte("/* FOO in comment */\n" +       // コメント内は対象外
		"x = FOO; // FOO again\n" + // 行コメント内も対象外
		"s = \"FOO\"; y = MAX_LEN;\n" + // 文字列内は対象外、MAX_LEN は対象
		"if (likely(z)) {}\n" + // 大文字なし → GUI と同じく除外
		"PACKET pkt; size_t n;\n") // 型名は type(=1)、小文字でも対象
	got := symbolTokens(src, search.SymbolsByKind{Macros: macros, Types: []string{"PACKET", "size_t"}})
	// (deltaLine, deltaStart, length, type, modifiers)
	want := []int{
		1, 4, 3, 0, 0, // 2行目 col 4 の FOO
		1, 15, 7, 0, 0, // 3行目 col 15 の MAX_LEN
		2, 0, 6, 1, 0, // 5行目 PACKET (type)
		0, 12, 6, 1, 0, // 同じ行 size_t (type)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("tokens = %v, want %v", got, want)
	}
}

func TestMacroTokensUTF16Column(t *testing.T) {
	// 日本語コメントの後ろ: 列は UTF-16 単位で数える（「状態」は 2 単位）
	src := []byte("a = 1; /* 状態 */ b = FOO;\n")
	got := symbolTokens(src, search.SymbolsByKind{Macros: []string{"FOO"}})
	// "a = 1; /* 状態 */ b = " は UTF-16 で 20 単位
	want := []int{0, 20, 3, 0, 0}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("tokens = %v, want %v", got, want)
	}
}

func TestTypeTokensOnlyInTypePosition(t *testing.T) {
	types := []string{"PACKET", "md", "ssl_st", "version"} // md / version は衝突しがちな小文字の型名
	src := []byte("unsigned char md[16];\n" +              // 変数 md: 直後が [ → 塗らない
		"unsigned int version;\n" + // 変数 version: 直後が ; → 塗らない
		"PACKET pkt;\n" + // 宣言 → 塗る
		"struct ssl_st *s;\n" + // struct の直後 → 塗る
		"version = 3;\n") // 代入 → 塗らない
	got := symbolTokens(src, search.SymbolsByKind{Types: types})
	want := []int{
		2, 0, 6, 1, 0, // PACKET
		1, 7, 6, 1, 0, // ssl_st
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("tokens = %v, want %v", got, want)
	}
}
