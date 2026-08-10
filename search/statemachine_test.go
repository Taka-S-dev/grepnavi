package search

import (
	"path/filepath"
	"strings"
	"testing"
)

// enum 定義から全体集合と値が出て、代入されない状態が浮く
func TestAnalyzeStateMachineEnum(t *testing.T) {
	requireRg(t)
	dir := t.TempDir()
	write(t, dir+"/defs.h",
		"typedef enum {\n"+
			"    CS_IDLE,\n"+
			"    CS_OPEN = 5,\n"+
			"    CS_CLOSED\n"+
			"} conn_state_t;\n")
	write(t, dir+"/main.c",
		"void f(struct c *c) {\n"+
			"    switch (c->cs) {\n"+
			"    case CS_IDLE:\n"+
			"        c->cs = CS_OPEN;\n"+
			"        break;\n"+
			"    }\n"+
			"}\n")

	sm := AnalyzeStateMachine(t.Context(),
		[]string{filepath.Join(dir, "defs.h"), filepath.Join(dir, "main.c")}, "cs", dir, "")

	if sm.Family != "enum" {
		t.Fatalf("family = %q, want enum (states: %+v)", sm.Family, sm.States)
	}
	if len(sm.States) != 3 {
		t.Fatalf("状態数 = %d, want 3: %+v", len(sm.States), sm.States)
	}
	byName := map[string]StateInfo{}
	for _, s := range sm.States {
		byName[s.Name] = s
	}
	if byName["CS_IDLE"].Value != "0" || byName["CS_OPEN"].Value != "5" || byName["CS_CLOSED"].Value != "6" {
		t.Errorf("値が違う: %+v", sm.States)
	}
	if !byName["CS_OPEN"].Assigned {
		t.Errorf("CS_OPEN は代入されているはず")
	}
	if byName["CS_CLOSED"].Assigned || byName["CS_CLOSED"].Observed {
		t.Errorf("CS_CLOSED はデッドステートのはず: %+v", byName["CS_CLOSED"])
	}
	// 値順に並ぶ
	if sm.States[0].Name != "CS_IDLE" || sm.States[2].Name != "CS_CLOSED" {
		t.Errorf("値順に並んでいない: %+v", sm.States)
	}
}

// enum でないブロック（同名メンバーが struct/switch にある）を enum と誤認しない
func TestAnalyzeStateMachineNotEnumBlock(t *testing.T) {
	requireRg(t)
	dir := t.TempDir()
	// ST_A は enum ではなく switch の case にだけ現れる（索引無しだと
	// FindDefinitionsN が enum_member 扱いのヒットを返しうる形）
	write(t, dir+"/main.c",
		"struct wrap {\n"+
			"    int ST_A;\n"+ // struct メンバーに同名がある罠
			"    int other;\n"+
			"};\n"+
			"void f(struct s *s) {\n"+
			"    if (s->st == ST_A)\n"+
			"        s->st = ST_B;\n"+
			"}\n")

	sm := AnalyzeStateMachine(t.Context(),
		[]string{dir + "/main.c"}, "st", dir, "")
	// struct wrap を enum と誤認していれば other 等が状態に混ざる
	for _, s := range sm.States {
		if s.Name == "other" {
			t.Fatalf("struct メンバーを状態に取り込んだ: %+v", sm.States)
		}
	}
}

// #define 群は共通接頭辞で全体集合を推定し、値も定義行から計算する
func TestAnalyzeStateMachinePrefix(t *testing.T) {
	requireRg(t)
	dir := t.TempDir()
	write(t, dir+"/ps.h",
		"#define PS_INIT 0\n"+
			"#define PS_RUN  1\n"+
			"#define PS_DONE (PS_RUN + 1)\n"+
			"#define PS_HELPER(x) ((x)+1)\n")
	write(t, dir+"/main.c",
		"void f(struct m *m) {\n"+
			"    if (m->ps == PS_INIT)\n"+
			"        m->ps = PS_RUN;\n"+
			"}\n")

	files := []string{filepath.Join(dir, "ps.h"), filepath.Join(dir, "main.c")}
	sm := AnalyzeStateMachine(t.Context(), files, "ps", dir, "")

	if sm.Family != "prefix" {
		t.Fatalf("family = %q, want prefix (states: %+v)", sm.Family, sm.States)
	}
	byName := map[string]StateInfo{}
	for _, s := range sm.States {
		byName[s.Name] = s
	}
	if _, ok := byName["PS_HELPER"]; ok {
		t.Errorf("関数形式マクロが状態に混ざった: %+v", sm.States)
	}
	if len(sm.States) != 3 {
		t.Fatalf("状態数 = %d, want 3: %+v", len(sm.States), sm.States)
	}
	if byName["PS_DONE"].Value != "2" {
		t.Errorf("PS_DONE の値 = %q, want 2 (式の解決)", byName["PS_DONE"].Value)
	}
	if byName["PS_DONE"].Assigned || byName["PS_DONE"].Observed {
		t.Errorf("PS_DONE はデッドステートのはず")
	}
}

// ヘルパ関数（右辺が仮引数）の呼び出し箇所から、定数渡しの遷移を復元する
func TestAnalyzeStateMachineHelper(t *testing.T) {
	requireRg(t)
	dir := t.TempDir()
	write(t, dir+"/defs.h",
		"enum tcp_st {\n"+
			"    TS_CLOSE,\n"+
			"    TS_SYN,\n"+
			"    TS_ESTABLISHED\n"+
			"};\n"+
			"void set_st(struct sock *sk, int st);\n")
	write(t, dir+"/helper.c",
		"void set_st(struct sock *sk, int st)\n"+
			"{\n"+
			"    sk->st = st;\n"+
			"}\n")
	write(t, dir+"/caller.c",
		"void open_conn(struct sock *sk)\n"+
			"{\n"+
			"    switch (sk->st) {\n"+
			"    case TS_CLOSE:\n"+
			"        set_st(sk, TS_SYN);\n"+
			"        break;\n"+
			"    }\n"+
			"    set_st(sk, next_state(sk));\n"+
			"}\n")

	files := []string{dir + "/defs.h", dir + "/helper.c", dir + "/caller.c"}
	sm := AnalyzeStateMachine(t.Context(), files, "st", dir, "")

	var viaKeys []string
	for _, tr := range sm.Transitions {
		if tr.Via != "" {
			viaKeys = append(viaKeys, transKey(tr)+"@"+tr.Func+" via "+tr.Via)
		}
	}
	// 定数渡しの1件だけ復元される。変数渡し・プロトタイプ宣言・ヘルパ自身の
	// 定義行は遷移にならない
	want := []string{"TS_CLOSE->TS_SYN@open_conn via set_st"}
	if strings.Join(viaKeys, ",") != strings.Join(want, ",") {
		t.Errorf("via 遷移 = %v, want %v\n全遷移: %+v", viaKeys, want, sm.Transitions)
	}
	// enum も見つかる（TS_ESTABLISHED はデッドステート）
	if sm.Family != "enum" {
		t.Errorf("family = %q, want enum", sm.Family)
	}
}

// 全体集合を特定できないときは、現れた名前だけで正直に返す
func TestAnalyzeStateMachineObservedFallback(t *testing.T) {
	requireRg(t)
	dir := t.TempDir()
	write(t, dir+"/main.c",
		"void f(struct m *m) {\n"+
			"    if (m->st == ALPHA_ONE)\n"+
			"        m->st = BETA_TWO;\n"+
			"}\n")

	sm := AnalyzeStateMachine(t.Context(),
		[]string{filepath.Join(dir, "main.c")}, "st", dir, "")

	if sm.Family != "observed" {
		t.Fatalf("family = %q, want observed", sm.Family)
	}
	if len(sm.States) != 2 {
		t.Fatalf("状態数 = %d, want 2: %+v", len(sm.States), sm.States)
	}
}
