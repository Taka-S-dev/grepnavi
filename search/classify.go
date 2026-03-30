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

// stripLineComment は行末の /* ... */ インラインコメントと // コメントを除去する。
// パーレン計数・セミコロン判定をコメント内の記号に惑わされないようにするため。
func stripLineComment(s string) string {
	// /* ... */ を左から順に除去（単一行内の複数コメントにも対応）
	for {
		start := strings.Index(s, "/*")
		if start < 0 {
			break
		}
		end := strings.Index(s[start+2:], "*/")
		if end < 0 {
			s = s[:start]
			break
		}
		s = s[:start] + s[start+2+end+2:]
	}
	// // 行コメントを除去
	if i := strings.Index(s, "//"); i >= 0 {
		s = s[:i]
	}
	return strings.TrimRight(s, " \t")
}

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

	// K&R スタイル: 関数名と ( が別行のケース（例: "int foo\n(\n...)\n{"）
	if parenIdx < 0 {
		// マッチ行が関数定義の戻り値型+名前に見えない場合は除外
		// （引数の一部・文・代入・メンバーアクセスを含む行はスキップ）
		if strings.ContainsAny(t, ",;=()") || reDotArrow.MatchString(t) || !reAlphanum.MatchString(t) {
			return ""
		}
		// 次の非空行が ( だけ、または ( で始まる引数リストか確認
		nextIsOpenParen := false
		for _, s := range snippet {
			if s.Line <= matchLine {
				continue
			}
			st := strings.TrimSpace(s.Text)
			if st == "" {
				continue
			}
			nextIsOpenParen = strings.HasPrefix(st, "(")
			break
		}
		if !nextIsOpenParen {
			return ""
		}
		// さらに先を見て { が来れば func
		for _, s := range snippet {
			if s.Line <= matchLine {
				continue
			}
			st := strings.TrimSpace(s.Text)
			if reBraceStart.MatchString(st) || reBraceEnd.MatchString(st) {
				return "func"
			}
		}
		return ""
	}

	// コメントを除いたテキストでセミコロン判定・パーレン計数を行う
	tCode := stripLineComment(t)

	if reControl.MatchString(t) ||
		strings.HasPrefix(t, "{") ||
		strings.HasPrefix(t, "!") ||
		strings.HasPrefix(t, "/*") ||
		strings.HasPrefix(t, "//") ||
		strings.HasPrefix(t, "*") ||
		strings.HasPrefix(t, "||") ||
		strings.HasPrefix(t, "&&") ||
		reSemiEnd.MatchString(tCode) ||
		reLogicEnd.MatchString(tCode) ||
		parenIdx <= 0 ||
		reAssign.MatchString(t[:parenIdx]) ||
		reDotArrow.MatchString(t[:parenIdx]) ||
		!reFuncCall.MatchString(t) {
		return ""
	}

	if reBraceEnd.MatchString(tCode) {
		return "func"
	}

	openParens := strings.Count(tCode, "(") - strings.Count(tCode, ")")
	for _, s := range snippet {
		if s.Line <= matchLine {
			continue
		}
		st := strings.TrimSpace(s.Text)
		if st == "" {
			continue
		}
		sc := stripLineComment(st)
		openParens += strings.Count(sc, "(") - strings.Count(sc, ")")
		if reBraceStart.MatchString(st) || reBraceEnd.MatchString(sc) {
			return "func"
		}
		if openParens <= 0 && reSemiEnd.MatchString(sc) {
			break
		}
		if openParens <= 0 && st != "" && !reAlphanum.MatchString(st) {
			break
		}
	}
	// スニペットを使い切っても ( が閉じなかった場合（引数が多くコンテキスト外に出た）
	// → 代入・制御文・メンバーアクセスは既に除外済みなので func と判定
	if openParens > 0 {
		return "func"
	}
	return ""
}
