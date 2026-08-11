package search

import (
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// 除外はユーザーが宣言したものだけを使う。既定は空。
//
// 生成物らしいパスを推測して既定で落とすと、結果が理由なく消える。grepnavi は
// 他の場所ではそうしていない（遷移元が読めなければ `?`、ディレクトリが無ければ
// 理由、索引が古ければ警告）。何を対象にするかはツリーごとの事情で、外から
// 当てられるものではない。
//
// 構文は .gitignore に合わせる。書き方を覚え直させないためと、rg 自身が
// gitignore の実装を持っているため。検索は rg に `--ignore-file` で丸ごと
// 任せ、索引（gtags / ctags）が返したヒットだけをこちらの照合器で落とす。
// 二重実装になるので、両者が一致することは rg を正解とした差分テストで見る。
var (
	excludeMu    sync.RWMutex
	excludeRoot  string
	excludePats  []string
	excludeRules []excludeRule
	excludeFile  string // rg に渡すパターンファイル
	excludeSeq   int
)

// excludeRule は1行のパターン。
type excludeRule struct {
	neg      bool     // `!` 先頭。直前までの判定を打ち消す
	dirOnly  bool     // `/` 終わり。ディレクトリにだけ当たる
	anchored bool     // ルート起点に固定（先頭 `/` か、区切りを含む）
	segs     []string
}

// SetExcludes はプロジェクトの除外パターンを差し替える。root は相対パスを
// 組み立てる基準で、パターンはこの root からの相対パスに照合される。
func SetExcludes(root string, pats []string) {
	clean := make([]string, 0, len(pats))
	for _, p := range pats {
		if p = strings.TrimRight(strings.TrimLeft(p, " \t"), " \t"); p != "" {
			clean = append(clean, filepath.ToSlash(p))
		}
	}
	rules := make([]excludeRule, 0, len(clean))
	for _, p := range clean {
		if r, ok := parseExcludeRule(p); ok {
			rules = append(rules, r)
		}
	}

	excludeMu.Lock()
	old := excludeFile
	excludeRoot, excludePats, excludeRules = root, clean, rules
	excludeFile = writeExcludeFile(clean, &excludeSeq)
	excludeMu.Unlock()

	// 実行中の rg が掴んでいると Windows では消せない。放置しても一時ディレクトリ
	// ごと消えるので、失敗は無視してよい
	if old != "" {
		_ = os.Remove(old)
	}
}

// Excludes は現在の除外パターンを返す。
func Excludes() []string {
	excludeMu.RLock()
	defer excludeMu.RUnlock()
	return append([]string(nil), excludePats...)
}

// RgIgnoreArgs は rg に渡す除外指定を返す（除外が無ければ空）。
//
// glob (`--glob !p`) ではなくパターンファイルを使うのは、区切りを含む glob が
// 検索ルートではなく **カレントディレクトリ** 基準で照合されるため。常駐する
// grepnavi では当てにできず、実際 `ssl/html` は効かなかった。`--ignore-file` は
// gitignore の意味論そのままで、否定 (`!`) も「除外したディレクトリの中は
// 否定で戻せない」規則も rg 側が正しく扱う。
//
// 使うときは RgWorkDir() を cmd.Dir に入れること。パターンの基準が cwd なので、
// これを忘れると区切りを含むパターンが黙って効かなくなる。
func RgIgnoreArgs() []string {
	excludeMu.RLock()
	defer excludeMu.RUnlock()
	if excludeFile == "" {
		return nil
	}
	return []string{"--ignore-file", excludeFile}
}

// RgWorkDir は rg を起動すべきディレクトリ（除外パターンの基準）を返す。
func RgWorkDir() string {
	excludeMu.RLock()
	defer excludeMu.RUnlock()
	if excludeFile == "" {
		return ""
	}
	return excludeRoot
}

// IsExcluded はファイルが除外対象かを返す。
func IsExcluded(file string) bool { return isExcluded(file, false) }

// IsExcludedDir はディレクトリが除外対象かを返す。
// `doc/` のようにディレクトリだけを指すパターンがあるので、ファイルとは分ける。
func IsExcludedDir(dir string) bool { return isExcluded(dir, true) }

func isExcluded(p string, isDir bool) bool {
	excludeMu.RLock()
	root, rules := excludeRoot, excludeRules
	excludeMu.RUnlock()
	if len(rules) == 0 {
		return false
	}
	rel := filepath.ToSlash(p)
	if root != "" {
		if r, err := filepath.Rel(root, p); err == nil && !strings.HasPrefix(r, "..") {
			rel = filepath.ToSlash(r)
		}
	}
	segs := strings.Split(strings.Trim(rel, "/"), "/")

	// 親から順に見る。途中のディレクトリが除外されたらその配下は全部除外で、
	// 後ろの否定でも戻せない（gitignore と同じ）
	for i := 1; i <= len(segs); i++ {
		last := i == len(segs)
		if excludedAt(rules, segs[:i], !last || isDir) {
			return true
		}
	}
	return false
}

// excludedAt は1つのパス（segs）が除外されるかを、最後に当たった行で決める。
func excludedAt(rules []excludeRule, segs []string, isDir bool) bool {
	excluded := false
	for _, r := range rules {
		if r.dirOnly && !isDir {
			continue
		}
		if !matchRule(r, segs) {
			continue
		}
		excluded = !r.neg
	}
	return excluded
}

func matchRule(r excludeRule, segs []string) bool {
	if r.anchored {
		return matchSegs(r.segs, segs)
	}
	// 区切りを含まないパターンはどの階層にも当たる。呼び出し側が親から順に
	// 全ての階層を渡してくるので、ここでは末尾だけを見ればよい
	ok, _ := path.Match(r.segs[0], segs[len(segs)-1])
	return ok
}

func matchSegs(pat, segs []string) bool {
	if len(pat) == 0 {
		return len(segs) == 0
	}
	if pat[0] == "**" {
		// 末尾の `**` は「中身」を指す。`foo/**` は foo 自身には当たらない
		if len(pat) == 1 {
			return len(segs) > 0
		}
		for i := 0; i <= len(segs); i++ {
			if matchSegs(pat[1:], segs[i:]) {
				return true
			}
		}
		return false
	}
	if len(segs) == 0 {
		return false
	}
	if ok, _ := path.Match(pat[0], segs[0]); !ok {
		return false
	}
	return matchSegs(pat[1:], segs[1:])
}

// parseExcludeRule は1行を解釈する（コメント・空行は ok=false）。
func parseExcludeRule(line string) (excludeRule, bool) {
	var r excludeRule
	if strings.HasPrefix(line, "#") {
		return r, false // コメント。`#` 自体を指したいなら `\#`
	}
	if strings.HasPrefix(line, "!") {
		r.neg = true
		line = line[1:]
	} else if strings.HasPrefix(line, `\`) {
		// `\!` `\#` は先頭記号のエスケープ
		line = line[1:]
	}
	if strings.HasSuffix(line, "/") {
		r.dirOnly = true
		line = strings.TrimSuffix(line, "/")
	}
	if strings.HasPrefix(line, "/") {
		r.anchored = true
		line = strings.TrimPrefix(line, "/")
	}
	if line == "" {
		return r, false
	}
	r.segs = strings.Split(line, "/")
	if len(r.segs) > 1 {
		r.anchored = true // 区切りを含む = ルート起点（gitignore と同じ）
	}
	return r, true
}

var excludeTmpDir struct {
	once sync.Once
	path string
}

// writeExcludeFile は rg に渡すパターンファイルを書く（空なら書かない）。
// 名前を毎回変えるのは、実行中の rg が古い内容を読まないようにするため。
func writeExcludeFile(pats []string, seq *int) string {
	if len(pats) == 0 {
		return ""
	}
	excludeTmpDir.once.Do(func() {
		if d, err := os.MkdirTemp("", "grepnavi-exclude"); err == nil {
			excludeTmpDir.path = d
		}
	})
	dir := excludeTmpDir.path
	if dir == "" {
		return ""
	}
	*seq++
	p := filepath.Join(dir, "exclude"+strconv.Itoa(*seq)+".ignore")
	if err := os.WriteFile(p, []byte(strings.Join(pats, "\n")+"\n"), 0644); err != nil {
		return ""
	}
	return p
}

// dropExcludedHits は索引が返したヒットから除外対象を落とす。
// 索引のキャッシュは生のまま持ち、出す直前に落とす。キャッシュ側で落とすと
// 設定を変えてもキャッシュが切れるまで反映されない。
func dropExcludedHits(hits []DefHit) []DefHit {
	if len(Excludes()) == 0 {
		return hits
	}
	out := hits[:0:0]
	for _, h := range hits {
		if !IsExcluded(h.File) {
			out = append(out, h)
		}
	}
	return out
}
