package lsp

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func posParams(uri string, line, ch int) json.RawMessage {
	b, _ := json.Marshal(map[string]any{
		"textDocument": map[string]string{"uri": uri},
		"position":     map[string]int{"line": line, "character": ch},
	})
	return b
}

func writeFile(t *testing.T, dir, name, src string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// 同じ語の出現。コメント・文字列の中は出さず、書き込みは Write で区別する。
func TestDocumentHighlightSkipsCommentsAndMarksWrites(t *testing.T) {
	dir := t.TempDir()
	f := writeFile(t, dir, "a.c", ""+
		"int run(void) {\n"+
		"\tint v = 1;           /* v */\n"+
		"\tv = v + 1;           // v\n"+
		"\tputs(\"v\");\n"+
		"\treturn v;\n"+
		"}\n")
	s := &server{root: dir}
	uri := pathToURI(f)
	res, rerr := s.handleDocumentHighlight(context.Background(), posParams(uri, 2, 1))
	if rerr != nil {
		t.Fatalf("error: %+v", rerr)
	}
	hs := res.([]documentHighlight)
	var got []string
	for _, h := range hs {
		k := "R"
		if h.Kind == highlightWrite {
			k = "W"
		}
		got = append(got, k+":"+itoa(h.Range.Start.Line)+":"+itoa(h.Range.Start.Character))
	}
	want := []string{"W:1:5", "W:2:1", "R:2:5", "R:4:8"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("highlights = %v, want %v", got, want)
	}
}

func itoa(n int) string { return strconv.Itoa(n) }

func intToString(n int) string { return strconv.Itoa(n) }

// `foo(a, |` で foo のシグネチャと引数の番号。複数行の宣言も 1 行に畳む。
func TestSignatureHelpFindsTheEnclosingCall(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "lib.c", ""+
		"int add(int a,\n"+
		"        int b)\n"+
		"{\n"+
		"\treturn a + b;\n"+
		"}\n"+
		"#define SQ(x) ((x) * (x))\n")
	f := writeFile(t, dir, "main.c", ""+
		"int add(int a, int b);\n"+
		"int run(void) {\n"+
		"\treturn add(SQ(2), \n"+
		"\t           3);\n"+
		"}\n")
	s := &server{root: dir}
	uri := pathToURI(f)

	res, rerr := s.handleSignatureHelp(context.Background(), posParams(uri, 3, 13)) // `3` の直後 = 第2引数
	if rerr != nil {
		t.Fatalf("error: %+v", rerr)
	}
	sh, ok := res.(signatureHelp)
	if !ok || len(sh.Signatures) == 0 {
		t.Fatalf("no signature: %#v", res)
	}
	if sh.ActiveParameter != 1 {
		t.Errorf("activeParameter = %d, want 1", sh.ActiveParameter)
	}
	if !strings.Contains(sh.Signatures[0].Label, "add(int a, int b)") {
		t.Errorf("label = %q", sh.Signatures[0].Label)
	}
	if len(sh.Signatures[0].Parameters) != 2 || sh.Signatures[0].Parameters[1].Label != "int b" {
		t.Errorf("parameters = %+v", sh.Signatures[0].Parameters)
	}

	// マクロの中: `SQ(2|` は SQ の第 1 引数
	res, _ = s.handleSignatureHelp(context.Background(), posParams(uri, 2, 15))
	sh, ok = res.(signatureHelp)
	if !ok || len(sh.Signatures) == 0 || !strings.HasPrefix(sh.Signatures[0].Label, "SQ(x)") || sh.ActiveParameter != 0 {
		t.Errorf("macro signature = %#v", res)
	}
}

func TestEnclosingCallStopsAtStatementBoundary(t *testing.T) {
	if n, _, ok := enclosingCall("x = f(a, g(b), "); !ok || n != "f" {
		t.Errorf("nested: %q %v", n, ok)
	}
	if _, _, ok := enclosingCall("f(a); x = "); ok {
		t.Error("after a closed call there is no enclosing call")
	}
	if _, _, ok := enclosingCall("if (x) {"); ok {
		t.Error("a block is not a call")
	}
}

// 変数 → その struct の定義。型表が無くても宣言文の字面から辿る。
func TestTypeDefinitionResolvesTheVariableStruct(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "pt.h", "struct pt {\n\tint x;\n};\n")
	f := writeFile(t, dir, "main.c", ""+
		"#include \"pt.h\"\n"+
		"int run(void) {\n"+
		"\tstruct pt *p = 0;\n"+
		"\treturn p->x;\n"+
		"}\n")
	s := &server{root: dir}
	res, rerr := s.handleTypeDefinition(context.Background(), posParams(pathToURI(f), 3, 8))
	if rerr != nil {
		t.Fatalf("error: %+v", rerr)
	}
	locs := res.([]location)
	if len(locs) == 0 || !strings.HasSuffix(uriToPath(locs[0].URI), "pt.h") || locs[0].Range.Start.Line != 0 {
		t.Errorf("type definition = %+v", locs)
	}
}

// 関数ポインタのメンバ → 関数を入れている行。関数そのものなら定義。
func TestImplementationListsRegistrationSites(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not installed")
	}
	dir := t.TempDir()
	writeFile(t, dir, "ops.c", ""+
		"struct ops { int (*read)(int); };\n"+
		"static int my_read(int a) { return a; }\n"+
		"struct ops table = { .read = my_read };\n"+
		"void setup(struct ops *o) { o->read = my_read; }\n")
	f := writeFile(t, dir, "main.c", ""+
		"struct ops;\n"+
		"int run(struct ops *p) {\n"+
		"\treturn p->read(1);\n"+
		"}\n")
	s := &server{root: dir}
	res, rerr := s.handleImplementation(context.Background(), posParams(pathToURI(f), 2, 12))
	if rerr != nil {
		t.Fatalf("error: %+v", rerr)
	}
	var lines []int
	for _, l := range res.([]location) {
		if strings.HasSuffix(uriToPath(l.URI), "ops.c") {
			lines = append(lines, l.Range.Start.Line)
		}
	}
	if len(lines) != 2 || lines[0] != 2 || lines[1] != 3 {
		t.Errorf("registration sites = %v, want [2 3] (initializer and assignment)", lines)
	}
}

// 折りたたみ: 関数本体・#if〜#endif・複数行コメント
func TestFoldingRangesCoverFunctionsDirectivesAndComments(t *testing.T) {
	dir := t.TempDir()
	f := writeFile(t, dir, "a.c", ""+
		"/*\n"+ // 0
		" * header\n"+ // 1
		" */\n"+ // 2
		"#ifdef X\n"+ // 3
		"int a;\n"+ // 4
		"#endif\n"+ // 5
		"int run(void)\n"+ // 6
		"{\n"+ // 7
		"\treturn 0;\n"+ // 8
		"}\n") // 9
	s := &server{root: dir}
	params, _ := json.Marshal(map[string]any{"textDocument": map[string]string{"uri": pathToURI(f)}})
	res, rerr := s.handleFoldingRange(context.Background(), params)
	if rerr != nil {
		t.Fatalf("error: %+v", rerr)
	}
	got := map[string]bool{}
	for _, r := range res.([]foldingRange) {
		got[r.Kind+":"+intToString(r.StartLine)+"-"+intToString(r.EndLine)] = true
	}
	for _, want := range []string{"comment:0-2", "region:3-5", "region:6-9"} {
		if !got[want] {
			t.Errorf("missing %s in %v", want, got)
		}
	}
}

// メンバ呼び出し `p->read(` では、同名の関数 read が索引にあっても実装とは
// みなさない（openssl で bio_ssl.c の static ssl_read に飛んでいた）。
func TestImplementationIgnoresSameNamedFunctionForMemberCalls(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not installed")
	}
	dir := t.TempDir()
	writeFile(t, dir, "ops.c", ""+
		"struct ops { int (*read)(int); };\n"+
		"static int read(int fd) { return fd; }\n"+ // 同名の関数
		"static int my_read(int a) { return a; }\n"+
		"struct ops table = { .read = my_read };\n")
	f := writeFile(t, dir, "main.c", "int run(struct ops *p) { return p->read(1); }\n")
	s := &server{root: dir}
	res, _ := s.handleImplementation(context.Background(), posParams(pathToURI(f), 0, 36))
	var lines []int
	for _, l := range res.([]location) {
		lines = append(lines, l.Range.Start.Line)
	}
	if len(lines) != 1 || lines[0] != 3 {
		t.Errorf("implementation of a member call = %v, want [3] (the initializer), not the function read", lines)
	}
}

func TestSignatureAtReadsFunctionPointerMembers(t *testing.T) {
	dir := t.TempDir()
	f := writeFile(t, dir, "m.h", ""+
		"struct ssl_method_st {\n"+
		"    int (*ssl_read) (SSL *s, void *buf, size_t len,\n"+
		"                     size_t *readbytes);\n"+
		"};\n")
	label, params, ok := signatureAt(f, 2, "ssl_read")
	if !ok {
		t.Fatal("member signature not found")
	}
	if !strings.Contains(label, "(*ssl_read) (SSL *s, void *buf, size_t len, size_t *readbytes)") {
		t.Errorf("label = %q", label)
	}
	if len(params) != 4 || params[3].Label != "size_t *readbytes" {
		t.Errorf("params = %+v", params)
	}
}

func TestMemberAccessBefore(t *testing.T) {
	text := "return s->method->ssl_read(s, buf"
	name, at, _, ok := enclosingCallAt(text)
	if !ok || name != "ssl_read" || !memberAccessBefore(text, at) {
		t.Errorf("s->method->ssl_read( should be a member call: %q %d %v", name, at, ok)
	}
	text = "return ssl_read(s, buf"
	name, at, _, ok = enclosingCallAt(text)
	if !ok || name != "ssl_read" || memberAccessBefore(text, at) {
		t.Errorf("ssl_read( should be a plain call: %q %d %v", name, at, ok)
	}
	if !memberAccessBefore("ops.read", 4) {
		t.Error("ops.read should be a member access")
	}
}

// ローカル変数は囲む関数の中だけ、グローバルはファイル全体。
func TestDocumentHighlightScopesLocalsToTheirFunction(t *testing.T) {
	dir := t.TempDir()
	f := writeFile(t, dir, "a.c", ""+
		"int g;\n"+ // 0
		"int one(int n) {\n"+ // 1
		"\treturn n + g;\n"+ // 2
		"}\n"+ // 3
		"int two(int n) {\n"+ // 4
		"\tg = n;\n"+ // 5
		"\treturn n;\n"+ // 6
		"}\n") // 7
	s := &server{root: dir}
	uri := pathToURI(f)
	res, _ := s.handleDocumentHighlight(context.Background(), posParams(uri, 6, 8)) // two() の n
	var lines []int
	for _, h := range res.([]documentHighlight) {
		lines = append(lines, h.Range.Start.Line)
	}
	if len(lines) != 3 || lines[0] != 4 || lines[2] != 6 {
		t.Errorf("local n highlighted at %v, want [4 5 6] only", lines)
	}
	res, _ = s.handleDocumentHighlight(context.Background(), posParams(uri, 5, 1)) // g はグローバル
	lines = nil
	for _, h := range res.([]documentHighlight) {
		lines = append(lines, h.Range.Start.Line)
	}
	if len(lines) != 3 || lines[0] != 0 || lines[1] != 2 || lines[2] != 5 {
		t.Errorf("global g highlighted at %v, want [0 2 5]", lines)
	}
}

// 受け手の struct が分かるときは、その struct のメンバ／初期化子だけに絞る。
// tags は手書き（ctags の m 行と struct: フィールド）。
func TestMemberLookupsAreNarrowedByTheReceiverStruct(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not installed")
	}
	dir := t.TempDir()
	hdr := writeFile(t, dir, "ops.h", ""+
		"struct file_operations {\n"+
		"\tint (*read)(struct file *, char *, int);\n"+
		"};\n"+
		"struct kvm_io {\n"+
		"\tint (*read)(void *opaque, int addr);\n"+
		"};\n")
	writeFile(t, dir, "impl.c", ""+
		"#include \"ops.h\"\n"+
		"static int fs_read(struct file *f, char *b, int n) { return n; }\n"+
		"static int io_read(void *o, int a) { return a; }\n"+
		"static const struct file_operations fops = {\n"+
		"\t.read = fs_read,\n"+
		"};\n"+
		"static struct kvm_io kio = { .read = io_read };\n")
	f := writeFile(t, dir, "main.c", ""+
		"#include \"ops.h\"\n"+
		"int run(struct file_operations *fop) {\n"+
		"\treturn fop->read(0, 0, 1);\n"+
		"}\n")
	rel := strings.ReplaceAll(hdr, "\\", "/")
	writeFile(t, dir, "tags", ""+
		"!_TAG_FILE_SORTED\t1\t/0=unsorted, 1=sorted, 2=foldcase/\n"+
		"read\t"+rel+"\t/^\tint (*read)(struct file *, char *, int);$/;\"\tm\tline:2\tstruct:file_operations\n"+
		"read\t"+rel+"\t/^\tint (*read)(void *opaque, int addr);$/;\"\tm\tline:5\tstruct:kvm_io\n")
	s := &server{root: dir}
	uri := pathToURI(f)

	res, _ := s.handleSignatureHelp(context.Background(), posParams(uri, 2, 21)) // fop->read(0, 0, 1|
	sh, ok := res.(signatureHelp)
	if !ok || len(sh.Signatures) != 1 || !strings.Contains(sh.Signatures[0].Label, "struct file *") {
		t.Errorf("signature should be file_operations.read only: %#v", res)
	}

	res, _ = s.handleImplementation(context.Background(), posParams(uri, 2, 14)) // read
	var got []int
	for _, l := range res.([]location) {
		got = append(got, l.Range.Start.Line)
	}
	if len(got) != 1 || got[0] != 4 {
		t.Errorf("implementation should be the file_operations initializer only (line 4), got %v", got)
	}
}

func TestReceiverChainBefore(t *testing.T) {
	text := "ret = file->f_op->read(file, buf"
	_, at, _, _ := enclosingCallAt(text)
	if c := receiverChainBefore(text, at); strings.Join(c, ".") != "file.f_op" {
		t.Errorf("chain = %v", c)
	}
	text = "x = get(s)->read("
	_, at, _, _ = enclosingCallAt(text)
	if c := receiverChainBefore(text, at); c != nil {
		t.Errorf("a call result has no name chain, got %v", c)
	}
}

// ローカル変数・引数のホバーと F12 は、この関数の宣言行を返す。索引の同名シンボルは引かない。
func TestLocalsResolveToTheirDeclarationInTheFunction(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "other.c", "struct rec { int version; };\nint version = 3;\n")
	f := writeFile(t, dir, "main.c", ""+
		"int get(struct rec *r, int flag) {\n"+ // 0: 引数 flag
		"\tunsigned int version;\n"+ // 1: ローカル version
		"\tversion = r->version + flag;\n"+ // 2
		"\treturn version;\n"+ // 3
		"}\n")
	s := &server{root: dir}
	uri := pathToURI(f)

	res, _ := s.handleHover(context.Background(), posParams(uri, 3, 9)) // return version
	hv, _ := res.(map[string]any)
	md, _ := hv["contents"].(map[string]string)
	if md == nil || !strings.Contains(md["value"], "local") || !strings.Contains(md["value"], "unsigned int version;") {
		t.Errorf("hover on a local should show its declaration, got %#v", res)
	}
	res, _ = s.handleDefinition(context.Background(), posParams(uri, 3, 9))
	locs := res.([]location)
	if len(locs) != 1 || locs[0].URI != uri || locs[0].Range.Start.Line != 1 {
		t.Errorf("definition of a local should be its declaration line, got %+v", locs)
	}
	res, _ = s.handleDefinition(context.Background(), posParams(uri, 2, 24)) // flag（引数）
	locs = res.([]location)
	if len(locs) != 1 || locs[0].Range.Start.Line != 0 {
		t.Errorf("definition of a parameter should be the signature line, got %+v", locs)
	}
	// r->version はメンバ。同名のローカルがあってもローカル扱いにしない
	if _, _, ok := localDeclaration(strings.Join([]string{
		"int get(struct rec *r, int flag) {", "\tunsigned int version;", "\tversion = r->version + flag;", "}"}, "\n"),
		position{Line: 2, Character: 15}, "version"); ok {
		t.Error("r->version must not resolve to the local version")
	}
}

// doxygen の出力ごと索引にしたツリーでは、tags に HTML の見出しが入る。
// エディタの F12 とホバーには出さない（GUI は最後に並べて残す）。
func TestEditorAnswersDropHitsOutsideCSources(t *testing.T) {
	dir := t.TempDir()
	hdr := writeFile(t, dir, "rec.h", "struct rec {\n\tint rlayer;\n};\n")
	html := writeFile(t, dir, "532.html", "<html>\n<body>\n<h3>\n<title>rlayer</title>\n")
	f := writeFile(t, dir, "main.c", "#include \"rec.h\"\nint get(struct rec *r) { return r->rlayer; }\n")
	slash := func(p string) string { return strings.ReplaceAll(p, "\\", "/") }
	writeFile(t, dir, "tags", ""+
		"!_TAG_FILE_SORTED\t1\t/0=unsorted, 1=sorted, 2=foldcase/\n"+
		"rlayer\t"+slash(html)+"\t/^<title>rlayer<\\/title>$/;\"\tj\tline:4\n"+
		"rlayer\t"+slash(hdr)+"\t/^\\tint rlayer;$/;\"\tm\tline:2\tstruct:rec\n")
	s := &server{root: dir}
	uri := pathToURI(f)
	res, _ := s.handleDefinition(context.Background(), posParams(uri, 1, 36))
	for _, l := range res.([]location) {
		if strings.HasSuffix(l.URI, ".html") {
			t.Errorf("F12 led into generated HTML: %+v", l)
		}
	}
	res, _ = s.handleHover(context.Background(), posParams(uri, 1, 36))
	if hv, ok := res.(map[string]any); ok {
		if md := hv["contents"].(map[string]string)["value"]; strings.Contains(md, ".html") {
			t.Errorf("hover shows an HTML heading: %s", md)
		}
	}
}

// メンバ呼び出し `p->read(` の F12 とホバーは、同名の関数ではなくメンバの宣言へ。
func TestMemberCallsResolveToTheMemberDeclaration(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not installed")
	}
	dir := t.TempDir()
	writeFile(t, dir, "ops.h", "struct ops {\n\tint (*read)(int);\n};\n")
	writeFile(t, dir, "read.c", "int read(int fd) { return fd; }\n") // 同名の関数
	f := writeFile(t, dir, "main.c", "#include \"ops.h\"\nint run(struct ops *p) { return p->read(1); }\n")
	s := &server{root: dir}
	uri := pathToURI(f)
	res, _ := s.handleDefinition(context.Background(), posParams(uri, 1, 36))
	locs := res.([]location)
	if len(locs) != 1 || !strings.HasSuffix(uriToPath(locs[0].URI), "ops.h") || locs[0].Range.Start.Line != 1 {
		t.Errorf("F12 on p->read should land on the member declaration, got %+v", locs)
	}
	res, _ = s.handleHover(context.Background(), posParams(uri, 1, 36))
	hv, _ := res.(map[string]any)
	md, _ := hv["contents"].(map[string]string)
	if md == nil || !strings.Contains(md["value"], "member") || !strings.Contains(md["value"], "(*read)(int)") || strings.Contains(md["value"], "read.c") {
		t.Errorf("hover on p->read should show the member only, got %#v", res)
	}
}

// `T *a, *b;` の 2 つ目以降の宣言子もローカルとして解決する。
func TestLocalsDeclaredInAListResolve(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "other.c", "struct rec { int thisrr; int j; };\n")
	f := writeFile(t, dir, "main.c", ""+
		"int get(struct rec *r) {\n"+
		"\tstruct rec *rr, *thisrr;\n"+ // 1
		"\tsize_t num_recs = 0, max_recs, j;\n"+ // 2
		"\tthisrr = rr;\n"+ // 3
		"\treturn j + r->thisrr;\n"+ // 4
		"}\n")
	s := &server{root: dir}
	uri := pathToURI(f)
	res, _ := s.handleDefinition(context.Background(), posParams(uri, 3, 3)) // thisrr
	if locs := res.([]location); len(locs) != 1 || locs[0].Range.Start.Line != 1 {
		t.Errorf("thisrr should resolve to its declaration on line 1, got %+v", locs)
	}
	res, _ = s.handleDefinition(context.Background(), posParams(uri, 4, 8)) // j
	if locs := res.([]location); len(locs) != 1 || locs[0].Range.Start.Line != 2 {
		t.Errorf("j should resolve to its declaration on line 2, got %+v", locs)
	}
	if _, _, ok := localDeclaration("int f(int a) {\n\tg(a, thisrr);\n}\n", position{Line: 1, Character: 7}, "thisrr"); ok {
		t.Error("a call argument list is not a declaration")
	}
}

// ホバーの場所表示はリンク、ローカル変数には型の struct へのリンクが付く。
func TestHoverLinksToTheSourceAndTheVariableStruct(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "pt.h", "struct pt {\n\tint x;\n};\n")
	f := writeFile(t, dir, "main.c", "#include \"pt.h\"\nint run(void) {\n\tstruct pt *p = 0;\n\treturn p->x;\n}\n")
	s := &server{root: dir}
	res, _ := s.handleHover(context.Background(), posParams(pathToURI(f), 3, 8)) // p
	md := res.(map[string]any)["contents"].(map[string]string)["value"]
	if !strings.Contains(md, "](file:///") || !strings.Contains(md, "#L3)") {
		t.Errorf("hover header should link to main.c line 3: %s", md)
	}
	if !strings.Contains(md, "struct pt") || !strings.Contains(md, "pt.h#L1)") {
		t.Errorf("hover should link to struct pt in pt.h: %s", md)
	}
}

// 宣言が複数行に分かれていても、ホバーには型まで含めた宣言全体を出す。
func TestDeclarationBlockSpansTheWholeDeclaration(t *testing.T) {
	dir := t.TempDir()
	f := writeFile(t, dir, "h.h", ""+
		"struct ssl_st {\n"+ // 1
		"    size_t cert_verify_hash_len;\n"+ // 2
		"\n"+ // 3
		"    /* Flag to indicate whether we should send a HelloRetryRequest */\n"+ // 4
		"    enum {SSL_HRR_NONE = 0, SSL_HRR_PENDING, SSL_HRR_COMPLETE}\n"+ // 5
		"        hello_retry_request;\n"+ // 6
		"    int (*ssl_read) (SSL *s, void *buf, size_t len,\n"+ // 7
		"                     size_t *readbytes);\n"+ // 8
		"    RECORD_LAYER rlayer;\n"+ // 9
		"};\n")
	cases := map[int]string{
		6: "enum {SSL_HRR_NONE = 0, SSL_HRR_PENDING, SSL_HRR_COMPLETE}\n    hello_retry_request;",
		7: "int (*ssl_read) (SSL *s, void *buf, size_t len,\n                 size_t *readbytes);",
		9: "RECORD_LAYER rlayer;",
	}
	for line, want := range cases {
		if got := declarationBlock(f, line, "x"); got != want {
			t.Errorf("line %d:\n got %q\nwant %q", line, got, want)
		}
	}
}
