package search

import (
	"regexp"
	"sort"
	"strings"

	"grepnavi/graph"
)

// 状態遷移スキャナ。状態変数（構造体メンバ名または変数名）への代入を集め、
// 代入を囲む case グループ / if 条件から遷移元状態を推定する。
// ビルドなしの字句解析なので方針は enum の値計算と同じ「間違った遷移を
// 見せるくらいなら遷移元不明として見せる」: 否定条件・default 混在・
// 複雑な式は推定せず From を空にする。
//
// cscope の代入クエリとの違いは、出現を返すだけでなく「どの状態からの
// 遷移か」の文脈まで読むこと。コメント・文字列は先に無害化する。

// StateTransition は状態変数への代入1件。
type StateTransition struct {
	From     []string `json:"from,omitempty"`      // 遷移元状態（空 = 不明）
	FromKind string   `json:"from_kind,omitempty"` // "case" / "if"
	To       string   `json:"to,omitempty"`        // 遷移先の定数名
	ToExpr   string   `json:"to_expr,omitempty"`   // 右辺が定数1個でないときの式（To と排他）
	File     string   `json:"file"`
	Line     int      `json:"line"`
	Func     string   `json:"func,omitempty"`
	// Via はヘルパ関数の呼び出しから復元した遷移の、そのヘルパ名。
	// 実際の代入はヘルパの中にあり、この行は定数を渡している呼び出し箇所
	Via string `json:"via,omitempty"`
	// FellThrough は From のうち、この case ではなく上の case から
	// フォールスルーして到達する状態。代入行だけ見ると別の case の中に
	// 見えるので、根拠（どこでその状態になったか）まで示さないと誤りに見える
	FellThrough []FallThroughSource `json:"fell_through,omitempty"`
	Ifdef       []graph.IfdefFrame  `json:"ifdef,omitempty"`
}

// FallThroughSource はフォールスルーで届いた遷移元1つ。SetLine はその状態に
// なった代入の行（case ラベルで入ったのではないので、行を示さないと
// 「この case にその状態のラベルは無い」と誤りに見える）。
type FallThroughSource struct {
	Name    string `json:"name"`
	SetLine int    `json:"set_line,omitempty"`
}

// helperSpec は「状態を仮引数で受け取って代入するヘルパ関数」。
// 呼び出し箇所の argIndex 番目の引数が定数なら遷移として復元する。
type helperSpec struct {
	name     string
	argIndex int
}

// ScanStateTransitions は files の各ファイルから varName への代入を集める。
// 読めないファイルは黙って飛ばす（部分的な結果の方が全滅より役に立つ）。
func ScanStateTransitions(files []string, varName string) []StateTransition {
	return scanStateFiles(files, varName, nil)
}

// scanStateFiles は helpers も含めてファイル群を走査する。
// 参照検索で絞ったファイルでも大半は「読むだけ」なので、代入も呼び出しも
// 無いファイルは行ごとの精密走査に入る前に安価な判定で捨てる。ツリー全体を
// 対象にすると、この足切りが有無で数倍の差になる。
func scanStateFiles(files []string, varName string, helpers []helperSpec) []StateTransition {
	return scanStateFilesWith(files, varName, helpers, nil)
}

// scanStateFilesWith は「定数と認めてよい名前か」の追加判定を受け取る。
// 既定は大文字始まりだけだが、コールバック欄に入るのは `psk_use_session_cb` の
// ような小文字の関数名なので、それを通すために呼び出し側が判定を足せる。
func scanStateFilesWith(files []string, varName string, helpers []helperSpec, alsoConst func(string) bool) []StateTransition {
	quick := quickRejectRe(varName, helpers)
	code := codeOnlyCache{}
	var out []StateTransition
	for _, f := range files {
		lines, err := CachedLines(f)
		if err != nil {
			continue
		}
		if !anyLineMatches(lines, quick) {
			continue
		}
		trs := scanStateLinesWith(lines, varName, helpers, alsoConst)
		if len(trs) == 0 {
			continue
		}
		hasIfdef := anyLineHasPrefix(lines, "#if")
		for i := range trs {
			trs[i].File = f
			// 囲む関数は呼び出し元一覧と同じ範囲表から引く。以前は別の抽出器を
			// 使っていて、引数リストが `#ifdef` や改行で割れた関数を置けず
			// （curl の multistate、openssl の SSL_CTX_set_..._callback）、
			// 関数名が空になっていた。空だとヘルパ検出が動かないので、
			// 「呼び出し側で何を渡しているか」まで復元できなくなる
			trs[i].Func, _ = code.containingFunc(f, lines, trs[i].Line)
			// ifdef スタック抽出はファイル全体を読み直すので、
			// そもそも条件コンパイルが無いファイルでは呼ばない
			if !hasIfdef {
				continue
			}
			if frames, err := ExtractIfdefStack(f, trs[i].Line); err == nil && len(frames) > 0 {
				trs[i].Ifdef = frames
			}
		}
		out = append(out, trs...)
	}
	sort.SliceStable(out, func(a, b int) bool {
		if out[a].File != out[b].File {
			return out[a].File < out[b].File
		}
		return out[a].Line < out[b].Line
	})
	return out
}

// quickRejectRe は「代入かヘルパ呼び出しがありうる行」にだけ当たる粗い正規表現。
// コメント内の記述にも当たるが、ここは足切り専用で、判定はこの後の精密走査が行う。
func quickRejectRe(varName string, helpers []helperSpec) *regexp.Regexp {
	alts := []string{`\b` + regexp.QuoteMeta(varName) + `\b\s*=[^=]`}
	for _, h := range helpers {
		alts = append(alts, `\b`+regexp.QuoteMeta(h.name)+`\s*\(`)
	}
	return regexp.MustCompile(strings.Join(alts, "|"))
}

func anyLineMatches(lines []string, re *regexp.Regexp) bool {
	for _, l := range lines {
		if re.MatchString(l) {
			return true
		}
	}
	return false
}

func anyLineHasPrefix(lines []string, prefix string) bool {
	for _, l := range lines {
		if strings.HasPrefix(strings.TrimSpace(l), prefix) {
			return true
		}
	}
	return false
}

// ===== コード視界（コメント・文字列・プリプロセッサ行の無害化）=====

// buildCodeView は各行のコメント・文字列/文字リテラルの中身・プリプロセッサ行を
// 空白に置き換えた同形の行列を返す。行数と桁位置が保存されるので、以降の
// 走査は「コードとして意味のある文字」だけを相手にできる。
// プリプロセッサ行を消すのは、#if の条件式や #define 本文を通常コードの
// 文脈（if 条件・代入）と誤認しないため。マクロ内の代入は1段データフローの
// 領域なので、ここでは対象外に倒す。
func buildCodeView(lines []string) []string {
	code := make([]string, len(lines))
	inComment := false
	inPreproc := false
	for i, line := range lines {
		b := []byte(strings.Repeat(" ", len(line)))
		if inPreproc {
			inPreproc = strings.HasSuffix(strings.TrimRight(line, " \t"), `\`)
			code[i] = string(b)
			continue
		}
		if !inComment && strings.HasPrefix(strings.TrimSpace(line), "#") {
			inPreproc = strings.HasSuffix(strings.TrimRight(line, " \t"), `\`)
			code[i] = string(b)
			continue
		}
		for j := 0; j < len(line); j++ {
			if inComment {
				if line[j] == '*' && j+1 < len(line) && line[j+1] == '/' {
					inComment = false
					j++
				}
				continue
			}
			switch {
			case line[j] == '/' && j+1 < len(line) && line[j+1] == '/':
				j = len(line)
			case line[j] == '/' && j+1 < len(line) && line[j+1] == '*':
				inComment = true
				j++
			case line[j] == '"' || line[j] == '\'':
				q := line[j]
				for j++; j < len(line); j++ {
					if line[j] == '\\' {
						j++
					} else if line[j] == q {
						break
					}
				}
			default:
				b[j] = line[j]
			}
		}
		code[i] = string(b)
	}
	return code
}

// ===== 走査 =====

// reStateConst は「状態を表す定数名」の形。大文字始まりであることだけを見る。
// 全部大文字に限ると linux の `TCP_CA_Open` `TCP_CA_Loss` が定数と認められず、
// net/ipv4 の遷移 11 件のうち 9 件が消えた（全部大文字なのは TCP_CA_CWR だけ）。
// 大文字始まりに緩めても、除きたいもの（`tcp_set_ca_state(sk, state)` の
// 変数渡し、仮引数の `int state`）は小文字始まりなので落ちたままになる。
var reStateConst = regexp.MustCompile(`^[A-Z][A-Za-z0-9_]*$`)

// flowState は「この位置で状態変数が取りうる値」。known=false は不明。
// case ラベルだけを遷移元にすると、同じ case の中で先に別の代入がある場合に
// 誤る（openssl: case CONNECT_RETRY の中で CONNECTING を代入した後の
// 代入は、遷移元が CONNECT_RETRY ではなく CONNECTING）。そのため代入・
// 分岐・合流を追って現在値を持ち回る。
type flowState struct {
	known bool
	set   []string
	kind  string // "case" / "assign" / "if"（表示用。合流で混ざったら空）
}

func flowUnknown() flowState { return flowState{} }

func flowOf(kind string, names ...string) flowState {
	return flowState{known: true, set: append([]string(nil), names...), kind: kind}
}

// flowUnion は分岐の合流。片方でも不明なら合流後も不明。
func flowUnion(a, b flowState) flowState {
	if !a.known || !b.known {
		return flowUnknown()
	}
	seen := map[string]bool{}
	var out []string
	for _, s := range append(append([]string(nil), a.set...), b.set...) {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	kind := a.kind
	if a.kind != b.kind {
		kind = ""
	}
	return flowState{known: true, set: out, kind: kind}
}

// braceFrame は { } 1段。entry はブロックに入る直前の状態で、
// ブロックが return 等で抜けるときは中の代入を外へ持ち出さない。
type braceFrame struct {
	depth     int
	entry     flowState
	isSwitch  bool
	isIf      bool // else が来たら entry まで戻すため
	onVar     bool
	groupOpen bool // case グループが継続中（break 等で閉じたら false）
	endsExit  bool // 直近の文が return/break/goto/continue
}

// pendingCtx は switch/if の条件を読み終えて、まだ { か文が来ていない状態。
type pendingCtx struct {
	isSwitch bool
	onVar    bool
	labels   []string  // if 条件から読めた遷移元（空 = 絞り込めない）
	entry    flowState // 条件を読む直前の状態（else 側はここへ戻る）
}

type stateEvent struct {
	pos, end int
	kind     string // "switch" "if" "else" "case" "assign" "call" "term" "open" "close" "semi"
	label    string
	helper   int // kind=="call" のとき helpers のインデックス
}

func scanStateLines(lines []string, varName string) []StateTransition {
	return scanStateLinesWith(lines, varName, nil, nil)
}

// scanStateLinesWith は通常の代入に加えて、helpers の呼び出しを
// 「引数渡しの擬似代入」として拾う。呼び出し箇所は代入と同じフレーム機構を
// 通るので、case/if の遷移元文脈がそのまま付く。定数以外を渡している
// 呼び出し（変数・関数定義や宣言の仮引数）は遷移にしない。
func scanStateLinesWith(lines []string, varName string, helpers []helperSpec, alsoConst func(string) bool) []StateTransition {
	isConst := func(t string) bool {
		return reStateConst.MatchString(t) || (alsoConst != nil && alsoConst(t))
	}
	code := buildCodeView(lines)
	v := regexp.QuoteMeta(varName)

	// 構造体メンバとして使われている名前なら、接頭辞のない裸の代入は
	// 同名のローカル変数（状態の退避 `saved = s->st;` など）とみなして無視する。
	// openssl は退避用ローカルに状態と同じ名前を付けており、これを遷移として
	// 数えると以降の遷移元まで狂う。メンバ形が一度も出ない場合は素の変数
	// として扱うので、グローバル変数の状態機械はそのまま解析できる。
	reMember := regexp.MustCompile(`(?:->|\.)\s*\b` + v + `\b`)
	pfx := `(?:(?:->|\.)\s*)?`
	if anyLineMatches(code, reMember) {
		pfx = `(?:->|\.)\s*`
	}

	reVar := regexp.MustCompile(pfx + `\b` + v + `\b`)
	reAssign := regexp.MustCompile(pfx + `\b` + v + `\b\s*=([^=]|$)`)
	reCase := regexp.MustCompile(`\bcase\s+([A-Za-z_]\w*)\s*:|\bdefault\s*:`)
	reSwitch := regexp.MustCompile(`\bswitch\s*\(`)
	reIf := regexp.MustCompile(`\bif\s*\(`)
	reElse := regexp.MustCompile(`\belse\b`)
	reTerm := regexp.MustCompile(`\b(break|return|goto|continue)\b`)
	// ヘルパ呼び出しの正規表現は行ごとに組み直すと走査全体を律速するので先に作る
	reCalls := make([]*regexp.Regexp, len(helpers))
	for i, h := range helpers {
		reCalls[i] = regexp.MustCompile(`\b` + regexp.QuoteMeta(h.name) + `\s*\(`)
	}
	reEq := regexp.MustCompile(pfx + `\b` + v + `\b\s*==\s*([A-Za-z_]\w*)`)
	// 否定は !st だけでなく !(s->st == X) のようにメンバアクセスを挟む形もある
	reNeq := regexp.MustCompile(`!\s*\(*\s*(?:\w+\s*(?:->|\.)\s*)*\b` + v + `\b|` + pfx + `\b` + v + `\b\s*!=`)

	depth := 0
	cur := flowUnknown() // 現在位置で状態変数が取りうる値
	var frames []braceFrame
	// pending は switch/if の条件を読み終えて、まだ { も文も来ていない状態。
	// { が来たらブロックとして確定、先に文が来たらその1文にだけ効く。
	var pending *pendingCtx
	// 直前に閉じた if に入る前の状態。else 側はここから始まる
	// （then 節での代入は else 節には効かない）
	elseEntry, elseValid := flowUnknown(), false
	// carried は「上の case から落ちてきて、この位置に届いている状態」。
	// 代入があれば消えるので、印が付くのはグループ最初の代入だけ
	var carried map[string]bool
	// originLine は各状態を最後に代入した行。フォールスルーで届いた状態が
	// どこで設定されたかを示すのに使う
	originLine := map[string]int{}
	var out []StateTransition
	// 複数行にまたがる条件式・右辺を読んだあと、読み終えた位置までの
	// イベントを読み飛ばすためのカーソル
	skipLine, skipCol := -1, -1

	top := func() *braceFrame {
		if len(frames) == 0 {
			return nil
		}
		return &frames[len(frames)-1]
	}
	// 直前の文が return 等だった印を、通常の文が来たら解除する
	clearExit := func() {
		if t := top(); t != nil {
			t.endsExit = false
		}
	}
	// 代入・ヘルパ呼び出しの共通処理: 現在値から辺を1本出し、現在値を更新する。
	// brace なし if の下にある文は条件付きなので、更新は合流（union）にする。
	record := func(lineNo int, fill func(*StateTransition)) {
		from := cur
		condGuarded := pending != nil && !pending.isSwitch
		if condGuarded && len(pending.labels) > 0 {
			from = flowOf("if", pending.labels...)
		}
		tr := StateTransition{Line: lineNo}
		if from.known {
			tr.From = append([]string(nil), from.set...)
			tr.FromKind = from.kind
			for _, n := range tr.From {
				if carried[n] {
					tr.FellThrough = append(tr.FellThrough,
						FallThroughSource{Name: n, SetLine: originLine[n]})
				}
			}
		}
		fill(&tr)
		out = append(out, tr)

		next := flowUnknown()
		if tr.To != "" {
			next = flowOf("assign", tr.To)
			originLine[tr.To] = lineNo
		}
		if condGuarded {
			cur = flowUnion(cur, next) // 実行されたとは限らない
		} else {
			cur = next
		}
		// 代入で状態が決まった後は、以降の遷移元はフォールスルー由来ではない
		carried = nil
		clearExit()
	}

	readCond := func(i, from int) (string, int, int) {
		bal := 0
		var sb strings.Builder
		for li := i; li < len(code) && li < i+8; li++ {
			s := code[li]
			start := 0
			if li == i {
				start = from
			}
			for ci := start; ci < len(s); ci++ {
				sb.WriteByte(s[ci])
				if s[ci] == '(' {
					bal++
				} else if s[ci] == ')' {
					bal--
					if bal == 0 {
						return sb.String(), li, ci + 1
					}
				}
			}
			sb.WriteByte(' ')
		}
		return sb.String(), i, len(code[i])
	}

	condLabels := func(cond string) []string {
		if reNeq.MatchString(cond) {
			return nil // 否定を含む条件から遷移元は言えない
		}
		var labels []string
		for _, m := range reEq.FindAllStringSubmatch(cond, -1) {
			labels = append(labels, m[1])
		}
		return labels
	}

	readRHS := func(i, from int) (string, int) {
		var sb strings.Builder
		for li := i; li < len(code) && li < i+5; li++ {
			s := code[li]
			start := 0
			if li == i {
				start = from
			}
			for ci := start; ci < len(s); ci++ {
				if s[ci] == ';' {
					return strings.TrimSpace(sb.String()), li
				}
				sb.WriteByte(s[ci])
			}
			sb.WriteByte(' ')
		}
		return strings.TrimSpace(sb.String()), i
	}

	for i := 0; i < len(code); i++ {
		line := code[i]
		var evs []stateEvent
		for _, m := range reSwitch.FindAllStringIndex(line, -1) {
			evs = append(evs, stateEvent{pos: m[0], end: m[1] - 1, kind: "switch"})
		}
		for _, m := range reIf.FindAllStringIndex(line, -1) {
			evs = append(evs, stateEvent{pos: m[0], end: m[1] - 1, kind: "if"})
		}
		for _, m := range reCase.FindAllStringSubmatchIndex(line, -1) {
			lbl := "default"
			if m[2] >= 0 {
				lbl = line[m[2]:m[3]]
			}
			evs = append(evs, stateEvent{pos: m[0], end: m[1], kind: "case", label: lbl})
		}
		for _, m := range reAssign.FindAllStringIndex(line, -1) {
			evs = append(evs, stateEvent{pos: m[0], end: m[1], kind: "assign"})
		}
		for hi, reCall := range reCalls {
			for _, m := range reCall.FindAllStringIndex(line, -1) {
				evs = append(evs, stateEvent{pos: m[0], end: m[1] - 1, kind: "call", helper: hi})
			}
		}
		for _, m := range reTerm.FindAllStringIndex(line, -1) {
			evs = append(evs, stateEvent{pos: m[0], end: m[1], kind: "term"})
		}
		for ci, c := range line {
			switch c {
			case '{':
				evs = append(evs, stateEvent{pos: ci, end: ci + 1, kind: "open"})
			case '}':
				evs = append(evs, stateEvent{pos: ci, end: ci + 1, kind: "close"})
			case ';':
				evs = append(evs, stateEvent{pos: ci, end: ci + 1, kind: "semi"})
			}
		}
		// else if でも else を出す。位置順に else → if と処理され、
		// 「if に入る前の状態へ戻してから条件で絞る」が正しく行われる
		for _, m := range reElse.FindAllStringIndex(line, -1) {
			evs = append(evs, stateEvent{pos: m[0], end: m[1], kind: "else"})
		}
		sort.SliceStable(evs, func(a, b int) bool { return evs[a].pos < evs[b].pos })

		for _, e := range evs {
			if i < skipLine || (i == skipLine && e.pos < skipCol) {
				continue
			}
			switch e.kind {
			case "open":
				depth++
				f := braceFrame{depth: depth, entry: cur}
				if pending != nil {
					if pending.isSwitch {
						f.isSwitch = true
						f.onVar = pending.onVar
					} else {
						f.isIf = true
						f.entry = pending.entry
						if len(pending.labels) > 0 {
							// 条件が成り立つ側のブロック: 状態は条件どおりに絞れる
							cur = flowOf("if", pending.labels...)
						}
					}
					pending = nil
				}
				frames = append(frames, f)
			case "close":
				depth--
				for len(frames) > 0 && frames[len(frames)-1].depth > depth {
					f := frames[len(frames)-1]
					frames = frames[:len(frames)-1]
					if f.endsExit {
						// return 等で抜けるブロックの代入は外へ流れない
						cur = f.entry
					} else {
						// ブロックを通った場合と通らなかった場合の両方がありうる
						cur = flowUnion(f.entry, cur)
					}
					if f.isIf {
						elseEntry, elseValid = f.entry, true
					}
				}
			case "semi":
				// brace なし if の効力は1文で終わり。else 側はこの if に
				// 入る前の状態から始まる
				if pending != nil && !pending.isSwitch {
					elseEntry, elseValid = pending.entry, true
				}
				pending = nil
			case "switch":
				cond, li, ci := readCond(i, e.end)
				pending = &pendingCtx{isSwitch: true, onVar: reVar.MatchString(cond)}
				if li > i || ci > e.pos {
					skipLine, skipCol = li, ci
				}
			case "if":
				cond, li, ci := readCond(i, e.end)
				pending = &pendingCtx{labels: condLabels(cond), entry: cur}
				if li > i || ci > e.pos {
					skipLine, skipCol = li, ci
				}
			case "else":
				// then 節を通らなかった側なので、if に入る前の状態へ戻す。
				// 条件の否定からは遷移元を絞れないので labels は付けない
				if elseValid {
					cur = elseEntry
					elseValid = false
				}
				pending = &pendingCtx{entry: cur}
			case "case":
				t := top()
				if t == nil || !t.isSwitch || t.depth != depth {
					break
				}
				t.endsExit = false
				if !t.onVar {
					// 別変数の switch でも case ラベルは合流点。制御は switch の
					// 頭から来るので、前の枝の代入はこの枝には届かない。
					// 持ち越すと兄弟の枝の代入が遷移元になる（openssl statem.c で
					// `switch (ret)` の default 枝が、上の枝が入れた
					// READ_STATE_POST_PROCESS を遷移元として引き継いでいた）。
					// break の無い枝からは落ちてくるので、その分だけ合流させる。
					if t.groupOpen {
						cur = flowUnion(cur, t.entry)
					} else {
						cur = t.entry
					}
					t.groupOpen = true
					break
				}
				if e.label == "default" {
					cur = flowUnknown() // その他すべて
					carried = nil
				} else if t.groupOpen {
					// フォールスルー: いま届いている状態はこの case のラベルでは
					// 到達できない（上の case から落ちてきた）ので印を残す
					carried = map[string]bool{}
					if cur.known {
						for _, n := range cur.set {
							carried[n] = true
						}
					}
					cur = flowUnion(cur, flowOf("case", e.label))
				} else {
					cur = flowOf("case", e.label)
					carried = nil
				}
				t.groupOpen = true
			case "term":
				// brace なし if に続く break/return は条件付き脱出。ここで
				// グループを閉じると次の case へのフォールスルーを見落とす
				if pending != nil && !pending.isSwitch {
					break
				}
				if t := top(); t != nil {
					t.endsExit = true
					if t.isSwitch && t.depth == depth {
						t.groupOpen = false
					}
				}
			case "assign":
				eq := strings.Index(line[e.pos:], "=")
				rhs, endLine := readRHS(i, e.pos+eq+1)
				record(i+1, func(tr *StateTransition) { classifyRHS(rhs, tr) })
				if endLine > i {
					skipLine, skipCol = endLine, 0
				}
			case "call":
				h := helpers[e.helper]
				args, li, ci := readCond(i, e.end)
				// 定数を渡している呼び出しだけが遷移。変数渡し・関数の定義や
				// 宣言の仮引数（"int state" 等）はここで自然に落ちる
				if arg := nthArg(args, h.argIndex); isConst(arg) {
					record(i+1, func(tr *StateTransition) { tr.To = arg; tr.Via = h.name })
				}
				if li > i || ci > e.pos {
					skipLine, skipCol = li, ci
				}
			}
		}
	}
	return out
}

// nthArg は "(a, f(x), C)" 形式の引数リストから idx 番目（0起点）を返す。
// カンマの分割は括弧の深さ0のものだけ。範囲外は空文字。
func nthArg(args string, idx int) string {
	t := strings.TrimSpace(args)
	if strings.HasPrefix(t, "(") && strings.HasSuffix(t, ")") {
		t = t[1 : len(t)-1]
	}
	depth, start, n := 0, 0, 0
	for i := 0; i <= len(t); i++ {
		if i == len(t) || (t[i] == ',' && depth == 0) {
			if n == idx {
				return strings.TrimSpace(t[start:i])
			}
			n++
			start = i + 1
			continue
		}
		switch t[i] {
		case '(', '[':
			depth++
		case ')', ']':
			depth--
		}
	}
	return ""
}

// classifyRHS は右辺を To / ToExpr に振り分ける。
// 大文字識別子1個 → 定数（enum 所属の厳密判定に置き換えるまでの近似）。
// 三項演算子や関数呼び出しは、誤った1本の辺にするより式のまま見せる。
func classifyRHS(rhs string, tr *StateTransition) {
	t := strings.TrimSpace(rhs)
	for strings.HasPrefix(t, "(") && strings.HasSuffix(t, ")") {
		inner := strings.TrimSpace(t[1 : len(t)-1])
		if !strings.ContainsAny(inner, "()") {
			t = inner
			continue
		}
		break
	}
	if reStateConst.MatchString(t) {
		tr.To = t
		return
	}
	tr.ToExpr = t
}
