package search

import (
	"bufio"
	"bytes"
	"container/list"
	"os"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/text/encoding/japanese"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"

	"grepnavi/graph"
)

// ExtractIfdefStack はファイルの matchLine 行目（1始まり）を囲む
// #ifdef/#ifndef/#if ブロックのスタックを返す。
// 外側のブロックが [0]、最内側が末尾。
func ExtractIfdefStack(filePath string, matchLine int) ([]graph.IfdefFrame, error) {
	lines, err := cachedLines(filePath)
	if err != nil {
		return nil, err
	}
	return extractStack(lines, matchLine), nil
}

// extractStack は行スライスとマッチ行番号（1始まり）からスタックを計算する。
func extractStack(lines []string, matchLine int) []graph.IfdefFrame {
	var stack []graph.IfdefFrame

	limit := matchLine - 1
	if limit > len(lines) {
		limit = len(lines)
	}

	for i := 0; i < limit; i++ {
		raw := lines[i]
		lineNum := i + 1

		// 継続行（末尾 \）は無視してよい（#ifdef 自体が継続することはほぼない）
		trimmed := strings.TrimSpace(raw)
		if !strings.HasPrefix(trimmed, "#") {
			continue
		}
		// # と directive の間の空白を除去
		body := strings.TrimSpace(trimmed[1:])

		switch {
		case hasWord(body, "ifdef"):
			cond := wordAfter(body, "ifdef")
			stack = append(stack, graph.IfdefFrame{
				Line:      lineNum,
				Directive: "ifdef",
				Condition: cond,
				Active:    true,
			})

		case hasWord(body, "ifndef"):
			cond := wordAfter(body, "ifndef")
			stack = append(stack, graph.IfdefFrame{
				Line:      lineNum,
				Directive: "ifndef",
				Condition: cond,
				Active:    true,
			})

		case hasWord(body, "if") && !hasWord(body, "ifdef") && !hasWord(body, "ifndef"):
			cond := wordAfter(body, "if")
			stack = append(stack, graph.IfdefFrame{
				Line:      lineNum,
				Directive: "if",
				Condition: cond,
				Active:    true,
			})

		case hasWord(body, "elif"):
			cond := wordAfter(body, "elif")
			if len(stack) > 0 {
				stack[len(stack)-1] = graph.IfdefFrame{
					Line:      lineNum,
					Directive: "elif",
					Condition: cond,
					Active:    true,
				}
			}

		case body == "else":
			if len(stack) > 0 {
				top := stack[len(stack)-1]
				stack[len(stack)-1] = graph.IfdefFrame{
					Line:      lineNum,
					Directive: "else",
					Condition: top.Condition,
					Active:    !top.Active,
				}
			}

		case hasWord(body, "endif"):
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		}
	}

	return stack
}

// hasWord は body が指定 word で始まるかチェック（空白または行末が続く）。
func hasWord(body, word string) bool {
	if body == word {
		return true
	}
	if strings.HasPrefix(body, word) {
		next := body[len(word)]
		return next == ' ' || next == '\t'
	}
	return false
}

// wordAfter は "word rest" から rest を返す。
func wordAfter(body, word string) string {
	if body == word {
		return ""
	}
	return strings.TrimSpace(body[len(word)+1:])
}

// --- ファイルキャッシュ (LRU, バイト予算制) ---
//
// callers / calltree / hover は 1 クエリで数十〜数百ファイルを読むため、
// 件数上限だと 1 クエリでキャッシュが一周して以降も毎回ディスクに戻ってしまう。
// 合計バイトで管理し、典型的な C ファイル（数十KB）なら数千件保持できるようにする。

const fileCacheBudgetBytes  = 64 * 1024 * 1024 // キャッシュ全体の予算
const fileCacheMaxFileBytes = 8 * 1024 * 1024  // これを超える単一ファイルはキャッシュしない（予算の独占防止）

type cacheEntry struct {
	path  string
	lines []string
	mtime time.Time
	bytes int
	elem  *list.Element
}

var fileCache = &lruFileCache{
	budget: fileCacheBudgetBytes,
	items:  make(map[string]*cacheEntry, 256),
}

type lruFileCache struct {
	mu     sync.Mutex
	budget int
	total  int // 保持中エントリの合計バイト
	items  map[string]*cacheEntry
	order  list.List // front = most recently used
}

func (c *lruFileCache) clear() {
	c.mu.Lock()
	c.items = make(map[string]*cacheEntry, 256)
	c.order.Init()
	c.total = 0
	c.mu.Unlock()
}

func (c *lruFileCache) get(path string, mtime time.Time) ([]string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.items[path]
	if !ok || !e.mtime.Equal(mtime) {
		return nil, false
	}
	c.order.MoveToFront(e.elem)
	return e.lines, true
}

func (c *lruFileCache) put(path string, mtime time.Time, lines []string, size int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.items[path]; ok {
		c.total += size - e.bytes
		e.lines = lines
		e.mtime = mtime
		e.bytes = size
		c.order.MoveToFront(e.elem)
	} else {
		e := &cacheEntry{path: path, lines: lines, mtime: mtime, bytes: size}
		e.elem = c.order.PushFront(e)
		c.items[path] = e
		c.total += size
	}
	for c.total > c.budget {
		oldest := c.order.Back()
		if oldest == nil {
			break
		}
		oe := oldest.Value.(*cacheEntry)
		c.order.Remove(oldest)
		delete(c.items, oe.path)
		c.total -= oe.bytes
	}
}

// CachedLines はファイルの行スライスをキャッシュ付きで返す。
func CachedLines(path string) ([]string, error) { return cachedLines(path) }

func cachedLines(path string) ([]string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	mtime := info.ModTime()
	if lines, ok := fileCache.get(path, mtime); ok {
		return lines, nil
	}
	lines, err := readLines(path)
	if err != nil {
		return nil, err
	}
	// 大きすぎるファイルはキャッシュしない（メモリ節約）
	totalBytes := 0
	for _, l := range lines {
		totalBytes += len(l) + 1
	}
	if totalBytes <= fileCacheMaxFileBytes {
		fileCache.put(path, mtime, lines, totalBytes)
	}
	return lines, nil
}

func readLines(path string) ([]string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	// BOM / エンコーディング判定して UTF-8 に変換
	data := toUTF8(raw)

	var lines []string
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 512*1024), 512*1024)
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	return lines, scanner.Err()
}

// Encoding は DetectEncoding が判定するファイルエンコーディング。
type Encoding int

const (
	EncUTF8 Encoding = iota
	EncUTF8BOM
	EncUTF16LE
	EncUTF16BE
	EncSJIS
	EncEUCJP
	EncUnknown
)

// DetectEncoding はバイト列のエンコーディングを判定する。
// 判定順は toUTF8 の従来挙動と同一 (BOM → UTF-8 → Shift-JIS/EUC-JP)。
//
// Shift-JIS/EUC-JP の判別は「エラーが出ない方を採用」ではできない: x/text の
// 両デコーダは不正バイト列をエラーにせず U+FFFD へ置換するため、err はほぼ
// 常に nil になり、判定順で先に試した方 (SJIS) が実質固定で勝ってしまう
// (EUC-JP ファイルが化けたまま SJIS 判定される)。そこで両方でデコードし、
// 置換文字 (U+FFFD) の出現数が少ない方を採用する。同数なら従来通り SJIS を
// 優先。両方とも置換だらけなら日本語エンコーディングではないとみなす。
func DetectEncoding(b []byte) Encoding {
	if bytes.HasPrefix(b, []byte{0xEF, 0xBB, 0xBF}) {
		return EncUTF8BOM
	}
	if bytes.HasPrefix(b, []byte{0xFF, 0xFE}) {
		return EncUTF16LE
	}
	if bytes.HasPrefix(b, []byte{0xFE, 0xFF}) {
		return EncUTF16BE
	}
	if utf8.Valid(b) {
		return EncUTF8
	}
	if len(b) == 0 {
		return EncUnknown
	}
	sjisOut, _, _ := transform.Bytes(japanese.ShiftJIS.NewDecoder(), b)
	eucOut, _, _ := transform.Bytes(japanese.EUCJP.NewDecoder(), b)
	sjisBad, sjisTotal := countReplacementRunes(sjisOut)
	eucBad, eucTotal := countReplacementRunes(eucOut)
	// 半分以上が置換文字なら、どちらのデコード結果ももはや妥当な日本語テキス
	// トとは言えない。
	if sjisTotal > 0 && eucTotal > 0 && sjisBad*2 > sjisTotal && eucBad*2 > eucTotal {
		return EncUnknown
	}
	if eucBad < sjisBad {
		return EncEUCJP
	}
	return EncSJIS
}

// countReplacementRunes はデコード結果に含まれる U+FFFD (置換文字) の数と
// 総 rune 数を返す。
func countReplacementRunes(b []byte) (bad, total int) {
	for _, r := range string(b) {
		total++
		if r == utf8.RuneError {
			bad++
		}
	}
	return bad, total
}

// toUTF8 はバイト列のエンコーディングを判定して UTF-8 に変換する。
// 対応: UTF-8 BOM, UTF-16 LE/BE BOM, Shift-JIS, EUC-JP。
func toUTF8(b []byte) []byte {
	switch DetectEncoding(b) {
	case EncUTF8BOM:
		return b[3:]
	case EncUTF16LE:
		if out, _, err := transform.Bytes(unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewDecoder(), b); err == nil {
			return out
		}
		// If UTF-16 decode fails, fall through to return b.
		// Bytes starting with 0xFF/0xFE are invalid in UTF-8, SJIS, and EUC-JP,
		// so returning unchanged is equivalent to the old inline try-all-encodings path.
	case EncUTF16BE:
		if out, _, err := transform.Bytes(unicode.UTF16(unicode.BigEndian, unicode.UseBOM).NewDecoder(), b); err == nil {
			return out
		}
		// Same reasoning as UTF-16 LE above.
	case EncSJIS:
		if out, _, err := transform.Bytes(japanese.ShiftJIS.NewDecoder(), b); err == nil {
			return out
		}
	case EncEUCJP:
		if out, _, err := transform.Bytes(japanese.EUCJP.NewDecoder(), b); err == nil {
			return out
		}
	}
	return b
}
