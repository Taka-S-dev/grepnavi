package search

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeC(t *testing.T, src string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "a.c")
	if err := os.WriteFile(p, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// 巨大な switch の中から、その語を含む case だけを切り出す。
// 遷移関数を全文取ると 31.8 KB になるが、確かめたいのは数十行でしかない。
func TestExtractCaseBlocks(t *testing.T) {
	file := writeC(t, `int f(int x)
{
    switch (x) {
    case A:
        noise();
        break;
    case B:
    case C:
        st->hand_state = TLS_ST_OK;
        break;
    case D:
        other();
        break;
    }
    return 0;
}
`)
	blocks, err := ExtractCaseBlocks(file, 1, "TLS_ST_OK")
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 1 {
		t.Fatalf("blocks = %d, want 1: %+v", len(blocks), blocks)
	}
	b := blocks[0]
	// 連続する case は先頭まで遡る（B から入っても C から入っても同じ行に届く）
	if b.Label != "B" {
		t.Errorf("label = %q, want B", b.Label)
	}
	if !strings.Contains(b.Body, "case C:") || !strings.Contains(b.Body, "TLS_ST_OK") {
		t.Errorf("body に case C と代入が入っていない:\n%s", b.Body)
	}
	if strings.Contains(b.Body, "case A:") || strings.Contains(b.Body, "case D:") {
		t.Errorf("隣の case まで含んでいる:\n%s", b.Body)
	}
}

// case の外にある行は、塊を推測せず前後だけ返す。
func TestExtractCaseBlocksOutsideSwitch(t *testing.T) {
	file := writeC(t, `int f(void)
{
    int y = 0;
    st->hand_state = TLS_ST_BEFORE;
    return y;
}
`)
	blocks, err := ExtractCaseBlocks(file, 1, "TLS_ST_BEFORE")
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 1 || blocks[0].Label != "" {
		t.Fatalf("case の外なのにラベルが付いた: %+v", blocks)
	}
	if !strings.Contains(blocks[0].Body, "TLS_ST_BEFORE") {
		t.Errorf("body に当該行が無い:\n%s", blocks[0].Body)
	}
}

// 内側のブロックにある行でも、外側の case に正しく紐づく。
func TestExtractCaseBlocksNested(t *testing.T) {
	file := writeC(t, `int f(int x)
{
    switch (x) {
    case A:
        if (cond) {
            st->hand_state = TLS_ST_OK;
        }
        break;
    case B:
        break;
    }
}
`)
	blocks, err := ExtractCaseBlocks(file, 1, "TLS_ST_OK")
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 1 || blocks[0].Label != "A" {
		t.Fatalf("入れ子から外側の case を取れていない: %+v", blocks)
	}
}

// 値と関数でまとめた結果は行番号を持っているので、語で探し直すより直接指す方が
// 小さい。語で指定すると、その語が出てくる case を全部返すことになる。
func TestExtractCaseBlocksAt(t *testing.T) {
	file := writeC(t, `int f(int x)
{
    switch (x) {
    case A:
        st->s = V;
        break;
    case B:
        st->s = V;
        break;
    case C:
        st->s = V;
        break;
    }
}
`)
	byWord, err := ExtractCaseBlocks(file, 1, "st->s = V")
	if err != nil {
		t.Fatal(err)
	}
	if len(byWord) != 3 {
		t.Fatalf("語で指定 = %d ブロック, want 3", len(byWord))
	}
	// 行を指せば、その case だけ
	byLine, err := ExtractCaseBlocksAt(file, []int{8})
	if err != nil {
		t.Fatal(err)
	}
	if len(byLine) != 1 || byLine[0].Label != "B" {
		t.Fatalf("行で指定 = %+v, want case B のみ", byLine)
	}
	// 同じ case を指す行を複数渡しても1回だけ
	dup, err := ExtractCaseBlocksAt(file, []int{8, 9})
	if err != nil {
		t.Fatal(err)
	}
	if len(dup) != 1 {
		t.Errorf("同じ case が重複した: %+v", dup)
	}
}
