package search

import (
	"regexp"
	"strings"
	"sync"
)

// struct 本体からのメンバー抽出（ctags のメンバー表の補完）。
//
// ctags は `STACK_OF(EX_CALLBACK) *meth;` のようなマクロ生成の型や、匿名 union の
// 中身を取りこぼすことがある。そのとき表は空だが、struct の場所（ファイル:行）は
// 索引が知っているので、本体の { ... } を読んで宣言子の名前を拾う。
// 結果は struct 名でキャッシュする（同じ struct は何度も引かれる）。

var structBodyCache = struct {
	sync.Mutex
	root string
	m    map[string][]Member
}{m: map[string][]Member{}}

// structMembersFromSource は root の索引で name（struct/union のタグ名）の定義を
// 見つけ、本体を読んでメンバーを返す。見つからなければ nil。
func structMembersFromSource(root, name string) []Member {
	structBodyCache.Lock()
	if structBodyCache.root != root {
		structBodyCache.root = root
		structBodyCache.m = map[string][]Member{}
	}
	if ms, ok := structBodyCache.m[name]; ok {
		structBodyCache.Unlock()
		return ms
	}
	structBodyCache.Unlock()

	var members []Member
	if hits, err := CtagsFindDefinitions(name, root); err == nil {
		for _, h := range hits {
			if h.Kind != "struct" && h.Kind != "union" {
				continue
			}
			if lines, err := readFileLines(h.File); err == nil {
				members = parseStructBody(lines, h.Line)
			}
			if len(members) > 0 {
				break
			}
		}
	}
	structBodyCache.Lock()
	structBodyCache.m[name] = members
	structBodyCache.Unlock()
	return members
}

// 関数ポインタメンバー: void (*name)(...)
var reFuncPtrMember = regexp.MustCompile(`\(\s*\*\s*([A-Za-z_]\w*)\s*\)`)

// 普通の宣言子: 末尾の識別子（配列・ビットフィールドは後ろに付く）
var reLastDeclarator = regexp.MustCompile(`([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*(?::\s*\d+\s*)?$`)

// parseStructBody は defLine（1-indexed）から始まる struct/union 定義の本体を読み、
// メンバー名と型文字列を返す。コメント・文字列は落とした行で見る。
// 入れ子の匿名 struct/union の中身もメンバーとして拾う（C ではそのまま触れるため）。
// 名前付きの入れ子は本来そのメンバー名で触るべきだが、区別せず拾う（取りこぼす
// より候補が少し多い方が害が小さい）。
func parseStructBody(lines []string, defLine int) []Member {
	if defLine < 1 || defLine > len(lines) {
		return nil
	}
	code := codeOnlyLines(lines)
	var body strings.Builder
	depth := 0
	started := false
	for i := defLine - 1; i < len(code); i++ {
		for _, ch := range code[i] {
			switch ch {
			case '{':
				depth++
				if depth == 1 {
					started = true
					continue
				}
			case '}':
				depth--
				if started && depth == 0 {
					return membersFromBody(body.String())
				}
			}
			if started && depth >= 1 {
				body.WriteRune(ch)
			}
		}
		if started {
			body.WriteByte('\n')
		}
		if !started && i > defLine+5 {
			return nil // 定義行の近くに { が無い（前方宣言など）
		}
	}
	return nil
}

func membersFromBody(body string) []Member {
	var out []Member
	// 入れ子ブロックの中身も同じ平面で見る: { と } を ; に置き換えて文に割る
	flat := strings.NewReplacer("{", ";", "}", ";").Replace(body)
	for _, stmt := range strings.Split(flat, ";") {
		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			continue
		}
		// 匿名 struct/union の開始 "union" / "struct name" だけの断片は読み飛ばす
		if stmt == "struct" || stmt == "union" || strings.HasPrefix(stmt, "struct ") && !strings.ContainsAny(stmt, "*;") && len(strings.Fields(stmt)) == 2 {
			continue
		}
		// 宣言子がカンマ区切りで並ぶことがある: int a, b;
		typ := ""
		for k, piece := range splitTopLevelCommas(stmt) {
			piece = strings.TrimSpace(piece)
			if m := reFuncPtrMember.FindStringSubmatch(piece); m != nil {
				out = append(out, Member{Name: m[1], Type: strings.TrimSpace(strings.Replace(piece, m[0], "(*)", 1))})
				continue
			}
			m := reLastDeclarator.FindStringSubmatch(piece)
			if m == nil {
				continue
			}
			name := m[1]
			if k == 0 {
				typ = strings.TrimSpace(strings.TrimSuffix(piece[:len(piece)-len(m[0])], " "))
				// "unsigned char *" のように名前の直前の * は型側に残す
			}
			if isCKeyword(name) {
				continue
			}
			out = append(out, Member{Name: name, Type: typ})
		}
	}
	return out
}

var cKeywords = map[string]bool{
	"struct": true, "union": true, "enum": true, "const": true, "volatile": true,
	"unsigned": true, "signed": true, "int": true, "char": true, "long": true, "short": true,
	"void": true, "float": true, "double": true, "static": true, "extern": true, "typedef": true,
}

func isCKeyword(s string) bool { return cKeywords[s] }
