package lsp

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"

	"grepnavi/search"
)

type signatureHelp struct {
	Signatures      []signatureInformation `json:"signatures"`
	ActiveSignature int                    `json:"activeSignature"`
	ActiveParameter int                    `json:"activeParameter"`
}

type signatureInformation struct {
	Label      string                 `json:"label"`
	Parameters []parameterInformation `json:"parameters"`
}

type parameterInformation struct {
	Label string `json:"label"`
}

// handleSignatureHelp は `foo(a, |` の位置で foo のシグネチャと、いま何番目の
// 引数かを返す。シグネチャは定義行の字面（関数なら `(` から対応する `)` まで、
// マクロなら #define の行）で、型を解釈しない。
func (s *server) handleSignatureHelp(ctx context.Context, raw json.RawMessage) (any, *responseError) {
	var p textDocumentPositionParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &responseError{Code: codeInvalidParams, Message: err.Error()}
	}
	content, ok := s.documentText(p.TextDocument.URI)
	if !ok {
		return nil, nil
	}
	lines := strings.Split(content, "\n")
	if p.Position.Line < 0 || p.Position.Line >= len(lines) {
		return nil, nil
	}
	lineText := strings.TrimSuffix(lines[p.Position.Line], "\r")
	before := lineText[:utf16ByteOffset(lineText, p.Position.Character)]
	name, nameAt, arg, found := enclosingCallAt(before)
	// 引数が行をまたいでいる: 上の行を継ぎ足して開き括弧を探す（最大 5 行）
	for k := 1; !found && k <= 5 && p.Position.Line-k >= 0; k++ {
		before = strings.TrimSuffix(lines[p.Position.Line-k], "\r") + "\n" + before
		name, nameAt, arg, found = enclosingCallAt(before)
	}
	if !found || cKeywords[name] {
		return nil, nil
	}
	// `s->method->ssl_read(` はメンバ（関数ポインタ）の呼び出し。名前で関数を
	// 引くと同名の別関数（bio_ssl.c の static ssl_read）のシグネチャが出るので、
	// メンバの宣言 `int (*ssl_read) (SSL *, ...)` だけを見る
	member := memberAccessBefore(before, nameAt)
	path := uriToPath(p.TextDocument.URI)
	var defs []search.DefHit
	owner := ""
	if member {
		// 受け手 `file->f_op` の型が分かれば、その struct の本体にある宣言行を
		// 直接読む（linux の `read` は数十の struct にあり、名前で引くと混ざる）。
		// 分からなければ ctags のメンバ項目に頼る（gtags にメンバは無い）
		if chain := receiverChainBefore(before, nameAt); len(chain) > 0 {
			owner, _ = search.ChainStructInText(s.root, content, p.Position.Line+1, chain)
		}
		if owner != "" {
			defs = s.memberDeclarations(ctx, owner, name, path)
		}
		if len(defs) == 0 {
			defs, _ = search.CtagsFindDefinitions(name, s.root)
		}
	} else {
		defs = s.findDefinitions(ctx, name, path)
	}
	var sigs []signatureInformation
	for _, h := range defs {
		if member {
			if h.Kind != "member" || (owner != "" && h.Owner != "" && h.Owner != owner) {
				continue
			}
		} else if h.Kind != "func" && h.Kind != "define" {
			continue
		}
		label, params, ok := signatureAt(h.File, h.Line, name)
		if !ok {
			continue
		}
		sigs = append(sigs, signatureInformation{Label: label, Parameters: params})
		if len(sigs) == 3 {
			break
		}
	}
	if len(sigs) == 0 {
		return nil, nil
	}
	return signatureHelp{Signatures: sigs, ActiveSignature: 0, ActiveParameter: arg}, nil
}

// memberDeclarations は struct / union `owner` の本体から、メンバ name の宣言行を返す。
// `int (*read)(...)` のような関数ポインタも `int n;` も、名前の直後の字面で見る。
func (s *server) memberDeclarations(ctx context.Context, owner, name, currentFile string) []search.DefHit {
	// struct 名として成り立たない文字列で索引を引かない: 索引に無い語は rg の
	// 全走査に落ち、大きいツリーでは期限（15 秒）まで待つことになる
	if !isIdentifier(owner) {
		return nil
	}
	re := regexp.MustCompile(`(?:\(\s*\*\s*` + regexp.QuoteMeta(name) + `\s*\)|\b` + regexp.QuoteMeta(name) + `\s*[;\[:,)])`)
	var out []search.DefHit
	for _, d := range s.findDefinitions(ctx, owner, currentFile) {
		if d.Kind != "struct" && d.Kind != "union" {
			continue
		}
		lines, err := search.CachedLines(d.File)
		if err != nil {
			continue
		}
		depth := 0
		for i := d.Line - 1; i < len(lines) && i < d.Line-1+2000; i++ {
			l := lines[i]
			if depth > 0 && re.MatchString(l) {
				out = append(out, search.DefHit{File: d.File, Line: i + 1, Text: l, Name: name, Kind: "member", Owner: owner})
				break
			}
			depth += strings.Count(l, "{") - strings.Count(l, "}")
			if depth <= 0 && i > d.Line-1 && strings.Contains(l, "}") {
				break // 本体の終わり
			}
		}
	}
	return out
}

// isIdentifier は C の識別子として成り立つ文字列か。
func isIdentifier(s string) bool {
	if s == "" || (s[0] >= '0' && s[0] <= '9') {
		return false
	}
	for i := 0; i < len(s); i++ {
		if !isIdentByte(s[i]) {
			return false
		}
	}
	return true
}

// enclosingCall は text の末尾から遡り、まだ閉じていない `(` の直前の識別子と、
// そこからカーソルまでに数えた最上位のカンマの数（= 何番目の引数か）を返す。
// `;` や `{` に当たったら呼び出しの中ではない。
func enclosingCall(text string) (name string, arg int, ok bool) {
	name, _, arg, ok = enclosingCallAt(text)
	return name, arg, ok
}

// enclosingCallAt は enclosingCall に加えて、識別子の開始位置（byte）を返す。
func enclosingCallAt(text string) (name string, nameAt int, arg int, ok bool) {
	depth := 0
	commas := 0
	for i := len(text) - 1; i >= 0; i-- {
		switch text[i] {
		case ')', ']', '}':
			depth++
		case '(':
			if depth == 0 {
				name = identBefore(text, i)
				if name == "" {
					return "", 0, 0, false
				}
				j := i
				for j > 0 && (text[j-1] == ' ' || text[j-1] == '\t') {
					j--
				}
				return name, j - len(name), commas, true
			}
			depth--
		case '[', '{':
			if depth == 0 {
				return "", 0, 0, false
			}
			depth--
		case ',':
			if depth == 0 {
				commas++
			}
		case ';':
			if depth == 0 {
				return "", 0, 0, false
			}
		}
	}
	return "", 0, 0, false
}

// receiverChainBefore は nameAt の識別子の受け手を、変数名とメンバ名の列で返す:
// `x = file->f_op->read` の read なら ["file", "f_op"]。識別子と `->` / `.` だけ
// で繋がっている範囲を取り、`get(s)->read` のように括弧を含むときは空。
func receiverChainBefore(text string, nameAt int) []string {
	var chain []string
	j := nameAt
	for {
		for j > 0 && (text[j-1] == ' ' || text[j-1] == '\t') {
			j--
		}
		switch {
		case j >= 2 && text[j-2:j] == "->":
			j -= 2
		case j >= 1 && text[j-1] == '.':
			j--
		default:
			return chain
		}
		for j > 0 && (text[j-1] == ' ' || text[j-1] == '\t') {
			j--
		}
		end := j
		for j > 0 && isIdentByte(text[j-1]) {
			j--
		}
		if j == end {
			return nil // `)->read` : 受け手が式で名前ではない
		}
		chain = append([]string{text[j:end]}, chain...)
	}
}

// memberAccessBefore は text の nameAt にある識別子が `->` か `.` の直後かを返す。
// C にメソッドは無いので、これが真なら関数ポインタのメンバを呼んでいる。
func memberAccessBefore(text string, nameAt int) bool {
	j := nameAt
	for j > 0 && (text[j-1] == ' ' || text[j-1] == '\t') {
		j--
	}
	if j >= 2 && text[j-2:j] == "->" {
		return true
	}
	return j >= 1 && text[j-1] == '.'
}

// identBefore は text[:end] の末尾（空白を挟んでよい）にある識別子を返す。
func identBefore(text string, end int) string {
	j := end
	for j > 0 && (text[j-1] == ' ' || text[j-1] == '\t') {
		j--
	}
	i := j
	for i > 0 && isIdentByte(text[i-1]) {
		i--
	}
	if i == j || (text[i] >= '0' && text[i] <= '9') {
		return ""
	}
	return text[i:j]
}

// signatureAt は定義行から `name(...)` の字面を切り出す。複数行の引数リストは
// 対応する `)` まで（最大 12 行）継ぎ足す。
func signatureAt(file string, line int, name string) (string, []parameterInformation, bool) {
	lines, err := search.CachedLines(file)
	if err != nil || line < 1 || line > len(lines) {
		return "", nil, false
	}
	var sb strings.Builder
	for i := line - 1; i < len(lines) && i < line-1+12; i++ {
		if sb.Len() > 0 {
			sb.WriteByte(' ')
		}
		sb.WriteString(strings.TrimSpace(strings.TrimSuffix(lines[i], "\r")))
		if paramsClosed(sb.String(), name) {
			break
		}
	}
	text := sb.String()
	// 引数リストの `(` を探す。関数は `name(` / `name (`、関数ポインタのメンバは
	// `(*name) (` と、名前の後ろに `)` が一つ挟まる
	start := -1
	for from := 0; from < len(text); {
		at := strings.Index(text[from:], name)
		if at < 0 {
			break
		}
		at += from
		j := at + len(name)
		for j < len(text) && (text[j] == ' ' || text[j] == '\t') {
			j++
		}
		if j < len(text) && text[j] == ')' {
			j++
			for j < len(text) && (text[j] == ' ' || text[j] == '\t') {
				j++
			}
		}
		if j < len(text) && text[j] == '(' && (at == 0 || !isIdentByte(text[at-1])) {
			start = j
			break
		}
		from = at + len(name)
	}
	if start < 0 {
		return "", nil, false
	}
	depth := 0
	end := -1
	for i := start; i < len(text); i++ {
		switch text[i] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				end = i
			}
		}
		if end >= 0 {
			break
		}
	}
	if end < 0 {
		return "", nil, false
	}
	// ラベルは戻り値型から `)` まで。#define は行頭の "#define " を落とす
	label := strings.TrimSpace(strings.TrimPrefix(text[:end+1], "#define"))
	label = strings.Join(strings.Fields(label), " ")
	inner := strings.TrimSpace(text[start+1 : end])
	var params []parameterInformation
	if inner != "" && inner != "void" {
		for _, part := range splitTopLevel(inner) {
			params = append(params, parameterInformation{Label: strings.TrimSpace(part)})
		}
	}
	return label, params, true
}

// paramsClosed は text の中で name の後の括弧が閉じているかを返す。
func paramsClosed(text, name string) bool {
	open := strings.Index(text, name)
	if open < 0 {
		return false
	}
	depth := 0
	seen := false
	for i := open; i < len(text); i++ {
		switch text[i] {
		case '(':
			depth++
			seen = true
		case ')':
			depth--
			if seen && depth == 0 {
				return true
			}
		}
	}
	return false
}

// splitTopLevel はカンマで分ける。括弧の中のカンマ（関数ポインタ引数）は分けない。
func splitTopLevel(s string) []string {
	var parts []string
	depth := 0
	start := 0
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '(', '[':
			depth++
		case ')', ']':
			depth--
		case ',':
			if depth == 0 {
				parts = append(parts, s[start:i])
				start = i + 1
			}
		}
	}
	return append(parts, s[start:])
}
