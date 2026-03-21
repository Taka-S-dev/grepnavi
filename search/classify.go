package search

import (
	"regexp"
	"strings"

	"grepnavi/graph"
)

// JS の defKind と同等のロジック。パッケージ初期化時にコンパイル済み。
// NOTE: 宣言/定義の判定ロジック（{ の有無）は search/hover.go の handleHover と対になっています。
// 片方を変更した場合はもう片方も確認してください。
var (
	reDefine    = regexp.MustCompile(`^#\s*define\s+\w`)
	reStruct    = regexp.MustCompile(`^(struct|union)\s+\w+\s*(\{|$)`)
	reEnum      = regexp.MustCompile(`^enum\s+\w+\s*\{`)
	reTypedef   = regexp.MustCompile(`\btypedef\b`)
	reControl   = regexp.MustCompile(`^(if|else|while|for|switch|return|case|do)\b`)
	reSemiEnd   = regexp.MustCompile(`;\s*$`)
	reLogicEnd  = regexp.MustCompile(`[&|]\s*$`)
	reFuncCall  = regexp.MustCompile(`\w+\s*\(`)
	reDotArrow  = regexp.MustCompile(`[>\-\.:]`)
	reAssign    = regexp.MustCompile(`=`)
	reBraceEnd  = regexp.MustCompile(`\{\s*$`)
	reBraceStart = regexp.MustCompile(`^\{`)
	reAlphanum  = regexp.MustCompile(`^[a-zA-Z0-9_\s,*()\[\]{}]`)
)

// ClassifyKind は1行のテキストと後続スニペットからシンボル種別を判定する。
// 戻り値: "func" / "define" / "struct" / "enum" / "typedef" / ""
func ClassifyKind(text string, snippet []graph.SnippetLine, matchLine int) string {
	t := strings.TrimSpace(text)
	if t == "" {
		return ""
	}

	if reDefine.MatchString(t) {
		return "define"
	}
	if reStruct.MatchString(t) {
		return "struct"
	}
	if reEnum.MatchString(t) {
		return "enum"
	}
	if reTypedef.MatchString(t) {
		return "typedef"
	}

	parenIdx := strings.Index(t, "(")
	if reControl.MatchString(t) ||
		strings.HasPrefix(t, "{") ||
		strings.HasPrefix(t, "!") ||
		strings.HasPrefix(t, "/*") ||
		strings.HasPrefix(t, "//") ||
		strings.HasPrefix(t, "*") ||
		strings.HasPrefix(t, "||") ||
		strings.HasPrefix(t, "&&") ||
		reSemiEnd.MatchString(t) ||
		reLogicEnd.MatchString(t) ||
		parenIdx <= 0 ||
		reAssign.MatchString(t[:parenIdx]) ||
		reDotArrow.MatchString(t[:parenIdx]) ||
		!reFuncCall.MatchString(t) {
		return ""
	}

	if reBraceEnd.MatchString(t) {
		return "func"
	}

	openParens := strings.Count(t, "(") - strings.Count(t, ")")
	for _, s := range snippet {
		if s.Line <= matchLine {
			continue
		}
		st := strings.TrimSpace(s.Text)
		if st == "" {
			continue
		}
		openParens += strings.Count(st, "(") - strings.Count(st, ")")
		if reBraceStart.MatchString(st) || reBraceEnd.MatchString(st) {
			return "func"
		}
		if openParens <= 0 && reSemiEnd.MatchString(st) {
			break
		}
		if openParens <= 0 && st != "" && !reAlphanum.MatchString(st) {
			break
		}
	}
	return ""
}
