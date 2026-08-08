package search

import (
	"context"
	"regexp"
	"strconv"
	"strings"
)

// #define の置換部が整数定数式なら値を計算して HoverHit.Value に入れる。
// (2|ERR_R_FATAL) のような定義はログの数値やビットフラグと突き合わせられない
// ので、人が余白で暗算している値をツールが出す。方針は enum の計算値と同じ
// 「間違った値を見せるくらいなら出さない」: 語彙の外（関数形式マクロ・
// sizeof・キャスト・比較・浮動小数）や定義の食い違いに当たった時点で諦める。
// 評価は自前の再帰下降パーサで行い、コードの実行は一切しない。

const (
	evalMaxDepth   = 6 // 識別子解決の入れ子上限（別名連鎖の4段より式の分は深めに）
	evalMaxLookups = 8 // 1ホバーあたりの定義検索回数の上限。ホバー遅延の天井
)

// reDefineHead: #define 行の頭。group1=名前、group2=名前直後の '('（関数形式の印）。
// `#define A (x)` は置換部が括弧の別物なので、'(' は名前に密着したときだけ拾う。
var reDefineHead = regexp.MustCompile(`^\s*#\s*define\s+([A-Za-z_]\w*)(\()?\s*(.*)$`)

// stripCommentsStateful は1行からコメントを除いたコードを返す。inComment は
// 行開始時点で /* ブロック内かどうか、戻り値は行終了時点の状態。
// 行単位の stripLineComment と違い複数行コメントをまたいで状態を持つ。
// 直前コメントに旧定義（コメントアウトされた #define）が残っているのは
// 実コードでよくある形で、状態なしで走査するとそちらを拾って誤値になる。
func stripCommentsStateful(line string, inComment bool) (string, bool) {
	var b strings.Builder
	i := 0
	for i < len(line) {
		if inComment {
			j := strings.Index(line[i:], "*/")
			if j < 0 {
				return b.String(), true
			}
			i += j + 2
			inComment = false
			continue
		}
		if strings.HasPrefix(line[i:], "/*") {
			inComment = true
			i += 2
			continue
		}
		if strings.HasPrefix(line[i:], "//") {
			break
		}
		b.WriteByte(line[i])
		i++
	}
	return b.String(), inComment
}

// defineReplacement はカード本文から name の置換部テキストを取り出す。
// 本文の先頭には直前コメントが付くことがあるので、コメント状態を追いながら
// 行単位で #define を探す。name の一致を要求するのは、索引の行ずれで別の
// マクロの行を掴んだとき誤った値を計算しないため。関数形式マクロは ok=false。
func defineReplacement(body, name string) (string, bool) {
	lines := strings.Split(body, "\n")
	inComment := false
	for i := 0; i < len(lines); i++ {
		code, still := stripCommentsStateful(lines[i], inComment)
		inComment = still
		m := reDefineHead.FindStringSubmatch(code)
		if m == nil || m[1] != name {
			continue
		}
		if m[2] == "(" {
			return "", false
		}
		expr := m[3]
		// 行末 \ の継続行を連結
		for strings.HasSuffix(strings.TrimRight(expr, " \t"), `\`) && i+1 < len(lines) {
			expr = strings.TrimSuffix(strings.TrimRight(expr, " \t"), `\`)
			i++
			cont, still := stripCommentsStateful(lines[i], inComment)
			inComment = still
			expr = strings.TrimRight(expr, " \t") + " " + strings.TrimLeft(cont, " \t")
		}
		// 式の途中で /* が閉じていない（コメントが次の物理行へ続く）場合、
		// 見えている部分だけ評価すると別の式の値になる
		if inComment {
			return "", false
		}
		expr = strings.TrimSpace(expr)
		if expr == "" {
			return "", false
		}
		return expr, true
	}
	return "", false
}

// evalTok は定数式の1トークン。kind: 'n'=数値 'i'=識別子 'o'=演算子 '('/')'
type evalTok struct {
	kind     byte
	op       string
	num      int64
	unsigned bool // u/U 接尾辞。C では幅と符号の意味論が変わるため危険な演算を拒否する印
	name     string
}

// reCIntLiteral は C の整数リテラル字面（16進 or 10進/8進）。Go の ParseInt は
// 0b/0o/数字区切り _ も通してしまうので、C に無い字面を先に落とす。
var reCIntLiteral = regexp.MustCompile(`^(0[xX][0-9a-fA-F]+|[0-9]+)$`)

// lexConstExpr は式を字句に分ける。整数定数式の語彙（整数リテラル・識別子・
// ビット/算術演算子・括弧）の外の文字が現れたら ok=false。比較・論理演算・
// 三項・カンマは値こそ計算できるが #define 定数の用途では出ないので対象外。
func lexConstExpr(s string) ([]evalTok, bool) {
	var toks []evalTok
	for i := 0; i < len(s); {
		c := s[i]
		switch {
		case c == ' ' || c == '\t':
			i++
		case c >= '0' && c <= '9':
			j := i
			for j < len(s) && (s[j] == '_' || s[j] >= '0' && s[j] <= '9' ||
				s[j] >= 'a' && s[j] <= 'z' || s[j] >= 'A' && s[j] <= 'Z') {
				j++
			}
			lit := s[i:j]
			k := len(lit)
			for k > 0 && strings.ContainsRune("uUlL", rune(lit[k-1])) {
				k--
			}
			if !reCIntLiteral.MatchString(lit[:k]) {
				return nil, false
			}
			// int64 に収まらない値（0xFFFFFFFFFFFFFFFF 等）は符号なし幅の解釈が
			// 要るので対象外。ビットを int64 に詰め替えると >> や / が誤値になる
			n, err := strconv.ParseInt(lit[:k], 0, 64)
			if err != nil {
				return nil, false
			}
			toks = append(toks, evalTok{kind: 'n', num: n,
				unsigned: strings.ContainsAny(lit[k:], "uU")})
			i = j
		case c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z':
			j := i
			for j < len(s) && (s[j] == '_' || s[j] >= '0' && s[j] <= '9' ||
				s[j] >= 'a' && s[j] <= 'z' || s[j] >= 'A' && s[j] <= 'Z') {
				j++
			}
			toks = append(toks, evalTok{kind: 'i', name: s[i:j]})
			i = j
		case c == '(' || c == ')':
			toks = append(toks, evalTok{kind: c})
			i++
		case c == '<' || c == '>':
			if i+1 >= len(s) || s[i+1] != c {
				return nil, false // 単独の < > は比較
			}
			toks = append(toks, evalTok{kind: 'o', op: s[i : i+2]})
			i += 2
		case strings.ContainsRune("|&^+-*/%~", rune(c)):
			if (c == '|' || c == '&') && i+1 < len(s) && s[i+1] == c {
				return nil, false // || と && は論理演算
			}
			toks = append(toks, evalTok{kind: 'o', op: string(c)})
			i++
		default:
			return nil, false
		}
	}
	if len(toks) == 0 {
		return nil, false
	}
	// 識別子直後の '(' は関数形式マクロの呼び出し（sizeof(x) もここで落ちる）
	for k := 0; k+1 < len(toks); k++ {
		if toks[k].kind == 'i' && toks[k+1].kind == '(' {
			return nil, false
		}
	}
	return toks, true
}

// isBareIntLiteral は式が（括弧・単項マイナスを除けば）リテラル1個かを返す。
// 素の 64 に「= 64」を添えても情報が増えないので注釈を省く判定に使う。
func isBareIntLiteral(expr string) bool {
	toks, ok := lexConstExpr(expr)
	if !ok {
		return false
	}
	i, j := 0, len(toks)
	for i < j && toks[i].kind == '(' && toks[j-1].kind == ')' {
		i, j = i+1, j-1
	}
	if i < j && toks[i].kind == 'o' && toks[i].op == "-" {
		i++
	}
	return j-i == 1 && toks[i].kind == 'n'
}

// evalVal は評価中の値。unsigned は u/U 接尾辞由来の値が混ざった印で、
// C の符号なし演算と int64 の結果が食い違いうる演算（~ / 単項 - / 負に
// なる演算結果）をこの印を見て拒否する。正の値の | & ^ << + * は符号の
// 解釈に依らずビット同一なので、SSL_OP_ALL のような U 付きフラグ定数は
// 普通に計算できる。
type evalVal struct {
	n        int64
	unsigned bool
}

// evalState は1回の注釈処理で共有する解決コンテキスト。
// cache は同じ識別子の再解決を防ぎ、seen は循環定義を検出する。
type evalState struct {
	resolve func(string) (string, bool)
	cache   map[string]evalVal
	seen    map[string]bool
	depth   int
}

type evalParser struct {
	toks []evalTok
	pos  int
	st   *evalState
}

// evalDefineExpr は expr を C の整数定数式として評価する。resolve は識別子を
// 一意な #define 置換部へ引く関数（見つからない・一意でないときは ok=false）。
func evalDefineExpr(expr string, resolve func(string) (string, bool)) (int64, bool) {
	st := &evalState{resolve: resolve, cache: map[string]evalVal{}, seen: map[string]bool{}}
	v, ok := st.eval(expr)
	return v.n, ok
}

func (st *evalState) eval(expr string) (evalVal, bool) {
	toks, ok := lexConstExpr(expr)
	if !ok {
		return evalVal{}, false
	}
	p := &evalParser{toks: toks, st: st}
	v, ok := p.parseBinary(1)
	if !ok || p.pos != len(p.toks) {
		return evalVal{}, false
	}
	return v, true
}

// 2項演算の優先順位（C準拠、値が大きいほど強い）。全て左結合。
var evalPrec = map[string]int{
	"|": 1, "^": 2, "&": 3,
	"<<": 4, ">>": 4,
	"+": 5, "-": 5,
	"*": 6, "/": 6, "%": 6,
}

func (p *evalParser) parseBinary(minPrec int) (evalVal, bool) {
	left, ok := p.parseUnary()
	if !ok {
		return evalVal{}, false
	}
	for p.pos < len(p.toks) {
		t := p.toks[p.pos]
		if t.kind != 'o' {
			break
		}
		prec, isBin := evalPrec[t.op]
		if !isBin || prec < minPrec {
			break
		}
		p.pos++
		right, ok := p.parseBinary(prec + 1)
		if !ok {
			return evalVal{}, false
		}
		r := evalVal{unsigned: left.unsigned || right.unsigned}
		switch t.op {
		case "|":
			r.n = left.n | right.n
		case "^":
			r.n = left.n ^ right.n
		case "&":
			r.n = left.n & right.n
		case "<<", ">>":
			if right.n < 0 || right.n > 63 {
				return evalVal{}, false
			}
			// 負値の >> は論理シフト（符号なし）と算術シフトで結果が割れる
			if t.op == ">>" && left.n < 0 {
				return evalVal{}, false
			}
			if t.op == "<<" {
				r.n = left.n << uint(right.n)
			} else {
				r.n = left.n >> uint(right.n)
			}
		case "+":
			r.n = left.n + right.n
		case "-":
			r.n = left.n - right.n
		case "*":
			r.n = left.n * right.n
		case "/", "%":
			if right.n == 0 {
				return evalVal{}, false
			}
			// 符号付き同士なら C も Go もゼロ方向切り捨てで一致する
			if t.op == "/" {
				r.n = left.n / right.n
			} else {
				r.n = left.n % right.n
			}
		}
		// 符号なし由来の値が負になったら C ではラップして巨大な正値。再現しない
		if r.unsigned && r.n < 0 {
			return evalVal{}, false
		}
		left = r
	}
	return left, true
}

func (p *evalParser) parseUnary() (evalVal, bool) {
	if p.pos < len(p.toks) && p.toks[p.pos].kind == 'o' {
		op := p.toks[p.pos].op
		if op == "~" || op == "-" || op == "+" {
			p.pos++
			v, ok := p.parseUnary()
			if !ok {
				return evalVal{}, false
			}
			// ~0U は幅（32/64bit）で値が変わり、-x も符号なしではラップする
			if v.unsigned && op != "+" {
				return evalVal{}, false
			}
			switch op {
			case "~":
				v.n = ^v.n
			case "-":
				v.n = -v.n
			}
			return v, true
		}
	}
	return p.parsePrimary()
}

func (p *evalParser) parsePrimary() (evalVal, bool) {
	if p.pos >= len(p.toks) {
		return evalVal{}, false
	}
	t := p.toks[p.pos]
	switch t.kind {
	case 'n':
		p.pos++
		return evalVal{n: t.num, unsigned: t.unsigned}, true
	case 'i':
		p.pos++
		return p.st.resolveIdent(t.name)
	case '(':
		p.pos++
		v, ok := p.parseBinary(1)
		if !ok || p.pos >= len(p.toks) || p.toks[p.pos].kind != ')' {
			return evalVal{}, false
		}
		p.pos++
		return v, true
	}
	return evalVal{}, false
}

func (st *evalState) resolveIdent(name string) (evalVal, bool) {
	if v, ok := st.cache[name]; ok {
		return v, true
	}
	if st.seen[name] || st.depth >= evalMaxDepth {
		return evalVal{}, false
	}
	expr, ok := st.resolve(name)
	if !ok {
		return evalVal{}, false
	}
	st.seen[name] = true
	st.depth++
	v, ok := st.eval(expr)
	st.depth--
	delete(st.seen, name)
	if !ok {
		return evalVal{}, false
	}
	st.cache[name] = v
	return v, true
}

// annotateDefineValues は define カードの置換部を評価し、決まった値を Value に
// 入れる。word はホバーした語（連鎖カードは自分の Name を持つ）。
// 識別子の解決は別名連鎖と同じ優先順位（gtags → rg）。同名 #define が複数あり
// 置換部が食い違う場合（ifdef 分岐など）はどれが生きているか分からないので
// 解決しない。読めなかった定義も「食い違っているかもしれない定義」なので
// 黙って飛ばさず失敗にする。
func annotateDefineValues(ctx context.Context, hits []HoverHit, word, dir, glob string) {
	lookups := 0
	type defEntry struct {
		expr string
		ok   bool
	}
	defCache := map[string]defEntry{}
	resolve := func(name string) (string, bool) {
		if c, hit := defCache[name]; hit {
			return c.expr, c.ok
		}
		if lookups >= evalMaxLookups || ctx.Err() != nil {
			return "", false
		}
		lookups++
		var dh []DefHit
		if GtagsAvailable(dir) {
			dh, _ = GtagsFindDefinitions(ctx, name, dir)
		}
		if len(dh) == 0 {
			dh, _ = FindDefinitionsN(ctx, name, dir, glob, 5)
		}
		uniq := ""
		found := true
		var expr string
		for _, h := range dh {
			if h.Kind != "define" {
				continue
			}
			lines, err := CachedLines(h.File)
			if err != nil {
				found = false
				break
			}
			body := extractDefineBlock(lines, h.Line)
			if body == "" {
				body = h.Text
			}
			e, ok := defineReplacement(body, name)
			if !ok {
				found = false
				break
			}
			norm := strings.Join(strings.Fields(e), " ")
			if uniq != "" && norm != uniq {
				found = false
				break
			}
			uniq, expr = norm, e
		}
		if uniq == "" || !found {
			defCache[name] = defEntry{}
			return "", false
		}
		defCache[name] = defEntry{expr: expr, ok: true}
		return expr, true
	}

	for i := range hits {
		h := &hits[i]
		if h.Kind != "define" || h.Value != "" {
			continue
		}
		name := word
		if h.Chained && h.Name != "" {
			name = h.Name
		}
		expr, ok := defineReplacement(h.Body, name)
		if !ok || isBareIntLiteral(expr) {
			continue
		}
		if v, ok := evalDefineExpr(expr, resolve); ok {
			h.Value = strconv.FormatInt(v, 10)
		}
	}
}
