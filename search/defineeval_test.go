package search

import (
	"strings"
	"testing"
)

func TestEvalDefineExpr(t *testing.T) {
	defs := map[string]string{
		"FATAL":   "64",
		"MALLOC":  "(1|FATAL)",
		"MASK":    "0xff",
		"BIG":     "0xFFFFFFFFFFFFFFFF",
		"SUFFIX":  "16UL",
		"UFLAG":   "0x80000BFFU",
		"LOOP_A":  "LOOP_B",
		"LOOP_B":  "LOOP_A",
		"DIAMOND": "(HI|LO)",
		"HI":      "(BASE<<4)",
		"LO":      "BASE",
		"BASE":    "3",
	}
	resolve := func(name string) (string, bool) {
		e, ok := defs[name]
		return e, ok
	}

	cases := []struct {
		expr string
		want int64
		ok   bool
	}{
		{"1|64", 65, true},
		{"(2 | FATAL)", 66, true},
		{"1|2<<3", 17, true},        // << は | より強い
		{"2+3*4", 14, true},         // * は + より強い
		{"(2+3)*4", 20, true},       // 括弧が勝つ
		{"1<<4|1<<2", 20, true},     // シフト同士の OR
		{"0x10 + 010", 24, true},        // 16進と8進
		{"1<<2+3", 32, true},            // シフトは加算より弱い（C準拠）
		{"SUFFIX", 16, true},            // UL 接尾辞（正の値のままなら U でも一致）
		{"UFLAG", 2147486719, true},     // openssl の SSL_OP 系フラグの形
		{"0xffffffffU >> 8", 0xffffff, true}, // 左辺が非負なら論理/算術シフトは一致
		{"~0", -1, true},                // 単項 NOT（符号付き int の C と一致）
		{"~~0", 0, true},                // 単項の重ね掛け
		{"- -1", 1, true},
		{"-FATAL", -64, true},           // 単項マイナス + 解決
		{"MALLOC", 65, true},            // 識別子の入れ子解決
		{"MASK & 0x0f", 15, true},
		{"0x1FL", 31, true},             // 16進 + L 接尾辞
		{"100 / 7 % 5", 4, true},        // 左結合
		{"-7 / 2", -3, true},            // 符号付き除算はゼロ方向切り捨てで C と一致
		{"DIAMOND", 51, true},           // 同じ識別子を2経路から参照（循環ではない）
		{"BIG", 0, false},               // int64 に収まらない値は幅の解釈が要るので対象外
		{"~16U", 0, false},              // 符号なしの ~ は幅で値が変わる
		{"-1U", 0, false},               // 符号なしの単項マイナスはラップする
		{"1U - 2", 0, false},            // 符号なし演算が負に落ちたらラップ。再現しない
		{"-1 >> 1", 0, false},           // 負値の >> は処理系依存
		{"LOOP_A", 0, false},            // 循環定義
		{"UNKNOWN", 0, false},           // 解決不能
		{"1/0", 0, false},               // ゼロ除算
		{"1%0", 0, false},
		{"1<<64", 0, false},             // シフト範囲外
		{"1 ? 2 : 3", 0, false},         // 三項演算子は対象外
		{"1 < 2", 0, false},             // 比較は対象外
		{"1 || 0", 0, false},            // 論理演算は対象外
		{"FOO(1)", 0, false},            // 関数形式マクロの呼び出し
		{"sizeof(int)", 0, false},       // sizeof も識別子+( で落ちる
		{"1.5", 0, false},               // 浮動小数
		{"089", 0, false},               // 不正な8進
		{"1_000", 0, false},             // Go にしかない数字区切り
		{"0o17", 0, false},              // Go にしかない8進表記
		{"'a'", 0, false},               // 文字リテラル
		{"\"str\"", 0, false},           // 文字列
		{"(1", 0, false},                // 括弧不整合
		{"1 2", 0, false},               // 演算子なしで値が並ぶ
		{"", 0, false},
	}
	for _, c := range cases {
		got, ok := evalDefineExpr(c.expr, resolve)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("evalDefineExpr(%q) = (%d, %v), want (%d, %v)", c.expr, got, ok, c.want, c.ok)
		}
	}
}

func TestDefineReplacement(t *testing.T) {
	cases := []struct {
		name string
		body string
		def  string // 探す名前
		want string
		ok   bool
	}{
		{"単純", "#define FATAL 64", "FATAL", "64", true},
		{"式", "# define ERR (2|FATAL)", "ERR", "(2|FATAL)", true},
		{"先頭コメント付き本文", "/* fatal error */\n#define ERR (1|64)", "ERR", "(1|64)", true},
		{"行末コメント除去", "#define ERR 64 /* mask */", "ERR", "64", true},
		{"継続行の連結", "#define ERR (1| \\\n    64)", "ERR", "(1| 64)", true},
		{"関数形式は拒否", "#define F(x) ((x)|1)", "F", "", false},
		{"名前と ( の間の空白は置換部", "#define A (64)", "A", "(64)", true},
		{"名前不一致は拒否", "#define OTHER 64", "ERR", "", false},
		{"置換部なし", "#define FLAG", "FLAG", "", false},
		{"式の途中のコメント", "#define A (1|/*x*/2)", "A", "(1|2)", true},
		// 直前コメントにコメントアウトされた旧定義が残っている形。状態なしで
		// 走査すると旧定義 (1|32) を拾って誤値になる
		{"コメント内の旧定義を無視",
			"/* Formerly:\n#define ERR_MASK (1|32)\n   now stricter */\n#define ERR_MASK (1|64)",
			"ERR_MASK", "(1|64)", true},
		{"未終端コメントは拒否", "#define A 1|2 /* comment", "A", "", false},
		{"継続行で閉じないコメントも拒否", "#define A (1| \\\n2 /* c \\\n) */", "A", "", false},
	}
	for _, c := range cases {
		got, ok := defineReplacement(c.body, c.def)
		if ok != c.ok || got != c.want {
			t.Errorf("%s: defineReplacement = (%q, %v), want (%q, %v)", c.name, got, ok, c.want, c.ok)
		}
	}
}

func TestIsBareIntLiteral(t *testing.T) {
	for expr, want := range map[string]bool{
		"64":       true,
		"(64)":     true,
		"((0x40))": true,
		"-1":       true,
		"(1|64)":   false,
		"FATAL":    false,
		"~0":       false,
	} {
		if got := isBareIntLiteral(expr); got != want {
			t.Errorf("isBareIntLiteral(%q) = %v, want %v", expr, got, want)
		}
	}
}

// ホバー統合: openssl の ERR_R_* と同じ形の定義で値が付くこと、
// 付けてはいけないケース（素のリテラル・多重定義の食い違い・関数形式）で
// 付かないことを確認する。
func TestHoverDefineValues(t *testing.T) {
	requireRg(t)
	dir := t.TempDir()
	write(t, dir+"/err.h",
		"#define ERR_R_FATAL 64\n"+
			"#define ERR_R_MALLOC_FAILURE (1|ERR_R_FATAL)\n"+
			"#define ERR_R_PLAIN 64\n"+
			"#define ERR_ALIAS ERR_R_FATAL\n"+
			"#define ERR_FN(x) ((x)|1)\n"+
			"#define ERR_USES_FN (ERR_FN(1)|2)\n"+
			"#define AMBIG_USER (AMBIG|1)\n"+
			"#define AMBIG 1\n")
	write(t, dir+"/other.h",
		"#define AMBIG 2\n")

	hoverValue := func(word string) string {
		t.Helper()
		hits, _, err := FindHover(t.Context(), word, dir, "", dir)
		if err != nil {
			t.Fatal(err)
		}
		for _, h := range hits {
			if !h.Chained {
				return h.Value
			}
		}
		return ""
	}

	if v := hoverValue("ERR_R_MALLOC_FAILURE"); v != "65" {
		t.Errorf("(1|ERR_R_FATAL) の値 = %q, want 65", v)
	}
	if v := hoverValue("ERR_R_PLAIN"); v != "" {
		t.Errorf("素のリテラルに値が付いた: %q", v)
	}
	if v := hoverValue("ERR_ALIAS"); v != "64" {
		t.Errorf("別名の値 = %q, want 64", v)
	}
	if v := hoverValue("ERR_USES_FN"); v != "" {
		t.Errorf("関数形式マクロを含む式に値が付いた: %q", v)
	}
	if v := hoverValue("AMBIG_USER"); v != "" {
		t.Errorf("多重定義（食い違い）を解決してしまった: %q", v)
	}

	// 連鎖カード側にも式なら値が付く（別名 → 式 → 値の途中段）
	hits, _, err := FindHover(t.Context(), "ERR_ALIAS", dir, "", dir)
	if err != nil {
		t.Fatal(err)
	}
	var chainBodies []string
	for _, h := range hits {
		if h.Chained {
			chainBodies = append(chainBodies, h.Body+" [value="+h.Value+"]")
		}
	}
	joined := strings.Join(chainBodies, "\n")
	if !strings.Contains(joined, "ERR_R_FATAL 64") {
		t.Errorf("別名連鎖カードが無い:\n%s", joined)
	}
}
