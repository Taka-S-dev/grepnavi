package lsp

import (
	"context"
	"strings"
	"testing"
)

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
