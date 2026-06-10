package api

import "testing"

func TestLooksLikeRegexPattern(t *testing.T) {
	regexLike := []string{
		`recipe.*save`, `foo.+bar`, `\bword\b`, `\d+`, `\w+_init`, `a\s*b`, `(?i)foo`,
		`^prefix`, `suffix$`,
	}
	for _, p := range regexLike {
		if !looksLikeRegexPattern(p) {
			t.Errorf("looksLikeRegexPattern(%q) = false, want true", p)
		}
	}
	// C コードの literal 検索で普通に現れるものは誤検知しない
	literals := []string{
		`recipe_save`, `foo(bar)`, `arr[0]`, `a || b`, `x->field`, `#define MAX`,
		`if (err != NULL)`, `printf("%d\n", x)`,
	}
	for _, p := range literals {
		if looksLikeRegexPattern(p) {
			t.Errorf("looksLikeRegexPattern(%q) = true, want false", p)
		}
	}
}
