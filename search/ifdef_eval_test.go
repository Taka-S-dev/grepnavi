package search

import (
	"testing"
)

func TestParseDefines(t *testing.T) {
	tests := []struct {
		input string
		want  map[string]int
	}{
		{"WIN32=1 DEBUG=0", map[string]int{"WIN32": 1, "DEBUG": 0}},
		{"NDEBUG", map[string]int{"NDEBUG": 1}},
		{"A=1 B=2 C", map[string]int{"A": 1, "B": 2, "C": 1}},
		{"", map[string]int{}},
	}
	for _, tt := range tests {
		got := ParseDefines(tt.input)
		if len(got) != len(tt.want) {
			t.Errorf("ParseDefines(%q): got %v, want %v", tt.input, got, tt.want)
			continue
		}
		for k, v := range tt.want {
			if got[k] != v {
				t.Errorf("ParseDefines(%q)[%q]: got %d, want %d", tt.input, k, got[k], v)
			}
		}
	}
}

func TestEvalIfExpr(t *testing.T) {
	defines := map[string]int{"WIN32": 1, "DEBUG": 0, "VERSION": 2}

	tests := []struct {
		expr string
		want bool
	}{
		{"WIN32", true},
		{"DEBUG", false},
		{"!WIN32", false},
		{"!DEBUG", true},
		{"WIN32 == 1", true},
		{"WIN32 == 0", false},
		{"VERSION == 2", true},
		{"WIN32 && !DEBUG", true},
		{"WIN32 || DEBUG", true},
		{"DEBUG || 0", false},
		{"defined(WIN32)", true},
		{"defined(UNKNOWN)", false},
		{"(WIN32 && DEBUG) || VERSION", true},
	}
	for _, tt := range tests {
		got := evalIfExpr(tt.expr, defines)
		if got != tt.want {
			t.Errorf("evalIfExpr(%q): got %v, want %v", tt.expr, got, tt.want)
		}
	}
}

func TestComputeInactiveSet(t *testing.T) {
	t.Run("ifdef active branch", func(t *testing.T) {
		lines := []string{
			"#ifdef WIN32",
			"int x = 1;",
			"#else",
			"int x = 2;",
			"#endif",
		}
		defines := map[string]int{"WIN32": 1}
		inactive := computeInactiveSet(lines, defines)
		if inactive[2] {
			t.Error("line 2 should be active (WIN32 branch)")
		}
		if !inactive[4] {
			t.Error("line 4 should be inactive (else branch)")
		}
	})

	t.Run("ifdef inactive branch", func(t *testing.T) {
		lines := []string{
			"#ifdef LINUX",
			"int x = 1;",
			"#else",
			"int x = 2;",
			"#endif",
		}
		defines := map[string]int{"WIN32": 1}
		inactive := computeInactiveSet(lines, defines)
		if !inactive[2] {
			t.Error("line 2 should be inactive (LINUX not defined)")
		}
		if inactive[4] {
			t.Error("line 4 should be active (else branch)")
		}
	})

	t.Run("ifndef", func(t *testing.T) {
		lines := []string{
			"#ifndef NDEBUG",
			"assert(x);",
			"#endif",
		}
		defines := map[string]int{}
		inactive := computeInactiveSet(lines, defines)
		if inactive[2] {
			t.Error("line 2 should be active (NDEBUG not defined)")
		}
	})

	t.Run("nested ifdef", func(t *testing.T) {
		lines := []string{
			"#ifdef WIN32",
			"#ifdef DEBUG",
			"log();",
			"#endif",
			"#endif",
		}
		defines := map[string]int{"WIN32": 1}
		inactive := computeInactiveSet(lines, defines)
		if !inactive[3] {
			t.Error("line 3 should be inactive (DEBUG not defined)")
		}
	})

	t.Run("elif", func(t *testing.T) {
		lines := []string{
			"#if VERSION == 1",
			"v1();",
			"#elif VERSION == 2",
			"v2();",
			"#else",
			"vx();",
			"#endif",
		}
		defines := map[string]int{"VERSION": 2}
		inactive := computeInactiveSet(lines, defines)
		if !inactive[2] {
			t.Error("line 2 should be inactive (VERSION != 1)")
		}
		if inactive[4] {
			t.Error("line 4 should be active (VERSION == 2)")
		}
		if !inactive[6] {
			t.Error("line 6 should be inactive (else)")
		}
	})
}
