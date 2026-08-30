package lsp

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
)

// 識別子の途中で切って「型 + 宣言子」と読まない（SSL_AD_RECORD_OVERFLO + W）。
// 引数の並びの途中にある語は宣言ではない。
func TestArgumentListsAreNotDeclarations(t *testing.T) {
	src := "int f(SSL *s) {\n\tSSLfatal(s, SSL_AD_RECORD_OVERFLOW, SSL_F_SSL3_GET_RECORD,\n\t\tSSL_R_PACKET_LENGTH_TOO_LONG);\n}\n"
	if _, _, ok := localDeclaration(src, position{Line: 1, Character: 40}, "SSL_F_SSL3_GET_RECORD"); ok {
		t.Error("SSL_F_SSL3_GET_RECORD inside a call is not a local declaration")
	}
	if !declRegexp("b").MatchString("int a, b;") || !declRegexp("p").MatchString("struct pt*p;") {
		t.Error("real declarations must still match")
	}
}

// 着地点は行全体ではなく語の列（履歴と選択がその語になる）。
func TestDefinitionRangesPointAtTheSymbol(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "lib.c", "static int helper(int x) { return x; }\n")
	f := writeFile(t, dir, "main.c", "int helper(int x);\nint run(void) {\n\treturn helper(41);\n}\n")
	s := &server{root: dir}
	res, _ := s.handleDefinition(context.Background(), posParams(pathToURI(f), 2, 9))
	locs := res.([]location)
	if len(locs) == 0 {
		t.Fatal("no definition")
	}
	r := locs[0].Range
	if r.Start.Character != 11 || r.End.Character != 17 {
		t.Errorf("range should cover `helper` on the definition line (11..17), got %+v", r)
	}
}

// 語が行に無ければ行全体、あればその語の列。参照と呼び出し階層も同じ範囲を返す。
func TestSymbolRangesAcrossAnswers(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not installed")
	}
	dir := t.TempDir()
	lib := writeFile(t, dir, "lib.c", "int helper(int x) { return x; }\n")
	f := writeFile(t, dir, "main.c", "int helper(int x);\nint run(void) {\n\treturn helper(41);\n}\n")
	if r := wordRange(lib, 1, "absent"); r.Start.Character != 0 || r.End.Character != 9999 {
		t.Errorf("missing word should fall back to the whole line, got %+v", r)
	}
	if r := wordRange(lib, 1, "helper"); r.Start.Character != 4 || r.End.Character != 10 {
		t.Errorf("wordRange = %+v, want 4..10", r)
	}
	s := &server{root: dir}
	ctx := context.Background()
	res, _ := s.handleReferences(ctx, posParams(pathToURI(f), 2, 9))
	for _, l := range res.([]location) {
		if l.Range.End.Character == 9999 {
			t.Errorf("reference range is still the whole line: %+v", l)
		}
	}
	item, _ := json.Marshal(map[string]any{"item": map[string]any{
		"name": "run", "uri": pathToURI(f),
		"selectionRange": map[string]any{"start": map[string]int{"line": 1, "character": 4}, "end": map[string]int{"line": 1, "character": 7}},
	}})
	out, _ := s.handleOutgoingCalls(ctx, item)
	b, _ := json.Marshal(out)
	if strings.Contains(string(b), `"character":9999`) {
		t.Errorf("outgoing call ranges are still whole lines: %s", b)
	}
}
