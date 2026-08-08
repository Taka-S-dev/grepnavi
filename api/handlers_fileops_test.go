package api

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// code.cmd シムから VS Code 本体を割り出す。シム経由は cmd → node の連鎖に
// なるため、本体が見つかる環境ではそちらを直接起動する。
func TestVscodeExeFromShim(t *testing.T) {
	root := t.TempDir()
	bin := filepath.Join(root, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(bin, "code.cmd")
	if err := os.WriteFile(shim, []byte("@echo off"), 0o644); err != nil {
		t.Fatal(err)
	}

	if got := vscodeExeFromShim(shim); got != "" {
		t.Errorf("Code.exe が無いのに解決した: %q", got)
	}

	exe := filepath.Join(root, "Code.exe")
	if err := os.WriteFile(exe, []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := vscodeExeFromShim(shim); got != exe {
		t.Errorf("vscodeExeFromShim = %q, want %q", got, exe)
	}

	// シムでない code (本体や PATH 上の別物) はそのまま使う
	if got := vscodeExeFromShim(filepath.Join(root, "code")); got != "" {
		t.Errorf("拡張子なしはシム扱いしないはず: %q", got)
	}
}

// エディタコマンド名の解決は1回だけ行い、以後は記憶した絶対パスを使う。
// PATH にネットワークドライブが混ざる環境では走査自体が遅いため。
func TestResolveEditorBin(t *testing.T) {
	dir := t.TempDir()
	// キャッシュはパッケージ変数なので -count=N の2回目以降も生きている。
	// 実行ごとに一意な名前にしないと、前回の TempDir のパスが返って落ちる。
	// TempDir の末尾は毎回 "001" なので、一意なのはその親の方。
	name := "grepnavi-fake-editor-" + filepath.Base(filepath.Dir(dir))
	bin := filepath.Join(dir, name)
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)

	if got := resolveEditorBin(name); got != bin {
		t.Errorf("resolveEditorBin(%q) = %q, want %q", name, got, bin)
	}
	// 消しても記憶した解決結果を返す = 再走査していない
	if err := os.Remove(bin); err != nil {
		t.Fatal(err)
	}
	if got := resolveEditorBin(name); got != bin {
		t.Errorf("キャッシュから返すはず: got %q", got)
	}
	// 絶対パスは触らない
	if got := resolveEditorBin(bin); got != bin {
		t.Errorf("絶対パスはそのまま返すはず: got %q", got)
	}
}
