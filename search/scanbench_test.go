package search

import (
	"fmt"
	"strings"
	"testing"
)

// benchCFile は計測用の C ソースを組み立てる。コメント・文字列・#ifdef・
// 長い関数を混ぜて、実際のツリーで走査器が踏むものを一通り含める。
func benchCFile(funcs, linesPerFunc int) []string {
	var b strings.Builder
	b.WriteString("/* generated for benchmarking\n * multi-line header comment\n */\n")
	b.WriteString("#include <stdio.h>\n\n")
	for f := 0; f < funcs; f++ {
		fmt.Fprintf(&b, "static int bench_func_%d(int a, const char *s)\n{\n", f)
		fmt.Fprintf(&b, "\tint total = 0; /* accumulator */\n")
		for i := 0; i < linesPerFunc; i++ {
			switch i % 6 {
			case 0:
				fmt.Fprintf(&b, "\ttotal += helper_%d(a, \"text with { brace and /* comment */ inside\");\n", i%13)
			case 1:
				fmt.Fprintf(&b, "\t/* plain comment mentioning helper_1(a) */\n")
			case 2:
				fmt.Fprintf(&b, "#ifdef HAVE_FEATURE_%d\n\ttotal += other_call(a);\n#endif\n", i%3)
			case 3:
				fmt.Fprintf(&b, "\tif (a > %d) {\n\t\ttotal -= 1;\n\t}\n", i)
			case 4:
				fmt.Fprintf(&b, "\tchar c = '{'; /* char literal holding a brace */\n")
			default:
				fmt.Fprintf(&b, "\ttotal += %d;\n", i)
			}
		}
		b.WriteString("\treturn total;\n}\n\n")
	}
	return strings.Split(b.String(), "\n")
}

func BenchmarkCodeOnlyLines(b *testing.B) {
	lines := benchCFile(40, 60)
	b.ReportAllocs()
	b.SetBytes(int64(len(lines)))
	for i := 0; i < b.N; i++ {
		codeOnlyLines(lines)
	}
}

func BenchmarkFindContainingFunc(b *testing.B) {
	lines := benchCFile(40, 60)
	target := len(lines) - 20 // 最後の関数の奥
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		findContainingFunc(lines, target)
	}
}

func BenchmarkEnclosingFuncStart(b *testing.B) {
	lines := benchCFile(40, 60)
	target := len(lines) - 20
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		enclosingFuncStart(lines, target)
	}
}

// 参照1件ごとに走る経路。呼び出し元が数百件あればこの回数だけ回る。
func BenchmarkMentionsInCode(b *testing.B) {
	lines := benchCFile(40, 60)
	target := len(lines) - 20
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		c := codeOnlyCache{}
		c.mentionsInCode("bench.c", lines, target, "helper_1")
	}
}

// 包含関数が無い行（トップレベル）は候補を遡り切るので最悪ケースになる。
func BenchmarkEnclosingFuncStartNoMatch(b *testing.B) {
	lines := benchCFile(40, 60)
	lines = append(lines, "int global_tail = 1;") // どの関数にも属さない行
	target := len(lines)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		enclosingFuncStart(lines, target)
	}
}

// 実際の呼び出し元一覧: 同じファイルに 200 件ヒットし、キャッシュを共有する形。
func BenchmarkCallerScanSharedCache(b *testing.B) {
	lines := benchCFile(40, 60)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		c := codeOnlyCache{}
		for h := 0; h < 200; h++ {
			line := 10 + h*20
			if line >= len(lines) {
				line = len(lines) - 1
			}
			c.mentionsInCode("bench.c", lines, line, "helper_1")
			findContainingFunc(lines, line)
		}
	}
}
