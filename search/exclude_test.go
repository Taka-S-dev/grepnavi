package search

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestExcludeGitignoreSyntax(t *testing.T) {
	cases := []struct {
		name  string
		pats  []string
		file  string
		isDir bool
		want  bool
	}{
		{"区切りなしはどの階層にも当たる", []string{"*.BAK"}, "src/a.BAK", false, true},
		{"当たらないもの", []string{"*.BAK"}, "src/a.c", false, false},
		{"フォルダ名にも当たる", []string{".history"}, ".history/2026/a.c", false, true},
		{"深いところのフォルダ名", []string{".history"}, "src/.history/a.c", false, true},
		{"区切りありはルート起点", []string{"ssl/html"}, "ssl/html/index.html", false, true},
		{"別の階層には当たらない", []string{"ssl/html"}, "crypto/ssl/html/i.html", false, false},
		{"** は区切りをまたぐ", []string{"ssl/**/*.html"}, "ssl/a/b/c.html", false, true},
		{"* は区切りをまたがない", []string{"a/*/c"}, "a/b/x/c", false, false},
		{"先頭 / はルート直下に固定", []string{"/tags"}, "tags", false, true},
		{"先頭 / は下の階層に当たらない", []string{"/tags"}, "src/tags", false, false},

		// gitignore に合わせた細かい規則
		{"末尾 / はディレクトリだけ", []string{"doc/"}, "doc", false, false},
		{"末尾 / はディレクトリには当たる", []string{"doc/"}, "doc", true, true},
		{"末尾 / の配下は除外", []string{"doc/"}, "doc/a.txt", false, true},
		{"foo/** は foo 自身に当たらない", []string{"foo/**"}, "foo", true, false},
		{"foo/** は中身に当たる", []string{"foo/**"}, "foo/a.c", false, true},

		// 否定
		{"否定で戻せる", []string{"*.c", "!keep.c"}, "src/keep.c", false, false},
		{"否定の対象外はそのまま", []string{"*.c", "!keep.c"}, "src/a.c", false, true},
		{"後の行が勝つ", []string{"!keep.c", "*.c"}, "src/keep.c", false, true},
		{"除外したフォルダの中は否定で戻せない", []string{"gen/", "!gen/keep.c"}, "gen/keep.c", false, true},
		{"フォルダを除外していなければ戻せる", []string{"gen/*", "!gen/keep.c"}, "gen/keep.c", false, false},

		// コメントとエスケープ
		{"# はコメント", []string{"#*.c"}, "a.c", false, false},
		{`\# はリテラル`, []string{`\#note`}, "#note", false, true},
		{`\! はリテラル`, []string{`\!keep.c`}, "!keep.c", false, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			SetExcludes("", c.pats)
			defer SetExcludes("", nil)
			got := isExcluded(c.file, c.isDir)
			if got != c.want {
				t.Errorf("%v vs %q (dir=%v) = %v, want %v", c.pats, c.file, c.isDir, got, c.want)
			}
		})
	}
}

func TestIsExcludedIsRootRelative(t *testing.T) {
	root := filepath.FromSlash("C:/proj")
	SetExcludes(root, []string{"build"})
	defer SetExcludes("", nil)

	if !IsExcluded(filepath.Join(root, "build", "a.c")) {
		t.Error("root 配下の build を除外できていない")
	}
	if IsExcluded(filepath.Join(root, "src", "a.c")) {
		t.Error("対象のファイルまで除外している")
	}
}

func TestSetExcludesSkipsBlankLines(t *testing.T) {
	SetExcludes("", []string{" ", "", " *.BAK "})
	defer SetExcludes("", nil)
	if got := Excludes(); len(got) != 1 || got[0] != "*.BAK" {
		t.Errorf("Excludes() = %v, want [*.BAK]", got)
	}
}

// 除外は「対象外」の宣言なので、検索の glob で覆せてはいけない。
func TestSearchGlobCannotOverrideExclude(t *testing.T) {
	requireRg(t)
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "keep.c"), "int needle;\n")
	if err := os.Mkdir(filepath.Join(dir, "gen"), 0755); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(dir, "gen", "x.c"), "int needle;\n")

	SetExcludes(dir, []string{"gen/*.c"})
	defer SetExcludes("", nil)

	got, err := Search(context.Background(), Options{
		Pattern: "needle", Dir: dir, FileGlob: "*.c", ContextLines: -1,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range got {
		if strings.Contains(filepath.ToSlash(m.File), "/gen/") {
			t.Fatalf("除外したファイルが検索結果に残っている: %v", m.File)
		}
	}
	if len(got) != 1 {
		t.Fatalf("got %d matches, want 1", len(got))
	}
}

// excludeTestFiles / excludeTestPatterns は照合の突き合わせに使う共通の材料。
var excludeTestFiles = []string{
	"keep.c", "a.BAK", "tags", "note.txt",
	"src/keep.c", "src/a.BAK", "src/tags", "src/doc/x.txt",
	"ssl/html/i.html", "ssl/html/keep.md", "ssl/keep.c",
	"gen/keep.c", "gen/sub/deep.c",
	"doc/a.txt", "vendor/lib/x.c",
}

var excludeTestPatterns = [][]string{
	{"*.BAK"},
	{"/tags"},
	{"tags"},
	{"ssl/html"},
	{"doc/"},
	{"gen/**"},
	{"*.c", "!keep.c"},
	{"gen/", "!gen/keep.c"},
	{"gen/*", "!gen/keep.c"},
	{"**/doc/*.txt"},
	{"*.BAK", "ssl/html", "/tags", "!src/tags"},
}

func makeExcludeTree(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, f := range excludeTestFiles {
		p := filepath.Join(dir, filepath.FromSlash(f))
		if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
			t.Fatal(err)
		}
		mustWrite(t, p, "x\n")
	}
	return dir
}

// 検索は rg の --ignore-file、索引ヒットはこちらの照合器と、gitignore の解釈が
// 2つある。食い違うと「検索には出ないのに定義ジャンプでは飛べる」ような、
// 理由の説明できない挙動になる。rg を正解として突き合わせる。
//
// rg はパターンもパスも cwd 相対のときが定義どおりの挙動なので、cwd をツリーに
// 移して相対パスで走らせる。絶対パスの検索対象に区切り付きパターンを適用するかは
// rg のバージョンで異なり（CI の Ubuntu で不適用を実測）、比較の土台にならない。
// 製品がその差で壊れないことは TestRgPrePassDropsOnlyExcludedFiles が見る。
func TestExcludeMatchesRipgrep(t *testing.T) {
	requireRg(t)
	dir := makeExcludeTree(t)
	patDir := t.TempDir() // パターンファイルはツリーの外に置き、一覧に混ぜない

	for i, pats := range excludeTestPatterns {
		SetExcludes(dir, pats)
		// 否定を含む宣言では製品は前倒し自体をやめるので、ここでは照合器の
		// 意味だけを比べる。パターンファイルは自前で書く
		pf := filepath.Join(patDir, "pats"+strconv.Itoa(i))
		mustWrite(t, pf, strings.Join(pats, "\n")+"\n")

		cmd := exec.Command("rg", "--files", "--hidden", "--ignore-file", pf, ".")
		cmd.Dir = dir
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("%v: rg failed: %v", pats, err)
		}
		rgKept := map[string]bool{}
		for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			if line == "" {
				continue
			}
			rel := strings.TrimPrefix(filepath.ToSlash(line), "./")
			rgKept[rel] = true
		}

		for _, f := range excludeTestFiles {
			goDrops := IsExcluded(filepath.Join(dir, filepath.FromSlash(f)))
			rgDrops := !rgKept[f]
			if goDrops != rgDrops {
				t.Errorf("%v で %s: rg=%v こちら=%v", pats, f,
					map[bool]string{true: "落とす", false: "残す"}[rgDrops],
					map[bool]string{true: "落とす", false: "残す"}[goDrops])
			}
		}
	}
	SetExcludes("", nil)
}

// 前倒し（rg への --ignore-file）は最適化で、落としてよいのは IsExcluded の
// 部分集合だけ。rg が Go 側より多く落とすと、宣言で戻したファイルが結果から
// 黙って消える。製品と同じ呼び方（絶対パスの検索対象）で、その向きだけを見る。
func TestRgPrePassDropsOnlyExcludedFiles(t *testing.T) {
	requireRg(t)
	dir := makeExcludeTree(t)

	for _, pats := range excludeTestPatterns {
		SetExcludes(dir, pats)
		args := append([]string{"--files", "--hidden"}, RgIgnoreArgs()...)
		args = append(args, dir)
		cmd := exec.Command("rg", args...)
		cmd.Dir = RgWorkDir()
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("%v: rg failed: %v", pats, err)
		}
		rgKept := map[string]bool{}
		for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			if line == "" {
				continue
			}
			rel, relErr := filepath.Rel(dir, line)
			if relErr != nil {
				t.Fatal(relErr)
			}
			rgKept[filepath.ToSlash(rel)] = true
		}
		for _, f := range excludeTestFiles {
			if !rgKept[f] && !IsExcluded(filepath.Join(dir, filepath.FromSlash(f))) {
				t.Errorf("%v: 前倒しが宣言より多く落としている: %s", pats, f)
			}
		}
	}
	SetExcludes("", nil)
}

// 否定を含む宣言は rg へ渡さない（SetExcludes のコメント参照）。
func TestNoPrePassWithNegation(t *testing.T) {
	defer SetExcludes("", nil)
	SetExcludes("x", []string{"*.BAK", "!keep.BAK"})
	if len(RgIgnoreArgs()) != 0 {
		t.Error("否定を含む宣言を rg へ前倒ししている")
	}
	SetExcludes("x", []string{"*.BAK"})
	if len(RgIgnoreArgs()) == 0 {
		t.Error("否定なしの宣言で前倒しが消えている")
	}
}

func mustWrite(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0644); err != nil {
		t.Fatal(err)
	}
}
