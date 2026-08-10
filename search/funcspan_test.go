package search

import (
	"strings"
	"testing"
)

func spansOf(src string) []funcSpan {
	return scanFuncSpans(codeOnlyLines(strings.Split(src, "\n")))
}

type styleCase struct {
	name string
	src  string
	want []funcSpan
}

// styleCaseSources は不変条件テストからも使う。手で書いた形の一覧を
// 2箇所に持つと、片方に足したときにもう片方が守られなくなる。
func styleCaseSources() []styleCase { return scanFuncSpanCases }

var scanFuncSpanCases = []styleCase{
		{
			name: "列0のブレース（K&R / Linux 形式）",
			src: "int top(void)\n{\n\treturn 1;\n}\n",
			want: []funcSpan{{"top", 1, 4}},
		},
		{
			name: "同じ行のブレース",
			src: "int same(void) {\n\treturn 1;\n}\n",
			want: []funcSpan{{"same", 1, 3}},
		},
		{
			name: "本体がインデントされている（いまの実装が落とす形）",
			src: "    int indented(void)\n    {\n        return 1;\n    }\n",
			want: []funcSpan{{"indented", 1, 4}},
		},
		{
			name: "戻り値がマクロで複数行シグネチャ",
			src: "static STACK_OF(GENERAL_NAME) *\nparse_names(const char *s,\n            int flags)\n{\n\treturn NULL;\n}\n",
			want: []funcSpan{{"parse_names", 1, 6}},
		},
		{
			name: "初期化子は変数名の範囲になり、次の関数を巻き込まない",
			src: "static const struct ops my_ops = {\n\t.read = do_read,\n};\nint after(void)\n{\n\treturn 0;\n}\n",
			want: []funcSpan{{"my_ops", 1, 3}, {"after", 4, 7}},
		},
		{
			name: "struct 定義は関数ではない",
			src: "struct point {\n\tint x;\n};\nint use(void)\n{\n\treturn 0;\n}\n",
			want: []funcSpan{{"use", 4, 7}},
		},
		{
			name: "内側のブロックで関数が終わったことにしない",
			src: "int outer(int a)\n{\n\tif (a) {\n\t\ta++;\n\t}\n\twhile (a) {\n\t\ta--;\n\t}\n\treturn a;\n}\n",
			want: []funcSpan{{"outer", 1, 10}},
		},
		{
			name: "C++ のクラス内メソッド",
			src: "class Foo {\npublic:\n    int method(int a)\n    {\n        return a;\n    }\n};\n",
			want: []funcSpan{{"method", 3, 6}},
		},
		{
			name: "連続する関数",
			src: "void a(void)\n{\n}\nvoid b(void)\n{\n}\n",
			want: []funcSpan{{"a", 1, 3}, {"b", 4, 6}},
		},
		{
			// openssl の s_server.c 実物で踏んだ形。`\` で続く行は `#` で始まらないため
			// マクロ本体が次のシグネチャに連結され、`==` のせいで初期化子と誤判定されて
			// s_server_main（1200行）が丸ごと消えた
			name: "複数行の #define の直後の関数",
			src:  "#define IS_FLAG(o) \\\n (o == OPT_A || o == OPT_B \\\n  || o == OPT_C)\n\nint after_macro(int argc)\n{\n\treturn 0;\n}\n",
			want: []funcSpan{{"after_macro", 5, 8}},
		},
		{
			// 関数ポインタ表は関数ではないが、「どこで登録されたか」を示せるよう
			// テーブル変数の名前で範囲を作る（呼び出し元一覧がこれを出す）
			name: "ファイルスコープのテーブルは変数名で範囲を作る",
			src:  "static const OPTIONS opts[] = {\n\t{\"verify\", do_verify},\n\t{NULL, NULL}\n};\n",
			want: []funcSpan{{"opts", 1, 4}},
		},
		{
			name: "名前の取れない型定義は範囲を作らない",
			src:  "typedef struct {\n\tsize_t alloced;\n} buf_t;\ntypedef enum {\n\tOPT_A,\n} choice_t;\n",
			want: nil,
		},
		{
			// openssl の ssl_lib.c / ssl_sess.c に10個ある形。最後の `)` だけを見ると
			// 戻り値側の括弧に当たって名前が取れず、関数ごと見えなくなっていた
			name: "関数ポインタを返す関数",
			src:  "int (*SSL_get_verify_callback(const SSL *s)) (int, X509_STORE_CTX *) {\n\treturn s->cb;\n}\n",
			want: []funcSpan{{"SSL_get_verify_callback", 1, 3}},
		},
		{
			// どちらの名前も構成次第で正しい。大事なのは本体を範囲に収めること
			name: "シグネチャが #ifdef で分岐している",
			src:  "#ifdef ALT\nvoid DES_cbc_encrypt(int a)\n#else\nvoid DES_ncbc_encrypt(int a)\n#endif\n{\n\treturn;\n}\n",
			want: []funcSpan{{"DES_ncbc_encrypt", 2, 8}}, // 範囲は #ifdef 群の先頭から
		},
		{
			// `#if 1` の裏は構成に依らず死ぬ。生かすと両分岐のブレースを数えて
			// 深度がずれ、そのファイルの残り全部の関数が消える（openssl の gcm128.c）
			name: "#if 1 の裏側のブレースを数えない",
			src:  "void f(void)\n{\n#if 1\n\tif (a) {\n#else\n\tif (b) {\n#endif\n\t}\n}\nvoid g(void)\n{\n}\n",
			want: []funcSpan{{"f", 1, 9}, {"g", 10, 12}},
		},
		{
			name: "本体の中の #define のブレースを数えない",
			src:  "void f(void)\n{\n#define LOCAL(x) do { x; } while (0)\n#define OPEN() {\n\treturn;\n}\nvoid g(void)\n{\n}\n",
			want: []funcSpan{{"f", 1, 6}, {"g", 7, 9}},
		},
		{
			// openssl の testutil。`;` の無いマクロ呼び出しが宣言候補に残り、
			// その中の `==` で次の関数が初期化子扱いになって消えていた
			name: "セミコロンの無いマクロ呼び出しの直後の関数",
			src:  "DEFINE_COMPARISON(void *, ptr, eq, ==, \"%p\")\nDEFINE_COMPARISON(void *, ptr, ne, !=, \"%p\")\nint test_ptr_null(const char *file, int line)\n{\n}\n",
			want: []funcSpan{{"test_ptr_null", 1, 5}}, // 範囲はマクロ呼び出しから始まる
		},
		{
			// 両方の分岐が `{` を開いて閉じは1つ。数えすぎると深度が1ずれ、
			// そのファイルの残り全部の関数が消える（openssl gcm128.c / curl multi.c）。
			// 「#else に実装まるごと」は両分岐とも収支0なので巻き込まれない
			name: "両分岐が同じだけブレースを開く #if",
			src:  "void f(void)\n{\n#if defined(A) && defined(B)\n\tif (x && z) {\n#else\n\tif (x) {\n#endif\n\t}\n}\nvoid g(void)\n{\n}\n",
			want: []funcSpan{{"f", 1, 9}, {"g", 10, 12}},
		},
		{
			name: "#else に実装まるごとの形は落とさない",
			src:  "#ifdef HAVE_X\nint impl_a(void)\n{\n}\n#else\nint impl_b(void)\n{\n}\n#endif\n",
			want: []funcSpan{{"impl_a", 2, 4}, {"impl_b", 6, 8}},
		},
		{
			name: "プロトタイプ宣言は範囲を作らない",
			src: "int declared(void);\nint impl(void)\n{\n\treturn 0;\n}\n",
			want: []funcSpan{{"impl", 2, 5}},
		},
}

func TestScanFuncSpansStyles(t *testing.T) {
	for _, c := range scanFuncSpanCases {
		got := spansOf(c.src)
		if len(got) != len(c.want) {
			t.Errorf("%s: 件数 got=%d want=%d (%+v)", c.name, len(got), len(c.want), got)
			continue
		}
		for i := range c.want {
			if got[i] != c.want[i] {
				t.Errorf("%s: [%d] got=%+v want=%+v", c.name, i, got[i], c.want[i])
			}
		}
	}
}

func TestEnclosingSpanFindsInnermost(t *testing.T) {
	spans := spansOf("void a(void)\n{\n\tx();\n}\n\nvoid b(void)\n{\n\ty();\n}\n")
	for _, tc := range []struct {
		line int
		want string
	}{
		{1, "a"}, {3, "a"}, {4, "a"},
		{5, ""}, // 関数の外
		{6, "b"}, {8, "b"},
	} {
		got, ok := enclosingSpan(spans, tc.line)
		if tc.want == "" {
			if ok {
				t.Errorf("%d行目: 関数の外なのに %q を返した", tc.line, got.Name)
			}
			continue
		}
		if !ok || got.Name != tc.want {
			t.Errorf("%d行目: got=%q(%v) want=%q", tc.line, got.Name, ok, tc.want)
		}
	}
}

// 本体の中の行では、既存実装と同じ関数名になること（後退させない）。
//
// 本体の外まで比べても意味が無い。既存実装は `}` の次の空行や、次の関数の
// シグネチャ行を「ひとつ前の関数の中」と答えるため、そこを合わせにいくと
// 誤りのほうに寄せることになる。
func TestScanFuncSpansAgreesInsideBodies(t *testing.T) {
	lines := benchCFile(8, 30)
	spans := scanFuncSpans(codeOnlyLines(lines))
	if len(spans) != 8 {
		t.Fatalf("関数の数 got=%d want=8", len(spans))
	}
	checked := 0
	for _, sp := range spans {
		for line := sp.Start + 2; line < sp.End; line++ { // シグネチャと `{` を除く本体
			if strings.TrimSpace(lines[line-1]) == "" {
				continue
			}
			oldName, _ := findContainingFunc(lines, line)
			got, ok := enclosingSpan(spans, line)
			if !ok || got.Name != sp.Name {
				t.Fatalf("%d行目: 新=%q(%v) want=%q", line, got.Name, ok, sp.Name)
			}
			if oldName != "" && oldName != sp.Name {
				t.Errorf("%d行目 %q: 旧=%q 新=%q", line, strings.TrimSpace(lines[line-1]), oldName, sp.Name)
			}
			checked++
		}
	}
	if checked < 100 {
		t.Errorf("比較した行が少なすぎる: %d", checked)
	}
}
