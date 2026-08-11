package api

import (
	"os"
	"path/filepath"
	"testing"

	"grepnavi/search"
)

// 除外だけを書いた .grepnavi は、graphs が無くても新形式として読めること。
// graphs の有無だけで新旧を判定していたときは、除外設定が黙って消えていた。
func TestReadGrepnaviKeepsExcludeWithoutGraphs(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, grepnaviFile)
	if err := os.WriteFile(p, []byte(`{"root":"C:\\x","exclude":["*.BAK"]}`), 0644); err != nil {
		t.Fatal(err)
	}
	cfg := readGrepnavi(p)
	if len(cfg.Exclude) != 1 || cfg.Exclude[0] != "*.BAK" {
		t.Fatalf("exclude = %v, want [*.BAK]", cfg.Exclude)
	}
}

// グラフだけを更新する呼び出しが、除外設定を巻き添えで消さないこと。
func TestWriteGrepnaviKeepsExcludeWhenGraphChanges(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, grepnaviFile)
	if err := writeGrepnavi(p, grepnaviCfg{Root: dir, Exclude: []string{"gen/"}}); err != nil {
		t.Fatal(err)
	}
	addGraphToGrepnavi(dir, filepath.Join(dir, "g.json"))

	cfg := readGrepnavi(p)
	if len(cfg.Exclude) != 1 || cfg.Exclude[0] != "gen/" {
		t.Fatalf("exclude = %v, want [gen/]", cfg.Exclude)
	}
	if len(cfg.Graphs) != 1 {
		t.Fatalf("graphs = %v, want 1 件", cfg.Graphs)
	}
}

// ルートを開いた時点で、そのツリーの除外設定が検索側に効いていること。
func TestApplyProjectSettingsFeedsSearch(t *testing.T) {
	defer search.SetExcludes("", nil)
	dir := t.TempDir()
	if err := writeGrepnavi(filepath.Join(dir, grepnaviFile),
		grepnaviCfg{Root: dir, Exclude: []string{"gen"}}); err != nil {
		t.Fatal(err)
	}
	applyProjectSettings(dir)
	if !search.IsExcluded(filepath.Join(dir, "gen", "a.c")) {
		t.Error("除外が検索側へ渡っていない")
	}

	// 設定の無いツリーへ切り替えたら、前のツリーの除外は残らない
	applyProjectSettings(t.TempDir())
	if search.IsExcluded(filepath.Join(dir, "gen", "a.c")) {
		t.Error("前のプロジェクトの除外が残っている")
	}
}
