package lsp

import (
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
