package search

import (
	"context"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// 状態機械の組み立て。スキャナ (statescan.go) が返す生の遷移に、
// 状態の全体集合（enum の全メンバー、または共通接頭辞の #define 群）と
// 各状態の値・代入有無を重ねる。遷移に一度も現れない状態 =
// デッドステート候補はここで浮かび上がる。
//
// 値は全体集合を見つけた場所（enum ブロック・#define 行）から直接計算する。
// 名前ごとに索引を引き直すと、状態数 × 検索のコストが gtags なしの
// 大きいツリーで一気に効いてくる。

// StateInfo は状態1つ。Assigned が false の状態は「どの代入の遷移先にも
// なっていない」= 消し忘れ・初期値専用・またはスキャナが追えない経路
// （関数ポインタ等）でのみ使われる状態。
type StateInfo struct {
	Name     string `json:"name"`
	Value    string `json:"value,omitempty"` // 10進。決められないときは空
	Assigned bool   `json:"assigned"`
	Observed bool   `json:"observed"` // 遷移（From/To）のどこかに現れた
}

// StateMachine は1変数分の解析結果。
type StateMachine struct {
	Var         string            `json:"var"`
	Transitions []StateTransition `json:"transitions"`
	States      []StateInfo       `json:"states"`
	// Family は States の出どころ。"enum" = enum 定義の全メンバー、
	// "prefix" = 共通接頭辞で集めた #define 群、"observed" = 遷移に
	// 現れた名前だけ（全体集合を特定できなかった）
	Family string `json:"family"`
}

// 状態数の上限。接頭辞が短すぎて無関係の定数群を巻き込んだときの
// 暴走を止める。
const stateUniverseCap = 48

// ヘルパ展開の上限。参照検索はヘルパ1つごとに走るので数を絞る。
const (
	stateHelperCap      = 8
	stateHelperFileCap  = 100
	stateHelperRefLimit = 300
)

// AnalyzeStateMachine は files から varName の状態機械を組み立てる。
// dir/glob は状態名の定義解決（enum の特定・式の値計算）の検索範囲。
func AnalyzeStateMachine(ctx context.Context, files []string, varName, dir, glob string) StateMachine {
	trs := ScanStateTransitions(files, varName)
	trs = append(trs, expandHelperCalls(ctx, trs, varName, dir)...)

	observed := map[string]bool{}
	assigned := map[string]bool{}
	for _, tr := range trs {
		if tr.To != "" {
			observed[tr.To] = true
			assigned[tr.To] = true
		}
		for _, f := range tr.From {
			observed[f] = true
		}
	}

	states, family := stateSet(ctx, observed, dir, glob, files)
	for i := range states {
		states[i].Assigned = assigned[states[i].Name]
		states[i].Observed = observed[states[i].Name]
	}
	// 値が分かるものは値順（宣言順に近い）、決められないものは名前順で後ろへ
	sort.SliceStable(states, func(a, b int) bool {
		va, ea := strconv.ParseInt(states[a].Value, 10, 64)
		vb, eb := strconv.ParseInt(states[b].Value, 10, 64)
		if ea == nil && eb == nil {
			return va < vb
		}
		if ea == nil {
			return true
		}
		if eb == nil {
			return false
		}
		return states[a].Name < states[b].Name
	})

	return StateMachine{Var: varName, Transitions: trs, States: states, Family: family}
}

// expandHelperCalls は「右辺が自関数の仮引数」な代入（tcp_set_state 型の
// ヘルパ）を見つけ、その呼び出し箇所のうち定数を渡しているものを遷移として
// 復元する。呼び出し箇所は代入と同じフレーム機構を通るので、case/if の
// 遷移元文脈も付く。追うのは1段だけ: 呼び出し側も変数を渡している場合は
// 復元しない（それ以上は誤答側に倒れる）。
func expandHelperCalls(ctx context.Context, trs []StateTransition, varName, dir string) []StateTransition {
	// ヘルパ検出: ToExpr が単一識別子で、所属関数の仮引数に一致する代入
	var helpers []helperSpec
	seenHelper := map[string]bool{}
	for _, tr := range trs {
		if tr.To != "" || tr.Func == "" || !reIdentOnly.MatchString(tr.ToExpr) {
			continue
		}
		if seenHelper[tr.Func] || len(helpers) >= stateHelperCap {
			continue
		}
		if idx := paramIndex(tr.File, tr.Func, tr.ToExpr); idx >= 0 {
			seenHelper[tr.Func] = true
			helpers = append(helpers, helperSpec{name: tr.Func, argIndex: idx})
		}
	}
	if len(helpers) == 0 {
		return nil
	}

	// 呼び出し箇所のあるファイルを集める。状態変数が出ないファイルからも
	// 呼ばれうるので、走査済みの files に限定しない
	fileSet := map[string]bool{}
	for _, h := range helpers {
		refs, _, _, err := FindReferences(ctx, h.name, dir, stateHelperRefLimit, false, "")
		if err != nil {
			continue
		}
		for _, r := range refs {
			fileSet[r.File] = true
		}
	}
	files := make([]string, 0, len(fileSet))
	for f := range fileSet {
		files = append(files, f)
		if len(files) >= stateHelperFileCap {
			break
		}
	}
	sort.Strings(files)

	existing := map[string]bool{}
	for _, tr := range trs {
		existing[tr.File+":"+strconv.Itoa(tr.Line)] = true
	}

	var out []StateTransition
	for _, tr := range scanStateFiles(files, varName, helpers) {
		if tr.Via == "" {
			// 直接代入は走査済みファイルなら二重、未走査ファイルなら
			// 対象範囲の外から来たものなので、どちらも加えない
			continue
		}
		// ヘルパ自身の中の再帰的な呼び出しは定義側の話なので除く
		if seenHelper[tr.Func] {
			continue
		}
		key := tr.File + ":" + strconv.Itoa(tr.Line)
		if existing[key] {
			continue
		}
		existing[key] = true
		out = append(out, tr)
	}
	return out
}

var reIdentOnly = regexp.MustCompile(`^[A-Za-z_]\w*$`)

// paramIndex は file 内の関数 funcName の仮引数リストから name の位置を返す
// （見つからなければ -1）。シグネチャは関数の開始行から括弧が閉じるまでを読む。
func paramIndex(file, funcName, name string) int {
	lines, err := CachedLines(file)
	if err != nil {
		return -1
	}
	syms, _ := ExtractSymbols(file)
	start := -1
	for _, s := range syms {
		if s.Name == funcName {
			start = s.StartLine
			break
		}
	}
	if start < 1 {
		return -1
	}
	// 開始行から '(' 〜 対応する ')' までを連結
	var sb strings.Builder
	bal, seen := 0, false
	for i := start - 1; i < len(lines) && i < start+9; i++ {
		for _, c := range lines[i] {
			if c == '(' {
				bal++
				seen = true
			} else if c == ')' {
				bal--
			}
			if seen {
				sb.WriteRune(c)
			}
			if seen && bal == 0 {
				goto done
			}
		}
		sb.WriteByte(' ')
	}
done:
	params := sb.String()
	for i := 0; ; i++ {
		p := nthArg(params, i)
		if p == "" {
			return -1
		}
		// 仮引数の名前は宣言の末尾の識別子（"struct sock *sk" → sk）
		ids := regexp.MustCompile(`[A-Za-z_]\w*`).FindAllString(p, -1)
		if len(ids) > 0 && ids[len(ids)-1] == name {
			return i
		}
	}
}

// stateSet は状態の全体集合（名前と値）を推定する。
//  1. 遷移に現れた名前のどれかが enum メンバーなら、その enum の全メンバー
//  2. でなければ、共通接頭辞（'_' 区切り）を持つ #define を files から収集
//  3. どちらも成立しなければ、現れた名前だけ（値は個別解決）
func stateSet(ctx context.Context, observed map[string]bool, dir, glob string, files []string) ([]StateInfo, string) {
	names := make([]string, 0, len(observed))
	for n := range observed {
		names = append(names, n)
	}
	sort.Strings(names)

	for _, name := range names {
		var hits []DefHit
		if GtagsAvailable(dir) {
			hits, _ = GtagsFindDefinitions(ctx, name, dir)
		}
		if len(hits) == 0 {
			hits, _ = FindDefinitionsN(ctx, name, dir, glob, 5)
		}
		for _, h := range hits {
			if h.Kind != "enum_member" {
				continue
			}
			lines, err := CachedLines(h.File)
			if err != nil {
				continue
			}
			if members := enumBlockStates(lines, h.Line); len(members) >= 2 {
				return capStates(members), "enum"
			}
		}
	}

	if prefix := statePrefix(names); prefix != "" {
		members := prefixDefineStates(ctx, files, prefix, dir, glob)
		if len(members) > len(names) && plausibleStateSet(members, len(names)) {
			return capStates(members), "prefix"
		}
	}

	// 全体集合は不明。現れた名前だけ、値は既存の解決口で
	values := EvalMacroValues(ctx, names, dir, glob)
	out := make([]StateInfo, 0, len(names))
	for _, n := range names {
		out = append(out, StateInfo{Name: n, Value: values[n]})
	}
	return out, "observed"
}

// plausibleStateSet は接頭辞で集めた #define 群が「相互排他な状態の集合」
// らしいかを判定する。TCP_ のような短く一般的な接頭辞は無関係な定数
// （バッファサイズ・アルゴリズム係数）を大量に巻き込むので、その混入を弾く。
// シグナルは2つ:
//   - 値の重複が多い: 状態は普通ユニークな値を持つ。同じ値の #define が
//     並ぶのはビットフラグや係数群で、状態集合ではない
//   - 観測された状態に対して集合が大きすぎる: デッドステートが観測状態の
//     数倍もあるのは不自然（共通接頭辞が広すぎるサイン）
func plausibleStateSet(members []StateInfo, observedCount int) bool {
	if len(members) > observedCount*3+4 {
		return false
	}
	valued, seen := 0, map[string]bool{}
	dup := 0
	for _, m := range members {
		if m.Value == "" {
			continue
		}
		valued++
		if seen[m.Value] {
			dup++
		}
		seen[m.Value] = true
	}
	if valued >= 4 && dup*3 > valued {
		return false
	}
	return true
}

func capStates(states []StateInfo) []StateInfo {
	if len(states) > stateUniverseCap {
		return states[:stateUniverseCap]
	}
	return states
}

// enumBlockStates は memberLine を含む enum ブロックの全メンバーを、
// その場で計算した値付きで返す。ブロック内に #if があっても名前は
// 両分岐から集める（全体集合の用途では漏らさない方が価値がある）。
// 値の計算 (enumMemberValue) は #if 混在なら個別に諦めるので、
// 誤った値が付くことはない。
func enumBlockStates(lines []string, memberLine int) []StateInfo {
	start := findContainingBlockStart(lines, memberLine) - 1 // 0-indexed
	if start < 0 {
		return nil
	}
	// 開きブロックが本当に enum か検証する。findContainingBlockStart は
	// 直近の { を返すだけなので、関数本体や struct の { を掴んでいることがある
	// （索引無しで別の場所の同名メンバーに当たったとき顕著）。開き行、または
	// その直前の非空行に enum キーワードが無ければ enum ではない。
	opener := strings.TrimSpace(stripLineComment(lines[start]))
	if !strings.Contains(opener, "enum") {
		prev := start - 1
		for prev >= 0 && strings.TrimSpace(lines[prev]) == "" {
			prev--
		}
		if prev < 0 || !strings.Contains(stripLineComment(lines[prev]), "enum") {
			return nil
		}
	}
	var out []StateInfo
	addMember := func(part string, lineNo int) {
		part = strings.TrimSpace(part)
		if part == "" {
			return
		}
		if m := reEnumValueLine.FindStringSubmatch(part + ","); m != nil {
			si := StateInfo{Name: m[1]}
			if v, ok := enumMemberValue(lines, lineNo); ok {
				si.Value = strconv.FormatInt(v, 10)
			}
			out = append(out, si)
		}
	}
	opened := false
	for i := start; i < len(lines) && i < start+500; i++ {
		t := strings.TrimSpace(stripLineComment(lines[i]))
		if !opened {
			idx := strings.Index(t, "{")
			if idx < 0 {
				continue
			}
			opened = true
			t = strings.TrimSpace(t[idx+1:])
		}
		if strings.HasPrefix(t, "#") {
			continue
		}
		closed := false
		if idx := strings.IndexByte(t, '}'); idx >= 0 {
			t = strings.TrimSpace(t[:idx])
			closed = true
		}
		for _, part := range strings.Split(t, ",") {
			addMember(part, i+1)
		}
		if closed {
			return out
		}
	}
	return out
}

// statePrefix は状態名の共通接頭辞を '_' 区切りで返す（無ければ空）。
func statePrefix(names []string) string {
	if len(names) < 2 {
		return ""
	}
	prefix := names[0]
	for _, n := range names[1:] {
		for prefix != "" && !strings.HasPrefix(n, prefix) {
			prefix = prefix[:len(prefix)-1]
		}
	}
	idx := strings.LastIndexByte(prefix, '_')
	if idx < 0 {
		return ""
	}
	prefix = prefix[:idx+1]
	if len(prefix) < 3 {
		return ""
	}
	return prefix
}

// prefixDefineStates は files の中から #define <prefix>… を集め、
// その行の置換部から値を計算して返す。式が他のマクロを参照する場合の
// 解決は1つの resolver を共有する（検索回数の上限も共有される）。
func prefixDefineStates(ctx context.Context, files []string, prefix, dir, glob string) []StateInfo {
	re := regexp.MustCompile(`^\s*#\s*define\s+(` + regexp.QuoteMeta(prefix) + `\w+)([\s(].*)?$`)
	resolve := newDefineResolver(ctx, dir, glob, evalMaxLookups)
	seen := map[string]bool{}
	var out []StateInfo
	for _, f := range files {
		lines, err := CachedLines(f)
		if err != nil {
			continue
		}
		for i, line := range lines {
			m := re.FindStringSubmatch(line)
			if m == nil || seen[m[1]] {
				continue
			}
			if strings.HasPrefix(strings.TrimSpace(m[2]), "(") && strings.Index(line, m[1]+"(") > 0 {
				continue // 関数形式マクロは状態定数ではない
			}
			seen[m[1]] = true
			si := StateInfo{Name: m[1]}
			body := extractDefineBlock(lines, i+1)
			if body == "" {
				body = line
			}
			if expr, ok := defineReplacement(body, m[1]); ok {
				if v, ok2 := evalDefineExpr(expr, resolve); ok2 {
					si.Value = strconv.FormatInt(v, 10)
				}
			}
			out = append(out, si)
		}
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Name < out[b].Name })
	return out
}
