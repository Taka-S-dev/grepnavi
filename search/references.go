package search

import "context"

// Reference は word が使われている1箇所。
//
// CallSite（呼び出し元）と違い、包含関数が特定できない箇所も落とさない。
// 構造体メンバ・グローバル変数・マクロはファイルスコープや初期化子の中で
// 参照されることが多く、それらこそ「誰が触っているか」を知りたい対象になる。
type Reference struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Text string `json:"text"`           // 参照行のソース（呼び出しか代入かを呼び出し側で判断できるように）
	Func string `json:"func,omitempty"` // 包含関数（分かる場合のみ）
}

// FindReferences は word が使われている箇所を返す。
// 戻り値の第2要素は上限で打ち切ったか、第3要素は使用したエンジン。
//
// 索引と ripgrep の使い分け・絞り込み・コメント除外は FindRefSites が持つ。
// 呼び出し元一覧と同じ経路を通すことで、片方だけが取りこぼす形にならない。
// assignOnly を立てると、その語へ書き込んでいる行だけを返す。
func FindReferences(ctx context.Context, word, dir string, limit int, assignOnly bool) ([]Reference, bool, string, error) {
	sites, engine, truncated, err := FindRefSites(ctx, RefQuery{
		Word: word, Root: dir, Limit: limit, AssignOnly: assignOnly})
	if err != nil {
		return nil, false, engine, err
	}
	refs := make([]Reference, 0, len(sites))
	for _, s := range sites {
		refs = append(refs, Reference{File: s.File, Line: s.CallLine, Text: s.Text, Func: s.Func})
	}
	return refs, truncated, engine, nil
}
