package search

import (
	"strings"
	"testing"
)

func spansOf(src string) []funcSpan {
	return scanFuncSpans(codeOnlyLines(strings.Split(src, "\n")))
}

func TestScanFuncSpansStyles(t *testing.T) {
	cases := []struct {
		name string
		src  string
		want []funcSpan
	}{
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
			name: "プロトタイプ宣言は範囲を作らない",
			src: "int declared(void);\nint impl(void)\n{\n\treturn 0;\n}\n",
			want: []funcSpan{{"impl", 2, 5}},
		},
	}
	for _, c := range cases {
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
