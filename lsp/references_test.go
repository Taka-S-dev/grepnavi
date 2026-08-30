package lsp

import (
	"context"
	"encoding/json"
	"os/exec"
	"sort"
	"strings"
	"testing"
)

func refParams(uri string, line, ch int, includeDeclaration bool) json.RawMessage {
	b, _ := json.Marshal(map[string]any{
		"textDocument": map[string]string{"uri": uri},
		"position":     map[string]int{"line": line, "character": ch},
		"context":      map[string]bool{"includeDeclaration": includeDeclaration},
	})
	return b
}

func refLines(t *testing.T, s *server, params json.RawMessage) []string {
	t.Helper()
	res, rerr := s.handleReferences(context.Background(), params)
	if rerr != nil {
		t.Fatalf("error: %+v", rerr)
	}
	var out []string
	for _, l := range res.([]location) {
		p := uriToPath(l.URI)
		out = append(out, p[strings.LastIndexAny(p, `\/`)+1:]+":"+itoa(l.Range.Start.Line))
	}
	sort.Strings(out)
	return out
}

// ローカル変数の参照は、その変数を宣言している関数の中だけ。索引にローカルは
// 無いので、語で引くと別の関数の同名変数まで並ぶ。
func TestReferencesScopeLocalsToTheirFunction(t *testing.T) {
	dir := t.TempDir()
	f := writeFile(t, dir, "a.c", ""+
		"int f(void) {\n"+
		"\tint n = 0;\n"+
		"\tn++;\n"+
		"\treturn n;\n"+
		"}\n"+
		"int g(void) {\n"+
		"\tint n = 1;\n"+
		"\treturn n;\n"+
		"}\n")
	s := &server{root: dir}
	uri := pathToURI(f)
	got := refLines(t, s, refParams(uri, 2, 1, false))
	if want := "a.c:2 a.c:3"; strings.Join(got, " ") != want {
		t.Errorf("references without declaration = %v, want %s", got, want)
	}
	got = refLines(t, s, refParams(uri, 2, 1, true))
	if want := "a.c:1 a.c:2 a.c:3"; strings.Join(got, " ") != want {
		t.Errorf("references with declaration = %v, want %s", got, want)
	}
}

// メンバとして書かれた語の参照は `->name` `.name` の形で現れる行だけ。同名の
// 関数の呼び出しや定義は別物。
func TestReferencesKeepMemberAccessesOnly(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not installed")
	}
	dir := t.TempDir()
	writeFile(t, dir, "box.h", "struct box {\n\tint count;\n};\n")
	f := writeFile(t, dir, "main.c", ""+
		"#include \"box.h\"\n"+
		"int count(int x) { return x; }\n"+
		"int run(struct box *b) {\n"+
		"\tb->count = 1;\n"+
		"\treturn count(b->count);\n"+
		"}\n")
	s := &server{root: dir}
	uri := pathToURI(f)
	got := refLines(t, s, refParams(uri, 3, 4, true))
	if want := "main.c:3 main.c:4"; strings.Join(got, " ") != want {
		t.Errorf("member references = %v, want %s", got, want)
	}
}

// 無名の入れ子 struct のメンバ（`struct { int early_data; } ext;`）にも F12 が届く。
// ctags は無名 struct に __anon<16進> という内部名を付け、メンバの持ち主も
// `ssl_st::__anon…` で記録する。その鍵で辿れなければ rg に落ちて 0 件になる
// （実測: openssl の s->ext.early_data で 2 秒かけて 0 件）。
func TestAnonymousStructMembersResolve(t *testing.T) {
	dir := t.TempDir()
	hdr := writeFile(t, dir, "ssl.h", ""+
		"struct ssl_st {\n"+
		"\tint version;\n"+
		"\tstruct {\n"+
		"\t\tint early_data;\n"+
		"\t} ext;\n"+
		"};\n"+
		"typedef struct ssl_st SSL;\n")
	f := writeFile(t, dir, "main.c", ""+
		"#include \"ssl.h\"\n"+
		"int run(SSL *s) {\n"+
		"\treturn s->ext.early_data;\n"+
		"}\n")
	rel := strings.ReplaceAll(hdr, "\\", "/")
	writeFile(t, dir, "tags", ""+
		"!_TAG_FILE_SORTED\t1\t/0=unsorted, 1=sorted, 2=foldcase/\n"+
		"SSL\t"+rel+"\t/^typedef struct ssl_st SSL;$/;\"\tt\tline:7\ttyperef:struct:ssl_st\n"+
		"__anon1\t"+rel+"\t/^\tstruct {$/;\"\ts\tline:3\tstruct:ssl_st\n"+
		"early_data\t"+rel+"\t/^\t\tint early_data;$/;\"\tm\tline:4\tstruct:ssl_st::__anon1\ttyperef:typename:int\n"+
		"ext\t"+rel+"\t/^\t} ext;$/;\"\tm\tline:5\tstruct:ssl_st\ttyperef:struct:ssl_st::__anon1\n"+
		"ssl_st\t"+rel+"\t/^struct ssl_st {$/;\"\ts\tline:1\n"+
		"version\t"+rel+"\t/^\tint version;$/;\"\tm\tline:2\tstruct:ssl_st\ttyperef:typename:int\n")
	s := &server{root: dir}
	res, rerr := s.handleDefinition(context.Background(), posParams(pathToURI(f), 2, 16)) // early_data
	if rerr != nil {
		t.Fatalf("error: %+v", rerr)
	}
	locs := res.([]location)
	if len(locs) != 1 || !strings.HasSuffix(uriToPath(locs[0].URI), "ssl.h") || locs[0].Range.Start.Line != 3 {
		t.Errorf("definition of an anonymous struct member = %+v, want ssl.h line 3", locs)
	}
}
