package search

// TrimCaches はアイドル時に、再構築可能なキャッシュを全て解放する。
// どれも純粋な派生データなので、次のアクセスで遅延再構築され正しさに影響しない。
// 巨大 root（Linux カーネル等）ではマクロキャッシュだけで 100MB 級になるため、
// トレイ常駐中のメモリをここで返す。
func TrimCaches() {
	CtagsMacroTrim()
	fileCache.clear()
	gtagsClearResultCaches()
	_gtagsDefsAll.Store(nil)
}
