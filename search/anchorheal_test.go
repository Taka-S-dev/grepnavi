package search

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestHealLineIn(t *testing.T) {
	lines := []string{
		"#include <stdio.h>",
		"",
		"void target(void)",
		"{",
		"\tint  x = 0;",
		"}",
		"",
		"void twin(void)",
		"{",
		"}",
		"void twin(void)",
	}

	cases := []struct {
		name string
		line int
		text string
		want int
	}{
		{"ずれていなければそのまま", 3, "void target(void)", 3},
		{"ずれていれば一意な行へ移す", 1, "void target(void)", 3},
		{"上方向にも移す", 5, "void target(void)", 3},
		{"索引は空白を畳むので畳んで比べる", 1, "int x = 0;", 5},
		{"畳み込みの違いだけで動かさない", 5, "int x = 0;", 5},
		{"行き先が複数なら動かさない", 3, "void twin(void)", 3},
		{"一致する行が無ければ動かさない", 3, "void gone(void)", 3},
		{"識別子だけの手掛かりは使わない", 3, "target", 3},
		{"ファイル末尾より後ろでも一意なら移す", 99, "void target(void)", 3},
		{"行番号が不正なら触らない", 0, "void target(void)", 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := HealLineIn(lines, c.line, AnchorKey(c.text)); got != c.want {
				t.Errorf("HealLineIn(%d, %q) = %d, want %d", c.line, c.text, got, c.want)
			}
		})
	}
}

// 書式だけが違う双子の行があるとき、畳み込み比較なら両方に一致して
// 「複数一致」になり動かない。畳み込まないと片方だけに一意一致して、
// 正しい着地点を壊す。
func TestHealLineInKeepsLineWhenFormattingTwinExists(t *testing.T) {
	lines := []string{"#define FOO 1", "#else", "#define FOO\t1", "#endif"}
	key := AnchorKey("#define FOO 1")

	if got := HealLineIn(lines, 3, key); got != 3 {
		t.Errorf("タブ揃えの行に一致しているのに動かした: got %d, want 3", got)
	}
	if got := HealLineIn(lines, 4, key); got != 4 {
		t.Errorf("双子の行があるときは動かさないはず: got %d, want 4", got)
	}
}

func TestHealLineReadsFile(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.c")
	write(t, src, "printf(\"dbg\\n\");\n\nvoid target(void)\n{\n}\n")

	if got := HealLine(src, 1, "void target(void)"); got != 3 {
		t.Errorf("HealLine = %d, want 3", got)
	}
	if got := HealLine(filepath.Join(dir, "missing.c"), 1, "void target(void)"); got != 1 {
		t.Errorf("読めないファイルでは動かさないはず: got %d", got)
	}
	if got := HealLine("", 7, "void target(void)"); got != 7 {
		t.Errorf("パスが無ければ動かさないはず: got %d", got)
	}
}

// indexedDir は索引 (GRTAGS) を持つディレクトリを作り、その更新時刻を返す。
// ずれの判定はファイルと索引の更新時刻の比較なので、テストは時刻を明示する。
func indexedDir(t *testing.T) (string, time.Time) {
	t.Helper()
	dir := t.TempDir()
	write(t, filepath.Join(dir, "GRTAGS"), "dummy")
	fi, err := os.Stat(filepath.Join(dir, "GRTAGS"))
	if err != nil {
		t.Fatal(err)
	}
	return dir, fi.ModTime()
}

func writeAged(t *testing.T, path, content string, mod time.Time) {
	t.Helper()
	write(t, path, content)
	if err := os.Chtimes(path, mod, mod); err != nil {
		t.Fatal(err)
	}
}

func TestRegatherDriftedRefs(t *testing.T) {
	dir, idx := indexedDir(t)
	drifted := filepath.Join(dir, "drifted.c")
	fresh := filepath.Join(dir, "fresh.c")
	// 索引作成後に 2 行足された想定。参照は 3 行目から 5 行目へ動いている。
	writeAged(t, drifted,
		"/* dbg */\n/* dbg */\nvoid a(void)\n{\n\tfoo(1);\n\t/* foo は上で呼んでいる */\n\tfoobar(2);\n}\n",
		idx.Add(time.Minute))
	writeAged(t, fresh, "void b(void)\n{\n\tfoo(3);\n}\n", idx.Add(-time.Minute))

	hits := []DefHit{
		{File: drifted, Line: 3, Kind: "ref"},
		{File: fresh, Line: 3, Kind: "ref"},
	}
	got := regatherDriftedRefs(hits, "foo", dir, codeOnlyCache{})

	var lines []int
	for _, h := range got {
		if h.File == drifted {
			lines = append(lines, h.Line)
		}
	}
	if len(lines) != 1 || lines[0] != 5 {
		t.Errorf("ずれたファイルの取り直し = %v, want [5] (コメント内の言及と foobar は対象外)", lines)
	}
	last := got[len(got)-1]
	if last.File != fresh || last.Line != 3 {
		t.Errorf("ずれていないファイルのヒットはそのまま残るはず: got %s:%d", last.File, last.Line)
	}
}

// 索引より古いファイルは走査し直さない。コメント内だけの言及を「ずれ」と
// 見てしまうと、最新のファイルまで走査対象になり、結果が別物に置き換わる。
func TestRegatherDriftedRefsKeepsFreshHits(t *testing.T) {
	dir, idx := indexedDir(t)
	src := filepath.Join(dir, "a.c")
	writeAged(t, src, "void a(void)\n{\n\t/* foo は後で呼ぶ */\n\tfoo(1);\n}\n", idx.Add(-time.Minute))

	hits := []DefHit{
		{File: src, Line: 3, Kind: "ref"}, // コメント内の言及（後段の絞り込みで落ちる）
		{File: src, Line: 4, Kind: "ref"},
	}
	got := regatherDriftedRefs(hits, "foo", dir, codeOnlyCache{})
	if len(got) != 2 || got[0].Line != 3 || got[1].Line != 4 {
		t.Errorf("走査し直してはいけない: got %+v", got)
	}
}

// ずれ込んだ先がシンボル名を含むコメントでも取りこぼさない。呼び出しの真上に
// 説明コメントがある形は C ではありふれていて、行の中身でずれを判定すると
// ちょうどこの形を見逃す。
func TestRegatherDriftedRefsWhenDriftLandsOnComment(t *testing.T) {
	dir, idx := indexedDir(t)
	src := filepath.Join(dir, "a.c")
	writeAged(t, src, "/* dbg */\nvoid a(void)\n{\n\t/* ここで foo を呼ぶ */\n\tfoo(1);\n}\n", idx.Add(time.Minute))

	// 索引は 4 行目（挿入前の呼び出し行）を指しているが、そこは今コメント
	hits := []DefHit{{File: src, Line: 4, Kind: "ref"}}
	got := regatherDriftedRefs(hits, "foo", dir, codeOnlyCache{})
	if len(got) != 1 || got[0].Line != 5 {
		t.Errorf("取り直し = %+v, want 5 行目", got)
	}
}

// 関数の中に書かれたマクロ定義は参照ではない。同じ関数から1件しか残らない
// 絞り込みと合わさると、定義行が本物の使用箇所を追い出す。
func TestRegatherDriftedRefsSkipsMacroDefinition(t *testing.T) {
	dir, idx := indexedDir(t)
	src := filepath.Join(dir, "a.c")
	writeAged(t, src, "/* dbg */\nvoid a(void)\n{\n#define FOO 1\n\tint y = FOO + 2;\n}\n", idx.Add(time.Minute))

	hits := []DefHit{{File: src, Line: 4, Kind: "ref"}}
	got := regatherDriftedRefs(hits, "FOO", dir, codeOnlyCache{})
	if len(got) != 1 || got[0].Line != 5 {
		t.Errorf("取り直し = %+v, want 5 行目 (#define 行は参照ではない)", got)
	}
}

// 索引が見当たらないときは、ずれているかを判断できないので触らない。
func TestRegatherDriftedRefsWithoutIndex(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.c")
	write(t, src, "void a(void)\n{\n\tfoo(1);\n}\n")

	hits := []DefHit{{File: src, Line: 99, Kind: "ref"}}
	got := regatherDriftedRefs(hits, "foo", dir, codeOnlyCache{})
	if len(got) != 1 || got[0].Line != 99 {
		t.Errorf("regatherDriftedRefs = %+v, want 索引の値のまま", got)
	}
}

func TestDefinesWord(t *testing.T) {
	for _, s := range []string{"#define FOO 1", "  #  define FOO(x) (x)", "#define FOO"} {
		if !definesWord(s, "FOO") {
			t.Errorf("definesWord(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"\tint y = FOO + 2;", "#define FOOBAR 1", "#defineFOO 1", "#undef FOO"} {
		if definesWord(s, "FOO") {
			t.Errorf("definesWord(%q) = true, want false", s)
		}
	}
}

func TestContainsWord(t *testing.T) {
	if containsWord("foobar(1);", "foo") {
		t.Error("識別子の一部に当ててはいけない")
	}
	if containsWord("x = my_foo;", "foo") {
		t.Error("接尾辞に当ててはいけない")
	}
	if !containsWord("\tfoo(1);", "foo") {
		t.Error("単語として現れていれば当たるはず")
	}
	if !containsWord("foo", "foo") {
		t.Error("行全体が単語の場合も当たるはず")
	}
	if containsWord("foo", "") {
		t.Error("空文字は当てない")
	}
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestUsableAnchor(t *testing.T) {
	// ctags は行番号形式のアドレスだと text がシンボル名そのものになる。
	// それを手掛かりにすると初期化子の中の識別子1個の行に一意一致してしまう。
	for _, s := range []string{"", "   ", "target", "MY_MACRO", "x1"} {
		if UsableAnchor(AnchorKey(s)) {
			t.Errorf("UsableAnchor(%q) = true, want false", s)
		}
	}
	for _, s := range []string{"void target(void)", "#define FOO 1", "int x = 0;"} {
		if !UsableAnchor(AnchorKey(s)) {
			t.Errorf("UsableAnchor(%q) = false, want true", s)
		}
	}
}
