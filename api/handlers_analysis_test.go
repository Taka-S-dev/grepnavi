package api

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"grepnavi/search"
)

// /api/macro-values: 決まる名前だけが返り、決まらない名前はキーごと出ない
func TestHandleMacroValues(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not installed")
	}
	dir := t.TempDir()
	src := "#define FATAL 64\n#define MALLOC (1|FATAL)\n"
	if err := os.WriteFile(filepath.Join(dir, "defs.h"), []byte(src), 0644); err != nil {
		t.Fatal(err)
	}
	h := &Handler{root: dir, events: NewEventBus()}

	rec := httptest.NewRecorder()
	h.handleMacroValues(rec, httptest.NewRequest("GET", "/api/macro-values?names=FATAL,MALLOC,NOPE", nil))
	if rec.Code != 200 {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var got map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["FATAL"] != "64" || got["MALLOC"] != "65" {
		t.Errorf("解決値が違う: %v", got)
	}
	if _, ok := got["NOPE"]; ok {
		t.Errorf("未定義の名前に値が出た: %v", got)
	}

	// 名前なしは 400
	rec = httptest.NewRecorder()
	h.handleMacroValues(rec, httptest.NewRequest("GET", "/api/macro-values?names=", nil))
	if rec.Code != 400 {
		t.Errorf("空の names が %d を返した（400 のはず）", rec.Code)
	}
}

// 定義の無い語を引くたびに全域スキャンへ落ちると、大きなツリーでは毎回
// 打ち切りまで待たされる（UI は「定義を検索中」のまま固まって見える）。
// 逆に確定できないのに省くと、索引の外にある定義を取りこぼす。
func TestAuthoritativeGtagsMiss(t *testing.T) {
	tests := []struct {
		name                               string
		answered, stale, preloaded, direct bool
		want                               bool
	}{
		{"直接起動で答えた: 確定できる", true, false, false, true, true},
		{"プリロード表がある: 確定できる", true, false, true, false, true},
		{"索引が古い: 確定できない", true, true, true, true, false},
		{"gtags がエラー: 確定できない", false, false, true, true, false},
		{"迂回経路かつ表も無い: 確定できない", true, false, false, false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := authoritativeGtagsMiss(tt.answered, tt.stale, tt.preloaded, tt.direct); got != tt.want {
				t.Errorf("got %v, want %v", got, tt.want)
			}
		})
	}
}

// 一覧を返す口が空を null で返すと、受け取る側の hits.length が例外になる。
// ブラウザは点滅表示を止めた後に関数ごと抜けるため、状態欄が「定義を検索中」
// のまま二度と更新されなくなる（定義の無い語で必ず起きていた）。
func TestJSONOKEmptySliceIsArray(t *testing.T) {
	cases := []struct {
		name string
		v    interface{}
		want string
	}{
		{"nil スライス", []search.DefHit(nil), "[]"},
		{"空スライス", []search.DefHit{}, "[]"},
		{"nil 文字列スライス", []string(nil), "[]"},
		{"map は素通し", map[string]string(nil), "null"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			jsonOK(w, c.v)
			if got := strings.TrimSpace(w.Body.String()); got != c.want {
				t.Errorf("got %s, want %s", got, c.want)
			}
		})
	}
}

// HTTP ヘッダ値は latin-1 として読まれるため、UTF-8 のまま非 ASCII を入れると
// 受け取り側で化ける。em ダッシュ1つで "â€“" になり、文章全体が読めなくなる。
func TestHeaderSafe(t *testing.T) {
	cases := []struct{ in, want string }{
		{"No definition for 'x' — not indexed.", "No definition for 'x' - not indexed."},
		{"a – b", "a - b"},
		{"‘q’ and “q”", "'q' and \"q\""},
		{"定義が見つかりません", ""},
		{"plain ascii", "plain ascii"},
	}
	for _, c := range cases {
		if got := headerSafe(c.in); got != c.want {
			t.Errorf("headerSafe(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// ヒント文は必ずヘッダに載るので、書いた時点で ASCII であること
// （headerSafe が最後の砦だが、そこで落とされると文章が欠ける）。
func TestDefinitionEmptyHintIsASCII(t *testing.T) {
	hint := definitionEmptyHint("X509_CRL_free", t.TempDir()) // 索引の無いツリー
	if hint == "" {
		t.Fatal("索引が無いときはヒントを返すはず")
	}
	for _, r := range hint {
		if r > 0x7f {
			t.Errorf("ヒントに非 ASCII (%q): %s", r, hint)
		}
	}
}
