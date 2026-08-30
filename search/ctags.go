package search

// Universal Ctags 統合
//
// tags ファイル（ctags -R --fields=+n で生成）から定義を検索する。
//
// ソート状態に応じて2つの検索戦略を使い分ける:
//   - !_TAG_FILE_SORTED=1 (シンボル名順) → バイナリサーチ + 線形スキャン (~100ms)
//   - それ以外 (Exuberant Ctags 等でファイルパス順)  → ripgrep (~0.5s)

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"hash/fnv"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"grepnavi/proc"
)

const (
	// tags ファイル冒頭の `!_TAG_*` メタ行を読む最大行数。
	// Universal Ctags は 20 行を超えるメタ行を書くことがあるため余裕を持たせる。
	_ctagsHeaderScanLines = 200
	// バイナリサーチ後に同名シンボルを取りこぼさないための線形スキャン窓（バイト）。
	_ctagsLinearScanWindowBytes = 256 * 1024
)

// CtagsIndexed は dir 配下に tags ファイルが存在するか確認する。
func CtagsIndexed(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, "tags"))
	return err == nil
}

// SymbolsByKind はkind別のシンボル名セット。
type SymbolsByKind struct {
	Macros []string // define + enum_member
	// Types は typedef / struct / union / enum の名前。エディタ向け（LSP の
	// セマンティックトークン）で型名の使用箇所を塗るために持つ。ソート済み。
	Types []string
	// 以下は補完用。ctags が既定で付ける scope / typeref フィールドから拾う。
	// Members は struct/union 名 → メンバー一覧、Typedefs は typedef 名 → 実体の
	// 型文字列（"struct ssl_st" / "uint32_t" 等）、Globals はグローバル変数名 → 型。
	Members  map[string][]Member
	Typedefs map[string]string
	Globals  map[string]string
	// Functions は関数名（定義 f とプロトタイプ p）。補完の候補用。ソート済み。
	Functions []string
}

// Member は構造体メンバー1つ。Type は ctags の typeref から取った型文字列で、
// ポインタなら末尾に * を含む（"SSL3_RECORD *" 等）。
type Member struct {
	Name string
	Type string
}

// macroCache はCtagsMacroNamesの結果をメモリにキャッシュする。
var macroCache struct {
	sync.RWMutex
	dir       string
	mtime     time.Time
	symbols   SymbolsByKind
	loading   bool
	loadMtime time.Time // ロード中のファイルのmtime
}

// CtagsMacroWarmup はバックグラウンドでマクロキャッシュを構築する。
// サーバー起動時・ctags生成完了時・アイドルトリム後の再要求時に呼ぶ。
func CtagsMacroWarmup(dir string) {
	tagsPath := filepath.Join(dir, "tags")
	fi, err := os.Stat(tagsPath)
	if err != nil {
		return
	}
	mtime := fi.ModTime()
	size := fi.Size()

	macroCache.Lock()
	// 同じmtimeをキャッシュ済み or ロード中ならスキップ
	if (macroCache.dir == dir && macroCache.mtime.Equal(mtime)) ||
		(macroCache.loading && macroCache.loadMtime.Equal(mtime)) {
		macroCache.Unlock()
		return
	}
	macroCache.loading = true
	macroCache.loadMtime = mtime
	macroCache.Unlock()

	go func() {
		// サイドカーがあれば tags（カーネル規模で GB 級）のフルパースを省略
		syms, fromSidecar := loadMacroSidecar(dir, mtime, size)
		var err error
		if !fromSidecar {
			syms, err = ctagsParseSymbols(tagsPath)
			if err == nil {
				saveMacroSidecar(dir, mtime, size, syms)
			}
		}

		macroCache.Lock()
		macroCache.loading = false
		macroCache.loadMtime = time.Time{}
		if err == nil {
			macroCache.dir = dir
			macroCache.mtime = mtime
			macroCache.symbols = syms
			slog.Debug("ctags-macros warmup done", "dir", dir, "macros", len(syms.Macros), "sidecar", fromSidecar)
		}
		macroCache.Unlock()

		if !fromSidecar && err == nil {
			// GB 級 tags のパース churn を即 OS に返す（スカベンジャー任せだと数分残る）
			debug.FreeOSMemory()
		}
	}()
}

// CtagsMacroTrim はメモリ上のマクロキャッシュを解放する（アイドルトリム用）。
// 次回の CtagsMacroWarmup はサイドカーからサブ秒で再構築される。
func CtagsMacroTrim() {
	macroCache.Lock()
	if !macroCache.loading {
		macroCache.dir = ""
		macroCache.mtime = time.Time{}
		macroCache.symbols = SymbolsByKind{}
	}
	macroCache.Unlock()
}

// ===== マクロ名サイドカーキャッシュ =====
//
// tags から抽出したマクロ名だけを root 直下の .grepnavi-macros に永続化する。
// 純粋な派生キャッシュ（消しても正しさに影響しない）で、ヘッダの mtime/size が
// 現在の tags と一致するときだけ使う。root 配下に置くのは、シンボル名が既に
// tags として同じ場所にあるものだけを書くため（%TEMP% 等へ複製しない）。

// v2 で Types を追加。v1 のファイルはヘッダ不一致で読み飛ばされ、次回の
// フルパースで v2 に書き直される（派生キャッシュなので取りこぼしは無い）。
const macroSidecarMagic = "grepnavi-macros v4"

// サイドカーのセクション区切り行。シンボル名にタブは入らないので、タブ始まりの
// 行は名前と衝突しない。v3 で members / typedefs / globals を追加。
const (
	macroSidecarTypesMarker    = "\ttypes"
	macroSidecarMembersMarker  = "\tmembers"  // 以降の行: struct<TAB>name<TAB>type
	macroSidecarTypedefsMarker = "\ttypedefs" // 以降の行: name<TAB>type
	macroSidecarGlobalsMarker  = "\tglobals"  // 以降の行: name<TAB>type
	macroSidecarFuncsMarker    = "\tfunctions"
)

func macroSidecarPath(dir string) string { return filepath.Join(dir, ".grepnavi-macros") }

// ヘッダには除外設定の指紋も入れる。キャッシュは除外済みの表なので、
// 「対象から外すもの」を変えたら tags が同じでも作り直す必要がある。
func macroSidecarHeader(mtime time.Time, size int64) string {
	h := fnv.New64a()
	h.Write([]byte(excludeFingerprint())) // 規則は複数行なので1行のヘッダに収まる形に畳む
	return fmt.Sprintf("%s\t%d\t%d\t%x", macroSidecarMagic, mtime.UnixNano(), size, h.Sum64())
}

func loadMacroSidecar(dir string, mtime time.Time, size int64) (SymbolsByKind, bool) {
	f, err := os.Open(macroSidecarPath(dir))
	if err != nil {
		return SymbolsByKind{}, false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	if !sc.Scan() || sc.Text() != macroSidecarHeader(mtime, size) {
		return SymbolsByKind{}, false
	}
	syms := SymbolsByKind{Members: map[string][]Member{}, Typedefs: map[string]string{}, Globals: map[string]string{}}
	section := "macros"
	for sc.Scan() {
		t := sc.Text()
		switch t {
		case macroSidecarTypesMarker:
			section = "types"
			continue
		case macroSidecarMembersMarker:
			section = "members"
			continue
		case macroSidecarTypedefsMarker:
			section = "typedefs"
			continue
		case macroSidecarGlobalsMarker:
			section = "globals"
			continue
		case macroSidecarFuncsMarker:
			section = "functions"
			continue
		}
		switch section {
		case "macros":
			syms.Macros = append(syms.Macros, t)
		case "types":
			syms.Types = append(syms.Types, t)
		case "members":
			f := strings.SplitN(t, "\t", 3)
			if len(f) == 3 {
				syms.Members[f[0]] = append(syms.Members[f[0]], Member{Name: f[1], Type: f[2]})
			}
		case "typedefs":
			if f := strings.SplitN(t, "\t", 2); len(f) == 2 {
				syms.Typedefs[f[0]] = f[1]
			}
		case "globals":
			if f := strings.SplitN(t, "\t", 2); len(f) == 2 {
				syms.Globals[f[0]] = f[1]
			}
		case "functions":
			syms.Functions = append(syms.Functions, t)
		}
	}
	if sc.Err() != nil {
		return SymbolsByKind{}, false
	}
	return syms, true
}

func saveMacroSidecar(dir string, mtime time.Time, size int64, syms SymbolsByKind) {
	// tmp に書いて rename。途中クラッシュで壊れた本体を残さない
	tmp := macroSidecarPath(dir) + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return // 書けない root（読み取り専用等）ではフルパース運用に自然に落ちる
	}
	w := bufio.NewWriterSize(f, 1<<20)
	fmt.Fprintln(w, macroSidecarHeader(mtime, size))
	for _, m := range syms.Macros {
		w.WriteString(m)
		w.WriteByte('\n')
	}
	fmt.Fprintln(w, macroSidecarTypesMarker)
	for _, t := range syms.Types {
		w.WriteString(t)
		w.WriteByte('\n')
	}
	fmt.Fprintln(w, macroSidecarMembersMarker)
	for st, ms := range syms.Members {
		for _, m := range ms {
			fmt.Fprintf(w, "%s\t%s\t%s\n", st, m.Name, m.Type)
		}
	}
	fmt.Fprintln(w, macroSidecarTypedefsMarker)
	for name, ty := range syms.Typedefs {
		fmt.Fprintf(w, "%s\t%s\n", name, ty)
	}
	fmt.Fprintln(w, macroSidecarGlobalsMarker)
	for name, ty := range syms.Globals {
		fmt.Fprintf(w, "%s\t%s\n", name, ty)
	}
	fmt.Fprintln(w, macroSidecarFuncsMarker)
	for _, f := range syms.Functions {
		w.WriteString(f)
		w.WriteByte('\n')
	}
	err = w.Flush()
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmp)
		return
	}
	if err := os.Rename(tmp, macroSidecarPath(dir)); err != nil {
		os.Remove(tmp)
	}
}

// MacroCacheState はキャッシュの状態を表す。
type MacroCacheState struct {
	Symbols SymbolsByKind
	Ready   bool
	Loading bool
}

// CtagsMacroNames はキャッシュからシンボル一覧と状態を返す。未構築なら空を返す。
func CtagsMacroNames(dir string) MacroCacheState {
	macroCache.RLock()
	defer macroCache.RUnlock()
	if macroCache.loading {
		return MacroCacheState{Ready: false, Loading: true}
	}
	tagsPath := filepath.Join(dir, "tags")
	fi, err := os.Stat(tagsPath)
	if err != nil {
		return MacroCacheState{Ready: true, Loading: false}
	}
	if macroCache.dir == dir && macroCache.mtime.Equal(fi.ModTime()) {
		return MacroCacheState{Symbols: macroCache.symbols, Ready: true, Loading: false}
	}
	return MacroCacheState{Ready: false, Loading: false}
}

// SymbolsInFile はファイル内に出現するシンボルをkind別に返す。
func SymbolsInFile(file string, syms SymbolsByKind) SymbolsByKind {
	content, err := os.ReadFile(file)
	if err != nil {
		return SymbolsByKind{}
	}
	// syms.Macros はソート済み（ctagsParseSymbols で sort.Strings 済み）。
	// map を作らずバイナリサーチで検索することで、毎回の大量アロケーションを回避する。
	sorted := syms.Macros

	foundMacros := make(map[string]bool)
	src := content
	for len(src) > 0 {
		c := src[0]
		if c == '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') {
			end := 1
			for end < len(src) {
				ch := src[end]
				if ch == '_' || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') {
					end++
				} else {
					break
				}
			}
			name := string(src[:end])
			i := sort.SearchStrings(sorted, name)
			if i < len(sorted) && sorted[i] == name {
				foundMacros[name] = true
			}
			src = src[end:]
		} else {
			src = src[1:]
		}
	}

	result := SymbolsByKind{}
	for n := range foundMacros {
		result.Macros = append(result.Macros, n)
	}
	return result
}

// ctagsParseSymbols は tags ファイルをパースしてkind別シンボル名を返す。
func ctagsParseSymbols(tagsPath string) (SymbolsByKind, error) {
	f, err := os.Open(tagsPath)
	if err != nil {
		return SymbolsByKind{}, err
	}
	defer f.Close()

	tagsDir := filepath.Dir(tagsPath)
	seenMacro := make(map[string]bool)
	seenType := make(map[string]bool)
	seenFunc := make(map[string]bool)
	result := SymbolsByKind{Members: map[string][]Member{}, Typedefs: map[string]string{}, Globals: map[string]string{}}
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 256*1024), 256*1024)
	for scanner.Scan() {
		// Bytes() はスキャナ内部バッファへの参照を返す（アロケートなし）。
		// Text() はフル行文字列をアロケートするため、数百万行では数百MB消費する。
		line := scanner.Bytes()
		if len(line) == 0 || line[0] == '!' {
			continue
		}
		tab1 := bytes.IndexByte(line, '\t')
		if tab1 < 0 {
			continue
		}
		nameBytes := line[:tab1]
		if len(nameBytes) == 0 {
			continue
		}
		c := nameBytes[0]
		if c != '_' && !(c >= 'A' && c <= 'Z') && !(c >= 'a' && c <= 'z') {
			continue
		}
		rest := line[tab1:]
		// ファイル欄（2列目）で C/C++ 以外と除外パスを落とす。tags が古い設定で
		// 作られていると生成物（doxygen の html/js など）の名前が混ざり、補完で
		// cryptlib_8c.html のような候補が出る
		if tab2 := bytes.IndexByte(rest[1:], '\t'); tab2 >= 0 {
			file := string(rest[1 : 1+tab2])
			if !ctagsIsCFile(file) || IsExcluded(filepath.Join(tagsDir, strings.TrimPrefix(file, "./"))) {
				continue
			}
		}
		hasKind := func(k byte) bool {
			needle := []byte{'\t', k, '\t'}
			suffix := []byte{'\t', k}
			return bytes.Contains(rest, needle) || bytes.HasSuffix(rest, suffix)
		}
		if (hasKind('d') || hasKind('e')) && !seenMacro[string(nameBytes)] {
			// 小文字のみの名前は誤検知が多いので除外
			hasUpper := false
			for _, ch := range nameBytes {
				if ch >= 'A' && ch <= 'Z' {
					hasUpper = true
					break
				}
			}
			if hasUpper {
				// string(nameBytes) はシンボル名分だけをアロケート。
				// バッファは次の Scan() で上書きされるため独立コピーになる。
				name := string(nameBytes)
				seenMacro[name] = true
				result.Macros = append(result.Macros, name)
			}
		}
		// 型名は大文字規則を掛けない（size_t や ssl_st のような小文字の型が普通）。
		if (hasKind('t') || hasKind('s') || hasKind('u') || hasKind('g')) && !seenType[string(nameBytes)] {
			name := string(nameBytes)
			seenType[name] = true
			result.Types = append(result.Types, name)
		}
		// 補完用: メンバー（所属 struct/union と型）、typedef の実体、グローバル変数の型。
		// 拡張フィールドは ;" の後にタブ区切りで並ぶ（kind, line:, struct:, typeref: ...）。
		if hasKind('m') || hasKind('t') || hasKind('v') {
			ctagsCollectCompletionFields(&result, string(nameBytes), rest, hasKind)
		}
		if (hasKind('f') || hasKind('p')) && !seenFunc[string(nameBytes)] {
			name := string(nameBytes)
			seenFunc[name] = true
			result.Functions = append(result.Functions, name)
		}
	}
	sort.Strings(result.Macros)
	sort.Strings(result.Types)
	sort.Strings(result.Functions)
	return result, nil
}

// IsCSourceFile は拡張子で C/C++ のソース・ヘッダかを見る（索引に他言語が
// 混ざっている tags から C の項目だけ取るときの判定）。
func IsCSourceFile(file string) bool { return ctagsIsCFile(file) }

// ctagsIsCFile は tags のファイル欄が C/C++ のソース・ヘッダかを拡張子で見る。
func ctagsIsCFile(file string) bool {
	switch strings.ToLower(filepath.Ext(file)) {
	case ".c", ".h", ".cc", ".cpp", ".cxx", ".c++", ".hh", ".hpp", ".hxx", ".h++", ".inl", ".ipp", ".tcc":
		return true
	}
	return false
}

// ctagsCollectCompletionFields は1行の拡張フィールドから補完用の表を埋める。
//   - m: struct:X / union:X と typeref:typename:T → Members[X]
//   - t: typeref:struct:X（"struct X"）または typeref:typename:T → Typedefs[name]
//   - v: typeref:typename:T → Globals[name]
//
// typeref が無い行（古い ctags）は黙って飛ばす。補完の欠けは安全側。
func ctagsCollectCompletionFields(result *SymbolsByKind, name string, rest []byte, hasKind func(byte) bool) {
	var owner, typ string
	for _, f := range bytes.Split(rest, []byte{'\t'}) {
		s := string(f)
		switch {
		case strings.HasPrefix(s, "struct:"):
			owner = strings.TrimPrefix(s, "struct:")
		case strings.HasPrefix(s, "union:"):
			owner = strings.TrimPrefix(s, "union:")
		case strings.HasPrefix(s, "typeref:typename:"):
			typ = strings.TrimPrefix(s, "typeref:typename:")
		case strings.HasPrefix(s, "typeref:struct:"):
			typ = "struct " + strings.TrimPrefix(s, "typeref:struct:")
		case strings.HasPrefix(s, "typeref:union:"):
			typ = "union " + strings.TrimPrefix(s, "typeref:union:")
		case strings.HasPrefix(s, "typeref:enum:"):
			typ = "enum " + strings.TrimPrefix(s, "typeref:enum:")
		}
	}
	typ = readableAnonType(typ)
	switch {
	case hasKind('m') && owner != "":
		// 入れ子の struct:outer::inner のようなスコープは末尾だけ使う
		if i := strings.LastIndex(owner, "::"); i >= 0 {
			owner = owner[i+2:]
		}
		result.Members[owner] = append(result.Members[owner], Member{Name: name, Type: typ})
	case hasKind('t') && typ != "":
		if _, dup := result.Typedefs[name]; !dup {
			result.Typedefs[name] = typ
		}
	case hasKind('v') && typ != "":
		if _, dup := result.Globals[name]; !dup {
			result.Globals[name] = typ
		}
	}
}

// readableAnonType は匿名 struct/union/enum の内部名を読める形に直す。
// ctags は名前のない型に __anon<16進> という名前を付けるので、そのまま出すと
// 補完の型欄に "struct ssl_st::__anon95e14df50808" のような文字列が並ぶ。
// 名前で辿れる型ではない（メンバーも引けない）ので、形だけ見せる。
func readableAnonType(typ string) string {
	kind, rest, ok := strings.Cut(typ, " ")
	if !ok {
		return typ
	}
	last := rest
	if i := strings.LastIndex(last, "::"); i >= 0 {
		last = last[i+2:]
	}
	if !strings.HasPrefix(last, "__anon") {
		return typ
	}
	return kind + " {...}"
}

// ctagsReadSortedFlag は tags ファイルの先頭ヘッダから !_TAG_FILE_SORTED の値を返す。
// 1 = シンボル名順ソート済み、0 = 未ソート、2 = foldcase ソート。
// ヘッダが読めない場合は 0 を返す。
func ctagsReadSortedFlag(tagsPath string) int {
	f, err := os.Open(tagsPath)
	if err != nil {
		return 0
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	// メタ行 (!_TAG_*) は先頭付近にあるが、必ずしも1行目からではない。
	// ソート済みの tags では "!" より前に並ぶ名前のタグ（minified JS から
	// 拾われる空白始まりの名前など）が上に来ることがあり、「1行目が ! でなければ
	// ヘッダ無し」と判断すると未ソート扱いになる。そうなると全ての検索が
	// バイナリサーチではなく rg の全走査に落ちて 200 倍遅くなるため、
	// 途中で打ち切らず一定行数を読んでからあきらめる。
	for i := 0; i < _ctagsHeaderScanLines && scanner.Scan(); i++ {
		line := scanner.Text()
		if strings.HasPrefix(line, "!_TAG_FILE_SORTED\t") {
			fields := strings.SplitN(line, "\t", 3)
			if len(fields) >= 2 {
				n, err := strconv.Atoi(fields[1])
				if err == nil {
					return n
				}
			}
		}
	}
	return 0
}

// CtagsSymbolsForFile は tags ファイルから指定ファイルに定義されたシンボル一覧を返す。
// file は絶対パスで指定する。ripgrep でファイルパスフィールドを検索する。
func CtagsSymbolsForFile(file, dir string) ([]DefHit, error) {
	tagsPath := filepath.Join(dir, "tags")

	// tags ファイル内のファイルパスは dir からの相対パスで記録されている
	rel, err := filepath.Rel(dir, file)
	if err != nil {
		rel = file
	}
	// Windows パスセパレータを / に統一
	rel = strings.ReplaceAll(rel, `\`, "/")

	// タブ区切りの第2フィールドがファイルパスにマッチする行を抽出
	// `ctags -R .` で作った tags は "./crypto/x.c" のように ./ 付きで記録するので、
	// 先頭の ./ は有っても無くても当てる
	pattern := `\t(?:\./)?` + regexp.QuoteMeta(rel) + `\t`
	cmd := proc.CommandContext(context.Background(), "rg",
		"--no-line-number", "--no-filename", "--no-heading", "--color=never",
		pattern, tagsPath)

	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return []DefHit{}, nil
		}
		return nil, err
	}

	var hits []DefHit
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "!") || line == "" {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) < 3 {
			continue
		}
		if h := ctagsParseLine(line, fields[0], dir); h != nil {
			hits = append(hits, *h)
		}
	}
	slog.Debug("ctags-file-symbols", "file", file, "hits", len(hits))
	return hits, nil
}

// CtagsFindDefinitions は tags ファイルから word の定義を検索する。
// ファイルがシンボル名順にソートされていればバイナリサーチを、
// そうでなければ ripgrep を使う。
func CtagsFindDefinitions(word, dir string) ([]DefHit, error) {
	hits, err := ctagsFindDefinitionsRaw(word, dir)
	return dropExcludedHits(hits), err
}

func ctagsFindDefinitionsRaw(word, dir string) ([]DefHit, error) {
	tagsPath := filepath.Join(dir, "tags")

	sorted := ctagsReadSortedFlag(tagsPath)
	slog.Debug("ctags-find", "word", word, "tags", tagsPath, "sorted", sorted)

	if sorted == 1 {
		return ctagsFindBinarySearch(word, tagsPath, dir)
	}
	return ctagsFindRipgrep(word, tagsPath, dir)
}

// ctagsFindBinarySearch はシンボル名順ソート済みの tags ファイルをバイナリサーチで検索する。
func ctagsFindBinarySearch(word, tagsPath, dir string) ([]DefHit, error) {
	f, err := os.Open(tagsPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	fileSize := fi.Size()

	startOffset := ctagsFindStart(f, fileSize, word)

	if _, err := f.Seek(startOffset, io.SeekStart); err != nil {
		return nil, err
	}
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 256*1024), 256*1024)

	// startOffset は行頭とは限らないため、最初の1行（partial line）を読み捨てる
	if startOffset > 0 {
		scanner.Scan()
	}

	var hits []DefHit
	wordB := []byte(word)
	for scanner.Scan() {
		// この走査は二分探索が絞った窓の全行に対して走る。ほぼ全行が不一致
		// なので、確保の要らない Bytes で最初のタブまでを比べ、行の文字列化と
		// 分割は一致した行だけに絞る（Bytes の中身は次の Scan で無効になるが、
		// 一致時に即 string へ写すので問題ない）。
		b := scanner.Bytes()
		if len(b) > 0 && b[0] == '!' {
			continue
		}
		tab := bytes.IndexByte(b, '\t')
		if tab < 0 {
			continue
		}
		cmp := bytes.Compare(b[:tab], wordB)
		if cmp > 0 {
			break
		}
		if cmp != 0 {
			continue
		}
		h := ctagsParseLine(string(b), word, dir)
		if h != nil {
			hits = append(hits, *h)
		}
	}

	slog.Debug("ctags-find result", "word", word, "hits", len(hits), "engine", "bsearch")
	return preferDefinitionHits(hits), nil
}

// ctagsFindRipgrep は ripgrep で tags ファイルを検索する（ソート不問）。
func ctagsFindRipgrep(word, tagsPath, dir string) ([]DefHit, error) {
	pattern := `^` + regexp.QuoteMeta(word) + `\t`
	cmd := proc.CommandContext(context.Background(), "rg",
		"--no-line-number", "--no-filename", "--no-heading", "--color=never",
		"-m", "2000",
		pattern, tagsPath)

	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			slog.Debug("ctags-find result", "word", word, "hits", 0, "engine", "rg")
			return []DefHit{}, nil
		}
		return nil, err
	}

	var hits []DefHit
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "!") || line == "" {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) < 3 || fields[0] != word {
			continue
		}
		if h := ctagsParseLine(line, word, dir); h != nil {
			hits = append(hits, *h)
		}
	}

	slog.Debug("ctags-find result", "word", word, "hits", len(hits), "engine", "rg")
	return preferDefinitionHits(hits), nil
}

// ctagsParseLine は tags ファイルの1行をパースして DefHit を返す。
// 形式は  name<TAB>file<TAB>address[;"<TAB>拡張フィールド...]
//
// address は /^定義行$/ という検索パターンで、インデントのタブをそのまま含む。
// タブで単純分割するとパターンが複数フィールドに割れて定義行を復元できず、
// 拡張フィールドの位置もずれるので、拡張フィールド区切り ;"<TAB> を境に切る。
// line: が取得できない場合は nil を返す。
func ctagsParseLine(line, word, dir string) *DefHit {
	i1 := strings.IndexByte(line, '\t')
	if i1 < 0 {
		return nil
	}
	i2 := strings.IndexByte(line[i1+1:], '\t')
	if i2 < 0 {
		return nil
	}
	i2 += i1 + 1
	name, file, rest := line[:i1], line[i1+1:i2], line[i2+1:]

	if !filepath.IsAbs(file) {
		file = filepath.Join(dir, file)
	}
	// tags は絶対パスをスラッシュ区切りで持つ。gtags/rg 経由のヒットは
	// OS 区切りなので、揃えないと同じファイルが別物として扱われる。
	file = filepath.Clean(file)

	addr, ext := rest, ""
	if j := strings.LastIndex(rest, ";\"\t"); j >= 0 {
		addr, ext = rest[:j], rest[j+3:]
	} else {
		addr = strings.TrimSuffix(rest, ";\"")
	}

	lineNum := 0
	kind := ""
	owner := ""
	if ext != "" {
		for _, ef := range strings.Split(ext, "\t") {
			if strings.HasPrefix(ef, "line:") {
				if n, err := strconv.Atoi(strings.TrimPrefix(ef, "line:")); err == nil {
					lineNum = n
				}
			}
			if len(ef) == 1 {
				kind = ctagsKindToKind(ef)
			}
			// 入れ子 struct:outer::inner は末尾（直接の持ち主）だけ使う
			if o, ok := strings.CutPrefix(ef, "struct:"); ok {
				owner = o[strings.LastIndex(o, ":")+1:]
			} else if o, ok := strings.CutPrefix(ef, "union:"); ok {
				owner = o[strings.LastIndex(o, ":")+1:]
			}
		}
	}
	// line: フィールドがない場合はアドレスフィールド（"42" 形式）から取得
	if lineNum == 0 {
		if n, err := strconv.Atoi(strings.TrimSuffix(addr, ";")); err == nil && n > 0 {
			lineNum = n
		}
	}
	if lineNum == 0 {
		return nil
	}
	// アドレスが定義行そのものを持っているので、そこから復元する。
	// これを使わないと Text がシンボル名のエコーになり、gtags 経由のヒットと違って
	// 「その行が何なのか」が分からない（構造体メンバは必ずこの経路を通る）。
	text := ctagsPatternText(addr)
	if text == "" {
		text = word // アドレスが行番号形式のときはパターンが無い
	}
	return &DefHit{
		File:  file,
		Line:  lineNum,
		Text:  text,
		Name:  name,
		Owner: owner,
		Kind:  kind,
	}
}

// ctagsPatternText は tags のアドレスフィールド /^...$/ から定義行を復元する。
// 行番号形式（"42;"）や壊れた入力では空文字を返す。
func ctagsPatternText(addr string) string {
	// 拡張フィールドの区切り。パターン内にも ;" は現れうるので末尾側を採る。
	if i := strings.LastIndex(addr, ";\""); i >= 0 {
		addr = addr[:i]
	}
	if len(addr) < 2 || addr[0] != '/' || addr[len(addr)-1] != '/' {
		return ""
	}
	body := strings.TrimSuffix(strings.TrimPrefix(addr, "/"), "/")
	body = strings.TrimPrefix(body, "^")
	body = strings.TrimSuffix(body, "$")
	// ctags は / と \ をバックスラッシュでエスケープする。
	// あわせて空白の連続を1つに畳む: 定義行はインデントや桁揃えのタブを含み、
	// gtags 経由の Text も同じ形（空白1つ区切り）で返しているため。
	var b strings.Builder
	b.Grow(len(body))
	space := false
	for i := 0; i < len(body); i++ {
		c := body[i]
		if c == '\\' && i+1 < len(body) && (body[i+1] == '/' || body[i+1] == '\\') {
			i++
			c = body[i]
		}
		if c == ' ' || c == '\t' {
			space = true
			continue
		}
		if space && b.Len() > 0 {
			b.WriteByte(' ')
		}
		space = false
		b.WriteByte(c)
	}
	return b.String()
}

// ctagsFindStart はバイナリサーチで word の開始位置付近のオフセットを返す。
func ctagsFindStart(f *os.File, fileSize int64, word string) int64 {
	const scanWindow = 2 * 1024 * 1024

	lo := int64(0)
	hi := fileSize

	for hi-lo > scanWindow {
		mid := (lo + hi) / 2
		sym, lineStart, lineEnd, ok := ctagsReadSymbolAfter(f, mid)
		if !ok || lineStart >= hi {
			hi = mid
			continue
		}
		if sym == word {
			hi = lineStart
		} else if sym < word {
			lo = lineEnd
		} else {
			hi = mid
		}
	}

	if lo > 0 {
		lo -= _ctagsLinearScanWindowBytes
		if lo < 0 {
			lo = 0
		}
	}
	return lo
}

// ctagsReadSymbolAfter は offset の直後の完全な行のシンボル名と位置を返す。
func ctagsReadSymbolAfter(f *os.File, offset int64) (sym string, lineStart, lineEnd int64, ok bool) {
	pos := offset

	if offset > 0 {
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			return "", 0, 0, false
		}
		buf := make([]byte, 4096)
		found := false
		for {
			n, _ := f.Read(buf)
			if n == 0 {
				return "", 0, 0, false
			}
			for i := 0; i < n; i++ {
				if buf[i] == '\n' {
					pos = offset + int64(i) + 1
					found = true
					break
				}
			}
			if found {
				break
			}
			offset += int64(n)
		}
	}

	for {
		if _, err := f.Seek(pos, io.SeekStart); err != nil {
			return "", 0, 0, false
		}
		buf := make([]byte, 8192)
		n, _ := f.Read(buf)
		if n == 0 {
			return "", 0, 0, false
		}
		buf = buf[:n]

		nl := -1
		for i, b := range buf {
			if b == '\n' {
				nl = i
				break
			}
		}
		lineBytes := buf
		lineLen := int64(n)
		if nl >= 0 {
			lineBytes = buf[:nl]
			lineLen = int64(nl) + 1
		}

		lineStr := strings.TrimRight(string(lineBytes), "\r")
		if strings.HasPrefix(lineStr, "!") || lineStr == "" {
			pos += lineLen
			continue
		}

		tab := strings.IndexByte(lineStr, '\t')
		if tab < 0 {
			pos += lineLen
			continue
		}

		return lineStr[:tab], pos, pos + lineLen, true
	}
}

func ctagsKindToKind(k string) string {
	switch k {
	case "f":
		return "func"
	case "s":
		return "struct"
	case "u":
		return "union"
	case "e":
		return "enum_member" // enumerator（enumのメンバー値）
	case "g":
		return "enum" // enumeration（enum型定義）
	case "d":
		return "define"
	case "t":
		return "typedef"
	case "m":
		return "member"
	case "v":
		return "var"
	default:
		return k
	}
}
