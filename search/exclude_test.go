package search

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
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

// 検索は rg の --ignore-file、索引ヒットはこちらの照合器と、gitignore の解釈が
// 2つある。食い違うと「検索には出ないのに定義ジャンプでは飛べる」ような、
// 理由の説明できない挙動になる。rg を正解として突き合わせる。
func TestExcludeMatchesRipgrep(t *testing.T) {
	requireRg(t)
	dir := t.TempDir()
	files := []string{
		"keep.c", "a.BAK", "tags", "note.txt",
		"src/keep.c", "src/a.BAK", "src/tags", "src/doc/x.txt",
		"ssl/html/i.html", "ssl/html/keep.md", "ssl/keep.c",
		"gen/keep.c", "gen/sub/deep.c",
		"doc/a.txt", "vendor/lib/x.c",
	}
	for _, f := range files {
		p := filepath.Join(dir, filepath.FromSlash(f))
		if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
			t.Fatal(err)
		}
		mustWrite(t, p, "x\n")
	}

	patternSets := [][]string{
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
	for _, pats := range patternSets {
		SetExcludes(dir, pats)

		// rg 側: --ignore-file を効かせるには cwd が基準
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

		for _, f := range files {
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

func mustWrite(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0644); err != nil {
		t.Fatal(err)
	}
}
