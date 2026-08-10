package search

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFindContainingFunc(t *testing.T) {
	// Linux カーネル形式（{ は列0）。呼び出しがネストしたブロック内にある。
	kernelStyle := []string{
		`static int helper(void)`, // 1
		`{`,                       // 2
		`	return 0;`,              // 3
		`}`,                       // 4
		``,                        // 5
		`static bool btrfs_submit_chunk(struct btrfs_bio *bbio, int mirror_num)`, // 6
		`{`,                                 // 7
		`	if (a && b) {`,                    // 8
		`		if (should_async_write(bbio) &&`, // 9
		`		    btrfs_wq_submit_bio(bbio, bioc, &smap, mirror_num))`, // 10
		`			goto done;`, // 11
		`	}`,            // 12
		`	return true;`, // 13
		`}`,             // 14
	}

	tests := []struct {
		name     string
		lines    []string
		callLine int
		wantFunc string
		wantDef  int
	}{
		{
			// 実際に取りこぼしていたケース: if の二重ネスト内の呼び出し
			name: "call nested in if blocks", lines: kernelStyle, callLine: 10,
			wantFunc: "btrfs_submit_chunk", wantDef: 6,
		},
		{
			name: "call at function top level", lines: kernelStyle, callLine: 13,
			wantFunc: "btrfs_submit_chunk", wantDef: 6,
		},
		{
			name: "earlier function is not confused", lines: kernelStyle, callLine: 3,
			wantFunc: "helper", wantDef: 1,
		},
		{
			// K&R でない { が行末に来るスタイル
			name: "brace on signature line", lines: []string{
				`void caller(void) {`,
				`	while (x) {`,
				`		target();`,
				`	}`,
				`}`,
			}, callLine: 3, wantFunc: "caller", wantDef: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotFunc, gotDef := findContainingFunc(tt.lines, tt.callLine)
			if gotFunc != tt.wantFunc || gotDef != tt.wantDef {
				t.Errorf("findContainingFunc(line %d) = (%q, %d), want (%q, %d)",
					tt.callLine, gotFunc, gotDef, tt.wantFunc, tt.wantDef)
			}
		})
	}
}

func TestFindCalleesStopsAtFunctionEnd(t *testing.T) {
	// カーネル形式: 関数の直後に EXPORT_SYMBOL_GPL が続く。
	// 閉じ } の次の行を本体に含めると、これが呼び出し先として現れる。
	file := filepath.Join(t.TempDir(), "xdp.c")
	src := `void __acquires(&lock->lock)
__libeth_xdpsq_lock(struct libeth_xdpsq_lock *lock)
{
	spin_lock(&lock->lock);
}
EXPORT_SYMBOL_GPL(__libeth_xdpsq_lock);
`
	if err := os.WriteFile(file, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	hits, _, err := FindCallees(t.Context(), file, 2, "")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, h := range hits {
		got[h.Name] = true
	}
	if !got["spin_lock"] {
		t.Errorf("spin_lock is in the body and must be a callee, got %v", got)
	}
	if got["EXPORT_SYMBOL_GPL"] {
		t.Errorf("EXPORT_SYMBOL_GPL sits after the closing brace and must not be a callee, got %v", got)
	}
}

// シグネチャ行を走査すると関数自身と引数の型名が呼び出し先に混ざる。
// 閉じ } の次の行（カーネルなら EXPORT_SYMBOL_GPL）も本体ではない。
func TestFindCalleesSkipsSignatureAndTrailer(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "a.c")
	src := `int blkg_conf_prep(struct blkcg *blkcg, const struct blkcg_policy *pol,
		   struct blkg_conf_ctx *ctx)
	__acquires(&bdev->bd_queue->queue_lock)
{
	int ret = blkg_conf_open_bdev(ctx);
	return ret;
}
EXPORT_SYMBOL_GPL(blkg_conf_prep);
`
	if err := os.WriteFile(file, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	hits, _, err := FindCallees(context.Background(), file, 1, "")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, h := range hits {
		names = append(names, h.Name)
	}
	for _, bad := range []string{"blkg_conf_prep", "__acquires", "EXPORT_SYMBOL_GPL"} {
		for _, n := range names {
			if n == bad {
				t.Errorf("%q should not be a callee; got %v", bad, names)
			}
		}
	}
	if len(names) != 1 || names[0] != "blkg_conf_open_bdev" {
		t.Errorf("callees = %v, want just blkg_conf_open_bdev", names)
	}
}

// 読んでいる最中に呼び先を聞くとき、カーソルは本体の途中にある。
// openssl の `static STACK_OF(GENERAL_NAME) *f(...)` のように戻り値が
// マクロでシグネチャが複数行にまたがる形でも囲む関数を特定できること。
func TestFindCalleesFromLineInsideBody(t *testing.T) {
	file := filepath.Join(t.TempDir(), "v3_crld.c")
	src := `static const int table[] = {
	1, 2, 3,
};

static STACK_OF(GENERAL_NAME) *gnames_from_sectname(X509V3_CTX *ctx,
                                                    char *sect)
{
	STACK_OF(CONF_VALUE) *gnsect;
	if (*sect == '@')
		gnsect = X509V3_get_section(ctx, sect + 1);
	else
		gnsect = X509V3_parse_list(sect);
	return gnsect;
}
`
	if err := os.WriteFile(file, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	// 10 行目（本体の途中）を渡す
	hits, _, err := FindCallees(t.Context(), file, 10, "")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, h := range hits {
		got[h.Name] = true
	}
	if !got["X509V3_get_section"] || !got["X509V3_parse_list"] {
		t.Errorf("本体の途中の行から呼び先を取れていない: %v", got)
	}
	// シグネチャの STACK_OF や関数自身は呼び先ではない
	if got["gnames_from_sectname"] {
		t.Errorf("関数自身が呼び先に混ざった: %v", got)
	}
}

// 500行級の関数でも呼び先が途中で切れないこと。
// 表示用の 200 行上限をそのまま解析に使うと、後半の呼び出しが
// 「これで全部」の顔で黙って消える（openssl の
// tls_early_post_process_client_hello が 499 行でこれを踏んでいた）。
func TestFindCalleesLongFunction(t *testing.T) {
	file := filepath.Join(t.TempDir(), "long.c")
	var b strings.Builder
	b.WriteString("int big(void)\n{\n")
	b.WriteString("\tearly_call();\n")
	for i := 0; i < 400; i++ {
		b.WriteString("\tx += 1;\n")
	}
	b.WriteString("\tlate_call();\n")
	b.WriteString("\treturn 0;\n}\n")
	if err := os.WriteFile(file, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	hits, truncated, err := FindCallees(t.Context(), file, 1, "")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, h := range hits {
		got[h.Name] = true
	}
	if !got["early_call"] {
		t.Errorf("前半の呼び出しが無い: %v", got)
	}
	if !got["late_call"] {
		t.Errorf("400行先の呼び出しが落ちている（上限で切られた）: %v", got)
	}
	if truncated {
		t.Errorf("この長さで打ち切り扱いになっている")
	}
}

func TestFilterCallSitesByDir(t *testing.T) {
	root := filepath.FromSlash("/proj")
	sites := []CallSite{
		{Func: "a", File: filepath.Join(root, "ssl", "x.c")},
		{Func: "b", File: filepath.Join(root, "apps", "y.c")},
		{Func: "c", File: filepath.Join(root, "ssl", "sub", "z.c")},
	}
	got := FilterCallSites(sites, filepath.Join(root, "ssl"), "")
	if len(got) != 2 || got[0].Func != "a" || got[1].Func != "c" {
		t.Fatalf("検索ディレクトリで絞れていない: %+v", got)
	}
	// 名前が前方一致するだけの兄弟ディレクトリを巻き込まない
	sites = append(sites, CallSite{Func: "d", File: filepath.Join(root, "ssl_extra", "w.c")})
	if got := FilterCallSites(sites, filepath.Join(root, "ssl"), ""); len(got) != 2 {
		t.Errorf("ssl_extra まで含めている: %+v", got)
	}
}

func TestFilterCallSitesByGlob(t *testing.T) {
	root := filepath.FromSlash("/proj")
	sites := []CallSite{
		{Func: "a", File: filepath.Join(root, "x.c")},
		{Func: "b", File: filepath.Join(root, "x.h")},
		{Func: "c", File: filepath.Join(root, "x.cpp")},
	}
	got := FilterCallSites(sites, "", "*.c,*.h")
	if len(got) != 2 || got[0].Func != "a" || got[1].Func != "b" {
		t.Fatalf("glob で絞れていない: %+v", got)
	}
	if got := FilterCallSites(sites, "", ""); len(got) != 3 {
		t.Errorf("絞り込み指定が無いのに減っている: %+v", got)
	}
}

func TestMarkIndirectCalls(t *testing.T) {
	sites := []CallSite{
		{Text: "ret = ssl_read(s, buf, n);"},
		{Text: "\t.read = ssl_read,"},
		{Text: "ops->read = &ssl_read;"},
		{Text: "if (ssl_read (s, buf, n) < 0)"}, // 関数名と ( の間に空白
	}
	MarkIndirectCalls(sites, "ssl_read")
	want := []bool{false, true, true, false}
	for i, w := range want {
		if sites[i].Indirect != w {
			t.Errorf("[%d] %q: Indirect=%v, want %v", i, sites[i].Text, sites[i].Indirect, w)
		}
	}
}
