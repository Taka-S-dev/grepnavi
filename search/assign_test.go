package search

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMarkAssignmentsForms(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "plain.c")
	// メンバ形が一度も出ないファイル。裸の代入も数える
	if err := os.WriteFile(file, []byte("int state;\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		text string
		want bool
	}{
		{"state = READY;", true},
		{"state=READY;", true},
		{"state += 1;", true},
		{"state <<= 2;", true},
		{"state++;", true},
		{"--state;", true},
		{"if (state == READY)", false},
		{"if (state != READY)", false},
		{"if (state <= MAX)", false},
		{"if (state >= MIN)", false},
		{"return state;", false},
		{"f(state);", false},
		{"other_state = READY;", false}, // 語境界
	}
	sites := make([]CallSite, len(cases))
	for i, c := range cases {
		sites[i] = CallSite{File: file, Text: c.text}
	}
	MarkAssignments(sites, "state")
	for i, c := range cases {
		if sites[i].Assign != c.want {
			t.Errorf("%q: Assign=%v, want %v", c.text, sites[i].Assign, c.want)
		}
	}
}

// 同名のローカルとメンバは行だけでは区別できない。以前はファイル内に
// メンバ形があれば裸の代入を無視していたが、`curves[n].nid` が1行あるだけで
// 同じファイルのローカル `nid = ...` が全部消えた（openssl の ecparam.c で30件）。
// いまはどちらも出し、区別は行の字面に任せる。
func TestMarkAssignmentsKeepsBothMemberAndLocal(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "member.c")
	if err := os.WriteFile(file, []byte("void f(SSL *s)\n{\n\tint state = 0;\n\ts->state = READY;\n}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	sites := []CallSite{
		{File: file, Text: "int state = 0;"},
		{File: file, Text: "s->state = READY;"},
		{File: file, Text: "conn.state = READY;"},
		{File: file, Text: "if (s->state == READY)"},
	}
	MarkAssignments(sites, "state")
	for i, want := range []bool{true, true, true, false} {
		if sites[i].Assign != want {
			t.Errorf("[%d] %q: Assign=%v, want %v", i, sites[i].Text, sites[i].Assign, want)
		}
	}
}

// 判定はコメント・文字列を落とした行で行う。生の行だと書式文字列の
// `"nid = %s"` が代入に見える（openssl の ectest.c で実際に出た）。
func TestMarkAssignmentsIgnoresStringsAndComments(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "s.c")
	if err := os.WriteFile(file, []byte("void f(void)\n{\n\tTEST_info(\"nid = %s\", x);\n\tnid = 3;\n}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	sites := []CallSite{
		{File: file, CallLine: 3, Text: `TEST_info("nid = %s", x);`},
		{File: file, CallLine: 4, Text: "nid = 3;"},
	}
	MarkAssignments(sites, "nid")
	if sites[0].Assign {
		t.Errorf("文字列の中を代入と判定している: %q", sites[0].Text)
	}
	if !sites[1].Assign {
		t.Errorf("本物の代入を落としている: %q", sites[1].Text)
	}
}

// `++p->n` が増やすのは n であって p ではない。前置の増減は語が
// lvalue 全体のときだけ数える（curl の `++multi->xfers_alive` で出た）。
func TestMarkAssignmentsPrefixIncrementTarget(t *testing.T) {
	sites := []CallSite{
		{Text: "++i;"},
		{Text: "--i;"},
		{Text: "++multi->xfers_alive;"},
		{Text: "--multi->xfers_alive;"},
		{Text: "multi->xfers_alive++;"},
	}
	MarkAssignments(sites, "multi")
	for i, want := range []bool{false, false, false, false, false} {
		if sites[i].Assign != want {
			t.Errorf("[%d] %q: multi への書き込み=%v, want %v", i, sites[i].Text, sites[i].Assign, want)
		}
	}
	// 後置の増減はメンバ自身への書き込み。cscope は ++/-- を代入として
	// 報告しないので、linux では 162 件がこちら側にしか出なかった
	memberInc := []CallSite{{Text: "dir->i_size++;"}, {Text: "src_dir->i_size--;"}}
	MarkAssignments(memberInc, "i_size")
	for i := range memberInc {
		if !memberInc[i].Assign {
			t.Errorf("メンバへの増減を落としている: %q", memberInc[i].Text)
		}
	}

	MarkAssignments(sites[:2], "i")
	for i, want := range []bool{true, true} {
		if sites[i].Assign != want {
			t.Errorf("[%d] %q: i への書き込み=%v, want %v", i, sites[i].Text, sites[i].Assign, want)
		}
	}
}
