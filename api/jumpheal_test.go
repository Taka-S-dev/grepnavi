package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"grepnavi/graph"
	"grepnavi/search"
)

func newJumpHealHandler(t *testing.T) (*Handler, string) {
	t.Helper()
	dir := t.TempDir()
	st := graph.NewStore(filepath.Join(dir, "g.json"), dir)
	t.Cleanup(st.Close)
	return &Handler{store: st, root: dir, events: NewEventBus()}, dir
}

func writeSrc(t *testing.T, dir, name, body string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// 索引の行番号がずれていても、記録された行テキストが1箇所だけに一致するなら
// そこへ寄せる。ずれの原因 (デバッグ行の挿入・外部編集) は問わない。
func TestHealedLineFollowsMovedText(t *testing.T) {
	h, dir := newJumpHealHandler(t)
	src := writeSrc(t, dir, "t.c", "a\nprobe1\nprobe2\nb\nvoid target(void)\n{\n}\n")

	if got := h.healedLine(src, 3, "void target(void)"); got != 5 {
		t.Errorf("下へずれた行に追従するはず: got %d, want 5", got)
	}
	src2 := writeSrc(t, dir, "u.c", "void target(void)\n{\n}\n")
	if got := h.healedLine(src2, 3, "void target(void)"); got != 1 {
		t.Errorf("上方向にも追従するはず: got %d, want 1", got)
	}
}

// 索引は行テキストの空白の連続を1つに畳んで持つ。生の行と単純比較すると、
// タブ揃えされた行が常に不一致になって追従が働かない。
func TestHealedLineMatchesCollapsedWhitespace(t *testing.T) {
	h, dir := newJumpHealHandler(t)
	src := writeSrc(t, dir, "t.c", "pad\nint\tfoo(void)\n{\n}\n")

	// 索引側は "int foo(void)"（空白1つ）、ファイル側はタブ
	if got := h.healedLine(src, 1, "int foo(void)"); got != 2 {
		t.Errorf("空白の畳み込みを揃えて比較するはず: got %d, want 2", got)
	}
	// ずれていない場合も、畳み込みの違いだけで「ずれた」と誤判定しない
	if got := h.healedLine(src, 2, "int foo(void)"); got != 2 {
		t.Errorf("一致しているものを動かしてはいけない: got %d, want 2", got)
	}
}

// 書式だけが違う双子の行があるとき、畳み込み比較なら両方に一致して
// 「複数一致」になり動かない。畳み込まないと片方だけに一意一致して、
// 正しい着地点を壊す。
func TestHealedLineKeepsLineWhenFormattingTwinExists(t *testing.T) {
	h, dir := newJumpHealHandler(t)
	src := writeSrc(t, dir, "t.c", "#define FOO 1\n#else\n#define FOO\t1\n#endif\n")

	if got := h.healedLine(src, 3, "#define FOO 1"); got != 3 {
		t.Errorf("双子の行があるときは動かさないはず: got %d, want 3", got)
	}
}

// ctags は行番号形式のアドレスだとパターンを持たず、行テキストがシンボル名
// そのものになる。それを手掛かりに探すと、識別子1個だけの行 (初期化子など) へ
// 引き剥がされる。手掛かりとして使えないテキストは判定に使わない。
func TestHealedLineIgnoresBareIdentifierAnchor(t *testing.T) {
	h, dir := newJumpHealHandler(t)
	src := writeSrc(t, dir, "t.c", "static const ops_t o = {\n\tfoo\n};\n\nint foo(void)\n{\n}\n")

	if got := h.healedLine(src, 5, "foo"); got != 5 {
		t.Errorf("識別子だけの手掛かりでは動かさないはず: got %d, want 5", got)
	}
}

// 動かしてよいのは行き先が1つに絞れるときだけ。曖昧なとき・見つからないとき・
// 読めないときは索引の値をそのまま返す（もっともらしく間違えない）。
func TestHealedLineKeepsLineWhenAmbiguous(t *testing.T) {
	h, dir := newJumpHealHandler(t)
	src := writeSrc(t, dir, "t.c", "x = 1;\n}\ny = 2;\n}\nz = 3;\n")

	cases := []struct {
		name string
		file string
		line int
		text string
		want int
	}{
		{"複数一致は動かさない", src, 1, "}", 1},
		{"一致なしは動かさない", src, 2, "void gone(void)", 2},
		{"読めないファイルは動かさない", filepath.Join(dir, "none.c"), 7, "x = 1;", 7},
		{"テキストが無ければ判定しない", src, 3, "   ", 3},
		{"行番号が無ければ判定しない", src, 0, "x = 1;", 0},
	}
	for _, c := range cases {
		if got := h.healedLine(c.file, c.line, c.text); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}
}

// ファイルが縮んで記録行が末尾を超えていても、探索へ進んで追従できる。
func TestHealedLineHandlesShrunkFile(t *testing.T) {
	h, dir := newJumpHealHandler(t)
	src := writeSrc(t, dir, "t.c", "int foo(void)\n{\n}\n")

	if got := h.healedLine(src, 99, "int foo(void)"); got != 1 {
		t.Errorf("末尾超過でも追従するはず: got %d, want 1", got)
	}
}

// 相対パスのヒットも root 基準で解決してから照合する。
func TestHealedLineResolvesRelativePath(t *testing.T) {
	h, dir := newJumpHealHandler(t)
	writeSrc(t, dir, "t.c", "a\nb\nvoid target(void)\n")

	if got := h.healedLine("t.c", 1, "void target(void)"); got != 3 {
		t.Errorf("相対パスでも追従するはず: got %d, want 3", got)
	}
}

// 動かしたヒットには印を付ける。黙って動かすと、外したときに気づけない。
func TestHealDefHitsMarksMovedHits(t *testing.T) {
	h, dir := newJumpHealHandler(t)
	src := writeSrc(t, dir, "t.c", "pad\npad\nvoid target(void)\nvoid other(void)\n")

	hits := h.healDefHits([]search.DefHit{
		{File: src, Line: 1, Text: "void target(void)"}, // ずれている
		{File: src, Line: 4, Text: "void other(void)"},  // ずれていない
	})
	if hits[0].Line != 3 || !hits[0].Healed {
		t.Errorf("動かしたヒット: got line=%d healed=%v, want 3/true", hits[0].Line, hits[0].Healed)
	}
	if hits[1].Line != 4 || hits[1].Healed {
		t.Errorf("動かしていないヒットに印を付けてはいけない: got line=%d healed=%v", hits[1].Line, hits[1].Healed)
	}
}

// シンボル名検索は決定時に1件だけ直す。ハンドラは root の外を触らない。
func TestHandleHealLine(t *testing.T) {
	h, dir := newJumpHealHandler(t)
	src := writeSrc(t, dir, "t.c", "pad\npad\nvoid target(void)\n")

	q := url.Values{"file": {src}, "line": {"1"}, "text": {"void target(void)"}}
	rec := httptest.NewRecorder()
	h.handleHealLine(rec, httptest.NewRequest("GET", "/api/heal-line?"+q.Encode(), nil))
	var got struct {
		Line   int  `json:"line"`
		Healed bool `json:"healed"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Line != 3 || !got.Healed {
		t.Errorf("heal-line = %+v, want line=3 healed=true", got)
	}

	outside := url.Values{"file": {filepath.Join(dir, "..", "elsewhere.c")}, "line": {"1"}, "text": {"void target(void)"}}
	rec = httptest.NewRecorder()
	h.handleHealLine(rec, httptest.NewRequest("GET", "/api/heal-line?"+outside.Encode(), nil))
	if rec.Code != http.StatusForbidden {
		t.Errorf("root の外は拒否するはず: got %d", rec.Code)
	}

	bad := url.Values{"file": {src}, "line": {"0"}}
	rec = httptest.NewRecorder()
	h.handleHealLine(rec, httptest.NewRequest("GET", "/api/heal-line?"+bad.Encode(), nil))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("行番号が不正なら 400 のはず: got %d", rec.Code)
	}
}
