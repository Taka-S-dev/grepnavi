package lsp

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// 位置は関数ごとに即答し、件数は resolve で数える。数えた結果はキャッシュされる。
func TestCodeLensCountsCallersOnResolve(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not installed")
	}
	dir := writeTestProject(t)
	os.WriteFile(filepath.Join(dir, "tbl.c"), []byte("int helper(int x);\nstruct ops { int (*fn)(int); } tbl = {\n\t.fn = helper,\n};\n"), 0o644)
	s := &server{root: dir}
	libURI := pathToURI(filepath.Join(dir, "lib.c"))
	params, _ := json.Marshal(map[string]any{"textDocument": map[string]string{"uri": libURI}})
	res, rerr := s.handleCodeLens(context.Background(), params)
	if rerr != nil {
		t.Fatalf("error: %+v", rerr)
	}
	lenses := res.([]codeLens)
	if len(lenses) != 1 || lenses[0].Data == nil || lenses[0].Data.Name != "helper" || lenses[0].Command != nil {
		t.Fatalf("lenses = %+v, want one unresolved lens for helper", lenses)
	}
	raw, _ := json.Marshal(lenses[0])
	res, rerr = s.handleCodeLensResolve(context.Background(), raw)
	if rerr != nil {
		t.Fatalf("error: %+v", rerr)
	}
	got := res.(codeLens)
	if got.Command == nil || !strings.HasPrefix(got.Command.Title, "呼び出し元 2") || !strings.Contains(got.Command.Title, "登録 1") {
		t.Errorf("title = %q, want 呼び出し元 2（登録 1）: run() and the table", got.Command.Title)
	}
	if got.Command.Command != "editor.action.showReferences" || len(got.Command.Arguments) != 3 {
		t.Errorf("command = %+v", got.Command)
	}
	if len(s.lensCache) != 1 {
		t.Errorf("resolve result should be cached, cache has %d entries", len(s.lensCache))
	}
}

func TestLineRunsFoldConsecutiveLines(t *testing.T) {
	rs := lineRuns([]int{3, 4, 5, 9, 12, 13})
	want := "2-4 8-8 11-12"
	var got []string
	for _, r := range rs {
		got = append(got, strings.Join([]string{itoa(r.Start.Line), itoa(r.End.Line)}, "-"))
	}
	if strings.Join(got, " ") != want {
		t.Errorf("runs = %v, want %s", got, want)
	}
}

// 文書を開くと、構成で偽になるブロックが grepnavi/inactiveRegions で届く。
func TestInactiveRegionsAreNotifiedOnOpen(t *testing.T) {
	dir := t.TempDir()
	f := writeFile(t, dir, "a.c", "int a;\n#if 0\nint dead;\n#endif\n#if DEBUG\nint dbg;\n#endif\nint b;\n")
	out := &safeBuf{}
	s := newServer(dir, bufio.NewReader(strings.NewReader("")), out)
	s.defines = map[string]int{"DEBUG": 0}
	uri := pathToURI(f)
	open, _ := json.Marshal(map[string]any{"textDocument": map[string]any{"uri": uri, "text": "x"}})
	s.publishInactive(s.handleDidOpen(open))
	fs := out.frames(t)
	if len(fs) != 1 || fs[0]["method"] != methodInactiveRegions {
		t.Fatalf("frames = %+v", fs)
	}
	p := fs[0]["params"].(map[string]any)
	ranges := p["ranges"].([]any)
	var got []string
	for _, r := range ranges {
		m := r.(map[string]any)
		got = append(got, itoa(int(m["start"].(map[string]any)["line"].(float64)))+"-"+itoa(int(m["end"].(map[string]any)["line"].(float64))))
	}
	if strings.Join(got, " ") != "2-2 5-5" {
		t.Errorf("inactive ranges = %v, want the #if 0 body and the DEBUG body (2-2 5-5)", got)
	}
}
