package search

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPreferDefinitionHits(t *testing.T) {
	tests := []struct {
		name      string
		hits      []DefHit
		wantFiles []string // 残るべきファイル名（順不同）
	}{
		{
			name: "宣言と定義が両方ある場合、定義だけ残る",
			hits: []DefHit{
				{File: "foo.h", Line: 5, Text: "void foo(int x);", Kind: "func"},   // 宣言
				{File: "foo.c", Line: 10, Text: "void foo(int x) {", Kind: "func"}, // 定義
			},
			wantFiles: []string{"foo.c"},
		},
		{
			name: "宣言のみの場合は全件返す",
			hits: []DefHit{
				{File: "foo.h", Line: 5, Text: "void foo(int x);", Kind: "func"},
			},
			wantFiles: []string{"foo.h"},
		},
		{
			name: "定義が .h のみの場合（インライン実装）はそのまま返す",
			hits: []DefHit{
				{File: "foo.h", Line: 5, Text: "void foo(int x);", Kind: "func"},          // 宣言
				{File: "bar.h", Line: 20, Text: "inline void foo(int x) {", Kind: "func"}, // 定義（ヘッダ内）
			},
			wantFiles: []string{"bar.h"},
		},
		{
			name: "#define は宣言扱いにしない",
			hits: []DefHit{
				{File: "foo.h", Line: 3, Text: "#define MAX_SIZE 100", Kind: "define"},
			},
			wantFiles: []string{"foo.h"},
		},
		{
			name: "宣言に末尾コメントがあっても宣言と判定できる",
			hits: []DefHit{
				{File: "foo.c", Line: 3, Text: "static int foo(int x);   /* forward decl */", Kind: "func"}, // 宣言（コメント付き）
				{File: "foo.c", Line: 10, Text: "static int foo(int x) {", Kind: "func"},                    // 定義
			},
			wantFiles: []string{"foo.c"},
		},
		{
			name: "宣言に /**/ コメントがあっても宣言と判定できる",
			hits: []DefHit{
				{File: "foo.c", Line: 3, Text: "static int foo(int x);/**/", Kind: "func"}, // 宣言（/**/ 付き）
				{File: "foo.c", Line: 10, Text: "static int foo(int x) {", Kind: "func"},   // 定義
			},
			wantFiles: []string{"foo.c"},
		},
		{
			name: "定義あり: .c と .h の定義が両方ある場合 .c を優先",
			hits: []DefHit{
				{File: "foo.h", Line: 5, Text: "void foo(int x);", Kind: "func"},          // 宣言
				{File: "bar.h", Line: 20, Text: "inline void foo(int x) {", Kind: "func"}, // 定義ヘッダ
				{File: "foo.c", Line: 10, Text: "void foo(int x) {", Kind: "func"},        // 定義実装
			},
			wantFiles: []string{"foo.c"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := preferDefinitionHits(tt.hits)
			if len(got) != len(tt.wantFiles) {
				t.Errorf("got %d hits, want %d: %v", len(got), len(tt.wantFiles), got)
				return
			}
			wantSet := map[string]bool{}
			for _, f := range tt.wantFiles {
				wantSet[f] = true
			}
			for _, h := range got {
				if !wantSet[h.File] {
					t.Errorf("unexpected file %q in result", h.File)
				}
			}
		})
	}
}

func TestIsDefinitionHit_MultilineSignature(t *testing.T) {
	// 複数行シグネチャのテスト。
	// CachedLines を使わずに lines を直接渡すため、
	// isDefinitionHitLines という内部ヘルパーでテストする。
	tests := []struct {
		name  string
		lines []string
		line  int // 1-indexed ヒット行
		want  bool
	}{
		{
			name: "通常の1行宣言は宣言と判定",
			lines: []string{
				"int foo(int x);",
			},
			line: 1,
			want: false,
		},
		{
			name: "1行定義は定義と判定",
			lines: []string{
				"int foo(int x) {",
				"    return x;",
				"}",
			},
			line: 1,
			want: true,
		},
		{
			name: "複数行シグネチャで末尾が ; なら宣言",
			lines: []string{
				"int foo(",
				"    const char*",
				"    int",
				"              name,",
				"              size);",
			},
			line: 1,
			want: false,
		},
		{
			name: "複数行シグネチャで { が出れば定義",
			lines: []string{
				"int foo(",
				"    const char* name,",
				"    int         size)",
				"{",
				"    return 0;",
				"}",
			},
			line: 1,
			want: true,
		},
		{
			name: "次行に { がある K&R スタイルは定義",
			lines: []string{
				"void foo()",
				"{",
				"    return;",
				"}",
			},
			line: 1,
			want: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := DefHit{File: "", Line: tt.line, Text: tt.lines[tt.line-1], Kind: "func"}
			got := isDefinitionHitLines(h, tt.lines)
			if got != tt.want {
				t.Errorf("isDefinitionHit = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestIsAnnotationLine(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}

	// カーネルの sparse 注釈: 関数名は次の行にある
	kernel := write("xdp.c", `void __acquires(&lock->lock)
__libeth_xdpsq_lock(struct libeth_xdpsq_lock *lock)
{
	spin_lock(&lock->lock);
}
`)
	if !isAnnotationLine(kernel, 1) {
		t.Error("line 1 annotates the function defined on line 2; must be rejected as a definition")
	}
	if isAnnotationLine(kernel, 2) {
		t.Error("line 2 is the real signature and must be kept")
	}

	// 通常の定義（次行が本体）
	normal := write("normal.c", `static int foo(int a)
{
	return a;
}
`)
	if isAnnotationLine(normal, 1) {
		t.Error("a signature followed by the body must be kept")
	}

	// 引数リストが複数行にまたがる定義
	multi := write("multi.c", `static int bar(int a,
	       int b)
{
	return a + b;
}
`)
	if isAnnotationLine(multi, 1) {
		t.Error("a signature split across lines must be kept")
	}

	// 同じ行に本体が始まる形
	inline := write("inline.c", `void baz(void) {
	return;
}
`)
	if isAnnotationLine(inline, 1) {
		t.Error("a signature with the brace on the same line must be kept")
	}
}

// 同名の別種シンボル（ヘッダの struct と .c の関数）は無関係な存在なので、
// 「.c があればヘッダを落とす」を種別をまたいで適用してはいけない。
func TestFilterImplFilesKeepsOtherKinds(t *testing.T) {
	hits := []DefHit{
		{File: `C:\p\fs\dev-ioctl.c`, Line: 757, Kind: "func", Text: "static long autofs_dev_ioctl("},
		{File: `C:\p\include\auto_dev-ioctl.h`, Line: 89, Kind: "struct", Text: "struct autofs_dev_ioctl {"},
		{File: `C:\p\include\autofs.h`, Line: 12, Kind: "func", Text: "long autofs_dev_ioctl(...);"},
	}
	got := filterImplFiles(hits)
	if len(got) != 2 {
		t.Fatalf("got %d hits, want 2: %+v", len(got), got)
	}
	if got[0].Kind != "func" || got[1].Kind != "struct" {
		t.Errorf("want the .c func and the header struct, got %+v", got)
	}
}

func TestFilterImplFilesDropsHeaderDeclOfSameKind(t *testing.T) {
	hits := []DefHit{
		{File: `C:\p\a.h`, Line: 1, Kind: "func"},
		{File: `C:\p\a.c`, Line: 2, Kind: "func"},
	}
	got := filterImplFiles(hits)
	if len(got) != 1 || got[0].Line != 2 {
		t.Errorf("want only the .c hit, got %+v", got)
	}
}

func TestRankDefHitsByTag(t *testing.T) {
	hits := []DefHit{
		{Line: 1, Kind: "func"},
		{Line: 2, Kind: "struct"},
		{Line: 3, Kind: "define"},
	}
	got := RankDefHitsByTag(hits, "struct")
	if got[0].Kind != "struct" {
		t.Errorf("want the struct first, got %+v", got)
	}
	// 残りの相対順は保つ
	if got[1].Kind != "func" || got[2].Kind != "define" {
		t.Errorf("want the remaining order preserved, got %+v", got)
	}
	// 元のスライスは並べ替えない（呼び出し側がキャッシュを渡してくる）
	if hits[0].Kind != "func" {
		t.Errorf("input was mutated: %+v", hits)
	}
	// タグ無し・未知のタグ・一致なしは素通し
	for _, tag := range []string{"", "typedef", "class"} {
		if got := RankDefHitsByTag(hits, tag); got[0].Kind != "func" {
			t.Errorf("tag %q reordered hits: %+v", tag, got)
		}
	}
}

// 定義が見つからないときは全レベルの完了を待つ経路に入る。ここで打ち切りを
// 見ていないと、どれか1つのレベルが返らないだけで検索全体が止まり、
// 呼び出し元が付けた打ち切りの天井も効かなくなる（UI が「検索中」で固まる）。
func TestCollectNearestReturnsWhenALevelNeverFinishes(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	ch := make(chan levelResult, 3)
	ch <- levelResult{level: 1} // level 0 と 2 は永久に返らない

	done := make(chan struct{})
	go func() {
		defer close(done)
		if hits, _ := collectNearest(ctx, cancel, ch, 3, time.Now()); len(hits) != 0 {
			t.Errorf("打ち切りなのにヒットを返した: %d 件", len(hits))
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("レベルが1つ返らないだけで戻ってこない")
	}
}

// 遠いレベルが先に返っても、近いレベルが未完なら採用しない。
func TestCollectNearestPrefersNearestLevel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ch := make(chan levelResult, 2)
	ch <- levelResult{level: 1, hits: []DefHit{{File: "far.c", Line: 1, Text: "int f(void) {"}}}
	ch <- levelResult{level: 0, hits: []DefHit{{File: "near.c", Line: 1, Text: "int f(void) {"}}}

	hits, err := collectNearest(ctx, cancel, ch, 2, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || hits[0].File != "near.c" {
		t.Errorf("近いレベルを採用していない: %+v", hits)
	}
}

// 定義が見つからないときは全レベルの完了を待つ経路に入る。ここで打ち切りを
// 見ていないと、どれか1つのレベルが返らないだけで検索全体が止まり、
// 呼び出し元が付けた 8 秒の天井も効かなくなる（UI が「検索中」で固まる）。
func TestFindDefinitionsSmartReturnsOnCancel(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "a.c")
	if err := os.WriteFile(src, []byte("int other(void) { return 0; }\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		// 存在しない語なので、打ち切りを見ない実装では全レベルの完了待ちになる
		if hits, _ := FindDefinitionsSmart(ctx, "no_such_symbol_anywhere", src, root, ""); len(hits) != 0 {
			t.Errorf("打ち切り済みなのにヒットを返した: %d 件", len(hits))
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("打ち切り済みの context で戻ってこない")
	}
}

// doxygen 出力を索引に含んだツリーでは、生成 HTML が定義として先頭に来ていた
// （実測: openssl の handshake_func が 359.html:4 に解決され、本物の
// ssl_local.h:1092 が2番目だった）。ソースを先に、HTML は落とさず後ろへ。
func TestPreferDefinitionHitsDemotesGeneratedHtml(t *testing.T) {
	dir := t.TempDir()
	html := filepath.Join(dir, "359.html")
	hdr := filepath.Join(dir, "ssl_local.h")
	if err := os.WriteFile(html, []byte("<div>int (*handshake_func) (SSL *);</div>\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hdr, []byte("int (*handshake_func) (SSL *);\n"), 0644); err != nil {
		t.Fatal(err)
	}
	// 索引は HTML を先に返してくる
	got := preferDefinitionHits([]DefHit{
		{File: html, Line: 1, Kind: "member", Text: "int (*handshake_func) (SSL *);"},
		{File: hdr, Line: 1, Kind: "member", Text: "int (*handshake_func) (SSL *);"},
	})
	if len(got) != 2 {
		t.Fatalf("候補が減っている: %+v", got)
	}
	if !strings.HasSuffix(got[0].File, ".h") {
		t.Errorf("先頭がソースでない: %s", got[0].File)
	}
	if !strings.HasSuffix(got[1].File, ".html") {
		t.Errorf("HTML が落ちている: %+v", got)
	}
}
