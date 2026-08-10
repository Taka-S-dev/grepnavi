package search

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCodeOnlyLines(t *testing.T) {
	lines := []string{
		`void caller(void) {`,
		`    real_call();`,
		`    /* we queue a work at btrfs_wq_submit_bio(), that runs later */`,
		`    /*`,
		`     * multi line: another_fn() is only mentioned here`,
		`     */`,
		`    // line comment: commented_fn()`,
		`    log("string_fn() inside a literal");`,
		`    mixed_call(); /* trailing comment: ghost_fn() */`,
		`    char c = '"'; after_quote_fn();`,
		`}`,
	}
	code := codeOnlyLines(lines)
	if len(code) != len(lines) {
		t.Fatalf("line count changed: %d -> %d", len(lines), len(code))
	}

	contains := func(i int, sub string) bool { return len(code[i]) > 0 && containsStr(code[i], sub) }

	// コードとして残るべきもの
	for _, tc := range []struct {
		idx int
		sub string
	}{
		{1, "real_call"},
		{8, "mixed_call"},
		{9, "after_quote_fn"}, // 文字リテラルの中の " に惑わされない
	} {
		if !contains(tc.idx, tc.sub) {
			t.Errorf("line %d should keep %q, got %q", tc.idx+1, tc.sub, code[tc.idx])
		}
	}

	// コメント・文字列内なので消えるべきもの
	for _, tc := range []struct {
		idx int
		sub string
	}{
		{2, "btrfs_wq_submit_bio"}, // 実際に誤検出された形（単一行ブロックコメント）
		{4, "another_fn"},          // 複数行ブロックコメントの途中
		{6, "commented_fn"},        // 行コメント
		{7, "string_fn"},           // 文字列リテラル
		{8, "ghost_fn"},            // 行末のブロックコメント
	} {
		if contains(tc.idx, tc.sub) {
			t.Errorf("line %d should drop %q, got %q", tc.idx+1, tc.sub, code[tc.idx])
		}
	}
}

func TestCodeOnlyCacheMentions(t *testing.T) {
	lines := []string{
		`void f(void) {`,
		`    /* mentions target() in prose */`,
		`    target();`,
		`}`,
	}
	c := codeOnlyCache{}
	if c.mentionsInCode("f.c", lines, 2, "target") {
		t.Error("comment-only mention must not count as code")
	}
	if !c.mentionsInCode("f.c", lines, 3, "target") {
		t.Error("real call must count as code")
	}
	// 範囲外の行番号は false
	if c.mentionsInCode("f.c", lines, 99, "target") {
		t.Error("out-of-range line must be false")
	}
}

func TestFindCalleesSkipsComments(t *testing.T) {
	file := filepath.Join(t.TempDir(), "sample.c")
	src := `void caller(void)
{
    real_call();
    /* explains that ghost_call() happens elsewhere */
    // and commented_call() too
    puts("literal_call() in a string");
}
`
	if err := os.WriteFile(file, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	// root は空: ctags 索引による絞り込みを行わず、コメント除去だけを検証する
	hits, _, err := FindCallees(t.Context(), file, 1, "")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, h := range hits {
		got[h.Name] = true
	}
	if !got["real_call"] {
		t.Errorf("real_call should be found, got %v", got)
	}
	for _, ghost := range []string{"ghost_call", "commented_call", "literal_call"} {
		if got[ghost] {
			t.Errorf("%s is inside a comment/string and must not be a callee, got %v", ghost, got)
		}
	}
}

func containsStr(s, sub string) bool { return strings.Contains(s, sub) }

func TestCodeOnlyLinesDropsIf0(t *testing.T) {
	lines := []string{
		`void f(void) {`,        // 1
		`#if 0`,                 // 2
		`	dead_call();`,         // 3
		`#if defined(X)`,        // 4  (無効ブロック内のネスト)
		`	nested_dead_call();`,  // 5
		`#endif`,                // 6
		`#else`,                 // 7
		`	live_in_else();`,      // 8  (#if 0 の裏は生きている)
		`#endif`,                // 9
		`#ifdef CONFIG_MAYBE`,   // 10
		`	config_call();`,       // 11 (構成依存は落とさない)
		`#else`,                 // 12
		`	other_config_call();`, // 13
		`#endif`,                // 14
		`	always_call();`,       // 15
		`}`,                     // 16
	}
	code := codeOnlyLines(lines)

	dead := map[int]string{3: "dead_call", 5: "nested_dead_call"}
	for ln, name := range dead {
		if strings.Contains(code[ln-1], name) {
			t.Errorf("line %d: %s is inside #if 0 and must be dropped, got %q", ln, name, code[ln-1])
		}
	}
	live := map[int]string{8: "live_in_else", 11: "config_call", 13: "other_config_call", 15: "always_call"}
	for ln, name := range live {
		if !strings.Contains(code[ln-1], name) {
			t.Errorf("line %d: %s must be kept, got %q", ln, name, code[ln-1])
		}
	}
}

// codeOnlyLinesRef は置き換え前の実装。行ごとに文字列を作る素直な形で、
// 新しい実装が1文字も振る舞いを変えていないことを突き合わせるために残す。
func codeOnlyLinesRef(lines []string) []string {
	out := make([]string, len(lines))
	inBlock := false
	var condStack []deadFrame
	for i, line := range lines {
		var b strings.Builder
		inStr, inChar := false, false
		for j := 0; j < len(line); j++ {
			c := line[j]
			switch {
			case inBlock:
				if c == '*' && j+1 < len(line) && line[j+1] == '/' {
					inBlock = false
					j++
				}
			case inStr, inChar:
				if c == '\\' {
					j++
					continue
				}
				if (inStr && c == '"') || (inChar && c == '\'') {
					inStr, inChar = false, false
				}
			case c == '/' && j+1 < len(line) && line[j+1] == '*':
				inBlock = true
				j++
			case c == '/' && j+1 < len(line) && line[j+1] == '/':
				j = len(line)
			case c == '"':
				inStr = true
			case c == '\'':
				inChar = true
			default:
				b.WriteByte(c)
			}
		}
		stripped := b.String()
		condStack = applyCondDirective(condStack, stripped)
		if anyDead(condStack) {
			stripped = ""
		}
		out[i] = stripped
	}
	return out
}

func TestCodeOnlyLinesMatchesReference(t *testing.T) {
	corpora := map[string][]string{
		"生成コード": benchCFile(6, 25),
		"手書き": {
			`#include <stdio.h>`,
			`/* block comment with "quote" and { brace`,
			`   still inside */ int live_after_comment;`,
			`char *s = "text /* not a comment */ with \" escape";`,
			`char c = '\'';`,
			`  # if 0`,
			`  dead_call();`,
			`  #else`,
			`  live_call();`,
			`  #endif`,
			`#ifdef CONFIG_X`,
			`  conditional_call(); // trailing comment`,
			`#endif`,
			``,
			`int tail; /* unterminated`,
			`still swallowed`,
		},
		"空":     {},
		"空行だけ": {"", "", ""},
	}
	for name, lines := range corpora {
		got := codeOnlyLines(lines)
		want := codeOnlyLinesRef(lines)
		if len(got) != len(want) {
			t.Fatalf("%s: 行数が違う got=%d want=%d", name, len(got), len(want))
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("%s: [%d] got=%q want=%q", name, i+1, got[i], want[i])
			}
		}
	}
}

// `#if 1` の裏は構成に依らず死ぬ。ここを生かすと、コンパイルされないコードの
// 中の識別子が参照として一覧に出る。ブレース勘定のほうは
// overCountedAltLines も面倒を見るので、こちらでしか差が出ない。
func TestCodeOnlyLinesDropsElseOfIfOne(t *testing.T) {
	got := codeOnlyLines([]string{
		"#if 1",
		"    live_call();",
		"#else",
		"    dead_call();",
		"#endif",
		"#if 0",
		"    also_dead();",
		"#else",
		"    also_live();",
		"#endif",
		"#ifdef CONFIG_X",
		"    maybe_a();",
		"#else",
		"    maybe_b();",
		"#endif",
	})
	want := map[int]bool{ // 行番号 → コードとして残るべきか
		2: true, 4: false, // #if 1 の表は生き、裏は死ぬ
		7: false, 9: true, // #if 0 はその逆
		12: true, 14: true, // 構成次第の #ifdef はどちらも生かす
	}
	for line, alive := range want {
		has := strings.TrimSpace(got[line-1]) != ""
		if has != alive {
			t.Errorf("%d行目 %q: コードとして残る=%v, want %v", line, got[line-1], has, alive)
		}
	}
}
