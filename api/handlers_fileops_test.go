package api

import (
	"os"
	"path/filepath"
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
