package api

import (
	"sync"
	"time"

	"grepnavi/search"
)

// ---- hover キャッシュ ----

const (
	_hoverCacheTTL = 2 * time.Minute
	_hoverCacheMax = 300
)

type hoverCacheEntry struct {
	hits      []search.HoverHit
	expiresAt time.Time
}

var (
	_hoverCacheMu sync.Mutex
	_hoverCache   = map[string]hoverCacheEntry{}
)

func hoverCacheGet(key string) ([]search.HoverHit, bool) {
	_hoverCacheMu.Lock()
	defer _hoverCacheMu.Unlock()
	e, ok := _hoverCache[key]
	if !ok || time.Now().After(e.expiresAt) {
		return nil, false
	}
	return e.hits, true
}

func hoverCacheSet(key string, hits []search.HoverHit) {
	_hoverCacheMu.Lock()
	defer _hoverCacheMu.Unlock()
	if len(_hoverCache) >= _hoverCacheMax {
		// 期限切れ優先、なければ任意の1件を強制削除
		deleted := false
		for k, v := range _hoverCache {
			if time.Now().After(v.expiresAt) {
				delete(_hoverCache, k)
				deleted = true
				break
			}
		}
		if !deleted {
			for k := range _hoverCache {
				delete(_hoverCache, k)
				break
			}
		}
	}
	_hoverCache[key] = hoverCacheEntry{hits: hits, expiresAt: time.Now().Add(_hoverCacheTTL)}
}

// ---- definition 検索結果 ----

// defResult は definition 検索の結果と、実際に hit を返した engine（fallback 後）の組。
// engine を hits と一緒に持ち回ることで、キャッシュヒット時や in-flight 待機側でも
// 「リクエストされた engine」ではなく「実際に使われた engine」を応答できる。
type defResult struct {
	hits   []search.DefHit
	engine string
}

// ---- definition in-flight dedup ----
// 同一キーのリクエストが同時に来た場合、2つ目以降は最初の検索完了まで待機して結果を共有する。

type defInflightEntry struct {
	done chan struct{}
	res  defResult
	err  error
}

var (
	_defInflightMu sync.Mutex
	_defInflight   = map[string]*defInflightEntry{}
)

// defInflightDo は key に対応する fn を一度だけ実行する。
// 同じ key で同時に呼ばれた場合、後続の呼び出しは先行の完了を待つ。
func defInflightDo(key string, fn func() (defResult, error)) (defResult, error) {
	_defInflightMu.Lock()
	if e, ok := _defInflight[key]; ok {
		_defInflightMu.Unlock()
		<-e.done
		return e.res, e.err
	}
	e := &defInflightEntry{done: make(chan struct{})}
	_defInflight[key] = e
	_defInflightMu.Unlock()

	e.res, e.err = fn()

	_defInflightMu.Lock()
	delete(_defInflight, key)
	_defInflightMu.Unlock()
	close(e.done)
	return e.res, e.err
}

// ---- definition キャッシュ ----

const (
	_defCacheTTL = 2 * time.Minute
	_defCacheMax = 200
)

type defCacheEntry struct {
	res       defResult
	expiresAt time.Time
}

var (
	_defCacheMu sync.Mutex
	_defCache   = map[string]defCacheEntry{}
)

func defCacheGet(key string) (defResult, bool) {
	_defCacheMu.Lock()
	defer _defCacheMu.Unlock()
	e, ok := _defCache[key]
	if !ok || time.Now().After(e.expiresAt) {
		return defResult{}, false
	}
	return e.res, true
}

func defCacheSet(key string, res defResult) {
	_defCacheMu.Lock()
	defer _defCacheMu.Unlock()
	if len(_defCache) >= _defCacheMax {
		deleted := false
		for k, v := range _defCache {
			if time.Now().After(v.expiresAt) {
				delete(_defCache, k)
				deleted = true
				break
			}
		}
		if !deleted {
			for k := range _defCache {
				delete(_defCache, k)
				break
			}
		}
	}
	_defCache[key] = defCacheEntry{res: res, expiresAt: time.Now().Add(_defCacheTTL)}
}

// defCacheClear はキャッシュ全体を破棄する。インデックス再生成後に呼び、
// 古い "見つかりません" や移動前の file:line を返し続けるのを防ぐ。
func defCacheClear() {
	_defCacheMu.Lock()
	defer _defCacheMu.Unlock()
	_defCache = map[string]defCacheEntry{}
}
