package search

import "sort"

// StateEdge は「その状態から どこへ行くか」の1本。同じ組の代入は畳んである。
// 関数名は Funcs 表への添字。1本ごとに名前を書くと、それだけで応答の大半を
// 占める（openssl の hand_state は 157 本あり、関数名は 35 文字前後）。
type StateEdge struct {
	To    string `json:"to"`
	Fn    int    `json:"fn"`             // Funcs の添字（-1 = 関数の外）
	Kind  string `json:"kind,omitempty"` // "case" / "if" / "assign"
	Lines []int  `json:"lines"`
	Via   string `json:"via,omitempty"` // 経由したヘルパ関数
	Fell  bool   `json:"fell_through,omitempty"`
}

// StateFrom は1つの遷移元からの行き先をまとめたもの。
type StateFrom struct {
	From  string      `json:"from"` // 空 = 遷移元を特定できなかった
	Edges []StateEdge `json:"edges"`
}

// StateSummary は状態機械1つを、読める大きさにまとめたもの。
type StateSummary struct {
	Var    string   `json:"var"`
	Root   string   `json:"root"`
	Family string   `json:"family"`
	States []string `json:"states"`
	// Funcs は "path:関数名"。辺からは添字で引く
	Funcs       []string    `json:"funcs"`
	From        []StateFrom `json:"from"`
	Total       int         `json:"total"`        // 代入の総数
	UnknownFrom int         `json:"unknown_from"` // 遷移元を特定できなかった数
	Unreached   []string    `json:"unreached,omitempty"`
}

// SummarizeStateMachine は解析結果を遷移元ごとに畳む。
//
// 生のまま返すと openssl の hand_state で 34.8 KB あり、受け取る側が読めない
// （実測: エージェントはファイルへ退避して素の grep に戻った）。
// 遷移元でまとめ、関数名を表に逃がすと1桁小さくなり、しかも
// 「この状態からどこへ行けるか」という問いの形にそのまま合う。
//
// 遷移元が空のものは捨てずに from="" のまま残す。落とすと「その代入は無い」に
// 見えるが、実際は「あるが遷移元を特定できなかった」で意味が違う。
func SummarizeStateMachine(m StateMachine, root string) StateSummary {
	out := StateSummary{Var: m.Var, Root: root, Family: m.Family, Total: len(m.Transitions)}
	for _, s := range m.States {
		out.States = append(out.States, s.Name)
		if !s.Assigned && !s.Observed {
			out.Unreached = append(out.Unreached, s.Name)
		}
	}

	fnIdx := map[string]int{}
	intern := func(file, fn string) int {
		if fn == "" {
			return -1
		}
		k := relToRoot(root, file) + ":" + fn
		if i, ok := fnIdx[k]; ok {
			return i
		}
		fnIdx[k] = len(out.Funcs)
		out.Funcs = append(out.Funcs, k)
		return len(out.Funcs) - 1
	}

	type key struct {
		from, to string
		fn       int
		via      string
	}
	fromOrder := []string{}
	byFrom := map[string]*StateFrom{}
	byKey := map[key]*StateEdge{}
	for _, t := range m.Transitions {
		to := t.To
		if to == "" {
			to = "expr: " + t.ToExpr
		}
		froms := t.From
		if len(froms) == 0 {
			froms = []string{""}
			out.UnknownFrom++
		}
		fn := intern(t.File, t.Func)
		for _, f := range froms {
			g := byFrom[f]
			if g == nil {
				g = &StateFrom{From: f}
				byFrom[f] = g
				fromOrder = append(fromOrder, f)
			}
			k := key{f, to, fn, t.Via}
			e := byKey[k]
			if e == nil {
				fell := false
				for _, ft := range t.FellThrough {
					if ft.Name == f {
						fell = true
					}
				}
				g.Edges = append(g.Edges, StateEdge{To: to, Fn: fn, Kind: t.FromKind, Via: t.Via, Fell: fell})
				e = &g.Edges[len(g.Edges)-1]
				byKey[k] = e
			}
			e.Lines = append(e.Lines, t.Line)
		}
	}
	for _, f := range fromOrder {
		out.From = append(out.From, *byFrom[f])
	}
	// 遷移元の名前順。不明は最後
	sort.SliceStable(out.From, func(a, b int) bool {
		if (out.From[a].From == "") != (out.From[b].From == "") {
			return out.From[b].From == ""
		}
		return out.From[a].From < out.From[b].From
	})
	return out
}
