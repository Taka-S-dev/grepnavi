package search

import (
	"fmt"
	"strings"
	"testing"
)

// 遷移を "FROM1|FROM2->TO" の形へ正規化して比較する（不明は "?"）
func transKey(tr StateTransition) string {
	from := "?"
	if len(tr.From) > 0 {
		from = strings.Join(tr.From, "|")
	}
	to := tr.To
	if to == "" {
		to = "expr:" + tr.ToExpr
	}
	return fmt.Sprintf("%s->%s", from, to)
}

func scanSrc(t *testing.T, src, varName string) []string {
	t.Helper()
	trs := scanStateLines(strings.Split(src, "\n"), varName)
	var got []string
	for _, tr := range trs {
		got = append(got, transKey(tr))
	}
	return got
}

func assertTrans(t *testing.T, src, varName string, want ...string) {
	t.Helper()
	got := scanSrc(t, src, varName)
	if len(got) != len(want) {
		t.Fatalf("遷移数 = %d, want %d\ngot:  %v\nwant: %v", len(got), len(want), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("[%d] = %q, want %q\ngot all: %v", i, got[i], want[i], got)
		}
	}
}

func TestStateScanSwitchCase(t *testing.T) {
	src := `
void f(struct s *s) {
    switch (s->st) {
    case ST_A:
        s->st = ST_B;
        break;
    case ST_C:
        s->st = ST_D;
        break;
    }
}`
	assertTrans(t, src, "st", "ST_A->ST_B", "ST_C->ST_D")
}

func TestStateScanStackedLabels(t *testing.T) {
	// 積み重ねラベルはグループ全体が遷移元
	src := `
void f(struct s *s) {
    switch (s->st) {
    case ST_A:
    case ST_B:
        s->st = ST_C;
        break;
    }
}`
	assertTrans(t, src, "st", "ST_A|ST_B->ST_C")
}

func TestStateScanFallThrough(t *testing.T) {
	// break されないグループは次の case へ流れ込む（openssl の NONE 問題）
	src := `
void f(struct s *s) {
    switch (s->st) {
    case ST_A:
        prep(s);
        /* fall through */
    case ST_B:
        s->st = ST_C;
        break;
    }
}`
	assertTrans(t, src, "st", "ST_A|ST_B->ST_C")
}

func TestStateScanBreakSeparatesGroups(t *testing.T) {
	src := `
void f(struct s *s) {
    switch (s->st) {
    case ST_A:
        s->st = ST_B;
        break;
    case ST_C:
        s->st = ST_D;
        break;
    case ST_E:
        s->st = ST_F;
        break;
    }
}`
	assertTrans(t, src, "st", "ST_A->ST_B", "ST_C->ST_D", "ST_E->ST_F")
}

func TestStateScanReturnAlsoCloses(t *testing.T) {
	src := `
void f(struct s *s) {
    switch (s->st) {
    case ST_A:
        s->st = ST_B;
        return;
    case ST_C:
        s->st = ST_D;
        break;
    }
}`
	assertTrans(t, src, "st", "ST_A->ST_B", "ST_C->ST_D")
}

func TestStateScanIfCondition(t *testing.T) {
	src := `
void f(struct s *s) {
    if (s->st == ST_A) {
        s->st = ST_B;
    }
}`
	assertTrans(t, src, "st", "ST_A->ST_B")
}

func TestStateScanIfOr(t *testing.T) {
	// || は複数の遷移元
	src := `
void f(struct s *s) {
    if (s->st == ST_A || s->st == ST_B) {
        s->st = ST_C;
    }
}`
	assertTrans(t, src, "st", "ST_A|ST_B->ST_C")
}

func TestStateScanBracelessIf(t *testing.T) {
	src := `
void f(struct s *s) {
    if (s->st == ST_A)
        s->st = ST_B;
    s->st = ST_C;
}`
	// 2つ目の代入は if の外なので不明
	assertTrans(t, src, "st", "ST_A->ST_B", "?->ST_C")
}

func TestStateScanBracelessIfOtherStmt(t *testing.T) {
	// brace なし if の効力は次の1文だけ。間に別の文が入ったら失効
	src := `
void f(struct s *s) {
    if (s->st == ST_A)
        log(s);
    s->st = ST_B;
}`
	assertTrans(t, src, "st", "?->ST_B")
}

func TestStateScanNegationIsUnknown(t *testing.T) {
	// != や ! を含む条件から遷移元は言えない
	src := `
void f(struct s *s) {
    if (s->st != ST_A) {
        s->st = ST_B;
    }
    if (!(s->st == ST_C)) {
        s->st = ST_D;
    }
}`
	assertTrans(t, src, "st", "?->ST_B", "?->ST_D")
}

func TestStateScanElseIsUnknown(t *testing.T) {
	src := `
void f(struct s *s) {
    if (s->st == ST_A)
        s->st = ST_B;
    else
        s->st = ST_C;
}`
	assertTrans(t, src, "st", "ST_A->ST_B", "?->ST_C")
}

func TestStateScanElseIf(t *testing.T) {
	src := `
void f(struct s *s) {
    if (s->st == ST_A)
        s->st = ST_B;
    else if (s->st == ST_C)
        s->st = ST_D;
}`
	assertTrans(t, src, "st", "ST_A->ST_B", "ST_C->ST_D")
}

func TestStateScanDefaultIsUnknown(t *testing.T) {
	src := `
void f(struct s *s) {
    switch (s->st) {
    case ST_A:
    default:
        s->st = ST_B;
        break;
    }
}`
	assertTrans(t, src, "st", "?->ST_B")
}

func TestStateScanNestedSwitchOtherVar(t *testing.T) {
	// 別変数の switch の case を遷移元と誤認しない
	src := `
void f(struct s *s) {
    switch (s->st) {
    case ST_A:
        switch (s->other) {
        case OTHER_X:
            s->st = ST_B;
            break;
        }
        break;
    }
}`
	assertTrans(t, src, "st", "ST_A->ST_B")
}

func TestStateScanCommentAndStringDecoys(t *testing.T) {
	src := `
void f(struct s *s) {
    /* s->st = ST_OLD; は昔の実装 */
    log("s->st = ST_FAKE");
    // s->st = ST_DEAD;
    s->st = ST_B;
}`
	assertTrans(t, src, "st", "?->ST_B")
}

func TestStateScanMultilineAssign(t *testing.T) {
	src := `
void f(struct s *s) {
    s->st =
        ST_LONG_NAME;
}`
	assertTrans(t, src, "st", "?->ST_LONG_NAME")
}

func TestStateScanOneLinerCase(t *testing.T) {
	// 1行に case・代入・break が並んでもイベント順で正しく読む
	src := `
void f(struct s *s) {
    switch (s->st) {
    case ST_A: s->st = ST_B; break;
    case ST_C: s->st = ST_D; break;
    }
}`
	assertTrans(t, src, "st", "ST_A->ST_B", "ST_C->ST_D")
}

func TestStateScanPlainVariable(t *testing.T) {
	// 構造体メンバでない素の変数
	src := `
void f(void) {
    int st = ST_INIT;
    if (st == ST_INIT)
        st = ST_RUN;
}`
	assertTrans(t, src, "st", "?->ST_INIT", "ST_INIT->ST_RUN")
}

func TestStateScanNoFalseNameMatch(t *testing.T) {
	// other_st や st_extra は変数 st ではない
	src := `
void f(struct s *s) {
    s->other_st = ST_X;
    st_extra = ST_Y;
    s->st = ST_B;
}`
	assertTrans(t, src, "st", "?->ST_B")
}

func TestStateScanComparisonIsNotAssignment(t *testing.T) {
	src := `
void f(struct s *s) {
    if (s->st == ST_A)
        use(s);
    if (s->st >= ST_B)
        use(s);
}`
	assertTrans(t, src, "st")
}

func TestStateScanExprRHS(t *testing.T) {
	// 定数1個でない右辺は式のまま見せる（誤った辺にしない）
	src := `
void f(struct s *s, int saved) {
    s->st = saved;
    s->st = next_state(s);
}`
	assertTrans(t, src, "st", "?->expr:saved", "?->expr:next_state(s)")
}

func TestStateScanPreprocessorIgnored(t *testing.T) {
	// #define 本文や #if 条件を文脈・代入と誤認しない
	src := `
#define SET_ST(s) ((s)->st = ST_MACRO)
#if defined(st) && st == ST_COND
#endif
void f(struct s *s) {
    s->st = ST_B;
}`
	assertTrans(t, src, "st", "?->ST_B")
}

func TestStateScanConditionalReturnKeepsGroup(t *testing.T) {
	// brace なし if の条件付き return/break はグループを閉じない
	// （openssl の WRITE_FLUSH ケースで実際に踏んだ形）
	src := `
void f(struct s *s) {
    switch (s->st) {
    case ST_A:
        if (flush(s) != 1)
            return;
        s->st = ST_B;
        return;
    case ST_C:
        s->st = ST_D;
        break;
    }
}`
	assertTrans(t, src, "st", "ST_A->ST_B", "ST_C->ST_D")
}

// フォールスルーで到達する遷移元には印が付く（代入行だけ見ると
// 別の case の中にあるので、印が無いと誤りに見える）
func TestStateScanFellThroughMark(t *testing.T) {
	src := `
void f(struct s *s) {
    switch (s->st) {
    case ST_A:
        if (bad(s))
            return;
        /* fall through */
    case ST_B:
        s->st = ST_C;
        s->st = ST_D;
        break;
    }
}`
	trs := scanStateLines(strings.Split(src, "\n"), "st")
	if len(trs) != 2 {
		t.Fatalf("遷移数 = %d, want 2", len(trs))
	}
	// 最初の代入: ST_A は落ちてきた側、ST_B は直接入った側
	if len(trs[0].FellThrough) != 1 || trs[0].FellThrough[0].Name != "ST_A" {
		t.Errorf("FellThrough = %+v, want [ST_A]", trs[0].FellThrough)
	}
	// 2つ目は直前の代入が遷移元なのでフォールスルーではない
	if len(trs[1].FellThrough) != 0 {
		t.Errorf("代入後の遷移に印が付いた: %+v", trs[1].FellThrough)
	}
}

// フォールスルーで届いた状態が「どこで代入されたか」まで分かる
// （case ラベルが無いので、行が出ないと誤りに見える）
func TestStateScanFellThroughSetLine(t *testing.T) {
	src := `
void f(struct s *s) {
    switch (s->st) {
    case ST_RETRY:
        s->st = ST_BUSY;
        if (fail(s))
            return;
        /* fall through */
    case ST_NEXT:
        s->st = ST_DONE;
        break;
    }
}`
	trs := scanStateLines(strings.Split(src, "\n"), "st")
	last := trs[len(trs)-1]
	if len(last.FellThrough) != 1 || last.FellThrough[0].Name != "ST_BUSY" {
		t.Fatalf("FellThrough = %+v, want [ST_BUSY]", last.FellThrough)
	}
	// ST_BUSY を代入したのは 5 行目
	if last.FellThrough[0].SetLine != 5 {
		t.Errorf("SetLine = %d, want 5", last.FellThrough[0].SetLine)
	}
}

// else 節は then 節の代入を引き継がない（openssl の SSL_read_early_data:1850
// で then 節の READING が else 節の遷移元に混ざっていた）
func TestStateScanElseDoesNotInheritThen(t *testing.T) {
	src := `
void f(struct s *s) {
    switch (s->st) {
    case ST_RETRY:
        if (accepted(s)) {
            s->st = ST_READING;
            if (again(s)) {
                s->st = ST_RETRY;
                return;
            }
        } else {
            s->st = ST_DONE;
        }
        return;
    }
}`
	assertTrans(t, src, "st",
		"ST_RETRY->ST_READING",
		"ST_READING->ST_RETRY",
		// else 側は if に入る前（= ST_RETRY）から。ST_READING は含まない
		"ST_RETRY->ST_DONE")
}

// 同名ローカルへの退避は遷移ではない（openssl の SSL_write_early_data が
// この形。数えると以降の遷移元まで狂う）
func TestStateScanLocalShadowIgnored(t *testing.T) {
	src := `
void f(struct s *s) {
    int st;
    st = s->st;
    s->st = ST_BUSY;
    s->st = st;
}`
	assertTrans(t, src, "st", "?->ST_BUSY", "ST_BUSY->expr:st")
}

func TestStateScanCaseAfterUnknownAssign(t *testing.T) {
	// 不明な値を代入した後は状態も不明。case ラベルに戻してはいけない
	src := `
void f(struct s *s) {
	switch (s->st) {
	case ST_A:
		s->st = compute(s);
		s->st = ST_B;
		break;
	}
}`
	assertTrans(t, src, "st", "ST_A->expr:compute(s)", "?->ST_B")
}

// 同じ case の中で先に代入があれば、次の代入の遷移元はその値
// （openssl: case CONNECT_RETRY の中で CONNECTING を代入した後の
//  代入は CONNECT_RETRY からではなく CONNECTING からの遷移）
func TestStateScanIntraBlockPredecessor(t *testing.T) {
	src := `
void f(struct s *s) {
    switch (s->st) {
    case ST_NONE:
        if (bad(s))
            return;
        /* fall through */
    case ST_CONNECT_RETRY:
        s->st = ST_CONNECTING;
        ret = connect(s);
        if (ret <= 0) {
            s->st = ST_CONNECT_RETRY;
            return;
        }
        /* fall through */
    case ST_WRITE_RETRY:
        s->st = ST_WRITING;
        break;
    }
}`
	assertTrans(t, src, "st",
		// 最初の代入は case グループ全体（NONE から落ちてくる経路を含む）
		"ST_NONE|ST_CONNECT_RETRY->ST_CONNECTING",
		// 直前で CONNECTING にしているので、ここは CONNECTING からの遷移
		"ST_CONNECTING->ST_CONNECT_RETRY",
		// return で抜けた分は流れてこない。落ちてくるのは CONNECTING の側
		"ST_CONNECTING|ST_WRITE_RETRY->ST_WRITING")
}

// 内側の switch が別の変数を見ている場合でも、その case ラベルは合流点。
// 前の枝が break で抜けていれば、そこでの代入はこの枝には届かない。
// openssl statem.c:658 で、兄弟の枝が入れた READ_STATE_POST_PROCESS を
// default 枝が遷移元として引き継いでいた（正解は外側の READ_STATE_BODY）。
func TestStateScanInnerSwitchOnOtherVar(t *testing.T) {
	src := `
void f(void)
{
    switch (st->read_state) {
    case READ_STATE_BODY:
        switch (ret) {
        case MSG_PROCESS_CONTINUE_PROCESSING:
            st->read_state = READ_STATE_POST_PROCESS;
            break;
        default:
            st->read_state = READ_STATE_HEADER;
            break;
        }
        break;
    }
}`
	assertTrans(t, src, "read_state",
		"READ_STATE_BODY->READ_STATE_POST_PROCESS",
		"READ_STATE_BODY->READ_STATE_HEADER")
}

// 別変数の switch でも、break の無い枝からは落ちてくる。落ちてくる側の
// 遷移元は、switch に入ったときの状態と直前の枝の状態の両方。
func TestStateScanInnerSwitchFallsThrough(t *testing.T) {
	src := `
void f(void)
{
    switch (st->w) {
    case W_PRE:
        switch (ret) {
        case R_A:
            st->w = W_MID;
        default:
            st->w = W_END;
            break;
        }
        break;
    }
}`
	assertTrans(t, src, "w",
		"W_PRE->W_MID",
		"W_MID|W_PRE->W_END")
}

// 状態定数が全部大文字とは限らない。linux は `TCP_CA_Open` のように
// 大小を混ぜる。全部大文字に限ると、その状態機械はほぼ空になる。
func TestStateScanMixedCaseConstants(t *testing.T) {
	src := `
void f(void)
{
    switch (icsk->icsk_ca_state) {
    case TCP_CA_Open:
        icsk->icsk_ca_state = TCP_CA_CWR;
        break;
    case TCP_CA_CWR:
        icsk->icsk_ca_state = TCP_CA_Loss;
        break;
    }
}`
	assertTrans(t, src, "icsk_ca_state",
		"TCP_CA_Open->TCP_CA_CWR",
		"TCP_CA_CWR->TCP_CA_Loss")
}

// 小文字始まりは変数なので状態にしない（ヘルパへの変数渡し・仮引数）。
func TestStateScanLowercaseIsNotAState(t *testing.T) {
	src := `
void tcp_set_ca_state(struct sock *sk, const u8 ca_state)
{
    icsk->icsk_ca_state = ca_state;
}`
	assertTrans(t, src, "icsk_ca_state", "?->expr:ca_state")
}
