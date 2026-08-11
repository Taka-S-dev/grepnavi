package search

import "strings"

// CaseBlock は関数の中の、ある語を含む場所だけを切り出した1件。
type CaseBlock struct {
	Label     string `json:"label,omitempty"` // 囲む case ラベル（無ければ空）
	StartLine int    `json:"start_line"`
	EndLine   int    `json:"end_line"`
	Body      string `json:"body"`
}

// caseBlockPad は case が見つからなかったときに前後へ足す行数。
const caseBlockPad = 4

// ExtractCaseBlocks は関数本体のうち、word を含む行を囲む case ブロックだけを返す。
//
// 遷移関数は巨大な switch で、確かめたいのはその中の1つの case だけ、ということが
// 多い。openssl の遷移関数6つを全文取ると 31.8 KB になるが、必要なのは各関数の
// 数十行でしかない。
//
// 切り出しは字面だけで行う。case ラベルが見つからなければブロックを推測せず、
// 前後 caseBlockPad 行を返して「これは case ではない」と分かる形にする。
func ExtractCaseBlocks(file string, funcLine int, word string) ([]CaseBlock, error) {
	lines, err := CachedLines(file)
	if err != nil {
		return nil, err
	}
	code := codeOnlyLines(lines)
	spans := scanFuncSpans(code)
	sp, ok := enclosingSpan(spans, funcLine)
	if !ok {
		return nil, nil
	}

	var out []CaseBlock
	taken := map[int]bool{} // 同じ case に複数ヒットしても1回だけ返す
	for i := sp.Start; i <= sp.End && i <= len(code); i++ {
		if !strings.Contains(code[i-1], word) {
			continue
		}
		start, end, label := caseExtent(code, sp, i)
		if taken[start] {
			continue
		}
		taken[start] = true
		out = append(out, CaseBlock{
			Label:     label,
			StartLine: start,
			EndLine:   end,
			Body:      strings.Join(lines[start-1:end], "\n"),
		})
	}
	return out, nil
}

// ExtractCaseBlocksAt は指定した行を囲む case ブロックだけを返す。
//
// 値と関数でまとめた結果は行番号を持っているので、語で探し直すより直接指す方が
// 小さい。語で指定すると、その語が出てくる case を全部返すことになる
// （openssl の TLS_ST_CW_CHANGE は6つの case から代入されていて 3.6 KB。
// 行を指すなら 1 ブロック 18 行で済む）。
func ExtractCaseBlocksAt(file string, lines []int) ([]CaseBlock, error) {
	src, err := CachedLines(file)
	if err != nil {
		return nil, err
	}
	code := codeOnlyLines(src)
	spans := scanFuncSpans(code)

	var out []CaseBlock
	taken := map[int]bool{}
	for _, ln := range lines {
		sp, ok := enclosingSpan(spans, ln)
		if !ok || ln < 1 || ln > len(code) {
			continue
		}
		start, end, label := caseExtent(code, sp, ln)
		if taken[start] {
			continue
		}
		taken[start] = true
		out = append(out, CaseBlock{
			Label:     label,
			StartLine: start,
			EndLine:   end,
			Body:      strings.Join(src[start-1:end], "\n"),
		})
	}
	return out, nil
}

// caseExtent は hit 行を囲む case ラベルの範囲を返す（label=""=case の外）。
// 同じブレース深度の case / default に挟まれた区間を1つの塊とみなす。
func caseExtent(code []string, sp funcSpan, hit int) (int, int, string) {
	depth := make([]int, len(code)+1) // 各行の開始時点でのブレース深度
	d := 0
	for i := sp.Start; i <= sp.End && i <= len(code); i++ {
		depth[i] = d
		d += strings.Count(code[i-1], "{") - strings.Count(code[i-1], "}")
	}
	// hit が if の内側にあっても、外側の case まで戻れるようにする。
	// これまでに見た最小の深さより深い行は、既に閉じたブロックの中なので飛ばす
	minD := depth[hit]
	start, label, want := 0, "", depth[hit]
	for i := hit; i >= sp.Start; i-- {
		if depth[i] < minD {
			minD = depth[i]
		}
		if depth[i] > minD {
			continue
		}
		if l, ok := caseLabel(code[i-1]); ok {
			start, label, want = i, l, depth[i]
			break
		}
	}
	if start == 0 {
		// case の中ではない。周辺だけ返す（塊を推測しない）
		return max(sp.Start, hit-caseBlockPad), min(sp.End, hit+caseBlockPad), ""
	}

	// 連続する case ラベル（フォールスルーでまとめられた入口）は先頭まで遡る
	for i := start - 1; i > sp.Start; i-- {
		if l, ok := caseLabel(code[i-1]); ok && depth[i] == want {
			start, label = i, l // 入口はまとめられた先頭の case
			continue
		}
		break
	}

	end := sp.End
	for i := hit + 1; i <= sp.End && i <= len(code); i++ {
		if depth[i] < want {
			end = i
			break
		}
		if depth[i] > want {
			continue
		}
		if _, ok := caseLabel(code[i-1]); ok {
			end = i - 1
			break
		}
	}
	return start, end, label
}

// caseLabel は行が case / default ラベルならその名前を返す。
func caseLabel(line string) (string, bool) {
	t := strings.TrimSpace(line)
	if strings.HasPrefix(t, "default") && strings.Contains(t, ":") {
		return "default", true
	}
	if !strings.HasPrefix(t, "case ") && !strings.HasPrefix(t, "case\t") {
		return "", false
	}
	rest := strings.TrimSpace(t[len("case"):])
	if i := strings.Index(rest, ":"); i >= 0 {
		return strings.TrimSpace(rest[:i]), true
	}
	return "", false
}
