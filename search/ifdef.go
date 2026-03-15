package search

import (
	"bufio"
	"os"
	"strings"
	"sync"
	"time"

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

// --- ファイルキャッシュ ---

type cacheEntry struct {
	lines []string
	mtime time.Time
}

var (
	fileCache sync.Map // map[string]*cacheEntry
)

// CachedLines はファイルの行スライスをキャッシュ付きで返す。
func CachedLines(path string) ([]string, error) { return cachedLines(path) }

func cachedLines(path string) ([]string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	mtime := info.ModTime()

	if v, ok := fileCache.Load(path); ok {
		entry := v.(*cacheEntry)
		if entry.mtime.Equal(mtime) {
			return entry.lines, nil
		}
	}

	lines, err := readLines(path)
	if err != nil {
		return nil, err
	}
	fileCache.Store(path, &cacheEntry{lines: lines, mtime: mtime})
	return lines, nil
}

func readLines(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var lines []string
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 512*1024), 512*1024)
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	return lines, scanner.Err()
}
