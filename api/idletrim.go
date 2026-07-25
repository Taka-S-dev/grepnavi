package api

// アイドルトリム
//
// API リクエストが途絶えたら、再構築可能なキャッシュを全て解放して OS に
// メモリを返す。トレイ常駐中に巨大 root（Linux カーネル等）のマクロキャッシュを
// 持ち続けないための仕組み。しきい値は UI の有無で二段構え:
// ウィンドウ/タブが全部閉じている（SSE 購読ゼロ）なら短く、開いたまま放置なら長く。
// トリム後の最初の操作はキャッシュの遅延再構築が走るが、マクロキャッシュは
// サイドカー（search/ctags.go 参照）からサブ秒で復元される。

import (
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"sync/atomic"
	"time"

	"grepnavi/search"
)

const (
	// UI（SSE 接続）がゼロ = ウィンドウ/タブを全て閉じてトレイに戻った状態。
	// 閉じた直後に開き直す操作で再構築が走らない程度の短い猶予で早めにトリムする。
	idleTrimAfterNoUI = 2 * time.Minute
	// UI が開いたまま操作がない状態。コードを読んでいるだけの時間に
	// トリムが頻発しないよう長めに取る。
	idleTrimAfterIdleUI = 10 * time.Minute
	idleTrimCheckEvery  = time.Minute
)

var (
	_lastActivity atomic.Int64 // UnixNano
	_idleTrimmed  atomic.Bool
)

func markActivity() {
	_lastActivity.Store(time.Now().UnixNano())
	_idleTrimmed.Store(false)
}

// ActivityMiddleware は /api/* リクエストをアイドル判定の活動として記録する。
func ActivityMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			markActivity()
		}
		next.ServeHTTP(w, r)
	})
}

// startIdleTrimmer はアイドル監視ゴルーチンを起動する（プロセス寿命で動き続ける）。
func startIdleTrimmer(events *EventBus) {
	markActivity()
	go func() {
		for range time.Tick(idleTrimCheckEvery) {
			if _idleTrimmed.Load() {
				continue
			}
			idle := time.Since(time.Unix(0, _lastActivity.Load()))
			threshold := idleTrimAfterIdleUI
			if events.SubscriberCount() == 0 {
				threshold = idleTrimAfterNoUI
			}
			if idle < threshold {
				continue
			}
			// フラグを先に立てる: 直後に activity が来た場合は markActivity が
			// false に戻すため、アイドル期間ごとのトリムは高々1回になる
			_idleTrimmed.Store(true)
			search.TrimCaches()
			hoverCacheClear()
			debug.FreeOSMemory()
			slog.Info("idle-trim: released caches and returned memory to the OS",
				"idle", idle.Round(time.Second))
		}
	}()
}
