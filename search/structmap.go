package search

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"grepnavi/proc"
)

// 参照マップ。gtags の索引から「どこが、どこの実装を参照しているか」を
// モジュール単位に畳んで返す。
//
// ジャンプマップは訪問の足跡なので、行っていない場所は永遠に空白のままで、
// 並び順にも意味を持たせられない。ここは索引の事実だけを数えるので、
// 1度も開いていないツリーでも全域が最初から見える。
//
// 数えるのは「参照している (シンボル, 参照元ファイル) の組」で、出現行数では
// ない。同じファイルが同じ関数を10行で呼んでも1と数える。境界の太さとしては
// 行数より安定し、索引のダンプから行番号を復元する必要もなくなる。

// StructEdge は境界をまたぐ参照のひとまとまり。
type StructEdge struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Count int    `json:"count"` // またいでいる (シンボル, 参照元ファイル) の組数
	// Symbols は見本（多い順・上限 structEdgeSymbolsMax）。エッジの中身へ
	// 飛ぶ足がかりで、全列挙の欄ではない
	Symbols []string `json:"symbols,omitempty"`
	// SymsCapped は見本が打ち切られたこと。シンボル名で絞り込むとき、この行は
	// 見本の範囲でしか判定できない（一致するのに落ちる可能性がある）
	SymsCapped bool `json:"syms_capped,omitempty"`
}

// StructOmitted は集計から外れたものの数。黙って落とさず、外れた事実を返す。
type StructOmitted struct {
	// SameName は同名の実装が複数あり、どれを指すか索引だけでは決められない
	// ので外したシンボル数。推測で片方に寄せると偽のエッジができる
	SameName int `json:"same_name"`
	// SameNameRefs はそれによって地図に出ていない参照の数。シンボル数だけでは
	// 地図全体のどれくらいが欠けているかが分からない
	SameNameRefs int `json:"same_name_refs"`
	// StaticRefs は static 定義を名前一致で指していた他ファイルからの参照。
	// C の規則の上でありえない結び付きなので落としている
	StaticRefs int `json:"static_refs"`
	// HeaderRefs はヘッダに現れた名前。プロトタイプ宣言が大半で、実装を
	// 使っている側ではないので数えていない
	HeaderRefs int `json:"header_refs"`
}

// StructOverview は全域を第 depth 階層で畳んだ地図。
type StructOverview struct {
	Edges   []StructEdge  `json:"edges"`
	Omitted StructOmitted `json:"omitted"`
}

// StructFocus は1モジュールの周辺だけを詳細にした眺め。
// 関心の外のモジュール同士のエッジは含めない（描かない、ではなく返さない）。
type StructFocus struct {
	Module   string        `json:"module"`
	Internal []StructEdge  `json:"internal"` // モジュール内のファイル間
	Incoming []StructEdge  `json:"incoming"` // 外 → 中のどのファイルに刺さるか
	Outgoing []StructEdge  `json:"outgoing"` // 中 → 外の何に頼るか
	Omitted  StructOmitted `json:"omitted"`

	// 公開面の狭さ。「モジュールかどうか」は入れ子なので判定できないが、
	// 外からの参照が中の少数に集中しているという事実は測れる。判断は見る側に残す。
	// 小さいまとまりでも公開面が狭ければ「1つの単位」として扱う根拠になる
	Files     int `json:"files"`      // 実装ファイル数
	FilesOpen int `json:"files_open"` // うち外から参照されるもの
	Syms      int `json:"syms"`       // 実装で定義されるシンボル数（同名除外後）
	SymsOpen  int `json:"syms_open"`  // うち外から参照されるもの
}

// structEdgeSymbolsMax は1つのエッジに添える見本シンボルの数。
const structEdgeSymbolsMax = 8

// structTables は dump を1回読んで作る基礎表。集計はこの上で行う。
//
// 参照を1件ずつ持たず、読みながら「ファイル対」に畳む。linux の GRTAGS は
// 850 万件あり、1件ずつ抱えるとメモリが保たない。表示は全て（全域の畳み込みも
// フォーカスも）ファイル対からの再集計で作れるので、粒度はここが下限でよい。
type structTables struct {
	// implFiles は実装(.c 系)に定義があるファイル。シンボル → ファイルの表は
	// 構築中しか要らない（linux では 100 万件になる）ので、畳んだ後は捨てる
	implFiles    []string
	sameName     int
	sameNameRefs int
	staticRefs   int
	headerRefs   int
	edges        map[structPair]*structFileEdge
}

type structPair struct{ src, def string }

type structFileEdge struct {
	count int
	// syms は見本。全数は持たない（エッジ数 × シンボル数はメモリに載らない）。
	// 出現順の先頭数件で、頻度順ではない
	syms []string
}

var structCache struct {
	sync.Mutex
	root    string
	mtime   time.Time // GTAGS の mtime。変わったら作り直す
	exclSeq string    // 除外設定の指紋。設定変更でも作り直す
	tables  *structTables
}

// StructMapOverview は root 全域を畳んだ参照マップを返す。
// depth > 0 なら一律にその階層で畳む。depth == 0 は自動: シェアの大きい塊から
// 重い子を1つずつ取り出して同格に並べる（モジュール境界の深さが揃っていない
// ツリーで、drivers のような巨大な塊の中身が地図に出てくるように）。
func StructMapOverview(ctx context.Context, root string, depth int) (*StructOverview, error) {
	t, err := structTablesFor(ctx, root)
	if err != nil {
		return nil, err
	}
	if depth == 0 {
		return overviewAuto(t), nil
	}
	return overviewFrom(t, depth), nil
}

const (
	// 全体のこの割合を超える塊は、中の重い部分を取り出して同格に並べる。
	// 意味を推測して境界を引くのではなく、重さだけで機械的に割る（規則は
	// UI にも表示する）
	structSplitShare = 0.15
	structMaxGroups  = 40
)

func (t *structTables) omitted() StructOmitted {
	return StructOmitted{
		SameName: t.sameName, SameNameRefs: t.sameNameRefs,
		StaticRefs: t.staticRefs, HeaderRefs: t.headerRefs,
	}
}

func overviewAuto(t *structTables) *StructOverview {
	groups := adaptiveGroups(t, structSplitShare, structMaxGroups)
	lookup := memoGroupLookup(groups)
	agg := map[[2]string]*structEdgeAcc{}
	for p, e := range t.edges {
		from := lookup(p.src)
		to := lookup(p.def)
		if from == to {
			continue
		}
		accumulate(agg, from, to, e)
	}
	return &StructOverview{Edges: finish(agg), Omitted: t.omitted()}
}

// groupLookup は「最長一致するグループ」を返す関数を作る。
// 親グループと取り出された子グループが同居するので、深い方が勝つ。
func groupLookup(groups map[string]bool) func(string) string {
	return func(rel string) string {
		segs := strings.Split(rel, "/")
		for d := len(segs); d >= 1; d-- {
			p := strings.Join(segs[:d], "/")
			if groups[p] {
				return p
			}
		}
		return structGroup(rel, 1)
	}
}

// memoGroupLookup は同じパスの解決を使い回す版。
func memoGroupLookup(groups map[string]bool) func(string) string {
	base := groupLookup(groups)
	memo := make(map[string]string, 1<<16)
	return func(rel string) string {
		if g, ok := memo[rel]; ok {
			return g
		}
		g := base(rel)
		memo[rel] = g
		return g
	}
}

// fileWeights はファイルごとの重み（そのファイルが端点になっている参照の数）。
// 畳み方の探索はこの表の上で行う。エッジを毎回走査すると linux では
// 66 万件 × 数十回になり、全体図に 26 秒かかっていた（実測）。実ファイルは
// 9 万件程度なので、先にファイル単位へ落としてから探索する。
func fileWeights(t *structTables) map[string]int {
	w := make(map[string]int, 1<<17)
	for p, e := range t.edges {
		w[p.src] += e.count
		w[p.def] += e.count
	}
	return w
}

// adaptiveGroups は第1階層から始め、シェアが share を超えるグループから
// いちばん重い子を1つ取り出す、を上限まで繰り返す。取り出された後の親は
// 「残り」を表すグループとして残る。
func adaptiveGroups(t *structTables, share float64, max int) map[string]bool {
	weights := fileWeights(t)
	groups := map[string]bool{}
	total := 0
	for f, n := range weights {
		groups[structGroup(f, 1)] = true
		total += n
	}
	if total == 0 {
		return groups
	}
	nosplit := map[string]bool{}
	for len(groups) < max {
		lookup := memoGroupLookup(groups)
		w := map[string]int{}
		for f, n := range weights {
			w[lookup(f)] += n
		}
		// しきい値を超える最重のグループ（決定的にするため同重は名前順）
		thr := int(share * float64(total))
		best, bestW := "", 0
		for g, n := range w {
			if nosplit[g] || n <= thr {
				continue
			}
			if n > bestW || (n == bestW && (best == "" || g < best)) {
				best, bestW = g, n
			}
		}
		if best == "" {
			break
		}
		// best の中でいちばん重い子（1段深いまとまり）を取り出す
		d := len(strings.Split(best, "/"))
		cw := map[string]int{}
		for f, n := range weights {
			if lookup(f) != best {
				continue
			}
			if c := structGroup(f, d+1); c != best {
				cw[c] += n
			}
		}
		child, childW := "", -1
		for c, n := range cw {
			if n > childW || (n == childW && c < child) {
				child, childW = c, n
			}
		}
		if child == "" {
			nosplit[best] = true // ファイル単体などこれ以上割れない
			continue
		}
		groups[child] = true
	}
	return groups
}

func overviewFrom(t *structTables, depth int) *StructOverview {
	if depth < 1 {
		depth = 1
	}
	agg := map[[2]string]*structEdgeAcc{}
	for p, e := range t.edges {
		from := structGroup(p.src, depth)
		to := structGroup(p.def, depth)
		if from == to {
			continue
		}
		accumulate(agg, from, to, e)
	}
	return &StructOverview{Edges: finish(agg), Omitted: t.omitted()}
}

// StructBrief はエージェント向けに畳んだ形。
//
// UI 用の応答は openssl 全域で 47 KB あり、そのまま渡しても読まれずに終わる
// （このプロジェクトでは実測済み: 19.3 KB の参照一覧はエージェントに捨てられ、
// 素の grep に戻られた）。エッジを1本の文字列にし、上位だけに絞ると 1 KB を切る。
type StructBrief struct {
	Root string `json:"root"`
	// Edges は "from>to:件数" の羅列。構造を掴むのに要るのは向きと太さだけで、
	// 見本シンボルはこの段階では要らない（要るなら focus を呼ぶ）
	Edges []string `json:"edges"`
	Total int      `json:"total_edges"`
	Shown int      `json:"shown_edges"`
	// Omitted は同名で集計から外れた分。地図に無いことと存在しないことは違う
	Omitted StructOmitted `json:"omitted"`
}

// BriefEdges は上位 top 本を "from>to:件数" に畳む（top<=0 で既定値）。
func BriefEdges(edges []StructEdge, top int) []string {
	if top <= 0 {
		top = structBriefTop
	}
	if len(edges) > top {
		edges = edges[:top]
	}
	out := make([]string, 0, len(edges))
	for _, e := range edges {
		out = append(out, fmt.Sprintf("%s>%s:%d", e.From, e.To, e.Count))
	}
	return out
}

// structBriefTop は既定の本数。openssl 全域で約 1 KB に収まる。
const structBriefTop = 40

// StructMapFocus は module（ディレクトリまたはルート直下のファイル）の
// 周辺だけを返す。外側の相手は module と同じ深さで畳む。
func StructMapFocus(ctx context.Context, root, module string) (*StructFocus, error) {
	t, err := structTablesFor(ctx, root)
	if err != nil {
		return nil, err
	}
	return focusFrom(t, module), nil
}

func focusFrom(t *structTables, module string) *StructFocus {
	module = strings.Trim(filepath.ToSlash(module), "/")
	depth := len(strings.Split(module, "/"))
	inMod := func(rel string) bool {
		return rel == module || strings.HasPrefix(rel, module+"/")
	}

	// モジュールの中身は「1段だけ深く」畳む。crypto のような 80 サブディレクトリの
	// モジュールでいきなりファイル粒度まで落とすと、内部エッジが数百本の洪水になる
	// （平坦なモジュールでは depth+1 = ファイルなので、これまでどおりファイルが出る）。
	// もう1段はクリックで降りる。
	inside := func(rel string) string { return structGroup(rel, depth+1) }

	internal := map[[2]string]*structEdgeAcc{}
	incoming := map[[2]string]*structEdgeAcc{}
	outgoing := map[[2]string]*structEdgeAcc{}
	openFiles := map[string]bool{}
	for p, e := range t.edges {
		sin, din := inMod(p.src), inMod(p.def)
		switch {
		case sin && din:
			if a, b := inside(p.src), inside(p.def); a != b {
				accumulate(internal, a, b, e)
			}
		case din:
			// 入口はモジュール内の「どこに刺さるか」を1段深くまで見せる。
			// 外から刺さる先の偏りが、そのモジュールの公開面をそのまま表す
			accumulate(incoming, structGroup(p.src, depth), inside(p.def), e)
			openFiles[p.def] = true
		case sin:
			accumulate(outgoing, module, structGroup(p.def, depth), e)
		}
	}
	files := 0
	for _, f := range t.implFiles {
		if inMod(f) {
			files++
		}
	}
	return &StructFocus{
		Module:    module,
		Internal:  finish(internal),
		Incoming:  finish(incoming),
		Outgoing:  finish(outgoing),
		Omitted:   t.omitted(),
		Files:     files,
		FilesOpen: len(openFiles),
	}
}

type structEdgeAcc struct {
	count  int
	capped bool // 見本を打ち切った（シンボル名での絞り込みが取りこぼしうる）
	syms  []string
}

func accumulate(agg map[[2]string]*structEdgeAcc, from, to string, e *structFileEdge) {
	k := [2]string{from, to}
	a := agg[k]
	if a == nil {
		a = &structEdgeAcc{}
		agg[k] = a
	}
	a.count += e.count
	// ファイル対のエッジでは count が「別々のシンボルの数」に等しい
	// （GRTAGS は (シンボル, ファイル) ごとに1レコード）。見本より多ければ
	// 元の時点で切れている
	if len(e.syms) < e.count {
		a.capped = true
	}
	for _, s := range e.syms {
		if len(a.syms) >= structEdgeSymbolsMax {
			a.capped = true
			break
		}
		if !slices.Contains(a.syms, s) {
			a.syms = append(a.syms, s)
		}
	}
}

func finish(agg map[[2]string]*structEdgeAcc) []StructEdge {
	out := make([]StructEdge, 0, len(agg))
	for k, a := range agg {
		// 見本は名前順（頻度は持っていない。全数を保持しないため）
		syms := append([]string(nil), a.syms...)
		sort.Strings(syms)
		out = append(out, StructEdge{From: k[0], To: k[1], Count: a.count, Symbols: syms, SymsCapped: a.capped})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		if out[i].From != out[j].From {
			return out[i].From < out[j].From
		}
		return out[i].To < out[j].To
	})
	return out
}

// structGroup は root 相対パスを第 depth 階層の見出しに畳む。
// ルート直下のファイルは自分自身が見出しになる（ssl_err.c のような
// 置き場のないファイルを「ルート」に混ぜると、そこが偽のハブになる）。
// StructChild は1階層下のまとまり1件。地図の行が被参照順で 40 個に絞られ、
// 重さで分割もされるのに対し、こちらは「そこに何があるか」を漏れなく出す
// 移動用の一覧。名前さえ分かればどこへでも飛べるようにするのが目的なので、
// 件数で打ち切らない。
type StructChild struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	IsFile   bool   `json:"is_file"`
	Files    int    `json:"files"`    // 配下の実装ファイル数
	Incoming int    `json:"incoming"` // そのまとまりの外から刺さる参照数
}

// StructChildren は parent の直下のまとまりを返す (parent="" ならツリー最上位)。
// 地図と同じ表から数えるので、実装定義を持たないディレクトリ (ヘッダだけの
// include/ など) は出てこない — 参照マップはそもそも実装の参照を集めた地図で、
// そこへ移動しても空の面しか出せない。
func StructChildren(ctx context.Context, root, parent string) ([]StructChild, error) {
	t, err := structTablesFor(ctx, root)
	if err != nil {
		return nil, err
	}
	return childrenFrom(t, parent), nil
}

func childrenFrom(t *structTables, parent string) []StructChild {
	parent = strings.Trim(filepath.ToSlash(parent), "/")
	depth := 1
	if parent != "" {
		depth = len(strings.Split(parent, "/")) + 1
	}
	under := func(rel, dir string) bool {
		return dir == "" || rel == dir || strings.HasPrefix(rel, dir+"/")
	}
	// 直下の名前。parent の外は "" を返す。
	childOf := func(rel string) string {
		if !under(rel, parent) {
			return ""
		}
		return structGroup(rel, depth)
	}

	idx := map[string]*StructChild{}
	get := func(p string) *StructChild {
		c := idx[p]
		if c == nil {
			name := p
			if i := strings.LastIndex(p, "/"); i >= 0 {
				name = p[i+1:]
			}
			c = &StructChild{Path: p, Name: name}
			idx[p] = c
		}
		return c
	}

	for _, f := range t.implFiles {
		c := childOf(f)
		if c == "" {
			continue
		}
		e := get(c)
		e.Files++
		// structGroup は「これ以上畳めない」とき rel をそのまま返す。
		// 直下に置かれたファイルはこれに当たる。
		if c == f {
			e.IsFile = true
		}
	}
	for p, e := range t.edges {
		c := childOf(p.def)
		if c == "" || under(p.src, c) {
			continue // 自分の中からの参照は「外から」ではない
		}
		get(c).Incoming += e.count
	}

	out := make([]StructChild, 0, len(idx))
	for _, c := range idx {
		out = append(out, *c)
	}
	// 地図本体と同じく被参照の多い順。同数はパスで安定させる。
	sort.Slice(out, func(i, j int) bool {
		if out[i].Incoming != out[j].Incoming {
			return out[i].Incoming > out[j].Incoming
		}
		return out[i].Path < out[j].Path
	})
	return out
}

func structGroup(rel string, depth int) string {
	segs := strings.Split(rel, "/")
	if len(segs)-1 < depth {
		return rel
	}
	return strings.Join(segs[:depth], "/")
}

// ErrRefMapNotBuilt は表がまだ作られていないことを表す。
// 呼び出し側はこれを見て「生成しますか」を出す（勝手に数十秒使わない）。
var ErrRefMapNotBuilt = errors.New("reference map not built")

// RefMapStatus は参照マップの状態。UI が「作りますか」を出すための材料。
type RefMapStatus struct {
	Indexed   bool  `json:"indexed"`             // gtags 索引があるか
	Built     bool  `json:"built"`               // 使える表があるか
	Stale     bool  `json:"stale"`               // 表はあるが索引が更新されている
	IndexMB   int64 `json:"index_mb"`            // 索引の大きさ
	EstimateS int   `json:"estimate_seconds"`    // 生成にかかる見込み
}

// RefMapStat は参照マップの状態を返す。
func RefMapStat(root string) RefMapStatus {
	st := RefMapStatus{}
	fi, err := os.Stat(filepath.Join(root, "GTAGS"))
	if err != nil {
		return st
	}
	st.Indexed = true
	var total int64 = fi.Size()
	if rfi, err := os.Stat(filepath.Join(root, "GRTAGS")); err == nil {
		total += rfi.Size()
	}
	st.IndexMB = total >> 20
	// 実測2点（openssl 索引 16MB で 1 秒 / linux 1511MB で 67 秒）から
	// 1MB あたり 45ms として概算する。桁を伝えるための数字で、精密さは要らない
	st.EstimateS = int(st.IndexMB*45/1000) + 1
	if _, ok := loadRefMapCache(root, fi.ModTime(), fi.Size(), excludeFingerprint()); ok {
		st.Built = true
		return st
	}
	// ヘッダが合わないだけで表そのものはある = 索引が更新された
	if _, err := os.Stat(refMapCachePath(root)); err == nil {
		st.Stale = true
	}
	return st
}

func excludeFingerprint() string { return strings.Join(Excludes(), "\n") }

// structTablesFor は基礎表を返す。無ければ作らずに ErrRefMapNotBuilt を返す。
// 索引のダンプは linux で 67 秒かかるので、要求されていない生成は始めない。
func structTablesFor(ctx context.Context, root string) (*structTables, error) {
	return refMapTables(ctx, root, false)
}

// BuildRefMap は基礎表を作って保存する。progress には進捗の行が渡る。
func BuildRefMap(ctx context.Context, root string, progress func(string)) error {
	if progress != nil {
		refMapProgress.Store(&progress)
		defer refMapProgress.Store(nil)
	}
	_, err := refMapTables(ctx, root, true)
	return err
}

// refMapProgress は構築中の進捗の宛先。構築は同時に1つだけ（ロックで直列化）。
var refMapProgress atomic.Pointer[func(string)]

func refMapNote(format string, args ...any) {
	if fn := refMapProgress.Load(); fn != nil {
		(*fn)(fmt.Sprintf(format, args...))
	}
}

func refMapTables(ctx context.Context, root string, build bool) (*structTables, error) {
	fi, err := os.Stat(filepath.Join(root, "GTAGS"))
	if err != nil {
		return nil, fmt.Errorf("gtags index required: GTAGS not found under %s", root)
	}
	fp := excludeFingerprint()

	structCache.Lock()
	defer structCache.Unlock()
	if structCache.root == root && structCache.mtime.Equal(fi.ModTime()) &&
		structCache.exclSeq == fp && structCache.tables != nil {
		return structCache.tables, nil
	}
	t, ok := loadRefMapCache(root, fi.ModTime(), fi.Size(), fp)
	if !ok {
		if !build {
			return nil, ErrRefMapNotBuilt
		}
		if t, err = buildStructTables(ctx, root); err != nil {
			return nil, err
		}
		refMapNote("保存中...")
		saveRefMapCache(root, fi.ModTime(), fi.Size(), fp, t)
		refMapNote("完了: %d ファイル / %d 参照関係", len(t.implFiles), len(t.edges))
	}
	structCache.root, structCache.mtime, structCache.exclSeq, structCache.tables = root, fi.ModTime(), fp, t
	return t, nil
}

// InvalidateStructCache は索引の再生成後に呼ぶ。
func InvalidateStructCache() {
	structCache.Lock()
	structCache.root = ""
	structCache.tables = nil
	structCache.Unlock()
}

var reStructEntry = regexp.MustCompile(`^\s*(\S+)\t\s*(\d+)\s`)

func buildStructTables(ctx context.Context, root string) (*structTables, error) {
	// GPATH: ファイル番号 → root 相対パス
	refMapNote("ファイル一覧を読み込み中 (GPATH)...")
	id2path := map[string]string{}
	err := gtagsDump(ctx, root, "GPATH", func(l string) {
		p := strings.Split(l, "	")
		// データ行は `./path<TAB>番号`。メタ行（先頭スペース + __.）と
		// 逆引き行（`番号<TAB>./path`）はここで落ちる
		if len(p) < 2 || !strings.HasPrefix(p[0], "./") {
			return
		}
		id := strings.TrimSpace(p[1])
		if id == "" || strings.IndexFunc(id, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
			return
		}
		rel := strings.TrimPrefix(strings.TrimSpace(p[0]), "./")
		if IsExcluded(filepath.Join(root, filepath.FromSlash(rel))) {
			return // 除外したファイルは定義側にも参照側にも出さない
		}
		id2path[id] = rel
	})
	if err != nil {
		return nil, err
	}

	// GTAGS: 定義。実装(.c 系)にある1定義のシンボルだけを使う。
	// ヘッダの宣言やマクロまで定義に数えると「全員が公開ヘッダを見ている」
	// という当たり前がエッジを埋める（実測: 上位が全部 include 行きになった）
	refMapNote("定義を読み込み中 (GTAGS)... ファイル %d 件", len(id2path))
	t := &structTables{edges: map[structPair]*structFileEdge{}}
	defFile := map[string]string{}
	// 「見えている定義がすべて static」なシンボル。1つでも外から見える定義が
	// あれば false に落とす（先に見えたほうで決めると、読む順で結果が変わる）。
	// すべて static なら、定義していないファイルからの参照は C の規則の上で
	// ありえないので落とす（structDefKind 参照）。
	allStatic := map[string]bool{}
	dict := map[byte]string{}
	dup := map[string]bool{}
	// 同名の実装が複数あるシンボルの、定義ファイル一覧。参照元が自分でも
	// 定義しているなら、その参照はその定義を指す（C の規則。static は
	// ファイルの外から見えない）。推測ではないので使ってよい
	multi := map[string][]string{}
	err = gtagsDump(ctx, root, "GTAGS", func(l string) {
		if strings.HasPrefix(l, " __.COMPRESS") {
			dict = structCompress(l)
			return
		}
		sym, id, image, ok := structEntry(l)
		if !ok {
			return
		}
		f := id2path[id]
		if f == "" || !isImplFile(f) {
			return
		}
		isStatic, _ := structDefKind(image, dict)
		if v, seen := allStatic[sym]; !seen {
			allStatic[sym] = isStatic
		} else if v && !isStatic {
			allStatic[sym] = false
		}
		if prev, seen := defFile[sym]; seen {
			if prev != f {
				if !dup[sym] {
					dup[sym] = true
					t.sameName++
					multi[sym] = []string{prev}
				}
				multi[sym] = append(multi[sym], f)
			}
			return
		}
		defFile[sym] = f
	})
	if err != nil {
		return nil, err
	}
	for sym := range dup {
		delete(defFile, sym)
	}
	impl := map[string]bool{}
	for _, f := range defFile {
		impl[f] = true
	}
	for f := range impl {
		t.implFiles = append(t.implFiles, f)
	}
	sort.Strings(t.implFiles)

	refMapNote("参照を読み込み中 (GRTAGS)... 実装 %d ファイル", len(t.implFiles))
	// GRTAGS: 参照。読みながらファイル対へ畳む（1件ずつは保持しない）
	err = gtagsDump(ctx, root, "GRTAGS", func(l string) {
		sym, id, _, ok := structEntry(l)
		if !ok {
			return
		}
		src := id2path[id]
		if src == "" || !isSourceFile(src) {
			return
		}
		if !isImplFile(src) {
			// ヘッダに出てくる名前はプロトタイプ宣言が大半で、実装を使って
			// いるわけではない（実測: openssl でヘッダ発のエッジ 1105 本は
			// すべて、実装からの参照が1本も無い＝宣言だけで生まれた線）。
			// マクロ本体からの本物の呼び出しも混ざるが、それを使っているのは
			// マクロを展開した側であって、宣言しているヘッダではない。
			t.headerRefs++
			return
		}
		if allStatic[sym] && defFile[sym] != src && !slices.Contains(multi[sym], src) {
			// static はファイルの外から見えない。名前が一致しただけの他人。
			// 同名が複数あっても、全部 static なら同じことが言える。
			t.staticRefs++
			return
		}
		def := defFile[sym]
		if def == "" {
			fs := multi[sym]
			if fs == nil {
				return // ツリー外の定義（libc 等）。同名の問題ではない
			}
			if !slices.Contains(fs, src) {
				t.sameNameRefs++ // どの実装を指すか決められない参照
				return
			}
			def = src // 同じファイルの定義を指す
		}
		if src == def {
			// 自分自身への参照は、どの畳み方でも境界をまたがない。
			// 表に持つとエッジ数と保存が無駄に膨らむ
			return
		}
		k := structPair{src: src, def: def}
		e := t.edges[k]
		if e == nil {
			e = &structFileEdge{}
			t.edges[k] = e
		}
		e.count++
		if len(e.syms) < structEdgeSymbolsMax && !slices.Contains(e.syms, sym) {
			e.syms = append(e.syms, sym)
		}
	})
	if err != nil {
		return nil, err
	}
	return t, nil
}

// GTAGS の定義レコードは `シンボル<TAB>ファイル番号 @n 行番号 定義行のソース`
// という形で、定義行そのものが入っている。@n は定義中のシンボル名、@x は
// 圧縮辞書 (メタレコード __.COMPRESS) の語。ここを読めば、追加の入出力なしに
// 「static か」「関数か」が分かる。
var reStructDefImage = regexp.MustCompile(`^@n\s+\d+\s+(.*)$`)

// structCompress は __.COMPRESS メタレコードの辞書 (文字 → 語)。
// 実測した gtags 6 では define / typedef の2語だけだが、辞書は DB が持っている
// ものなので読んで使う。読まずに前方一致で "static" を見ると、辞書に static が
// 入った DB では判定が黙って 0 件になる。
func structCompress(line string) map[byte]string {
	fs := strings.Fields(line)
	dict := map[byte]string{}
	for _, f := range fs {
		if len(f) > 1 && !strings.HasPrefix(f, "__.") {
			dict[f[0]] = f[1:]
		}
	}
	return dict
}

func expandImage(img string, dict map[byte]string) string {
	if !strings.Contains(img, "@") {
		return img
	}
	var b strings.Builder
	for i := 0; i < len(img); i++ {
		if img[i] != '@' || i+1 >= len(img) {
			b.WriteByte(img[i])
			continue
		}
		c := img[i+1]
		if w, ok := dict[c]; ok {
			b.WriteString(w)
			i++
			continue
		}
		b.WriteByte(img[i])
	}
	return b.String()
}

// structDefKind は定義行のソースから、ファイル外から参照されうるか (static で
// ないか) と、関数かどうかを見る。
//
// static はそのファイルの外から参照できない (C のリンケージ規則)。にもかかわらず
// 他ファイルからの参照が名前一致で結び付くのは、gtags が名前だけで突き合わせて
// いるため — 他のファイルのローカル変数 `cnt` が `static int cnt;` への参照に
// 化ける。規則の上でありえない結び付きなので、推測ではなく落としてよい。
//
// 型と名前が別の行に書かれた定義 (static が前の行にある) は取りこぼす。
// 取りこぼしても偽のエッジが残るだけで、本物のエッジは消えない。
func structDefKind(image string, dict map[byte]string) (isStatic, isFunc bool) {
	m := reStructDefImage.FindStringSubmatch(image)
	if m == nil {
		return false, false
	}
	src := strings.TrimSpace(expandImage(m[1], dict))
	isStatic = strings.HasPrefix(src, "static ") || strings.HasPrefix(src, "static\t")
	// 定義行のシンボル直後が '(' なら関数。@n は定義中のシンボル名を指す。
	isFunc = strings.Contains(strings.ReplaceAll(src, " ", ""), "@n(")
	return isStatic, isFunc
}

// structEntry は1レコードを シンボル / ファイル番号 / 残り (行番号と、GTAGS なら
// 定義行のソース) に割る。
func structEntry(line string) (sym, id, image string, ok bool) {
	if strings.HasPrefix(line, " __.") {
		return "", "", "", false // メタレコード
	}
	m := reStructEntry.FindStringSubmatchIndex(line)
	if m == nil {
		return "", "", "", false
	}
	// m[1] は正規表現全体の終端。その先が行番号と（GTAGS なら）定義行のソース。
	return line[m[2]:m[3]], line[m[4]:m[5]], strings.TrimLeft(line[m[1]:], " \t"), true
}

func isImplFile(rel string) bool {
	switch strings.ToLower(filepath.Ext(rel)) {
	case ".c", ".cc", ".cpp", ".cxx":
		return true
	}
	return false
}

func isSourceFile(rel string) bool {
	switch strings.ToLower(filepath.Ext(rel)) {
	case ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx":
		return true
	}
	return false
}

// gtagsDump は gtags --dump <db> の出力を1行ずつ fn へ渡す。
//
// 出力を丸ごと受け取ってはいけない: linux の GRTAGS / GTAGS は 591MB / 920MB あり、
// 文字列として抱えるとメモリが保たない。パイプを流しながら畳む。
//
// ダンプ形式は gtags の内部表現で、公式に文書化された API ではない。形式が
// 変わって読めなくなったときに黙って空の地図を返さないよう、1行も無かった
// 場合はエラーにする（呼び出し側でテストが検出する）。
func gtagsDump(ctx context.Context, root, db string, fn func(string)) error {
	bin := resolveGtagsBin()
	cmd := proc.CommandContext(ctx, bin, "--dump", db)
	cmd.Dir = root
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("gtags --dump %s failed: %v", db, err)
	}
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 256*1024), 8*1024*1024) // 参照の多い語は1行が長い
	n := 0
	for sc.Scan() {
		n++
		fn(sc.Text())
	}
	scanErr := sc.Err()
	if err := cmd.Wait(); err != nil && scanErr == nil {
		return fmt.Errorf("gtags --dump %s failed: %v", db, err)
	}
	if scanErr != nil {
		return fmt.Errorf("gtags --dump %s: %v", db, scanErr)
	}
	if n < 2 {
		return fmt.Errorf("gtags --dump %s returned no records", db)
	}
	return nil
}
