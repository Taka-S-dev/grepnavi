package search

import (
	"context"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// RefSubGroup は RefGroup をもう一段まとめたもの。行番号は間引かない。
//
// 見本を数件だけ返すと、使う側は結局「全部の場所」を取り直すことになる
// （実測: 値でまとめた 4.4 KB を受け取った後、生の 132 件 25.3 KB を再取得していた。
// 合計 29.7 KB で、まとめる前の 19.3 KB より増えた）。
// 2段目まで数え上げて全行番号を載せると 8.2 KB の1往復で終わる。
type RefSubGroup struct {
	Key   string `json:"key"`            // 内側の見出し（関数名・ファイル名）
	File  string `json:"file,omitempty"` // ルートからの相対パス
	Lines []int  `json:"lines"`
}

// RefGroup は参照をひとまとめにした1件。
type RefGroup struct {
	Key   string `json:"key"`   // まとめた見出し（代入値・関数名・ファイル名）
	Count int    `json:"count"` // このまとまりに属する参照の数
	// Sample は飛ぶための見本 "path:line"（path はルートからの相対）。
	// 構造体で返すとキー名とパスだけで応答の大半を占める（openssl の hand_state で
	// 52 グループ × 1件 = 7.5 KB。文字列にすると 3 KB台に収まる）。
	// 2段目を指定したときは Sub が全行番号を持つので、こちらは付けない
	Sample []string `json:"sample,omitempty"`
	// Sub は2段目のまとまり（group に2つ指定したときだけ）。
	Sub []RefSubGroup `json:"sub,omitempty"`
}

const (
	// 集約は上限に達する前に数え終える必要がある。上限で切ってから数えると
	// 「先頭 limit 件の中での分布」になり、全体の分布とは別物になる。
	groupBudget = 20000
	// 見本は「そこへ飛べる」ために添えるもので、全件を並べる欄ではない。
	// 3件×52グループを本文つきで返したら生の一覧より大きくなった（28.0 KB > 19.3 KB）
	groupSampleMax = 2
	// 2段目の行番号は間引かないが、際限なく積むと1グループで応答を埋めるので上限を置く
	groupLinesMax = 40
)

// GroupRefSites は参照を key ごとにまとめて返す。
//
// 参照が多い語では、1件ずつ返すと読む側が破綻する。openssl の hand_state は
// 代入だけで 100 件・19.3 KB あり、エージェントは受け取っても読めずに
// 素の grep へ戻った。同じ内容を代入値でまとめると 51 グループ・3.9 KB になり、
// しかも「どの値が誰から入るか」という問いにそのまま答える形になる。
//
// by は "value"（代入している値）/ "func"（囲む関数）/ "file"。
// value は代入行にしか無いので、その場合は代入だけを対象にする。
// sample は各グループに添える場所の数（0 で場所を省き、見出しと件数だけにする）。
func GroupRefSites(ctx context.Context, q RefQuery, by []string, sample int) ([]RefGroup, int, bool, error) {
	if len(by) == 0 {
		by = []string{"value"}
	}
	if sample < 0 {
		sample = 0
	} else if sample > groupSampleMax {
		sample = groupSampleMax
	}
	if by[0] == "value" {
		q.AssignOnly = true
	}
	// 分布を出すために、表示上限ではなく数え上げ用の予算で引く
	q.Limit = groupBudget
	sites, _, truncated, err := FindRefSites(ctx, q)
	if err != nil {
		return nil, 0, false, err
	}

	outer := groupKeyFunc(by[0], q.Word)
	var inner func(CallSite) string
	if len(by) > 1 {
		inner = groupKeyFunc(by[1], q.Word)
	}

	order := []string{}
	byKey := map[string]*RefGroup{}
	subOrder := map[string][]string{}
	subs := map[string]map[string]*RefSubGroup{}
	for _, s := range sites {
		k := outer(s)
		g := byKey[k]
		if g == nil {
			g = &RefGroup{Key: k}
			byKey[k] = g
			order = append(order, k)
			subs[k] = map[string]*RefSubGroup{}
		}
		g.Count++
		if inner == nil {
			if len(g.Sample) < sample {
				g.Sample = append(g.Sample,
					relToRoot(q.Root, s.File)+":"+strconv.Itoa(s.CallLine))
			}
			continue
		}
		ik := inner(s)
		sg := subs[k][ik]
		if sg == nil {
			sg = &RefSubGroup{Key: ik, File: relToRoot(q.Root, s.File)}
			subs[k][ik] = sg
			subOrder[k] = append(subOrder[k], ik)
		}
		// 同じ関数名が別ファイルにもある場合は、見出しにファイルを添えて区別する
		if sg.File != relToRoot(q.Root, s.File) {
			sg.File = ""
		}
		if len(sg.Lines) < groupLinesMax {
			sg.Lines = append(sg.Lines, s.CallLine)
		}
	}

	out := make([]RefGroup, 0, len(order))
	for _, k := range order {
		g := *byKey[k]
		for _, ik := range subOrder[k] {
			g.Sub = append(g.Sub, *subs[k][ik])
		}
		out = append(out, g)
	}
	// 多い順。どの値が主流かが先頭で分かる。同数なら見出し順で安定させる
	sort.SliceStable(out, func(a, b int) bool {
		if out[a].Count != out[b].Count {
			return out[a].Count > out[b].Count
		}
		return out[a].Key < out[b].Key
	})
	return out, len(sites), truncated, nil
}

// relToRoot はルート配下のパスを相対にする（外れていればそのまま返す）。
func relToRoot(root, file string) string {
	if root == "" {
		return file
	}
	rel, err := filepath.Rel(root, file)
	if err != nil || strings.HasPrefix(rel, "..") {
		return file
	}
	return filepath.ToSlash(rel)
}

// groupKeyFunc は1件から見出しを取り出す関数を返す。
func groupKeyFunc(by, word string) func(CallSite) string {
	switch by {
	case "func":
		return func(s CallSite) string {
			if s.Func == "" {
				return "(関数の外)"
			}
			return s.Func
		}
	case "file":
		return func(s CallSite) string { return s.File }
	default: // "value"
		re := assignedValueRe(word)
		return func(s CallSite) string {
			if v := assignedValue(re, s.Text); v != "" {
				return v
			}
			return "(値を読めない)"
		}
	}
}

// assignedValueRe は「その語への代入の右辺」を取り出す正規表現を組む。
var reAssignedTail = regexp.MustCompile(`\s*;.*$`)

func assignedValueRe(word string) *regexp.Regexp {
	// 複合代入（`+=` 等）は右辺だけ見ても意味が取れないので、演算子ごと見出しにする
	return regexp.MustCompile(`(?:(?:->|\.)\s*)?\b` + regexp.QuoteMeta(word) +
		`\b\s*((?:\+|-|\*|/|%|&|\||\^|<<|>>)?=)([^=].*)$`)
}

// assignedValue は行から代入の右辺を取り出す（""=取れない）。
// 値の意味は推定しない。字面をそのまま見出しにする。複数の代入が1行にある場合は
// 最初のものを採る。
func assignedValue(re *regexp.Regexp, text string) string {
	m := re.FindStringSubmatch(text)
	if m == nil {
		return ""
	}
	rhs := strings.TrimSpace(reAssignedTail.ReplaceAllString(m[2], ""))
	if rhs == "" {
		return ""
	}
	if op := m[1]; op != "=" {
		return op + " " + rhs
	}
	return rhs
}
