package search

import (
	"context"
	"os"
	"path/filepath"
	"sort"
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
	hits, _, _, err := FindCallees(t.Context(), file, 2, "")
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
	hits, _, _, err := FindCallees(context.Background(), file, 1, "")
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
	hits, _, _, err := FindCallees(t.Context(), file, 10, "")
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
	hits, _, truncated, err := FindCallees(t.Context(), file, 1, "")
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

func TestFindCalleesDeepInsideLongFunction(t *testing.T) {
	var b strings.Builder
	b.WriteString("void outer(void)\n{\n")
	for i := 0; i < 300; i++ {
		b.WriteString("\tfiller();\n")
	}
	b.WriteString("\ttarget_call();\n") // 303行目あたり
	b.WriteString("}\n")
	dir := t.TempDir()
	f := filepath.Join(dir, "long.c")
	if err := os.WriteFile(f, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	// 関数の 300 行目あたりにカーソルがある状態で問い合わせる
	hits, _, _, err := FindCallees(context.Background(), f, 300, "")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, h := range hits {
		if h.Name == "target_call" {
			found = true
		}
	}
	if !found {
		t.Errorf("200行より奥から問い合わせると呼び先が取れない: %d 件", len(hits))
	}
}

// findContainingFunc は範囲表に置き換わる前の実装。新しい実装が
// 本体の中で同じ答えを出すことを確かめる基準として残す。
// findContainingFunc は lines の callLine（1-indexed）から逆方向に
// 包含する関数定義を探し、関数名と定義行（1-indexed）を返す。
func findContainingFunc(lines []string, callLine int) (string, int) {
	idx := callLine - 1
	if idx < 0 || idx >= len(lines) {
		return "", 0
	}

	depth := 0
	for i := idx; i >= 0 && i > idx-2000; i-- {
		line := lines[i]
		for j := len(line) - 1; j >= 0; j-- {
			ch := line[j]
			if ch == '}' {
				depth++
			} else if ch == '{' {
				depth--
				if depth < 0 {
					// インデントされた { は if/for/while 等の内側ブロック。
					// 関数のオープンブレースは列0（`{` 単独行、または `void f(void) {`）
					// なので、そうでなければ1段外に出たものとして走査を続ける。
					// これを見落とすと、ブロック内の呼び出しが全て関数名を取れずに捨てられる。
					if len(line) > 0 && (line[0] == ' ' || line[0] == '\t') {
						depth = 0
						continue
					}
					// この { が包含関数のオープンブレース
					// この行とその前の数行から関数名を探す（行頭が空白でない行）
					var structName string
					var structLine int
					for k := i; k >= 0 && k >= i-8; k-- {
						l := lines[k]
						if len(l) == 0 || l[0] == '#' {
							continue
						}
						if l[0] != ' ' && l[0] != '\t' {
							// 関数定義を優先探索
							ms := reCalleeFunc.FindAllStringSubmatch(l, -1)
							for mi := len(ms) - 1; mi >= 0; mi-- {
								name := ms[mi][1]
								if !ctKeywords[name] {
									return name, k + 1
								}
							}
							// 構造体変数初期化: name = { パターン
							if ms2 := reStructVarName.FindAllStringSubmatch(l, -1); len(ms2) > 0 {
								for mi := len(ms2) - 1; mi >= 0; mi-- {
									name := ms2[mi][1]
									if !ctKeywords[name] && structName == "" {
										structName = name
										structLine = k + 1
									}
								}
							}
						}
					}
					if structName != "" {
						return structName, structLine
					}
					return "", i + 1
				}
			}
		}
	}
	return "", 0
}

// 呼び先はカーソル位置の語ではなく「囲む関数」で決まる。どちらの関数の
// 結果なのかを利用者に見せられるよう、解決した名前を返すこと。
func TestFindCalleesReportsEnclosingFunction(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "x.c")
	src := "void bar(void)\n{\n\tfoo();\n\tbaz();\n}\n"
	if err := os.WriteFile(file, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	// foo() の呼び出し行にカーソルがあっても、答えるのは bar の呼び先
	hits, funcName, _, err := FindCallees(t.Context(), file, 3, "")
	if err != nil {
		t.Fatal(err)
	}
	if funcName != "bar" {
		t.Errorf("解決した関数名 got=%q want=bar", funcName)
	}
	names := map[string]bool{}
	for _, h := range hits {
		names[h.Name] = true
	}
	if !names["foo"] || !names["baz"] {
		t.Errorf("bar の呼び先が揃っていない: %v", names)
	}
}

// 関数ポインタの宣言・キャストは呼び出しではない。字面が `識別子(` なので
// 型名が呼び先として拾われていた（実測: openssl の ssl3_read_bytes に `void`、
// ssl3_ctx_ctrl に `int`）。呼び出しを巻き添えにしていないことも併せて見る。
func TestCalleeSkipsFunctionPointerDeclarations(t *testing.T) {
	dir := t.TempDir()
	src := `void target(SSL *s, void *parg)
{
    void (*cb) (const SSL *ssl, int type2, int val) = NULL;
    void (*tbl[4])(int) = { 0 };
    *(int (**)(SSL *, void *))parg = 0;
    memcpy((const unsigned char (*)[16])s, parg, 16);
    i = s->handshake_func(s);
    cb(s, 1, 2);
    ret = foo(*parg, s);
}
`
	f := filepath.Join(dir, "t.c")
	if err := os.WriteFile(f, []byte(src), 0644); err != nil {
		t.Fatal(err)
	}
	hits, fn, _, err := FindCallees(context.Background(), f, 1, "")
	if err != nil {
		t.Fatal(err)
	}
	if fn != "target" {
		t.Fatalf("囲む関数 = %q, want target", fn)
	}
	got := map[string]bool{}
	for _, h := range hits {
		got[h.Name] = true
	}
	// 宣言・キャストの型名は呼び先ではない
	for _, bad := range []string{"void", "int", "char", "unsigned"} {
		if got[bad] {
			t.Errorf("型名 %q が呼び先として出ている: %v", bad, keysOf(got))
		}
	}
	// 本物の呼び出しは残る
	for _, want := range []string{"memcpy", "handshake_func", "cb", "foo"} {
		if !got[want] {
			t.Errorf("呼び出し %q が落ちている: %v", want, keysOf(got))
		}
	}
}

func keysOf(m map[string]bool) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func TestCalleeMarksMemberCalls(t *testing.T) {
	dir := t.TempDir()
	src := `int target(SSL *s, struct file *f, struct ops tbl[])
{
    n = s->method->ssl_read(s, buf, len);
    ops.open(f);
    r = tbl[i].cb(f);
    get_ops(s)->write(f);
    x = read(fd, buf, n);
    ret = f->f_op->read(f, buf);
    return plain(x);
}
`
	f := filepath.Join(dir, "t.c")
	if err := os.WriteFile(f, []byte(src), 0644); err != nil {
		t.Fatal(err)
	}
	hits, _, _, err := FindCallees(context.Background(), f, 1, "")
	if err != nil {
		t.Fatal(err)
	}
	type want struct {
		indirect bool
		receiver string
	}
	wants := map[string]want{
		"ssl_read": {true, "s->method"},
		"read":     {true, "f->f_op"}, // 間接の read
		"cb":       {true, "tbl[i]"},
		"open":     {true, "ops"},
		"write":    {true, ""}, // 戻り値のメンバ: 受け手は名前で追えない
		"plain":    {false, ""},
		"get_ops":  {false, ""},
	}
	seenDirectRead := false
	for _, h := range hits {
		if h.Name == "read" && !h.Indirect {
			// 同名の直接呼び出し `read(fd, ...)` は別の呼び先として残る
			seenDirectRead = true
			continue
		}
		w, ok := wants[h.Name]
		if !ok {
			continue
		}
		if h.Indirect != w.indirect || h.Receiver != w.receiver {
			t.Errorf("%s: indirect=%v receiver=%q, want indirect=%v receiver=%q",
				h.Name, h.Indirect, h.Receiver, w.indirect, w.receiver)
		}
		delete(wants, h.Name)
	}
	for name := range wants {
		t.Errorf("呼び先 %q が出ていない", name)
	}
	if !seenDirectRead {
		t.Errorf("直接呼び出しの read(fd) がメンバ呼び出しの read に吸われている")
	}
	if !strings.Contains(hits[0].Text, "ssl_read") {
		t.Errorf("Text が呼び出し行でない: %q", hits[0].Text)
	}
}
