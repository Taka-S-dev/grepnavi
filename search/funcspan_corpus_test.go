package search

import (
	"bufio"
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// 走査器はここまで3度、実物のコードでだけ壊れた。形を1つ見落とすと、その関数の
// 中にある参照が丸ごと呼び出し元一覧から消えるのに、手で書いたテストは全部通る。
// 手で思いつく形を並べるだけでは足りないので、以下の2段で守る。
//
//	1. どんな入力でも成り立つ不変条件（常時実行）
//	2. 実物のツリーを ctags と突き合わせ、取りこぼし率に上限を課す（任意実行）

// TestScanFuncSpansInvariants は入力に依らず成り立つ性質を確かめる。
// 範囲が重なる・順序が狂う・開始行に名前が無い、はどれも壊れている証拠になる。
func TestScanFuncSpansInvariants(t *testing.T) {
	sources := map[string][]string{
		"生成コード": benchCFile(12, 40),
	}
	for _, c := range styleCaseSources() {
		sources[c.name] = strings.Split(c.src, "\n")
	}
	for name, lines := range sources {
		spans := scanFuncSpans(codeOnlyLines(lines))
		prevEnd := 0
		for i, sp := range spans {
			if sp.Start < 1 || sp.End < sp.Start || sp.End > len(lines) {
				t.Errorf("%s: 範囲が壊れている %+v (全 %d 行)", name, sp, len(lines))
				continue
			}
			if sp.Start <= prevEnd {
				t.Errorf("%s: [%d] 前の範囲と重なる %+v (前の終わり %d)", name, i, sp, prevEnd)
			}
			prevEnd = sp.End
			// 開始行から数行のどこかに名前があるはず。無ければ別の場所を
			// 関数の頭だと思っている
			found := false
			for l := sp.Start; l <= sp.End && l < sp.Start+4; l++ {
				if strings.Contains(lines[l-1], sp.Name) {
					found = true
					break
				}
			}
			if !found {
				t.Errorf("%s: %q の開始行付近に名前が無い %+v | %s",
					name, sp.Name, sp, strings.TrimSpace(lines[sp.Start-1]))
			}
		}
	}
}

// TestCorpusAgainstCtags は実物の C ツリーを ctags と突き合わせる。
// ctags が「ここに関数がある」と言う行を、走査器も同じ関数だと答えるか。
//
// 走らせ方:
//
//	GREPNAVI_CORPUS=C:\path\to\some-c-tree go test ./search/ -run Corpus -v
//
// 手で書いたテストは思いついた形しか守れない。新しい形を見つけるのはこちら。
func TestCorpusAgainstCtags(t *testing.T) {
	root := os.Getenv("GREPNAVI_CORPUS")
	if root == "" {
		t.Skip("GREPNAVI_CORPUS 未設定")
	}
	if _, err := exec.LookPath("ctags"); err != nil {
		t.Skip("ctags なし")
	}
	// C++ も含める。C だけで測っていたあいだ、`namespace {` の直前に残った
	// マクロ呼び出しでファイル全体が偽の関数に飲まれるのを見逃していた
	cmd := exec.Command("ctags", "-x", "--c-kinds=f", "--c++-kinds=f",
		"--languages=C,C++", "-R", ".")
	cmd.Dir = root
	// Exuberant ctags は一時ファイルを作る。POSIX 風の TMPDIR を継承すると
	// Windows 版が開けずに落ちるので、この OS で使える場所を明示する
	tmp := os.TempDir()
	cmd.Env = append(os.Environ(), "TMPDIR="+tmp, "TMP="+tmp, "TEMP="+tmp)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil && out.Len() == 0 {
		t.Skipf("ctags 実行に失敗: %v %s", err, strings.TrimSpace(errb.String()))
	}

	type ent struct {
		name string
		line int
	}
	byFile := map[string][]ent{}
	sc := bufio.NewScanner(&out)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 4 || f[1] != "function" {
			continue
		}
		if ln, err := strconv.Atoi(f[2]); err == nil {
			byFile[f[3]] = append(byFile[f[3]], ent{f[0], ln})
		}
	}
	if len(byFile) == 0 {
		t.Skip("ctags が関数を1つも返さなかった")
	}

	files := make([]string, 0, len(byFile))
	for k := range byFile {
		files = append(files, k)
	}
	sort.Strings(files)

	total, miss := 0, 0
	var samples []string
	for _, rel := range files {
		lines, err := CachedLines(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			continue
		}
		spans := scanFuncSpans(codeOnlyLines(lines))
		for _, e := range byFile[rel] {
			total++
			if _, ok := enclosingSpan(spans, e.line); !ok {
				miss++
				if len(samples) < 20 {
					samples = append(samples, rel+":"+strconv.Itoa(e.line)+" "+e.name)
				}
			}
		}
	}
	for _, s := range samples {
		t.Log("  取りこぼし: " + s)
	}
	t.Logf("ctags の関数 %d 件 / 走査器が囲む関数を答えられない %d 件", total, miss)

	// 名前の食い違いは上限を課さない。openssl では 232 件のうち 227 件が
	// `STACK_OF(...) *f(...)` を ctags が `STACK_OF` と誤るもので、走査器の答えが正しい。
	//
	// 取りこぼしは走査器が答えられていない側。方言の違う4つのツリーで測った:
	//
	//	linux    751453 関数 / 58 件 (0.008%)
	//	postgres  26664 関数 /  3 件 (0.011%)
	//	openssl   10311 関数 /  2 件 (0.019%)
	//	curl       4990 関数 /  0 件
	//
	// 0.05% を超えたら新しい形が入ったということなので落とす。
	if total > 0 && miss*2000 > total {
		t.Errorf("取りこぼしが多すぎる: %d/%d (%.3f%%) — 上限 0.05%%",
			miss, total, float64(miss)*100/float64(total))
	}
}
