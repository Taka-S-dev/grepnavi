package search

import (
	"sort"
	"strconv"
	"strings"
)

// ParseDefines は "WIN32=1 DEBUG=0 NDEBUG" 形式の文字列を map に変換する。
func ParseDefines(s string) map[string]int {
	result := make(map[string]int)
	for _, part := range strings.Fields(s) {
		if idx := strings.Index(part, "="); idx >= 0 {
			val, err := strconv.Atoi(part[idx+1:])
			if err != nil {
				val = 1
			}
			result[part[:idx]] = val
		} else if part != "" {
			result[part] = 1
		}
	}
	return result
}

// ComputeInactiveLines は defines に基づいて非アクティブな行番号（1始まり）を返す。
func ComputeInactiveLines(filePath string, defines map[string]int) ([]int, error) {
	lines, err := cachedLines(filePath)
	if err != nil {
		return nil, err
	}
	inactiveSet := computeInactiveSet(lines, defines)
	result := make([]int, 0, len(inactiveSet))
	for ln := range inactiveSet {
		result = append(result, ln)
	}
	sort.Ints(result)
	return result, nil
}

type condFrame struct {
	parentActive   bool
	active         bool
	anyBranchTaken bool
}

func computeInactiveSet(lines []string, defines map[string]int) map[int]bool {
	inactive := make(map[int]bool)
	var stack []condFrame

	isActive := func() bool {
		if len(stack) == 0 {
			return true
		}
		return stack[len(stack)-1].active
	}

	for i, line := range lines {
		lineNum := i + 1
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "#") {
			if !isActive() {
				inactive[lineNum] = true
			}
			continue
		}
		body := strings.TrimSpace(trimmed[1:])
		cur := isActive()

		switch {
		case hasWord(body, "ifdef"):
			name := wordAfter(body, "ifdef")
			_, defined := defines[name]
			cond := cur && defined
			stack = append(stack, condFrame{parentActive: cur, active: cond, anyBranchTaken: cond})

		case hasWord(body, "ifndef"):
			name := wordAfter(body, "ifndef")
			_, defined := defines[name]
			cond := cur && !defined
			stack = append(stack, condFrame{parentActive: cur, active: cond, anyBranchTaken: cond})

		case hasWord(body, "if") && !hasWord(body, "ifdef") && !hasWord(body, "ifndef"):
			expr := wordAfter(body, "if")
			cond := cur && evalIfExpr(expr, defines)
			stack = append(stack, condFrame{parentActive: cur, active: cond, anyBranchTaken: cond})

		case hasWord(body, "elif"):
			if len(stack) > 0 {
				top := &stack[len(stack)-1]
				if top.parentActive && !top.anyBranchTaken {
					cond := evalIfExpr(wordAfter(body, "elif"), defines)
					top.active = cond
					if cond {
						top.anyBranchTaken = true
					}
				} else {
					top.active = false
				}
			}

		case body == "else" || strings.HasPrefix(body, "else ") || strings.HasPrefix(body, "else\t"):
			if len(stack) > 0 {
				top := &stack[len(stack)-1]
				top.active = top.parentActive && !top.anyBranchTaken
			}

		case hasWord(body, "endif"):
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}

		default:
			if !cur {
				inactive[lineNum] = true
			}
		}
	}
	return inactive
}

// ===== #if 式評価（再帰下降パーサー）=====

func evalIfExpr(expr string, defines map[string]int) bool {
	e := &ifExprParser{s: strings.TrimSpace(expr), defines: defines}
	return e.parseOr() != 0
}

type ifExprParser struct {
	s       string
	pos     int
	defines map[string]int
}

func (e *ifExprParser) skipWS() {
	for e.pos < len(e.s) && (e.s[e.pos] == ' ' || e.s[e.pos] == '\t') {
		e.pos++
	}
}

func (e *ifExprParser) parseOr() int64 {
	left := e.parseAnd()
	for {
		e.skipWS()
		if e.pos+1 < len(e.s) && e.s[e.pos:e.pos+2] == "||" {
			e.pos += 2
			right := e.parseAnd()
			if left != 0 || right != 0 {
				left = 1
			} else {
				left = 0
			}
		} else {
			break
		}
	}
	return left
}

func (e *ifExprParser) parseAnd() int64 {
	left := e.parseCompare()
	for {
		e.skipWS()
		if e.pos+1 < len(e.s) && e.s[e.pos:e.pos+2] == "&&" {
			e.pos += 2
			right := e.parseCompare()
			if left != 0 && right != 0 {
				left = 1
			} else {
				left = 0
			}
		} else {
			break
		}
	}
	return left
}

func (e *ifExprParser) parseCompare() int64 {
	left := e.parseUnary()
	e.skipWS()
	if e.pos+1 < len(e.s) {
		op := e.s[e.pos : e.pos+2]
		if op == "==" || op == "!=" {
			e.pos += 2
			right := e.parseUnary()
			if op == "==" {
				if left == right {
					return 1
				}
				return 0
			}
			if left != right {
				return 1
			}
			return 0
		}
	}
	return left
}

func (e *ifExprParser) parseUnary() int64 {
	e.skipWS()
	if e.pos < len(e.s) && e.s[e.pos] == '!' {
		e.pos++
		if e.parsePrimary() == 0 {
			return 1
		}
		return 0
	}
	return e.parsePrimary()
}

func (e *ifExprParser) parsePrimary() int64 {
	e.skipWS()
	if e.pos >= len(e.s) {
		return 0
	}
	if e.s[e.pos] == '(' {
		e.pos++
		v := e.parseOr()
		e.skipWS()
		if e.pos < len(e.s) && e.s[e.pos] == ')' {
			e.pos++
		}
		return v
	}
	if e.s[e.pos] >= '0' && e.s[e.pos] <= '9' {
		start := e.pos
		for e.pos < len(e.s) && e.s[e.pos] >= '0' && e.s[e.pos] <= '9' {
			e.pos++
		}
		n, _ := strconv.ParseInt(e.s[start:e.pos], 10, 64)
		return n
	}
	if isIdentStart(e.s[e.pos]) {
		start := e.pos
		for e.pos < len(e.s) && isIdentChar(e.s[e.pos]) {
			e.pos++
		}
		ident := e.s[start:e.pos]
		if ident == "defined" {
			e.skipWS()
			hasParen := e.pos < len(e.s) && e.s[e.pos] == '('
			if hasParen {
				e.pos++
			}
			e.skipWS()
			s2 := e.pos
			for e.pos < len(e.s) && isIdentChar(e.s[e.pos]) {
				e.pos++
			}
			name := e.s[s2:e.pos]
			e.skipWS()
			if hasParen && e.pos < len(e.s) && e.s[e.pos] == ')' {
				e.pos++
			}
			if _, ok := e.defines[name]; ok {
				return 1
			}
			return 0
		}
		if v, ok := e.defines[ident]; ok {
			return int64(v)
		}
		return 0
	}
	return 0
}

func isIdentStart(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'
}
func isIdentChar(c byte) bool {
	return isIdentStart(c) || (c >= '0' && c <= '9')
}
