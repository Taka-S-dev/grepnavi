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

	for i, line := range code {
		if funcDepth == 0 {
			if strings.TrimSpace(line) == "" {
				if decl.Len() == 0 {
					declStart = i + 1 // 空行はシグネチャの開始位置に含めない
				}
				continue
			}
			// 関数の外のディレクティブ行は丸ごと飛ばす。`#define FOO { ... }` の
			// ような釣り合わないブレースで深度が壊れるのを防ぐ。
			// `\` で続く行も同じ扱いにすること。2行目以降は `#` で始まらないので、
			// 見逃すとマクロ本体が次の関数のシグネチャに連結される
			// （openssl の `#define IS_PROT_FLAG(o) \` の直後の s_server_main が
			//  本体の `==` のせいで初期化子と誤判定され、丸ごと消えた）
			if inContinuedDirective || isDirectiveLine([]byte(line)) {
				inContinuedDirective = endsWithContinuation(line)
				resetDecl(i + 1)
				continue
			}
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
	if strings.Contains(d, "=") {
		if m := reStructVarName.FindStringSubmatch(d); m != nil {
			return m[1]
		}
		return ""
	}
	end := strings.LastIndexByte(d, ')')
	if end < 0 {
		return ""
	}
	// 対応する `(` まで戻る
	depth, open := 0, -1
	for i := end; i >= 0; i-- {
		switch d[i] {
		case ')':
			depth++
		case '(':
			depth--
			if depth == 0 {
				open = i
			}
		}
		if open >= 0 {
			break
		}
	}
	if open <= 0 {
		return ""
	}
	// `(` の直前の識別子
	i := open - 1
	for i >= 0 && (d[i] == ' ' || d[i] == '\t') {
		i--
	}
	last := i
	for i >= 0 && isIdentChar(d[i]) {
		i--
	}
	name := d[i+1 : last+1]
	if name == "" || !isIdentStart(name[0]) {
		return ""
	}
	// `if (...) {` などの制御構文は関数ではない
	if ctKeywords[name] {
		return ""
	}
	return name
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
