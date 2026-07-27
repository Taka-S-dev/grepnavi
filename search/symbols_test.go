package search

import "testing"

// カーネルではシグネチャが複数行に渡り、末尾に sparse 注釈が付く。
// { の直前の行だけを見ると注釈が関数名になり、本当の関数がどのシンボルにも現れない。
func TestExtractSymbolsSkipsSparseAnnotations(t *testing.T) {
	lines := []string{
		"static void __ceph_flush_snaps(struct ceph_inode_info *ci,",
		"\t\t\t       struct ceph_mds_session *session)",
		"\t\t__releases(ci->i_ceph_lock)",
		"\t\t__acquires(ci->i_ceph_lock)",
		"{",
		"\tint x = 0;",
		"}",
	}
	syms := extractSymbols(lines)
	if len(syms) != 1 {
		t.Fatalf("got %d symbols, want 1: %+v", len(syms), syms)
	}
	if syms[0].Name != "__ceph_flush_snaps" {
		t.Errorf("Name = %q, want __ceph_flush_snaps", syms[0].Name)
	}
	// 開始行は注釈行ではなくシグネチャの先頭
	if syms[0].StartLine != 1 {
		t.Errorf("StartLine = %d, want 1", syms[0].StartLine)
	}
	if syms[0].EndLine != 7 {
		t.Errorf("EndLine = %d, want 7", syms[0].EndLine)
	}
}

// 引数リストの継続行は "," で終わる。そこで遡上を止めると引数の多い関数で注釈に負ける。
func TestExtractSymbolsWalksPastCommaContinuations(t *testing.T) {
	lines := []string{
		"static void __kick_flushing_caps(struct ceph_mds_client *mdsc,",
		"\t\t\t\t struct ceph_mds_session *session,",
		"\t\t\t\t struct ceph_inode_info *ci,",
		"\t\t\t\t u64 oldest_flush_tid)",
		"\t__releases(ci->i_ceph_lock)",
		"{",
		"}",
	}
	syms := extractSymbols(lines)
	if len(syms) != 1 || syms[0].Name != "__kick_flushing_caps" {
		t.Fatalf("got %+v, want a single __kick_flushing_caps", syms)
	}
}

// 単一行シグネチャは従来どおり。遡上で前の関数に引きずられない。
func TestExtractSymbolsSingleLineUnaffected(t *testing.T) {
	lines := []string{
		"int first(void)",
		"{",
		"\treturn 1;",
		"}",
		"",
		"int second(int a)",
		"{",
		"\treturn a;",
		"}",
	}
	syms := extractSymbols(lines)
	if len(syms) != 2 {
		t.Fatalf("got %d symbols, want 2: %+v", len(syms), syms)
	}
	if syms[0].Name != "first" || syms[0].StartLine != 1 {
		t.Errorf("syms[0] = %+v", syms[0])
	}
	if syms[1].Name != "second" || syms[1].StartLine != 6 {
		t.Errorf("syms[1] = %+v", syms[1])
	}
}
