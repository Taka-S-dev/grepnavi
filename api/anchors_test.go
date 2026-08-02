package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// インデントだけ変わった行を「ずれ」と言われると実用にならない。
// 逆に中身が変わったものは見逃してはいけない。
func TestSameAnchorText(t *testing.T) {
	same := [][2]string{
		{"int foo(void)", "int foo(void)"},
		{"\tint foo(void)", "    int foo(void)"}, // インデント変更
		{"  }  ", "}"},
		{"", "   "},
	}
	diff := [][2]string{
		{"int foo(void)", "int bar(void)"},
		{"int foo(void)", "int foo(int x)"},
		{"}", "};"},
		{"int foo(void)", ""},
	}
	for _, p := range same {
		if !sameAnchorText(p[0], p[1]) {
			t.Errorf("sameAnchorText(%q, %q) = false, want true", p[0], p[1])
		}
	}
	for _, p := range diff {
		if sameAnchorText(p[0], p[1]) {
			t.Errorf("sameAnchorText(%q, %q) = true, want false", p[0], p[1])
		}
	}
}

func TestLineTextAt(t *testing.T) {
	f := writeTempLines(t, []string{"one", "two", "three"})
	for _, tt := range []struct {
		line int
		want string
		ok   bool
	}{
		{1, "one", true},
		{3, "three", true},
		{4, "", false}, // 末尾を超えた = 行が消えた
		{0, "", false},
	} {
		got, ok := lineTextAt(f, tt.line)
		if got != tt.want || ok != tt.ok {
			t.Errorf("lineTextAt(line=%d) = (%q, %v), want (%q, %v)", tt.line, got, ok, tt.want, tt.ok)
		}
	}
	if _, ok := lineTextAt("", 1); ok {
		t.Error("空のファイル名で ok=true")
	}
}

func writeTempLines(t *testing.T, lines []string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "a.c")
	if err := os.WriteFile(p, []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestSplitMemoKey(t *testing.T) {
	// Windows のパスは "C:" を含むので、末尾側の "::" で切らないと壊れる
	f, l, ok := splitMemoKey(`C:\proj\src\a.c::123`)
	if !ok || f != `C:\proj\src\a.c` || l != 123 {
		t.Errorf("got (%q, %d, %v)", f, l, ok)
	}
	for _, bad := range []string{"", "no-separator", "a.c::", "a.c::abc", "a.c::0", "a.c::-3"} {
		if _, _, ok := splitMemoKey(bad); ok {
			t.Errorf("splitMemoKey(%q) = ok, want not ok", bad)
		}
	}
}

// 既存メモに今の行を埋めると、既にずれているメモを「ずれていない」ことにしてしまう。
// 新しく現れたキー（旧 LineMemos に無いキー）だけ記録し、消えたメモのエントリは落とす。
func TestCaptureMemoAnchors(t *testing.T) {
	h := &Handler{}
	f := writeTempLines(t, []string{"one", "two", "three"})
	prevTexts := map[string]string{f + "::1": "元のテキスト"}
	memos := map[string]string{
		f + "::1": "既存のメモ",
		f + "::2": "新しいメモ",
		f + "::3": "記録の無い旧メモ",
		f + "::9": "行が存在しない",
	}
	// ::3 は前回から存在するが記録が無い = 旧データのメモ。
	// ここで今の行を控えると、既にずれた位置を「正しい」ことにしてしまう。
	prevMemos := map[string]string{
		f + "::1": "既存のメモ",
		f + "::3": "記録の無い旧メモ",
	}
	got := h.captureMemoAnchors(prevMemos, prevTexts, memos)

	if got[f+"::1"] != "元のテキスト" {
		t.Errorf("既存キーが上書きされた: %q", got[f+"::1"])
	}
	if got[f+"::2"] != "two" {
		t.Errorf("新規キーが記録されていない: %q", got[f+"::2"])
	}
	if v, ok := got[f+"::3"]; ok {
		t.Errorf("記録の無い旧メモに今の行を埋めてはいけない: %q", v)
	}
	if _, ok := got[f+"::9"]; ok {
		t.Error("存在しない行を記録してはいけない")
	}
	// 消えたメモは残さない
	if got2 := h.captureMemoAnchors(prevMemos, prevTexts, map[string]string{}); got2 != nil {
		t.Errorf("メモが空なら nil、got %+v", got2)
	}
	if got3 := h.captureMemoAnchors(prevMemos, prevTexts, map[string]string{f + "::2": "x"}); len(got3) != 1 {
		t.Errorf("消えたキーが残っている: %+v", got3)
	}
}

// MCP 経由のノードは grepnavi_root 基準の相対パスで来ることがある。
// 生のまま開くと cwd 依存で失敗し、偽の「行なし」判定になる。
func TestAbsFromRoot(t *testing.T) {
	// Windows パスをベタ書きすると Linux の CI で filepath の解釈が変わり
	// 落ちるため、実行 OS で組み立てた絶対パスを使う。
	root := t.TempDir()
	h := &Handler{root: root}
	if got := h.absFromRoot(filepath.Join("src", "a.c")); got != filepath.Join(root, "src", "a.c") {
		t.Errorf("相対パスが root で解決されていない: %q", got)
	}
	abs := filepath.Join(root, "b.c")
	if got := h.absFromRoot(abs); got != abs {
		t.Errorf("絶対パスは素通しのはず: %q", got)
	}
	if got := h.absFromRoot(""); got != "" {
		t.Errorf("空文字は素通しのはず: %q", got)
	}
}

// `}` のような頻出行は複数一致になり自動追従の対象外になる。
// この「曖昧なら動かない」性質が自動修正の安全性そのもの。
func TestUniqueAnchorLine(t *testing.T) {
	lines := []string{"int foo(void)", "{", "\treturn 0;", "}", "int bar(void)", "{", "}"}
	if got, ok := uniqueAnchorLine(lines, "return 0;"); !ok || got != 3 {
		t.Errorf("一意一致: got (%d, %v), want (3, true)", got, ok)
	}
	if got, ok := uniqueAnchorLine(lines, "  int foo(void)  "); !ok || got != 1 {
		t.Errorf("trim 比較のはず: got (%d, %v)", got, ok)
	}
	if _, ok := uniqueAnchorLine(lines, "}"); ok {
		t.Error("複数一致で ok=true になってはいけない")
	}
	if _, ok := uniqueAnchorLine(lines, "no such line"); ok {
		t.Error("0件で ok=true になってはいけない")
	}
}

