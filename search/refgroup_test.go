package search

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// 代入の右辺は字面のまま見出しにする。意味は推定しない。
func TestAssignedValue(t *testing.T) {
	re := assignedValueRe("hand_state")
	cases := []struct{ line, want string }{
		{"    st->hand_state = TLS_ST_OK;", "TLS_ST_OK"},
		{"st->hand_state = TLS_ST_CW_CLNT_HELLO;  /* コメント */", "TLS_ST_CW_CLNT_HELLO"},
		{"    hand_state = a ? B : C;", "a ? B : C"},
		{"    s->hand_state += 1;", "+= 1"},
		{"    if (st->hand_state == TLS_ST_OK)", ""}, // 比較は代入ではない
		{"    use(st->hand_state);", ""},
	}
	for _, c := range cases {
		if got := assignedValue(re, c.line); got != c.want {
			t.Errorf("assignedValue(%q) = %q, want %q", c.line, got, c.want)
		}
	}
}

// 見出しの取り出し方が by ごとに変わる。
func TestGroupKeyFunc(t *testing.T) {
	s := CallSite{Func: "state_machine", File: `C:\p\statem.c`, Text: "st->x = TLS_ST_OK;"}
	if got := groupKeyFunc("value", "x")(s); got != "TLS_ST_OK" {
		t.Errorf("value = %q", got)
	}
	if got := groupKeyFunc("func", "x")(s); got != "state_machine" {
		t.Errorf("func = %q", got)
	}
	if got := groupKeyFunc("file", "x")(s); got != `C:\p\statem.c` {
		t.Errorf("file = %q", got)
	}
	// 関数の外にある参照も落とさず、そう見える見出しにまとめる
	if got := groupKeyFunc("func", "x")(CallSite{}); got != "(関数の外)" {
		t.Errorf("関数の外 = %q", got)
	}
}

// 読めなかった行を捨てると件数が合わなくなる。まとめ先を用意して残す。
func TestGroupKeyKeepsUnreadableValue(t *testing.T) {
	re := regexp.MustCompile(`nothing matches`)
	_ = re
	got := groupKeyFunc("value", "x")(CallSite{Text: "use(x);"})
	if got != "(値を読めない)" {
		t.Errorf("got %q", got)
	}
}

// 集約は上限に達する前に数え終える。上限で切ってから数えると
// 「先頭 limit 件の中での分布」になり、全体の分布とは別物になる。
// openssl の hand_state は代入 132 件で、生の一覧は 100 件で切れていた。
func TestGroupRefSitesCountsPastTheDisplayLimit(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not installed")
	}
	root := t.TempDir()
	var b strings.Builder
	b.WriteString("void f(void)\n{\n")
	for i := 0; i < 120; i++ {
		b.WriteString("    st->target = VALUE_A;\n")
	}
	for i := 0; i < 30; i++ {
		b.WriteString("    st->target = VALUE_B;\n")
	}
	b.WriteString("}\n")
	if err := os.WriteFile(filepath.Join(root, "a.c"), []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}

	// Limit は集約側で上書きされる。呼び出し側が 5 を渡しても全件数える
	groups, total, _, err := GroupRefSites(context.Background(),
		RefQuery{Word: "target", Root: root, Limit: 5, NoIndex: true}, []string{"value"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if total != 150 {
		t.Errorf("total = %d, want 150（上限で切ってから数えている）", total)
	}
	if len(groups) != 2 {
		t.Fatalf("groups = %d, want 2: %+v", len(groups), groups)
	}
	// 多い順に並ぶ
	if groups[0].Key != "VALUE_A" || groups[0].Count != 120 {
		t.Errorf("[0] = %+v, want VALUE_A x120", groups[0])
	}
	if groups[1].Key != "VALUE_B" || groups[1].Count != 30 {
		t.Errorf("[1] = %+v, want VALUE_B x30", groups[1])
	}
	// 見本はルートからの相対 "path:line"
	if len(groups[0].Sample) != 1 || !strings.HasPrefix(groups[0].Sample[0], "a.c:") {
		t.Errorf("sample = %v, want a.c:<行>", groups[0].Sample)
	}
}

// 2段目まで数えると「どの値が、どの関数の、どの行から入るか」が1回で揃う。
// 1段だけだと使う側は場所を知るために生データを取り直すことになり、
// 往復も総量も増える（openssl の hand_state で 4.4 + 25.3 KB）。
func TestGroupRefSitesTwoLevels(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not installed")
	}
	root := t.TempDir()
	src := `void alpha(void)
{
    st->target = VALUE_A;
    st->target = VALUE_A;
}
void beta(void)
{
    st->target = VALUE_A;
    st->target = VALUE_B;
}
`
	if err := os.WriteFile(filepath.Join(root, "a.c"), []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}

	groups, total, _, err := GroupRefSites(context.Background(),
		RefQuery{Word: "target", Root: root, NoIndex: true}, []string{"value", "func"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if total != 4 {
		t.Fatalf("total = %d, want 4", total)
	}
	if len(groups) != 2 || groups[0].Key != "VALUE_A" || groups[0].Count != 3 {
		t.Fatalf("外側 = %+v", groups)
	}
	// 2段目は関数ごとに全行番号を持つ（見本ではない）
	sub := groups[0].Sub
	if len(sub) != 2 {
		t.Fatalf("VALUE_A の内側 = %+v, want 2 関数", sub)
	}
	if sub[0].Key != "alpha" || len(sub[0].Lines) != 2 {
		t.Errorf("alpha = %+v, want 2 行", sub[0])
	}
	if sub[1].Key != "beta" || len(sub[1].Lines) != 1 {
		t.Errorf("beta = %+v, want 1 行", sub[1])
	}
	if sub[0].File != "a.c" {
		t.Errorf("file = %q, want ルート相対の a.c", sub[0].File)
	}
	// 2段目があるときは見本を重ねない
	if len(groups[0].Sample) != 0 {
		t.Errorf("sample と sub が重複している: %v", groups[0].Sample)
	}
}
