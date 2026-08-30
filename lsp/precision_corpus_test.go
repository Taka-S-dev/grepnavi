package lsp

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"grepnavi/search"
)

// 実物のツリーで F12 の当たり率と応答時間を測り、記録した基準値を下回ったら落とす。
//
//	GREPNAVI_CORPUS=C:\path\to\openssl-1.1.1q go test ./lsp/ -run Precision -v
//	GREPNAVI_PRECISION_WRITE=1 ...   基準値 testdata/precision-<ツリー名>.json を書き直す
//
// 手書きのテストは「思いついた形」しか守れず、corpus_test の不変条件は「嘘をつかない」
// ことしか見ない。ここは「どれだけ当たるか」を数字にする: 直したつもりの変更が
// 別の場所を落としていないか、数字で言えるようにするため。
//
// 標本は走査順の先頭 precisionFiles 本から、関数呼び出し `name(` とメンバ参照
// `->name` / `.name` をファイルごとに一定数ずつ取る（同じ名前は 1 回）。
// 着地の判定は着地行の字面で行う:
//   - 関数: 1 件でその名前の定義行（`T name(` で `;` で終わらない、または #define）
//   - メンバ呼び出し `p->name(`: 1 件で `(*name)` の宣言行なら設計どおり
//   - メンバ: 1 件でその名前を含み関数定義ではない行
//
// 索引に無い名前（libc・マクロ生成名）の 0 件は「外れ」ではなく unindexed に数える。
func TestCorpusPrecision(t *testing.T) {
	root := os.Getenv("GREPNAVI_CORPUS")
	if root == "" {
		t.Skip("GREPNAVI_CORPUS 未設定")
	}
	const precisionFiles = 40
	const callsPerFile, membersPerFile = 10, 5

	s := &server{root: root}
	init, _ := json.Marshal(map[string]string{"rootUri": pathToURI(root)})
	s.handleInitialize(init)
	defer search.SetExcludes("", nil)
	time.Sleep(2 * time.Second) // 定義表のプリロードとサイドカーの読み込みを待つ（初回だけ遅い）

	var files []string
	filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() && strings.HasSuffix(p, ".c") && len(files) < precisionFiles {
			files = append(files, p)
		}
		return nil
	})

	reCall := regexp.MustCompile(`\b([A-Za-z_]\w*)\s*\(`)
	reMember := regexp.MustCompile(`(?:->|\.)([A-Za-z_]\w*)\b`)
	ctx := context.Background()
	calls := newTally("function-f12")
	members := newTally("member-f12")
	seenCall, seenMember := map[string]bool{}, map[string]bool{}
	for _, f := range files {
		content, ok := s.documentText(pathToURI(f))
		if !ok {
			continue
		}
		uri := pathToURI(f)
		lines := strings.Split(content, "\n")
		masked := maskNonCode(lines)
		nCalls, nMembers := 0, 0
		for i, l := range masked {
			if strings.HasPrefix(strings.TrimSpace(l), "#") {
				continue
			}
			for _, m := range reCall.FindAllStringSubmatchIndex(l, -1) {
				if nCalls >= callsPerFile {
					break
				}
				name := l[m[2]:m[3]]
				if cKeywords[name] || seenCall[name] || isDefinitionLine(l, name) {
					continue
				}
				seenCall[name] = true
				nCalls++
				isMemberCall := memberAccessBefore(l, m[2])
				t0 := time.Now()
				res, _ := s.handleDefinition(ctx, posParams(uri, i, utf16Len(l[:m[2]])))
				calls.add(classifyCall(root, name, res.([]location), isMemberCall), time.Since(t0), name)
			}
			for _, m := range reMember.FindAllStringSubmatchIndex(l, -1) {
				if nMembers >= membersPerFile {
					break
				}
				name := l[m[2]:m[3]]
				if seenMember[name] || (m[3] < len(l) && strings.HasPrefix(strings.TrimSpace(l[m[3]:]), "(")) {
					continue
				}
				seenMember[name] = true
				nMembers++
				t0 := time.Now()
				res, _ := s.handleDefinition(ctx, posParams(uri, i, utf16Len(l[:m[2]])))
				members.add(classifyMember(root, name, res.([]location)), time.Since(t0), name)
			}
		}
	}

	got := precisionReport{Files: len(files), Calls: calls.summary(), Members: members.summary()}
	t.Logf("files=%d\n%s\n%s", len(files), calls, members)

	basePath := filepath.Join("testdata", "precision-"+filepath.Base(root)+".json")
	if os.Getenv("GREPNAVI_PRECISION_WRITE") != "" {
		os.MkdirAll("testdata", 0o755)
		b, _ := json.MarshalIndent(got, "", "  ")
		if err := os.WriteFile(basePath, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s", basePath)
		return
	}
	b, err := os.ReadFile(basePath)
	if err != nil {
		t.Skipf("基準値 %s が無い（GREPNAVI_PRECISION_WRITE=1 で作る）", basePath)
	}
	var base precisionReport
	if err := json.Unmarshal(b, &base); err != nil {
		t.Fatal(err)
	}
	// 当たり率は基準から 2 ポイント以上落ちたら失敗。時間は環境で変わるので記録だけ
	for _, c := range []struct {
		name      string
		got, base tallySummary
	}{{"function-f12", got.Calls, base.Calls}, {"member-f12", got.Members, base.Members}} {
		if c.got.HitRate < c.base.HitRate-2 {
			t.Errorf("%s: hit rate %.1f%% < baseline %.1f%% - 2", c.name, c.got.HitRate, c.base.HitRate)
		}
		if c.got.WrongRate > c.base.WrongRate+2 {
			t.Errorf("%s: wrong rate %.1f%% > baseline %.1f%% + 2", c.name, c.got.WrongRate, c.base.WrongRate)
		}
	}
}

// 結果の分類。hit は使い手がそのまま読み進められる答え、ambiguous は候補から選ぶ答え、
// wrong は違う場所へ飛ぶ答え、miss は索引にあるのに 0 件、unindexed は索引に無い名前の 0 件。
const (
	outcomeHit       = "hit"
	outcomeAmbiguous = "ambiguous"
	outcomeWrong     = "wrong"
	outcomeMiss      = "miss"
	outcomeUnindexed = "unindexed"
)

func classifyCall(root, name string, locs []location, memberCall bool) string {
	if len(locs) == 0 {
		if hits, _ := search.CtagsFindDefinitions(name, root); len(hits) == 0 {
			return outcomeUnindexed
		}
		return outcomeMiss
	}
	defs := 0
	for _, loc := range locs {
		text := landingLine(loc)
		if isDefinitionLine(text, name) || (memberCall && isMemberDeclarationLine(text, name)) {
			defs++
		}
	}
	switch {
	case len(locs) == 1 && defs == 1:
		return outcomeHit
	case defs > 0:
		return outcomeAmbiguous
	}
	return outcomeWrong
}

func classifyMember(root, name string, locs []location) string {
	if len(locs) == 0 {
		if hits, _ := search.CtagsFindDefinitions(name, root); len(hits) == 0 {
			return outcomeUnindexed
		}
		return outcomeMiss
	}
	ok := 0
	for _, loc := range locs {
		if text := landingLine(loc); isMemberDeclarationLine(text, name) && !isDefinitionLine(text, name) {
			ok++
		}
	}
	switch {
	case len(locs) == 1 && ok == 1:
		return outcomeHit
	case ok > 0:
		return outcomeAmbiguous
	}
	return outcomeWrong
}

func landingLine(loc location) string {
	lines, err := search.CachedLines(uriToPath(loc.URI))
	if err != nil || loc.Range.Start.Line >= len(lines) {
		return ""
	}
	return strings.TrimSpace(lines[loc.Range.Start.Line])
}

// isDefinitionLine は text が name の関数定義（または #define）の行かを字面で見る。
func isDefinitionLine(text, name string) bool {
	if regexp.MustCompile(`^\s*#\s*define\s+` + regexp.QuoteMeta(name) + `\b`).MatchString(text) {
		return true
	}
	// カーネルの流儀では戻り値の型が前の行にあり、定義行が `name(` で始まる
	return regexp.MustCompile(`^\s*(?:static\s+|extern\s+|inline\s+)*(?:[A-Za-z_][\w\s\*]*\b)?`+regexp.QuoteMeta(name)+`\s*\(`).MatchString(text) &&
		!strings.HasSuffix(strings.TrimSpace(text), ";") &&
		// `int (*name)(...)` は関数ポインタの宣言。引数に関数ポインタを取る定義
		// `int f(int (*cb)(int))` は定義のまま
		!regexp.MustCompile(`\(\s*\*\s*`+regexp.QuoteMeta(name)+`\s*\)`).MatchString(text)
}

// isMemberDeclarationLine は text が name というメンバの宣言行かを字面で見る
// （`int name;` `T *name;` `int (*name)(...)` `name,`）。
func isMemberDeclarationLine(text, name string) bool {
	q := regexp.QuoteMeta(name)
	return regexp.MustCompile(`\(\s*\*\s*`+q+`\s*\)|\b`+q+`\s*(?:\[[^\]]*\]\s*)*[;,:=]|\b`+q+`\s*$`).MatchString(text)
}

// tally は分類ごとの件数と応答時間。
type tally struct {
	name     string
	counts   map[string]int
	examples map[string][]string
	times    []time.Duration
}

func newTally(name string) *tally {
	return &tally{name: name, counts: map[string]int{}, examples: map[string][]string{}}
}

func (a *tally) add(outcome string, d time.Duration, sym string) {
	a.counts[outcome]++
	a.times = append(a.times, d)
	if len(a.examples[outcome]) < 5 {
		a.examples[outcome] = append(a.examples[outcome], sym)
	}
}

type tallySummary struct {
	Samples   int            `json:"samples"`
	Counts    map[string]int `json:"counts"`
	HitRate   float64        `json:"hit_rate_percent"`   // hit / (samples - unindexed)
	WrongRate float64        `json:"wrong_rate_percent"` // wrong / (samples - unindexed)
	P50ms     float64        `json:"p50_ms"`
	P95ms     float64        `json:"p95_ms"`
}

func (a *tally) summary() tallySummary {
	n := len(a.times)
	judged := n - a.counts[outcomeUnindexed]
	rate := func(k string) float64 {
		if judged == 0 {
			return 0
		}
		return 100 * float64(a.counts[k]) / float64(judged)
	}
	sorted := append([]time.Duration(nil), a.times...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	pct := func(p float64) float64 {
		if n == 0 {
			return 0
		}
		return float64(sorted[int(float64(n-1)*p)]) / float64(time.Millisecond)
	}
	round := func(x float64) float64 { return math.Round(x*10) / 10 }
	return tallySummary{Samples: n, Counts: a.counts, HitRate: round(rate(outcomeHit)), WrongRate: round(rate(outcomeWrong)), P50ms: round(pct(0.5)), P95ms: round(pct(0.95))}
}

func (a *tally) String() string {
	sm := a.summary()
	var b strings.Builder
	fmt.Fprintf(&b, "%s: %d samples, hit %.1f%%, wrong %.1f%%, p50 %.0fms, p95 %.0fms\n", a.name, sm.Samples, sm.HitRate, sm.WrongRate, sm.P50ms, sm.P95ms)
	for _, k := range []string{outcomeHit, outcomeAmbiguous, outcomeWrong, outcomeMiss, outcomeUnindexed} {
		if a.counts[k] > 0 {
			fmt.Fprintf(&b, "  %-9s %4d  e.g. %s\n", k, a.counts[k], strings.Join(a.examples[k], ", "))
		}
	}
	return b.String()
}

type precisionReport struct {
	Files   int          `json:"files"`
	Calls   tallySummary `json:"function_f12"`
	Members tallySummary `json:"member_f12"`
}
