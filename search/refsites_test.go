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

// 参照一覧と呼び出し元一覧で「何を残すか」が分かれる点を固定する。
// この分岐が索引側に埋まっていたせいで、囲む関数の解決が壊れたときに
// 参照は ripgrep へ降格して成立し、呼び出し元だけ 0 件になった。
func TestKeepCallersDropsWhatOnlyCallersDrop(t *testing.T) {
	sites := []CallSite{
		{Func: "caller_a", File: "a.c", CallLine: 10},
		{Func: "caller_a", File: "a.c", CallLine: 20}, // 同じ関数からの2件目
		{Func: "", File: "a.c", CallLine: 5},          // プロトタイプ宣言など
		{Func: "target", File: "a.c", CallLine: 30},   // 自分自身
		{Func: "caller_a", File: "b.c", CallLine: 40}, // 別ファイルの同名関数は別物
		{Func: "caller_b", File: "b.c", CallLine: 50},
	}
	got := keepCallers(sites, "target")
	want := []struct {
		fn, file string
	}{
		{"caller_a", "a.c"}, {"caller_a", "b.c"}, {"caller_b", "b.c"},
	}
	if len(got) != len(want) {
		t.Fatalf("件数 got=%d want=%d (%+v)", len(got), len(want), got)
	}
	for i, w := range want {
		if got[i].Func != w.fn || got[i].File != w.file {
			t.Errorf("[%d] got=%s/%s want=%s/%s", i, got[i].File, got[i].Func, w.file, w.fn)
		}
	}

	// 参照一覧はどれも落とさない。囲む関数が無い箇所（宣言・マクロ定義）こそ
	// 「誰が触っているか」を知りたい対象になる
	if len(sites) != 6 {
		t.Errorf("元の一覧を書き換えている: %d", len(sites))
	}
}

func TestCapSitesReportsTruncation(t *testing.T) {
	sites := make([]CallSite, 5)
	if got, tr := capSites(sites, 10); len(got) != 5 || tr {
		t.Errorf("上限内なのに切っている: %d %v", len(got), tr)
	}
	if got, tr := capSites(sites, 3); len(got) != 3 || !tr {
		t.Errorf("切ったのに伝えていない: %d %v", len(got), tr)
	}
}

// FindRefSites の配線（エンジン選択・絞り込み・用途ごとの取捨）を通しで確かめる。
// 部品が正しくても配線が食い違うのが今日の不具合だったので、ここを空けない。
func writeRefFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	main := "" +
		"static int helper(int a);\n" + // 1: プロトタイプ宣言（囲む関数なし）
		"\n" +
		"#define CALL_HELPER() helper(0)\n" + // 3: マクロ定義（囲む関数なし）
		"\n" +
		"static const struct ops tbl = {\n" + // 5
		"\t.run = helper,\n" + // 6: 関数ポインタ表（囲む関数はテーブル変数名）
		"};\n" +
		"\n" +
		"static int helper(int a)\n" + // 9: 定義
		"{\n" +
		"\treturn a;\n" +
		"}\n" +
		"\n" +
		"int user(void)\n" + // 14
		"{\n" +
		"\tint x = helper(1);\n" + // 16
		"\tint y = helper(2);\n" + // 17: 同じ関数からの2件目
		"\treturn x + y;\n" +
		"}\n"
	if err := os.WriteFile(filepath.Join(dir, "main.c"), []byte(main), 0o644); err != nil {
		t.Fatal(err)
	}
	other := "int other(void)\n{\n\treturn helper(3);\n}\n" // 3行目
	if err := os.WriteFile(filepath.Join(dir, "other.c"), []byte(other), 0o644); err != nil {
		t.Fatal(err)
	}
	// 索引に入らない生成物。glob 絞り込みの確認用
	if err := os.WriteFile(filepath.Join(dir, "doc.html"), []byte("<p>helper(9)</p>\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestFindRefSitesReferencesKeepEveryUse(t *testing.T) {
	dir := writeRefFixture(t)
	sites, engine, _, err := FindRefSites(context.Background(), RefQuery{
		Word: "helper", Root: dir, NoIndex: true, Limit: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if engine != "rg" {
		t.Errorf("engine=%q want rg", engine)
	}
	at := map[string]string{} // "file:line" → 囲む関数
	for _, s := range sites {
		at[filepath.Base(s.File)+":"+strconv.Itoa(s.CallLine)] = s.Func
	}
	// 囲む関数が無い箇所こそ落としてはいけない
	for _, k := range []string{"main.c:1", "main.c:3"} {
		if _, ok := at[k]; !ok {
			t.Errorf("%s（囲む関数なし）が参照一覧から消えている: %v", k, at)
		}
	}
	if at["main.c:6"] != "tbl" {
		t.Errorf("関数ポインタ表の登録が %q（want tbl）", at["main.c:6"])
	}
	// 同じ関数からの2件は両方残る
	if at["main.c:16"] != "user" || at["main.c:17"] != "user" {
		t.Errorf("同じ関数からの複数参照が落ちている: %v", at)
	}
}

func TestFindRefSitesCallersNarrowToFunctions(t *testing.T) {
	dir := writeRefFixture(t)
	sites, _, _, err := FindRefSites(context.Background(), RefQuery{
		Word: "helper", Root: dir, NoIndex: true, CallersOnly: true, Limit: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, s := range sites {
		got[filepath.Base(s.File)+"/"+s.Func] = true
	}
	for _, want := range []string{"main.c/user", "other.c/other"} {
		if !got[want] {
			t.Errorf("%s が呼び出し元に出ていない: %v", want, got)
		}
	}
	if got["main.c/helper"] {
		t.Errorf("自分自身を呼び出し元にしている: %v", got)
	}
	if len(sites) != len(got) {
		t.Errorf("同じ関数から複数件返している: %d 件 / %d 種", len(sites), len(got))
	}
}

func TestFindRefSitesAppliesGlob(t *testing.T) {
	dir := writeRefFixture(t)
	sites, _, _, err := FindRefSites(context.Background(), RefQuery{
		Word: "helper", Root: dir, Glob: "*.c", NoIndex: true, Limit: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range sites {
		if filepath.Ext(s.File) != ".c" {
			t.Errorf("glob=*.c なのに %s が混じっている", s.File)
		}
	}
	if len(sites) == 0 {
		t.Error("glob で全部消えている")
	}
}

// 索引経路も実物の GTAGS を作って通す。今日の不具合は索引側だけが
// 用途ごとの取捨を持っていたことに起因したので、ここを ripgrep だけで
// 確かめると同じ食い違いを見逃す。
func TestFindRefSitesIndexPathMatchesReferences(t *testing.T) {
	if _, err := exec.LookPath("gtags"); err != nil {
		t.Skip("gtags なし")
	}
	dir := writeRefFixture(t)
	cmd := exec.Command("gtags")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("gtags の作成に失敗: %v %s", err, out)
	}
	if !GtagsAvailable(dir) {
		t.Skip("索引を認識できない")
	}

	refs, engine, _, err := FindRefSites(context.Background(), RefQuery{
		Word: "helper", Root: dir, Limit: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if engine != "gtags" {
		t.Fatalf("索引があるのに engine=%q", engine)
	}
	at := map[string]bool{}
	for _, s := range refs {
		at[filepath.Base(s.File)+":"+strconv.Itoa(s.CallLine)] = true
	}
	// 索引経路でも、囲む関数が無い箇所と同じ関数からの2件目を落とさない
	for _, k := range []string{"main.c:1", "main.c:3", "main.c:16", "main.c:17"} {
		if !at[k] {
			t.Errorf("索引経路で %s が消えている: %v", k, at)
		}
	}

	callers, _, _, err := FindRefSites(context.Background(), RefQuery{
		Word: "helper", Root: dir, CallersOnly: true, Limit: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, s := range callers {
		got[s.Func] = true
	}
	for _, want := range []string{"user", "other"} {
		if !got[want] {
			t.Errorf("索引経路の呼び出し元に %s が出ていない: %v", want, got)
		}
	}
	if got["helper"] {
		t.Errorf("自分自身を呼び出し元にしている: %v", got)
	}
}

// 索引のヒットは解決の前に切る。全件を解決してから切ると、上限が
// 2000 でも linux の `ret`（参照 60 万件）で 17 秒かかっていた。
// 打ち切ったことは必ず伝わること。
func TestFindRefSitesReportsIndexTruncation(t *testing.T) {
	if _, err := exec.LookPath("gtags"); err != nil {
		t.Skip("gtags なし")
	}
	dir := writeRefFixture(t)
	cmd := exec.Command("gtags")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("gtags の作成に失敗: %v %s", err, out)
	}
	if !GtagsAvailable(dir) {
		t.Skip("索引を認識できない")
	}
	full, _, tr, err := FindRefSites(context.Background(), RefQuery{Word: "helper", Root: dir, Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	if tr {
		t.Fatalf("上限に届いていないのに打ち切り扱い: %d 件", len(full))
	}
	cut, _, tr2, err := FindRefSites(context.Background(), RefQuery{Word: "helper", Root: dir, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if !tr2 {
		t.Errorf("上限 1 で切ったのに伝えていない: %d 件", len(cut))
	}
	if len(cut) > 1 {
		t.Errorf("上限 1 を超えて返している: %d 件", len(cut))
	}
}

func TestParseRefFilter(t *testing.T) {
	got := parseRefFilter("  crypto -test path:ssl -file:doc  ")
	want := []refTerm{
		{text: "crypto"},
		{neg: true, text: "test"},
		{pathOnly: true, text: "ssl"},
		{neg: true, pathOnly: true, text: "doc"},
	}
	if len(got) != len(want) {
		t.Fatalf("条件の数 got=%d want=%d (%+v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("[%d] got=%+v want=%+v", i, got[i], want[i])
		}
	}
	if len(parseRefFilter("   ")) != 0 {
		t.Error("空入力から条件が出ている")
	}
}

// 絞り込みは解決の前に掛かる。索引が返した全件が対象になるので、
// 手元で絞るのと違って「取ってこなかった範囲」が残らない。
func TestFindRefSitesServerSideFilter(t *testing.T) {
	dir := writeRefFixture(t)
	q := RefQuery{Word: "helper", Root: dir, NoIndex: true, Limit: 100}
	all, _, _, err := FindRefSites(context.Background(), q)
	if err != nil {
		t.Fatal(err)
	}
	q.Filter = "path:other"
	only, _, _, err := FindRefSites(context.Background(), q)
	if err != nil {
		t.Fatal(err)
	}
	if len(only) == 0 || len(only) >= len(all) {
		t.Fatalf("path: で絞れていない: 全 %d 件 → %d 件", len(all), len(only))
	}
	for _, s := range only {
		if !strings.Contains(strings.ToLower(s.File), "other") {
			t.Errorf("path:other に一致しない行が残っている: %s", s.File)
		}
	}
	q.Filter = "-path:other"
	rest, _, _, err := FindRefSites(context.Background(), q)
	if err != nil {
		t.Fatal(err)
	}
	if len(rest)+len(only) != len(all) {
		t.Errorf("除外と抽出の合計が全体に一致しない: %d + %d != %d", len(rest), len(only), len(all))
	}
}

// 索引が使えないときの経路でも、絞り込みと代入判定は上限で切る前に掛ける。
// 切ってから絞ると、絞り込みは「先頭 limit 件」の中しか見られない
// （linux の ret を path:net/ipv4 で引いたら 0 件になった）。
//
// 1ファイル内なら rg の返す順は行番号順で決まるので、残したい行を後ろに置けば
// 「先頭しか見ていない」実装は必ず落ちる。ファイルをまたぐ順序は不定なので
// この形にしてある。
func TestRgRefSitesNarrowsBeforeCap(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not installed")
	}
	root := t.TempDir()
	var b strings.Builder
	b.WriteString("void f(void)\n{\n")
	for i := 0; i < 60; i++ {
		b.WriteString("    use(target);\n") // 読み出しだけ。絞り込みでも代入でも残らない
	}
	for i := 0; i < 10; i++ {
		b.WriteString("    target = 1; /* KEEP */\n") // 残したい行は後ろ
	}
	b.WriteString("}\n")
	if err := os.WriteFile(filepath.Join(root, "a.c"), []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Run("絞り込み", func(t *testing.T) {
		sites, _, err := rgRefSites(context.Background(), "target", root, "", 5,
			parseRefFilter("keep"), false)
		if err != nil {
			t.Fatal(err)
		}
		if len(sites) == 0 {
			t.Fatal("上限で切ってから絞ったため、後ろの行に届いていない")
		}
		for _, s := range sites {
			if !strings.Contains(s.Text, "KEEP") {
				t.Errorf("絞り込みの外が混ざった: %s", s.Text)
			}
		}
	})

	t.Run("代入だけ", func(t *testing.T) {
		sites, _, err := rgRefSites(context.Background(), "target", root, "", 5, nil, true)
		if err != nil {
			t.Fatal(err)
		}
		if len(sites) == 0 {
			t.Fatal("上限で切ってから代入を選んだため、後ろの行に届いていない")
		}
		for _, s := range sites {
			if !s.Assign {
				t.Errorf("代入でない行が混ざった: %s", s.Text)
			}
		}
	})
}
