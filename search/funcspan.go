package search

import "strings"

// funcSpan は関数定義1つが占める行範囲。
type funcSpan struct {
	Name  string
	Start int // シグネチャの開始行（1-indexed）
	End   int // 閉じブレースの行
}

// scanFuncSpans はコメント・文字列を落とした行列を1回だけ前向きに走り、
// ファイル内の関数定義の範囲をすべて返す（Start 昇順）。
//
// 「ある行を囲む関数は？」を1件ずつ後ろ向きに探すと、答えが無い行（ファイル
// スコープの初期化子など）で候補を遡り切ることになり、実測で55倍遅かった。
// 先に全範囲を出しておけば、あとは二分探索で済む。
//
// ブレース深度だけで判断するので「関数のオープンブレースは列0にある」という
// 前提を持たない。インデントされた本体でも C++ のメソッドでも同じように取れる。
func scanFuncSpans(code []string) []funcSpan {
	var spans []funcSpan
	depth := 0
	// funcDepth は本体に入っている関数のブレース深度（0 = 関数の外）。
	// 関数の中では名前を探さない。C に入れ子の関数は無いので、本体の中の
	// `LIST_FOREACH(x, y) {` のようなマクロを関数と取り違えずに済む。
	funcDepth := 0
	openName, openStart := "", 0
	inContinuedDirective := false // `\` で続いているマクロ定義の途中

	declStart := 0           // 現在の宣言候補が始まった行（0-indexed）
	var decl strings.Builder // その宣言候補のテキスト
	resetDecl := func(next int) {
		decl.Reset()
		declStart = next
	}

	skipAlt := overCountedAltLines(code)

	for i, line := range code {
		if skipAlt[i+1] {
			continue // 数えると釣り合わなくなる分岐
		}
		// ディレクティブ行は本体の中でも飛ばす。`#define FOO { ... }` のような
		// 釣り合わないブレースで深度が壊れるのを防ぐ。`\` で続く行も同じ扱い。
		// 2行目以降は `#` で始まらないので、見逃すとマクロ本体が次の関数の
		// シグネチャに連結される（openssl の `#define IS_PROT_FLAG(o) \` の直後で
		// s_server_main が丸ごと消えた）
		if inContinuedDirective || isDirectiveLine([]byte(line)) {
			inContinuedDirective = endsWithContinuation(line)
			continue
		}
		if funcDepth == 0 && strings.TrimSpace(line) == "" {
			if decl.Len() == 0 {
				declStart = i + 1 // 空行はシグネチャの開始位置に含めない
			}
			continue
		}
		for j := 0; j < len(line); j++ {
			switch line[j] {
			case '{':
				if funcDepth == 0 {
					if name := declaratorName(decl.String()); name != "" {
						funcDepth = depth + 1
						openName, openStart = name, declStart+1
					}
					resetDecl(i + 1)
				}
				depth++
			case '}':
				if depth > 0 {
					depth--
				}
				if funcDepth > 0 && depth < funcDepth {
					spans = append(spans, funcSpan{Name: openName, Start: openStart, End: i + 1})
					funcDepth, openName = 0, ""
				}
				if funcDepth == 0 {
					resetDecl(i + 1)
				}
			case ';':
				if funcDepth == 0 {
					resetDecl(i + 1)
				}
			case ':':
				// `public:` や goto ラベルはシグネチャの一部ではない。
				// 括弧を含むもの（C++ の初期化子リスト `Foo() : x(0)`）は残す
				if funcDepth == 0 && !strings.Contains(decl.String(), "(") {
					resetDecl(i + 1)
				}
			default:
				if funcDepth == 0 {
					if decl.Len() == 0 && line[j] != ' ' && line[j] != '\t' {
						declStart = i
					}
					decl.WriteByte(line[j])
				}
			}
		}
		if funcDepth == 0 && decl.Len() > 0 {
			decl.WriteByte(' ') // 行をまたぐシグネチャの語をつなぐ
		}
	}
	return spans
}

// overCountedAltLines は、条件分岐のうち「数えるとブレースが釣り合わなくなる側」の
// 行を返す。前処理を評価できない以上どの分岐が生きるかは決められないが、
// 数えすぎになる場合だけは分かる。
//
//	#if A
//	  if (x) {        ← +1
//	#else
//	  if (y) {        ← +1
//	#endif
//	  }               ← 閉じは1つ
//
// 実際に開くのは片方だけなので、両方数えると深度が1ずれ、そのファイルの
// 残り全部の関数が見えなくなる（openssl の gcm128.c、curl の multi.c）。
//
// 逆に「#else 側に実装まるごと」という形は、どちらの分岐も収支 0 で釣り合う。
// 収支が 0 でない分岐が2つ以上あるときだけ、2つ目以降を落とす。これなら
// 実装が消えることはない（無条件に裏を落とすと openssl で取りこぼしが
// 11 件から 224 件に増えた）。
func overCountedAltLines(code []string) map[int]bool {
	type branch struct {
		lines []int
		delta int
	}
	type group struct{ branches []*branch }
	var stack []*group
	skip := map[int]bool{}

	cur := func() *branch {
		if len(stack) == 0 {
			return nil
		}
		g := stack[len(stack)-1]
		return g.branches[len(g.branches)-1]
	}
	inCont := false
	for i, line := range code {
		if inCont || isDirectiveLine([]byte(line)) {
			inCont = endsWithContinuation(line)
			d := strings.TrimSpace(strings.TrimSpace(line))
			if !strings.HasPrefix(d, "#") {
				continue // マクロ本体の継続行
			}
			d = strings.TrimSpace(d[1:])
			switch {
			case strings.HasPrefix(d, "if"):
				stack = append(stack, &group{branches: []*branch{{}}})
			case strings.HasPrefix(d, "else"), strings.HasPrefix(d, "elif"):
				if len(stack) > 0 {
					g := stack[len(stack)-1]
					g.branches = append(g.branches, &branch{})
				}
			case strings.HasPrefix(d, "endif"):
				if len(stack) == 0 {
					continue
				}
				g := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				kept, keptDelta := false, 0
				for _, b := range g.branches {
					if b.delta == 0 {
						continue
					}
					if !kept {
						kept, keptDelta = true, b.delta
						continue
					}
					for _, ln := range b.lines {
						skip[ln] = true
					}
				}
				if p := cur(); p != nil {
					p.delta += keptDelta
				}
			}
			continue
		}
		if b := cur(); b != nil {
			b.lines = append(b.lines, i+1)
			b.delta += strings.Count(line, "{") - strings.Count(line, "}")
		}
	}
	return skip
}

// endsWithContinuation は行が `\` で終わっている（次行へ続く）かを返す。
func endsWithContinuation(line string) bool {
	return strings.HasSuffix(strings.TrimRight(line, " \t"), `\`)
}

// declaratorName は `{` の直前までの宣言テキストから関数名を取り出す（""=関数でない）。
// 最後の `)` に対応する `(` の直前の識別子が関数名。この見方なら
// `STACK_OF(GENERAL_NAME) *f(void)` のように戻り値がマクロでも `f` に届く。
func declaratorName(decl string) string {
	d := strings.TrimSpace(decl)
	if d == "" {
		return ""
	}
	// `= {` はファイルスコープの初期化子。関数ではないが、`.read = do_read` の
	// ような関数ポインタ表の中身を「どこで登録されたか」として示せるよう、
	// テーブル変数の名前を範囲の名前にする（呼び出し元一覧はこれを出す）。
	// 名前を取れない `typedef struct {` などは範囲を作らない
	// 「`=` を含む」で見ると、セミコロンの無いマクロ呼び出しが宣言候補に
	// 残ったとき、その中の `==` で次の関数が初期化子扱いになる
	// （openssl の `DEFINE_COMPARISON(void *, ptr, eq, ==, "%p")` の直後）。
	// 初期化子は `{` の直前が `=` なので、末尾で見れば取り違えない
	if strings.HasSuffix(d, "=") {
		if m := reStructVarName.FindStringSubmatch(d); m != nil {
			return m[1]
		}
		return ""
	}
	// `)` を右から順に見て、対応する `(` の直前にある識別子を候補にする。
	// 最後の `)` だけを見ると、関数ポインタを返す関数
	// `int (*SSL_get_verify_callback(const SSL *s)) (int, X509_STORE_CTX *)`
	// で戻り値側の括弧に当たり、名前が取れずに関数ごと見えなくなる。
	// 型キーワードを飛ばしながら左へ下がれば、本体の引数リストに行き着く。
	for end := len(d) - 1; end >= 0; end-- {
		if d[end] != ')' {
			continue
		}
		open := matchingOpenParen(d, end)
		if open <= 0 {
			continue
		}
		name := identBefore(d, open)
		if name == "" || ctKeywords[name] || cTypeWords[name] {
			continue
		}
		return name
	}
	return ""
}

// matchingOpenParen は close 位置の `)` に対応する `(` の位置を返す（-1 = 無し）。
func matchingOpenParen(d string, close int) int {
	depth := 0
	for i := close; i >= 0; i-- {
		switch d[i] {
		case ')':
			depth++
		case '(':
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}

// identBefore は pos の直前にある識別子を返す（空白は読み飛ばす）。
func identBefore(d string, pos int) string {
	i := pos - 1
	for i >= 0 && (d[i] == ' ' || d[i] == '\t') {
		i--
	}
	last := i
	for i >= 0 && isIdentChar(d[i]) {
		i--
	}
	if i+1 > last || !isIdentStart(d[i+1]) {
		return ""
	}
	return d[i+1 : last+1]
}

// cTypeWords は宣言子の中で関数名になりえない語。
// `int (*f(x)) (y)` の外側の括弧が `int` を名前に見せるのを防ぐ。
var cTypeWords = map[string]bool{
	"int": true, "char": true, "void": true, "long": true, "short": true,
	"unsigned": true, "signed": true, "float": true, "double": true, "_Bool": true,
	"const": true, "volatile": true, "restrict": true, "inline": true,
	"static": true, "extern": true, "register": true, "auto": true,
	"struct": true, "union": true, "enum": true, "typedef": true,
}

// enclosingSpan は line を含む最も内側の関数を返す。Start 昇順を利用した二分探索。
func enclosingSpan(spans []funcSpan, line int) (funcSpan, bool) {
	lo, hi := 0, len(spans)-1
	best, found := funcSpan{}, false
	for lo <= hi {
		mid := (lo + hi) / 2
		if spans[mid].Start <= line {
			if line <= spans[mid].End {
				best, found = spans[mid], true
			}
			lo = mid + 1
		} else {
			hi = mid - 1
		}
	}
	return best, found
}
