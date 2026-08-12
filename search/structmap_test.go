package search

import (
	"context"
	"errors"
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
	// a.c / b.c の中の cmp は解決済みなので「決められない参照」に数えない。
	// c.c の1件だけが残る
	if o.Omitted.SameNameRefs != 1 {
		t.Errorf("決められない参照 = %d, want 1", o.Omitted.SameNameRefs)
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
