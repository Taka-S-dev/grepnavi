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
	"context"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// CtagsIndexed は dir 配下に tags ファイルが存在するか確認する。
func CtagsIndexed(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, "tags"))
	return err == nil
}

// SymbolsByKind はkind別のシンボル名セット。
type SymbolsByKind struct {
	Macros []string // define + enum_member
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
// サーバー起動時・ctags生成完了時に呼ぶ。
func CtagsMacroWarmup(dir string) {
	tagsPath := filepath.Join(dir, "tags")
	fi, err := os.Stat(tagsPath)
	if err != nil {
		return
	}
	mtime := fi.ModTime()

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
		syms, err := ctagsParseSymbols(tagsPath)

		macroCache.Lock()
		macroCache.loading = false
		macroCache.loadMtime = time.Time{}
		if err == nil {
			macroCache.dir = dir
			macroCache.mtime = mtime
			macroCache.symbols = syms
			slog.Debug("ctags-macros warmup done", "dir", dir, "macros", len(syms.Macros))
		}
		macroCache.Unlock()
	}()
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
	macroSet := make(map[string]bool, len(syms.Macros))
	for _, n := range syms.Macros {
		macroSet[n] = true
	}

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
			if macroSet[name] {
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

	seenMacro := make(map[string]bool)
	var result SymbolsByKind
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 256*1024), 256*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if len(line) == 0 || line[0] == '!' {
			continue
		}
		tab1 := strings.IndexByte(line, '\t')
		if tab1 < 0 {
			continue
		}
		name := line[:tab1]
		if len(name) == 0 {
			continue
		}
		c := name[0]
		if c != '_' && !(c >= 'A' && c <= 'Z') && !(c >= 'a' && c <= 'z') {
			continue
		}
		rest := line[tab1:]
		hasKind := func(k string) bool {
			return strings.Contains(rest, "\t"+k+"\t") || strings.HasSuffix(rest, "\t"+k)
		}
		if (hasKind("d") || hasKind("e")) && !seenMacro[name] {
			// 小文字のみの名前は誤検知が多いので除外
			hasUpper := false
			for _, ch := range name {
				if ch >= 'A' && ch <= 'Z' {
					hasUpper = true
					break
				}
			}
			if hasUpper {
				seenMacro[name] = true
				result.Macros = append(result.Macros, name)
			}
		}
	}
	return result, nil
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
	for i := 0; i < 20 && scanner.Scan(); i++ {
		line := scanner.Text()
		if !strings.HasPrefix(line, "!") {
			break
		}
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
	pattern := `\t` + regexp.QuoteMeta(rel) + `\t`
	cmd := exec.CommandContext(context.Background(), "rg",
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
		if h := ctagsParseFields(fields, fields[0], dir); h != nil {
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
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "!") {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) < 3 {
			continue
		}
		sym := fields[0]
		if sym > word {
			break
		}
		if sym != word {
			continue
		}
		h := ctagsParseFields(fields, word, dir)
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
	cmd := exec.CommandContext(context.Background(), "rg",
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
		if h := ctagsParseFields(fields, word, dir); h != nil {
			hits = append(hits, *h)
		}
	}

	slog.Debug("ctags-find result", "word", word, "hits", len(hits), "engine", "rg")
	return preferDefinitionHits(hits), nil
}

// ctagsParseFields は tags ファイルの1行分のフィールドをパースして DefHit を返す。
// line: が取得できない場合は nil を返す。
func ctagsParseFields(fields []string, word, dir string) *DefHit {
	file := fields[1]
	if !filepath.IsAbs(file) {
		file = filepath.Join(dir, file)
	}

	lineNum := 0
	kind := ""
	for _, ef := range fields[3:] {
		if strings.HasPrefix(ef, "line:") {
			n, err := strconv.Atoi(strings.TrimPrefix(ef, "line:"))
			if err == nil {
				lineNum = n
			}
		}
		if len(ef) == 1 {
			kind = ctagsKindToKind(ef)
		}
	}
	// line: フィールドがない場合はアドレスフィールド（"42;"形式）から取得
	if lineNum == 0 {
		addr := fields[2]
		if idx := strings.Index(addr, ";"); idx >= 0 {
			addr = addr[:idx]
		}
		if n, err := strconv.Atoi(addr); err == nil && n > 0 {
			lineNum = n
		}
	}
	if lineNum == 0 {
		return nil
	}
	return &DefHit{
		File: file,
		Line: lineNum,
		Text: word,
		Kind: kind,
	}
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
		lo -= 256 * 1024
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
