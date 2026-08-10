package search

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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
