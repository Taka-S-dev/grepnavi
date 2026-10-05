package search

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"
)

// mkTables は (シンボル, 参照元) の一覧からファイル対のエッジを組む。
func mkTables(defFile map[string]string, sameName int, refs [][2]string) *structTables {
	t := &structTables{sameName: sameName, sameNameRefs: sameName * 7, edges: map[structPair]*structFileEdge{}}
	impl := map[string]bool{}
	for _, f := range defFile {
		impl[f] = true
	}
	for f := range impl {
		t.implFiles = append(t.implFiles, f)
	}
	sort.Strings(t.implFiles)
	for _, r := range refs {
		sym, src := r[0], r[1]
		def := defFile[sym]
		if def == "" {
			continue
		}
		k := structPair{src: src, def: def}
		e := t.edges[k]
		if e == nil {
			e = &structFileEdge{}
			t.edges[k] = e
		}
		e.count++
		e.syms = append(e.syms, sym)
	}
	return t
}

func tablesForTest() *structTables {
	return mkTables(map[string]string{
		"core_init":  "core/init.c",
		"core_step":  "core/init.c",
		"net_send":   "net/tcp/send.c",
		"util_log":   "util.c", // ルート直下の実装
		"core_other": "core/other.c",
	}, 2, [][2]string{
		{"core_init", "net/tcp/send.c"}, // net → core
		{"core_step", "net/tcp/send.c"}, // net → core
		{"core_step", "net/tcp/recv.c"}, // net → core（別ファイル）
		{"net_send", "core/init.c"},     // core → net
		{"util_log", "core/init.c"},     // core → util.c
		{"util_log", "net/tcp/send.c"},  // net → util.c
		{"core_init", "core/other.c"},   // core 内部 → 出ない
		{"core_other", "core/init.c"},   // core 内部 → 出ない
	})
}

func TestOverviewAggregation(t *testing.T) {
	o := overviewFrom(tablesForTest(), 1)
	want := map[string]int{
		"net->core":    3,
		"core->net":    1,
		"core->util.c": 1,
		"net->util.c":  1,
	}
	if len(o.Edges) != len(want) {
		t.Fatalf("edges = %v, want %d 本", o.Edges, len(want))
	}
	for _, e := range o.Edges {
		if want[e.From+"->"+e.To] != e.Count {
			t.Errorf("%s->%s = %d, want %d", e.From, e.To, e.Count, want[e.From+"->"+e.To])
		}
	}
	// 多い順に並ぶ
	if o.Edges[0].From != "net" || o.Edges[0].To != "core" {
		t.Errorf("先頭が最大エッジでない: %+v", o.Edges[0])
	}
	if o.Omitted.SameName != 2 {
		t.Errorf("same_name = %d, want 2", o.Omitted.SameName)
	}
}

func TestFocusAggregation(t *testing.T) {
	f := focusFrom(tablesForTest(), "core")
	// 内部: init.c ⇄ other.c の2本
	if len(f.Internal) != 2 {
		t.Fatalf("internal = %+v, want 2 本", f.Internal)
	}
	// 入ってくる: net → core/init.c（3組が同じ定義ファイルに刺さる）
	if len(f.Incoming) != 1 || f.Incoming[0].From != "net" ||
		f.Incoming[0].To != "core/init.c" || f.Incoming[0].Count != 3 {
		t.Fatalf("incoming = %+v", f.Incoming)
	}
	// 出ていく: core → net と core → util.c
	out := map[string]int{}
	for _, e := range f.Outgoing {
		out[e.To] = e.Count
	}
	if out["net"] != 1 || out["util.c"] != 1 {
		t.Fatalf("outgoing = %+v", f.Outgoing)
	}
	// 公開面: 実装2ファイル中、外から触られるのは init.c だけ
	if f.Files != 2 || f.FilesOpen != 1 {
		t.Errorf("files = %d/%d, want 1/2", f.FilesOpen, f.Files)
	}
}

// 深いモジュールの内部は1段ずつ畳まれる（いきなりファイルの洪水にしない）。
func TestFocusFoldsInternalsOneLevel(t *testing.T) {
	tt := mkTables(map[string]string{
		"x509_cmp": "crypto/x509/cmp.c",
		"bn_add":   "crypto/bn/add.c",
	}, 0, [][2]string{
		{"bn_add", "crypto/x509/cmp.c"},   // x509 → bn（サブディレクトリ間）
		{"x509_cmp", "crypto/x509/vfy.c"}, // x509 の中 → 内部エッジにならない
		{"x509_cmp", "ssl/s.c"},           // 外から
	})
	f := focusFrom(tt, "crypto")
	if len(f.Internal) != 1 || f.Internal[0].From != "crypto/x509" || f.Internal[0].To != "crypto/bn" {
		t.Fatalf("internal = %+v, want crypto/x509 → crypto/bn の1本", f.Internal)
	}
	if len(f.Incoming) != 1 || f.Incoming[0].To != "crypto/x509" {
		t.Fatalf("incoming = %+v, want ssl → crypto/x509", f.Incoming)
	}
}

func TestFocusDeeperModule(t *testing.T) {
	// 2階層のモジュールを向いたら、外側の相手も2階層で畳まれる
	f := focusFrom(tablesForTest(), "net/tcp")
	found := false
	for _, e := range f.Outgoing {
		if e.To == "core/init.c" { // core は1階層しかないのでファイルまで出る
			found = true
		}
	}
	if !found {
		t.Fatalf("outgoing = %+v, want core/init.c 行き", f.Outgoing)
	}
}

// 相手のまとまり (Other) は深さではなく、フォーカスと分かれた直後の段で畳む。
func TestFocusOtherIsSiblingAtSplit(t *testing.T) {
	tt := mkTables(map[string]string{
		"bio_new":  "crypto/bio/bio_lib.c",
		"x509_cmp": "crypto/x509/cmp.c",
		"ssl_new":  "ssl/ssl_lib.c",
	}, 0, [][2]string{
		{"bio_new", "ssl/ssl_lib.c"},        // ssl のファイル → 相手は ssl
		{"bio_new", "ssl/statem/statem.c"},  // ssl の下の下 → 相手は ssl
		{"bio_new", "crypto/x509/cmp.c"},    // 同じ crypto の隣 → 相手は crypto/x509
		{"bio_new", "crypto/mem.c"},         // 分かれ目に直接あるファイル → そのまま
		{"x509_cmp", "crypto/bio/b_sock.c"}, // 外へ: 相手は crypto/x509
		{"ssl_new", "crypto/bio/b_sock.c"},  // 外へ: 相手は ssl
	})
	f := focusFrom(tt, "crypto/bio")
	in := map[string]string{}
	for _, e := range f.Incoming {
		in[e.From] = e.Other
	}
	want := map[string]string{
		"ssl/ssl_lib.c": "ssl", "ssl/statem": "ssl", "crypto/x509": "crypto/x509", "crypto/mem.c": "crypto/mem.c",
	}
	for from, other := range want {
		if in[from] != other {
			t.Errorf("incoming %s: other = %q, want %q (all %+v)", from, in[from], other, f.Incoming)
		}
	}
	out := map[string]string{}
	for _, e := range f.Outgoing {
		out[e.To] = e.Other
	}
	if out["crypto/x509"] != "crypto/x509" || out["ssl/ssl_lib.c"] != "ssl" {
		t.Errorf("outgoing other = %+v", f.Outgoing)
	}
	// 内部の行には付かない
	for _, e := range f.Internal {
		if e.Other != "" {
			t.Errorf("internal edge has other: %+v", e)
		}
	}
}

func TestSiblingGroup(t *testing.T) {
	cases := [][3]string{
		{"net/core/dev.c", "drivers/net/ethernet/intel", "net"},
		{"drivers/net/ethernet/broadcom/b.c", "drivers/net/ethernet/intel", "drivers/net/ethernet/broadcom"},
		{"drivers/net/dummy.c", "drivers/net/ethernet/intel", "drivers/net/dummy.c"},
		{"util.c", "core", "util.c"},
		{"net", "core", "net"}, // 既に畳まれたラベル
	}
	for _, c := range cases {
		if got := siblingGroup(c[0], c[1]); got != c[2] {
			t.Errorf("siblingGroup(%q, %q) = %q, want %q", c[0], c[1], got, c[2])
		}
	}
}

// 自動畳みは、シェアの大きい塊から重い子を取り出して同格に並べる。
func TestAdaptiveGroupsSplitsHeavyDirs(t *testing.T) {
	// big/hot が全体の大半を占め、big/cold と small は軽い
	defs := map[string]string{
		"hot_fn":   "big/hot/a.c",
		"cold_fn":  "big/cold/b.c",
		"small_fn": "small/u.c",
	}
	var refs [][2]string
	rep := func(sym, src string, n int) {
		for i := 0; i < n; i++ {
			refs = append(refs, [2]string{sym, src})
		}
	}
	rep("hot_fn", "small/u.c", 60)
	rep("cold_fn", "small/u.c", 3)
	rep("small_fn", "big/hot/a.c", 3)
	tt := mkTables(defs, 0, refs)

	o := overviewAuto(tt)
	names := map[string]bool{}
	for _, e := range o.Edges {
		names[e.From] = true
		names[e.To] = true
	}
	// 取り出しはシェアが要求する限り降りる。ここでは重さがファイル1枚に
	// 集中しているので、そのファイル自体がノードになる
	if !names["big/hot/a.c"] {
		t.Errorf("重さの実体 big/hot/a.c が取り出されていない: %+v", o.Edges)
	}
	if !names["big"] {
		t.Errorf("残りを表す big が消えている: %+v", o.Edges)
	}
	if names["big/cold"] {
		t.Errorf("軽い big/cold まで割られている: %+v", o.Edges)
	}
	// 決定性: 2回やって同じ
	o2 := overviewAuto(tt)
	if len(o.Edges) != len(o2.Edges) {
		t.Errorf("非決定的: %d vs %d", len(o.Edges), len(o2.Edges))
	}
}

func TestStructGroup(t *testing.T) {
	cases := []struct {
		rel  string
		d    int
		want string
	}{
		{"ssl/record/rec.c", 1, "ssl"},
		{"ssl/record/rec.c", 2, "ssl/record"},
		{"ssl/rec.c", 2, "ssl/rec.c"},
		{"util.c", 1, "util.c"}, // ルート直下は自分自身
	}
	for _, c := range cases {
		if got := structGroup(c.rel, c.d); got != c.want {
			t.Errorf("structGroup(%q,%d) = %q, want %q", c.rel, c.d, got, c.want)
		}
	}
}

// 実物の gtags で索引を作り、ダンプ形式が読めていることを確かめる。
// 形式は gtags の内部表現なので、バージョンが変わって読めなくなったときに
// ここが落ちる（黙って空の地図になるのが最悪の壊れ方）。
func TestStructMapFromRealGtags(t *testing.T) {
	if !GtagsInPath() {
		t.Skip("gtags なし")
	}
	dir := t.TempDir()
	write := func(rel, body string) {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
			t.Fatal(err)
		}
		mustWrite(t, p, body)
	}
	write("core/init.c", "void core_init(void) {}\nvoid core_step(void) { core_init(); }\n")
	write("net/send.c", "extern void core_step(void);\nvoid net_send(void) { core_step(); }\n")
	write("gen/junk.c", "extern void core_step(void);\nvoid junk(void) { core_step(); }\n")

	if err := GtagsBuildIndex(context.Background(), dir); err != nil {
		t.Fatalf("gtags: %v", err)
	}

	SetExcludes(dir, []string{"gen/"})
	defer SetExcludes("", nil)
	InvalidateStructCache()
	defer InvalidateStructCache()

	// 読むだけの経路は作らない。索引のダンプは linux で 67 秒かかるので、
	// 開いた瞬間に始めてしまうと利用者は理由も分からず待たされる
	if _, err := StructMapOverview(context.Background(), dir, 1); !errors.Is(err, ErrRefMapNotBuilt) {
		t.Fatalf("未生成なのに勝手に作っている: %v", err)
	}
	var progress []string
	if err := BuildRefMap(context.Background(), dir, func(l string) { progress = append(progress, l) }); err != nil {
		t.Fatal(err)
	}
	if len(progress) == 0 {
		t.Error("進捗が1行も流れていない")
	}
	if st := RefMapStat(dir); !st.Built || !st.Indexed {
		t.Errorf("生成後の状態が %+v", st)
	}

	o, err := StructMapOverview(context.Background(), dir, 1)
	if err != nil {
		t.Fatal(err)
	}
	var netToCore, genEdges int
	for _, e := range o.Edges {
		if e.From == "net" && e.To == "core" {
			netToCore = e.Count
		}
		if e.From == "gen" || e.To == "gen" {
			genEdges++
		}
	}
	if netToCore != 1 {
		t.Errorf("net→core = %d, want 1 (edges=%+v)", netToCore, o.Edges)
	}
	if genEdges != 0 {
		t.Errorf("除外した gen がエッジに出ている: %+v", o.Edges)
	}

	f, err := StructMapFocus(context.Background(), dir, "core")
	if err != nil {
		t.Fatal(err)
	}
	if len(f.Incoming) != 1 || f.Incoming[0].To != "core/init.c" {
		t.Errorf("incoming = %+v, want net → core/init.c", f.Incoming)
	}
	if len(f.Internal) != 0 {
		// core_step→core_init は同一ファイル内なので内部エッジにならない
		t.Errorf("internal = %+v, want 空", f.Internal)
	}
}

// 保存と読み直しで表が同じになること。索引のダンプは linux で 67 秒かかるので、
// 起動のたびに払わないための保存が壊れると、静かに毎回遅くなる。
func TestRefMapCacheRoundTrip(t *testing.T) {
	root := t.TempDir()
	src := tablesForTest()
	mtime := time.Unix(1700000000, 0)
	saveRefMapCache(root, mtime, 4242, "gen/", src)

	got, ok := loadRefMapCache(root, mtime, 4242, "gen/")
	if !ok {
		t.Fatal("保存したものを読み直せない")
	}
	if got.sameName != src.sameName || got.sameNameRefs != src.sameNameRefs {
		t.Errorf("sameName = %d/%d, want %d/%d", got.sameName, got.sameNameRefs, src.sameName, src.sameNameRefs)
	}
	if !slices.Equal(got.implFiles, src.implFiles) {
		t.Errorf("implFiles = %v, want %v", got.implFiles, src.implFiles)
	}
	if len(got.edges) != len(src.edges) {
		t.Fatalf("edges = %d 本, want %d", len(got.edges), len(src.edges))
	}
	for k, want := range src.edges {
		have := got.edges[k]
		if have == nil || have.count != want.count || !slices.Equal(have.syms, want.syms) {
			t.Errorf("%v: %+v, want %+v", k, have, want)
		}
	}
	// 畳んだ結果まで一致すること（表が同じでも読み違えれば地図は変わる）
	if a, b := overviewAuto(src), overviewAuto(got); len(a.Edges) != len(b.Edges) {
		t.Errorf("地図のエッジ数が違う: %d vs %d", len(a.Edges), len(b.Edges))
	}
}

// 索引が更新されたら、あるいは除外設定が変わったら、保存は使わない。
func TestRefMapCacheInvalidation(t *testing.T) {
	root := t.TempDir()
	mtime := time.Unix(1700000000, 0)
	saveRefMapCache(root, mtime, 4242, "gen/", tablesForTest())

	if _, ok := loadRefMapCache(root, mtime.Add(time.Second), 4242, "gen/"); ok {
		t.Error("索引が新しくなったのに古い保存を使っている")
	}
	if _, ok := loadRefMapCache(root, mtime, 9999, "gen/"); ok {
		t.Error("索引のサイズが変わったのに古い保存を使っている")
	}
	if _, ok := loadRefMapCache(root, mtime, 4242, "other/"); ok {
		t.Error("除外設定が変わったのに古い保存を使っている")
	}
	if _, ok := loadRefMapCache(t.TempDir(), mtime, 4242, "gen/"); ok {
		t.Error("別ルートの保存を読んでいる")
	}
}

// 壊れた保存は「読めない」として扱い、作り直しに落ちること。
func TestRefMapCacheRejectsGarbage(t *testing.T) {
	root := t.TempDir()
	mtime := time.Unix(1700000000, 0)
	saveRefMapCache(root, mtime, 4242, "", tablesForTest())
	p := refMapCachePath(root)
	body, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	// 先頭行（ヘッダ）は残し、本体を壊す
	head := strings.SplitN(string(body), "\n", 2)[0]
	mustWrite(t, p, head+"\ne\t999\t999\t5\n")
	if _, ok := loadRefMapCache(root, mtime, 4242, ""); ok {
		t.Error("壊れた保存を受け入れている")
	}
}

// 同名の実装が複数あっても、参照元が自分で定義しているなら、その参照は
// その定義を指す（C の規則。static はファイルの外から見えない）。
// 決められないのは、定義を持たないファイルからの参照だけ。
func TestSameNameResolvedWithinDefiningFile(t *testing.T) {
	if !GtagsInPath() {
		t.Skip("gtags なし")
	}
	dir := t.TempDir()
	write := func(rel, body string) {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
			t.Fatal(err)
		}
		mustWrite(t, p, body)
	}
	// cmp が a.c と b.c の両方にある。a.c は自分の cmp を呼ぶ
	write("a/a.c", "static int cmp(int x) { return x; }\nint a_run(void) { return cmp(1); }\n")
	write("b/b.c", "static int cmp(int x) { return -x; }\nint b_run(void) { return cmp(2); }\n")
	// どちらの cmp を指すか決められない参照
	write("c/c.c", "extern int cmp(int);\nint c_run(void) { return cmp(3); }\n")

	if err := GtagsBuildIndex(context.Background(), dir); err != nil {
		t.Fatalf("gtags: %v", err)
	}
	InvalidateStructCache()
	defer InvalidateStructCache()
	if err := BuildRefMap(context.Background(), dir, nil); err != nil {
		t.Fatal(err)
	}
	o, err := StructMapOverview(context.Background(), dir, 1)
	if err != nil {
		t.Fatal(err)
	}
	// a.c / b.c の中の cmp は解決済み。c.c の参照は、どちらの cmp も static で
	// ファイルの外から見えない以上「決められない」のではなく「ありえない」ので、
	// 決められない参照ではなく static 参照として外れる
	if o.Omitted.SameNameRefs != 0 {
		t.Errorf("決められない参照 = %d, want 0", o.Omitted.SameNameRefs)
	}
	if o.Omitted.StaticRefs != 1 {
		t.Errorf("static 定義への他ファイル参照 = %d, want 1", o.Omitted.StaticRefs)
	}
	if o.Omitted.SameName != 1 {
		t.Errorf("同名シンボル = %d, want 1", o.Omitted.SameName)
	}
	// 同じファイル内で解決したものは境界をまたがないのでエッジにならない
	for _, e := range o.Edges {
		if e.From == e.To {
			t.Errorf("自己参照がエッジになっている: %+v", e)
		}
	}
}

// 直下の一覧は移動のためのものなので、地図の行に出ないまとまりも落とさない。
// ルート直下ではディレクトリと、直に置かれた実装ファイルが並ぶ。
func TestStructChildrenTopLevel(t *testing.T) {
	got := childrenFrom(tablesForTest(), "")

	byPath := map[string]StructChild{}
	for _, c := range got {
		byPath[c.Path] = c
	}
	for _, want := range []string{"core", "net", "util.c"} {
		if _, ok := byPath[want]; !ok {
			t.Fatalf("%q が直下の一覧に無い: %+v", want, got)
		}
	}
	if c := byPath["util.c"]; !c.IsFile {
		t.Errorf("ルート直下の実装ファイルが is_file になっていない: %+v", c)
	}
	if c := byPath["core"]; c.IsFile || c.Files != 2 {
		t.Errorf("core = %+v, want ディレクトリで実装 2 ファイル", c)
	}
	// core は net から 3 参照。core 内部の相互参照は「外から」に数えない。
	if c := byPath["core"]; c.Incoming != 3 {
		t.Errorf("core の被参照 = %d, want 3 (内部の参照は数えない)", c.Incoming)
	}
	// 被参照の多い順。地図本体と同じ並びにする。
	for i := 1; i < len(got); i++ {
		if got[i-1].Incoming < got[i].Incoming {
			t.Fatalf("被参照の降順になっていない: %+v", got)
		}
	}
}

// 深い階層でも直下 1 段だけを返す。net の下は tcp だけで、send.c までは降りない。
func TestStructChildrenNested(t *testing.T) {
	got := childrenFrom(tablesForTest(), "net")
	if len(got) != 1 || got[0].Path != "net/tcp" {
		t.Fatalf("net の直下 = %+v, want net/tcp のみ", got)
	}
	if got[0].IsFile {
		t.Errorf("net/tcp をファイル扱いしている: %+v", got[0])
	}

	deeper := childrenFrom(tablesForTest(), "net/tcp")
	if len(deeper) != 1 || deeper[0].Path != "net/tcp/send.c" || !deeper[0].IsFile {
		t.Fatalf("net/tcp の直下 = %+v, want send.c (ファイル)", deeper)
	}
}

// 実装を持たないパスは空を返す (存在しないパスと区別しない — どちらも地図には無い)。
func TestStructChildrenUnknownPath(t *testing.T) {
	if got := childrenFrom(tablesForTest(), "docs"); len(got) != 0 {
		t.Errorf("docs の直下 = %+v, want 空", got)
	}
}

// GTAGS の定義レコードから static / 関数を読み取る。圧縮辞書 (__.COMPRESS) を
// 通してから見ないと、辞書に入った語で始まる定義を取り違える。
func TestStructDefKind(t *testing.T) {
	dict := structCompress(" __.COMPRESS\t __.COMPRESS ddefine ttypedef")
	if dict['d'] != "define" || dict['t'] != "typedef" {
		t.Fatalf("圧縮辞書 = %+v, want d=define t=typedef", dict)
	}
	cases := []struct {
		image          string
		static, isFunc bool
	}{
		{"@n 290 static int @n(SSL_DANE *dane,", true, true},
		{"@n 104 int @n(SSL *s, size_t length)", false, true},
		{"@n 42 static int @n = 0;", true, false},
		{"@n 7 unsigned char @n[16];", false, false},
		{"@n 12 #@d @n(x) ((x) + 1)", false, true}, // 圧縮された #define
		{"@n 3", false, false},                     // ソースが無いレコード
		{"", false, false},
	}
	for _, c := range cases {
		gotStatic, gotFunc := structDefKind(c.image, dict)
		if gotStatic != c.static || gotFunc != c.isFunc {
			t.Errorf("structDefKind(%q) = (static=%v func=%v), want (%v %v)",
				c.image, gotStatic, gotFunc, c.static, c.isFunc)
		}
	}
}

// 辞書に static が入っている DB でも判定が効く（gtags 6 の既定辞書には無いが、
// 辞書は DB 側が持つものなので、読まずに前方一致すると黙って 0 件になる）。
func TestStructDefKindCompressedStatic(t *testing.T) {
	dict := structCompress(" __.COMPRESS\t __.COMPRESS sstatic ddefine")
	if isStatic, isFunc := structDefKind("@n 10 @s int @n(void)", dict); !isStatic || !isFunc {
		t.Errorf("圧縮された static を展開できていない (static=%v func=%v)", isStatic, isFunc)
	}
}

func TestStructEntrySplitsImage(t *testing.T) {
	sym, id, image, ok := structEntry("dane_tlsa_add\t2929 @n 290 static int @n(SSL_DANE *dane,")
	if !ok || sym != "dane_tlsa_add" || id != "2929" {
		t.Fatalf("structEntry = (%q %q %q %v)", sym, id, image, ok)
	}
	if image != "@n 290 static int @n(SSL_DANE *dane," {
		t.Errorf("image = %q", image)
	}
	if _, _, _, ok := structEntry(" __.COMPRESS\t __.COMPRESS ddefine"); ok {
		t.Error("メタレコードを通してしまっている")
	}
}

// 表示中の1エッジの全シンボル。応答の見本 8 件と違い、こちらは打ち切らない。
// ラベルの畳み方は面ごとに違うので、3面それぞれで引けることを確かめる。
func TestStructEdgeSymbolsFocusFaces(t *testing.T) {
	tb := tablesForTest()
	member := func(focus, from, to string) []string {
		t.Helper()
		got := edgeSymbolsFrom(tb, focus, from, to)
		return got
	}
	// 外から: net → core/init.c（core フォーカス、入口は1段深い）
	if got := member("core", "net", "core/init.c"); !slices.Equal(got, []string{"core_init", "core_step"}) {
		t.Errorf("incoming = %v, want [core_init core_step]", got)
	}
	// 内部: core/init.c → core/other.c
	if got := member("core", "core/init.c", "core/other.c"); !slices.Equal(got, []string{"core_other"}) {
		t.Errorf("internal = %v, want [core_other]", got)
	}
	// 外へ: core/init.c → util.c（from は中のファイル。入口と同じく 1 段深い）
	if got := member("core", "core/init.c", "util.c"); !slices.Equal(got, []string{"util_log"}) {
		t.Errorf("outgoing = %v, want [util_log]", got)
	}
	// 別のエッジのシンボルが混ざらない
	if got := member("core", "net", "core/other.c"); len(got) != 0 {
		t.Errorf("net → core/other.c = %v, want empty", got)
	}
}

// 全体図（自動畳み）のエッジも同じ口で引ける。小さな木では自動畳みが
// ファイル粒度まで割るので、ラベルは overviewAuto の実物に合わせる。
func TestStructEdgeSymbolsOverview(t *testing.T) {
	tb := tablesForTest()
	got := edgeSymbolsFrom(tb, "", "net/tcp/send.c", "core/init.c")
	if !slices.Equal(got, []string{"core_init", "core_step"}) {
		t.Errorf("net/tcp/send.c → core/init.c = %v, want [core_init core_step]", got)
	}
}

// 見本の上限を超えるエッジでも、全シンボルが表に残っている（build で切らない）。
func TestBuildKeepsAllEdgeSymbols(t *testing.T) {
	if !GtagsInPath() {
		t.Skip("gtags なし")
	}
	dir := t.TempDir()
	var defs, calls strings.Builder
	for i := 0; i < 12; i++ {
		fmt.Fprintf(&defs, "int fn_%02d(void) { return %d; }\n", i, i)
		fmt.Fprintf(&calls, "  fn_%02d();\n", i)
	}
	mustWrite(t, filepath.Join(dir, "def.c"), defs.String())
	mustWrite(t, filepath.Join(dir, "use.c"), "void use(void) {\n"+calls.String()+"}\n")
	if err := GtagsBuildIndex(context.Background(), dir); err != nil {
		t.Fatalf("gtags: %v", err)
	}
	InvalidateStructCache()
	defer InvalidateStructCache()
	if err := BuildRefMap(context.Background(), dir, nil); err != nil {
		t.Fatal(err)
	}
	syms, err := StructEdgeSymbols(context.Background(), dir, "", "use.c", "def.c")
	if err != nil {
		t.Fatal(err)
	}
	if len(syms) != 12 {
		t.Fatalf("edge symbols = %d 件 %v, want 12 (見本上限の 8 で切れている)", len(syms), syms)
	}
	// 応答の見本は 8 件のままで、切れていることが伝わる
	f, err := StructMapFocus(context.Background(), dir, "def.c")
	if err != nil {
		t.Fatal(err)
	}
	if len(f.Incoming) != 1 || len(f.Incoming[0].Symbols) != structEdgeSymbolsMax || !f.Incoming[0].SymsCapped {
		t.Errorf("incoming = %+v, want 見本 %d 件 + syms_capped", f.Incoming, structEdgeSymbolsMax)
	}
}

// 全ディレクトリの一覧は深さに関係なく、実装を持つものを全部返す。
func TestStructAllDirs(t *testing.T) {
	dirs := allDirsFrom(tablesForTest())
	got := map[string]int{}
	for _, d := range dirs {
		got[d.Path] = d.Files
	}
	want := map[string]int{"core": 2, "net": 1, "net/tcp": 1}
	if len(got) != len(want) {
		t.Fatalf("dirs = %+v, want %v", dirs, want)
	}
	for p, n := range want {
		if got[p] != n {
			t.Errorf("%s = %d files, want %d", p, got[p], n)
		}
	}
	// パス順
	for i := 1; i < len(dirs); i++ {
		if dirs[i-1].Path > dirs[i].Path {
			t.Errorf("not sorted: %s > %s", dirs[i-1].Path, dirs[i].Path)
		}
	}
}

// 行き先がまとまりに畳まれていても、各シンボルがその中のどのファイルにあるかが分かる。
func TestFocusEdgesCarrySymbolFiles(t *testing.T) {
	f := focusFrom(tablesForTest(), "core")
	// net → core/init.c: core_init / core_step はどちらも core/init.c
	e := f.Incoming[0]
	if len(e.SymbolFiles) != len(e.Symbols) {
		t.Fatalf("symbol_files = %v, symbols = %v", e.SymbolFiles, e.Symbols)
	}
	for i, s := range e.Symbols {
		if e.SymbolFiles[i] != "core/init.c" {
			t.Errorf("%s defined in %q, want core/init.c", s, e.SymbolFiles[i])
		}
	}
	syms, files, err := StructEdgeSymbolFiles(context.Background(), "", "core", "net", "core/init.c", false)
	_ = syms
	_ = files
	_ = err // ルート無しでは表が無い。関数の形だけ確かめる
	pairs := edgeSymbolPairsFrom(tablesForTest(), "core", "net", "core/init.c")
	if len(pairs) != 2 || pairs[0][1] != "core/init.c" {
		t.Errorf("pairs = %v", pairs)
	}
}

func TestStructDefIsMacro(t *testing.T) {
	dict := map[byte]string{'d': "define", 't': "typedef"}
	for img, want := range map[string]bool{
		"@n 12 # @d @n":        true, // `# define X`（字下げ付き）
		"@n 103 #  @d @n":      true,
		"@n 5 #@d @n(a) (a)":   true,
		"@n 56 # undef @n":     true,
		"@n 7 int @n(void)":    false,
		"@n 9 static int @n;":  false,
		"@n 3 @t struct x @n;": false,
	} {
		if got := structDefIsMacro(img, dict); got != want {
			t.Errorf("%q: got %v, want %v", img, got, want)
		}
	}
}

// .c の中の #define は他の翻訳単位から見えない。名前が一致した他ファイルの参照を
// その .c への線にしない（openssl: apps/vms_term_sock.c の `# define OPENSSL_SYS_VMS`
// が、ヘッダの同名マクロを使う全ファイルからの入口に見えていた）。
func TestMacroInImplFileIsFileLocal(t *testing.T) {
	if !GtagsInPath() {
		t.Skip("gtags なし")
	}
	dir := t.TempDir()
	write := func(rel, body string) {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
			t.Fatal(err)
		}
		mustWrite(t, p, body)
	}
	write("include/os.h", "#define SYS_VMS 1\n")
	write("apps/vms.c", "#include \"os.h\"\n# define SYS_VMS 1\n# define WINNT 4\nint vms_run(void) { return SYS_VMS + WINNT; }\n")
	write("ssl/s.c", "#include \"os.h\"\nint s_run(void) { return SYS_VMS + WINNT; }\n")
	write("core/c.c", "int core_fn(void) { return 1; }\n")
	write("ssl/t.c", "int core_fn(void);\nint t_run(void) { return core_fn(); }\n")

	if err := GtagsBuildIndex(context.Background(), dir); err != nil {
		t.Fatalf("gtags: %v", err)
	}
	InvalidateStructCache()
	defer InvalidateStructCache()
	if err := BuildRefMap(context.Background(), dir, nil); err != nil {
		t.Fatal(err)
	}
	o, err := StructMapOverview(context.Background(), dir, 1)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range o.Edges {
		if e.To == "apps" {
			t.Errorf("ssl → apps の線ができている（.c 内のマクロを他ファイルの参照先にした）: %+v", e)
		}
	}
	// ssl/s.c の SYS_VMS と WINNT が、apps/vms.c のマクロへの参照として外れる
	if o.Omitted.StaticRefs != 2 {
		t.Errorf("static_refs = %d, want 2", o.Omitted.StaticRefs)
	}
	// 本物の線は残る
	found := false
	for _, e := range o.Edges {
		if e.From == "ssl" && e.To == "core" {
			found = true
		}
	}
	if !found {
		t.Errorf("ssl → core が無い: %+v", o.Edges)
	}
}

// ファイル単位では、サブディレクトリを畳まずに中のファイルどうしの線を返す。
func TestFocusFileLevel(t *testing.T) {
	tt := mkTables(map[string]string{
		"x509_cmp": "crypto/x509/cmp.c",
		"bn_add":   "crypto/bn/add.c",
		"mem_new":  "crypto/mem.c",
	}, 0, [][2]string{
		{"bn_add", "crypto/x509/cmp.c"},   // x509/cmp.c → bn/add.c
		{"x509_cmp", "crypto/x509/vfy.c"}, // 同じサブディレクトリの中: 畳んだ表では消える線
		{"mem_new", "crypto/bn/add.c"},    // bn/add.c → mem.c
		{"x509_cmp", "ssl/s.c"},           // 外から
	})
	f := focusFromAt(tt, "crypto", true)
	got := map[string]bool{}
	for _, e := range f.Internal {
		got[e.From+"->"+e.To] = true
	}
	for _, want := range []string{"crypto/x509/cmp.c->crypto/bn/add.c", "crypto/x509/vfy.c->crypto/x509/cmp.c", "crypto/bn/add.c->crypto/mem.c"} {
		if !got[want] {
			t.Errorf("internal に %s が無い: %v", want, got)
		}
	}
	if len(f.Incoming) != 1 || f.Incoming[0].To != "crypto/x509/cmp.c" {
		t.Errorf("incoming = %+v, want ssl → crypto/x509/cmp.c", f.Incoming)
	}
	if len(f.AllFiles) != 3 {
		t.Errorf("all_files = %v, want 実装 3 ファイル", f.AllFiles)
	}
	// 畳んだ版は今までどおり
	if g := focusFrom(tt, "crypto"); len(g.AllFiles) != 0 || len(g.Internal) != 2 {
		t.Errorf("folded: all_files=%v internal=%+v", g.AllFiles, g.Internal)
	}
	// 残りのシンボルも同じ畳み方で引ける
	if p := edgeSymbolPairsAt(tt, "crypto", "crypto/x509/vfy.c", "crypto/x509/cmp.c", true); len(p) != 1 || p[0][0] != "x509_cmp" {
		t.Errorf("edge symbols = %v", p)
	}
}

// 外へ の参照は、中のどのファイルから出ているかを持つ。まとまり全体で畳むと、
// 1 つのファイルが外の何を使っているかを絞り込めない。
func TestFocusOutgoingKeepsSourceFile(t *testing.T) {
	f := focusFrom(tablesForTest(), "core")
	got := map[string]int{}
	for _, e := range f.Outgoing {
		got[e.From+"->"+e.To] = e.Count
	}
	if got["core/init.c->net"] != 1 || got["core/init.c->util.c"] != 1 || len(got) != 2 {
		t.Errorf("outgoing = %v, want core/init.c → net と core/init.c → util.c", got)
	}
}
