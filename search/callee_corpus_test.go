package search

import (
	"context"
	"math/rand"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// 呼び先の取りこぼしは、手で書いた形では出なかった。openssl の padlock_ciphers は
// 直前にマクロ呼び出しが 17 行並んでいるだけで 0 件になり、linux のドライバは
// 戻り値型を前の行に置く書き方だけで定義が見つからなかった。どちらも実物の
// ツリーを当てて初めて出た。ここでは実物に対して 2 つを測る:
//
//  1. 走査器: 関数本体にある `識別子(` のうち、FindCallees が返さないものの割合
//  2. 展開経路: 名前から定義を探し（FindHover）、同じファイルの実装に辿り着く割合
//
//	GREPNAVI_CORPUS=C:\path\to\some-c-tree go test ./search/ -run Corpus -v

var reCorpusGnuDef = regexp.MustCompile(`^([A-Za-z_]\w*)\s*\(`)
var reCorpusDef = regexp.MustCompile(`^(?:(?:static|inline|__init|__exit|const|struct|unsigned|signed|noinline|__always_inline)\s+)*[A-Za-z_]\w*(?:\s*\*+\s*|\s+)([A-Za-z_]\w*)\s*\(`)
var reCorpusCall = regexp.MustCompile(`\b([A-Za-z_]\w*)\s*\(`)

type corpusFunc struct {
	file string
	line int // 名前のある行（1 始まり）
	name string
	refs map[string]bool
}

// corpusFuncs は root 配下の .c から関数定義を素朴に拾う。走査器とは別の
// 単純な規則（列 0 の `{` から列 0 の `}` まで）で本体を決めるので、走査器が
// 本体をどう切り出すかの検証になる。
func corpusFuncs(t *testing.T, root string, max int) []corpusFunc {
	t.Helper()
	var files []string
	filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		if d.IsDir() && (d.Name() == ".git" || (p != root && strings.Contains(strings.ToLower(d.Name()), "test"))) {
			return filepath.SkipDir
		}
		if !d.IsDir() && strings.HasSuffix(p, ".c") && !strings.Contains(strings.ToLower(rel), "test") {
			files = append(files, p)
		}
		return nil
	})
	sort.Strings(files)
	rng := rand.New(rand.NewSource(11))
	rng.Shuffle(len(files), func(i, j int) { files[i], files[j] = files[j], files[i] })

	var out []corpusFunc
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		lines := codeOnlyLines(strings.Split(string(raw), "\n"))
		for i, l := range lines {
			m := reCorpusGnuDef.FindStringSubmatch(l)
			gnu := m != nil
			if m == nil {
				m = reCorpusDef.FindStringSubmatch(l)
			}
			if m == nil || ctKeywords[m[1]] || strings.ToUpper(m[1]) == m[1] || strings.HasSuffix(strings.TrimSpace(l), ";") {
				continue
			}
			if gnu {
				if i == 0 {
					continue
				}
				prev := strings.TrimRight(lines[i-1], " \t")
				if prev == "" || strings.HasSuffix(prev, ";") || strings.HasSuffix(prev, "}") || strings.HasSuffix(prev, ")") || strings.HasSuffix(prev, "\\") {
					continue
				}
			}
			open := -1
			for j := i; j < len(lines) && j < i+4; j++ {
				if strings.HasPrefix(lines[j], "{") {
					open = j
					break
				}
			}
			if open < 0 {
				continue
			}
			refs := map[string]bool{}
			for k := open; k < len(lines); k++ {
				for _, c := range reCorpusCall.FindAllStringSubmatch(lines[k], -1) {
					if !ctKeywords[c[1]] && c[1] != m[1] {
						refs[c[1]] = true
					}
				}
				if strings.HasPrefix(lines[k], "}") {
					break
				}
			}
			if len(refs) > 0 {
				out = append(out, corpusFunc{file: f, line: i + 1, name: m[1], refs: refs})
			}
		}
		if len(out) >= max*3 {
			break
		}
	}
	rng.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	if len(out) > max {
		out = out[:max]
	}
	return out
}

// TestCorpusCalleeRecall は走査器の取りこぼし率に上限を課す。
// 参照集合は本体の `識別子(` 全部で、関数ポインタの宣言 `int (*cmp)(…)` の型名
// なども含む（走査器はこれを正しく落とす）ので 100% にはならないが、落ちるのは
// その種類だけのはずで、1% を超えたら形を見落としている。
func TestCorpusCalleeRecall(t *testing.T) {
	root := os.Getenv("GREPNAVI_CORPUS")
	if root == "" {
		t.Skip("GREPNAVI_CORPUS 未設定")
	}
	runCalleeRecall(t, root, 200, 0.01)
}

// TestFixtureCalleeRecall は実物で見つかった形を集めた小さなツリー
// (testdata/callee_corpus) に対して常時走る。実物のツリーは手元にしか無いので、
// 壊した形を CI でも踏めるように、落ちた形をそのまま持ち帰って置いてある。
// 見本は全部拾えるはずなので、取りこぼしも 0 件の関数も許さない。
func TestFixtureCalleeRecall(t *testing.T) {
	runCalleeRecall(t, filepath.Join("testdata", "callee_corpus"), 1000, 0)
}

func runCalleeRecall(t *testing.T, root string, n int, allowMissFrac float64) {
	t.Helper()
	funcs := corpusFuncs(t, root, n)
	if len(funcs) < 10 {
		t.Fatalf("関数定義が少なすぎる: %d", len(funcs))
	}
	refs, found := 0, 0
	var empty []string
	missing := map[string][]string{}
	for _, fn := range funcs {
		hits, _, _, err := FindCallees(context.Background(), fn.file, fn.line, "")
		if err != nil {
			t.Fatalf("%s:%d: %v", fn.file, fn.line, err)
		}
		got := map[string]bool{}
		for _, h := range hits {
			got[h.Name] = true
		}
		if len(got) == 0 {
			empty = append(empty, fn.file+":"+strconv.Itoa(fn.line)+" "+fn.name)
		}
		for r := range fn.refs {
			refs++
			if got[r] {
				found++
			} else {
				missing[r] = append(missing[r], fn.file+":"+strconv.Itoa(fn.line))
			}
		}
	}
	t.Logf("関数 %d / 参照 %d / 見つかった %d (%.1f%%)", len(funcs), refs, found, 100*float64(found)/float64(refs))
	for _, e := range empty {
		t.Errorf("本体に呼び出しがあるのに 0 件: %s", e)
	}
	if float64(refs-found) > allowMissFrac*float64(refs) {
		for name, where := range missing {
			t.Logf("落ちた %s: %v", name, where[:min(3, len(where))])
		}
		t.Errorf("取りこぼし %d/%d が上限 %.0f%% を超えた", refs-found, refs, 100*allowMissFrac)
	}
}

// TestCorpusCalleeExpansion はコールツリーの展開と同じ経路を測る: 名前から
// FindHover で定義を探し、標本と同じファイルの実装（decl でない func）に
// 辿り着けるか。呼び出し元ファイルを添える（同名の static を選り分けるため）。
// 同名の関数が別ファイルにもある名前（main など）は、標本のファイルが先頭に
// 来ることまで求める。
func TestCorpusCalleeExpansion(t *testing.T) {
	root := os.Getenv("GREPNAVI_CORPUS")
	if root == "" {
		t.Skip("GREPNAVI_CORPUS 未設定")
	}
	runCalleeExpansion(t, root, 60)
}

// TestFixtureCalleeExpansion は見本のツリーで展開経路を常時確かめる。
// 同名の static が 3 か所・同じ名前の定義が 8 ファイル・戻り値型が前の行・
// 関数ポインタの表に 6 回並ぶ名前、のどれも呼び出し元と同じファイルの実装に
// 辿り着かなければならない。
func TestFixtureCalleeExpansion(t *testing.T) {
	requireRg(t)
	root, err := filepath.Abs(filepath.Join("testdata", "callee_corpus"))
	if err != nil {
		t.Fatal(err)
	}
	runCalleeExpansion(t, root, 1000)
}

func runCalleeExpansion(t *testing.T, root string, n int) {
	t.Helper()
	funcs := corpusFuncs(t, root, n)
	if len(funcs) < 10 {
		t.Fatalf("関数定義が少なすぎる: %d", len(funcs))
	}
	ok := 0
	for _, fn := range funcs {
		hits, _, err := FindHover(context.Background(), fn.name, root, "*.c,*.h,*.cpp,*.hpp,*.cc", root, HoverScope{File: fn.file})
		if err != nil {
			t.Fatalf("%s: %v", fn.name, err)
		}
		var def *HoverHit
		for i := range hits {
			if hits[i].Kind == "func" && !hits[i].Decl {
				def = &hits[i]
				break
			}
		}
		switch {
		case def == nil:
			t.Errorf("%s (%s:%d): 定義が見つからない (%d 件)", fn.name, fn.file, fn.line, len(hits))
		case filepath.Clean(def.File) != filepath.Clean(fn.file):
			t.Errorf("%s (%s:%d): 別ファイルの定義 %s:%d が先に来た", fn.name, fn.file, fn.line, def.File, def.Line)
		default:
			ok++
		}
	}
	t.Logf("展開 %d/%d", ok, len(funcs))
}
