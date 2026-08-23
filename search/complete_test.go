package search

import (
	"strings"
	"testing"
)

// openssl 風の最小モデル: typedef SSL → struct ssl_st、メンバーにポインタと値の両方。
func completionFixture() (SymbolsByKind, []string) {
	syms := SymbolsByKind{
		Types: []string{"RECORD_LAYER", "SSL", "SSL3_RECORD", "record_layer_st", "ssl3_record_st", "ssl_st"},
		Members: map[string][]Member{
			"ssl_st":          {{"rlayer", "RECORD_LAYER"}, {"version", "int"}, {"session", "SSL_SESSION *"}},
			"record_layer_st": {{"rrec", "SSL3_RECORD *"}, {"numrpipes", "size_t"}},
			"ssl3_record_st":  {{"length", "size_t"}, {"type", "int"}},
		},
		Typedefs: map[string]string{
			"SSL":          "struct ssl_st",
			"RECORD_LAYER": "struct record_layer_st",
			"SSL3_RECORD":  "struct ssl3_record_st",
		},
		Globals:   map[string]string{"g_default_ctx": "SSL *", "openssl_configured": "int"},
		Macros:    []string{"OPENSSL_free", "SSL3_RT_HEADER_LENGTH", "SSL_OP_ALL"},
		Functions: []string{"CRYPTO_free", "OPENSSL_init_ssl", "ssl3_get_record", "ssl3_read_n"},
	}
	src := `int ssl3_get_record(SSL *s, size_t max)
{
    int enc_err, rret;
    SSL3_RECORD *rr, *thisrr;
    RECORD_LAYER rl;
    rr = s->rlayer.rrec;
    return 0;
}
`
	return syms, strings.Split(src, "\n")
}

func labels(items []CompletionItem) []string {
	out := []string{}
	for _, it := range items {
		out = append(out, it.Label)
	}
	return out
}

func TestCompleteMemberViaPointerParam(t *testing.T) {
	syms, lines := completionFixture()
	r := completeWith(syms, "", lines, 6, "    rr = s->")
	if !r.MemberAccess || !r.BasePointer {
		t.Fatalf("member=%v ptr=%v type=%q", r.MemberAccess, r.BasePointer, r.BaseType)
	}
	if got := labels(r.Items); strings.Join(got, ",") != "rlayer,session,version" {
		t.Errorf("members = %v", got)
	}
}

func TestCompleteMemberChainValueThenPointer(t *testing.T) {
	syms, lines := completionFixture()
	// s->rlayer は値（RECORD_LAYER）なので "." が正しい。その先の rrec はポインタ
	r := completeWith(syms, "", lines, 6, "    rr = s->rlayer.")
	if r.BasePointer {
		t.Errorf("rlayer is a value, got pointer=true (type %q)", r.BaseType)
	}
	// rrec はこのファイルで使われているので numrpipes より前に出る
	if got := labels(r.Items); strings.Join(got, ",") != "rrec,numrpipes" {
		t.Errorf("members = %v", got)
	}
	r = completeWith(syms, "", lines, 6, "    x = s->rlayer.rrec->")
	if !r.BasePointer || strings.Join(labels(r.Items), ",") != "length,type" {
		t.Errorf("chain end: ptr=%v items=%v", r.BasePointer, labels(r.Items))
	}
}

func TestCompleteDotOnPointerFlagsConversion(t *testing.T) {
	syms, lines := completionFixture()
	// ポインタに "." を打った: 候補は出しつつ BasePointer=true を返し、呼び出し側が -> に直す
	r := completeWith(syms, "", lines, 6, "    x = rr.")
	if !r.BasePointer || len(r.Items) != 2 {
		t.Errorf("ptr=%v items=%v type=%q", r.BasePointer, labels(r.Items), r.BaseType)
	}
}

func TestCompleteLocalDeclMultiDeclarator(t *testing.T) {
	syms, lines := completionFixture()
	// `SSL3_RECORD *rr, *thisrr;` の2つ目も拾えること
	r := completeWith(syms, "", lines, 6, "    y = thisrr->")
	if !r.BasePointer || strings.Join(labels(r.Items), ",") != "length,type" {
		t.Errorf("thisrr: ptr=%v items=%v type=%q", r.BasePointer, labels(r.Items), r.BaseType)
	}
	// 値型のローカル rl → "."（並びはファイル内の使用回数順）
	r = completeWith(syms, "", lines, 6, "    rl.")
	if r.BasePointer || strings.Join(labels(r.Items), ",") != "rrec,numrpipes" {
		t.Errorf("rl: ptr=%v items=%v", r.BasePointer, labels(r.Items))
	}
}

func TestCompleteGlobalVariable(t *testing.T) {
	syms, lines := completionFixture()
	r := completeWith(syms, "", lines, 6, "g_default_ctx->")
	if strings.Join(labels(r.Items), ",") != "rlayer,session,version" {
		t.Errorf("global: %v", labels(r.Items))
	}
}

func TestCompleteIdentifiers(t *testing.T) {
	syms, lines := completionFixture()
	r := completeWith(syms, "", lines, 6, "    printf(\"%d\", r")
	if r.MemberAccess || r.Prefix != "r" {
		t.Fatalf("member=%v prefix=%q", r.MemberAccess, r.Prefix)
	}
	got := strings.Join(labels(r.Items), ",")
	// ローカル（rl, rr, rret）が先。引数 s や max は前置詞 r に合わないので出ない
	if !strings.HasPrefix(got, "rl,rr,rret") {
		t.Errorf("identifiers = %v", got)
	}
	// 大文字で打ったら厳密一致のマクロが先。小文字の関数名は大文字小文字を無視した
	// 一致として後ろに付く
	r = completeWith(syms, "", lines, 6, "    n = SSL3")
	if got := strings.Join(labels(r.Items), ","); got != "SSL3_RT_HEADER_LENGTH,ssl3_get_record,ssl3_read_n" {
		t.Errorf("macros = %v", got)
	}
}

func TestCompleteUnknownStaysSilent(t *testing.T) {
	syms, lines := completionFixture()
	r := completeWith(syms, "", lines, 6, "    unknown_var->")
	if len(r.Items) != 0 || !r.MemberAccess {
		t.Errorf("unknown base should give no items: %v", labels(r.Items))
	}
	// return foo; を宣言と見誤らない（型の語が既知でない）
	lines2 := strings.Split("int f(void)\n{\n    return foo;\n    foo->\n}\n", "\n")
	r = completeWith(syms, "", lines2, 4, "    foo->")
	if len(r.Items) != 0 {
		t.Errorf("return-statement misread as declaration: %v", labels(r.Items))
	}
}

func TestRankCaseInsensitiveAndScope(t *testing.T) {
	syms, lines := completionFixture()
	// 小文字で打った openssl_f に、マクロ OPENSSL_free（大文字）が出る。
	// 厳密一致のグローバル openssl_configured は "openssl_f" と前方一致しないので出ない
	r := completeWith(syms, "", lines, 6, "    openssl_f")
	if strings.Join(labels(r.Items), ",") != "OPENSSL_free" {
		t.Errorf("case-insensitive: %v", labels(r.Items))
	}
	// 関数は候補に入り、同じ前置詞ならローカル > 関数 > マクロ の層で並ぶ
	r = completeWith(syms, "", lines, 6, "    ssl3")
	got := strings.Join(labels(r.Items), ",")
	if got != "ssl3_get_record,ssl3_read_n,SSL3_RT_HEADER_LENGTH" {
		t.Errorf("scope layers: %v", got)
	}
}

func TestRankLocalProximityAndIncomplete(t *testing.T) {
	syms, lines := completionFixture()
	// 宣言がカーソルに近いローカルが先: rl(5行目) > rr(4行目) > rret(3行目)
	r := completeWith(syms, "", lines, 6, "    r")
	if got := strings.Join(labels(r.Items), ","); got != "rl,rr,rret" {
		t.Errorf("proximity: %v", got)
	}
	// 1〜2 文字のうちは「取り直してくれ」の印を立てる。3 文字以上で全件なら立てない
	if !r.Incomplete {
		t.Errorf("short prefix should be incomplete")
	}
	r = completeWith(syms, "", lines, 6, "    rret")
	if r.Incomplete {
		t.Errorf("full list for a long prefix should be complete")
	}
}

func TestParseStructBodyHandlesWhatCtagsMisses(t *testing.T) {
	lines := strings.Split(`/* comment */
typedef struct ex_callbacks_st {
    STACK_OF(EX_CALLBACK) *meth;      /* macro-typed: ctags drops this */
    void (*free_func)(void *parent);   /* function pointer */
    unsigned char buf[16];
    unsigned int flags : 3;
    union {
        int as_int;
        long as_long;
    } u;
    int a, b;
} EX_CALLBACKS;
`, "\n")
	got := parseStructBody(lines, 2)
	names := []string{}
	for _, m := range got {
		names = append(names, m.Name)
	}
	want := "meth,free_func,buf,flags,as_int,as_long,u,a,b"
	if strings.Join(names, ",") != want {
		t.Errorf("members = %v, want %s", names, want)
	}
	if got[0].Type != "STACK_OF(EX_CALLBACK) *" {
		t.Errorf("meth type = %q", got[0].Type)
	}
}

// メンバー補完は大文字小文字を無視した前方一致で絞り、このファイルで使われて
// いるものを先に出す（100 件級の構造体で先頭が無関係なメンバーで埋まらないように）。
func TestCompleteMembersRankedByFileUsage(t *testing.T) {
	syms := SymbolsByKind{
		Types:    []string{"box_st"},
		Typedefs: map[string]string{"BOX": "struct box_st"},
		Members: map[string][]Member{"box_st": {
			{"aaa_unused", "int"}, {"Version", "int"}, {"used_often", "int"},
		}},
	}
	lines := strings.Split(`void f(BOX *b)
{
    b->used_often = 1;
    b->used_often = 2;
    b->
}
`, "\n")
	r := completeWith(syms, "", lines, 4, "    b->")
	if got := strings.Join(labels(r.Items), ","); got != "used_often,Version,aaa_unused" {
		t.Errorf("order = %v", got)
	}
	// 小文字で打っても大文字のメンバーに当たる
	r = completeWith(syms, "", lines, 4, "    b->ver")
	if got := strings.Join(labels(r.Items), ","); got != "Version" {
		t.Errorf("case-insensitive member = %v", got)
	}
}

// ctags は名前のない struct/union に __anon<16進> という内部名を付ける。
// 補完の型欄にそのまま出すと "struct ssl_st::__anon95e14df50808" になる。
func TestReadableAnonType(t *testing.T) {
	cases := map[string]string{
		"struct ssl_st::__anon95e14df50808": "struct {...}",
		"union __anon1234":                  "union {...}",
		"struct ssl_st":                     "struct ssl_st",
		"SSL3_RECORD *":                     "SSL3_RECORD *",
		"int":                               "int",
	}
	for in, want := range cases {
		if got := readableAnonType(in); got != want {
			t.Errorf("readableAnonType(%q) = %q, want %q", in, got, want)
		}
	}
}
