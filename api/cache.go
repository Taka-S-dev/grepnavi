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
		// 古いエントリを1件削除
		for k, v := range _hoverCache {
			if time.Now().After(v.expiresAt) {
				delete(_hoverCache, k)
				break
			}
		}
	}
	_hoverCache[key] = hoverCacheEntry{hits: hits, expiresAt: time.Now().Add(_hoverCacheTTL)}
}

// ---- definition in-flight dedup ----
// 同一キーのリクエストが同時に来た場合、2つ目以降は最初の検索完了まで待機して結果を共有する。

type defInflightEntry struct {
	done chan struct{}
	hits []search.DefHit
	err  error
}

var (
	_defInflightMu sync.Mutex
	_defInflight   = map[string]*defInflightEntry{}
)

// defInflightDo は key に対応する fn を一度だけ実行する。
// 同じ key で同時に呼ばれた場合、後続の呼び出しは先行の完了を待つ。
func defInflightDo(key string, fn func() ([]search.DefHit, error)) ([]search.DefHit, error) {
	_defInflightMu.Lock()
	if e, ok := _defInflight[key]; ok {
		_defInflightMu.Unlock()
		<-e.done
		return e.hits, e.err
	}
	e := &defInflightEntry{done: make(chan struct{})}
	_defInflight[key] = e
	_defInflightMu.Unlock()

	e.hits, e.err = fn()

	_defInflightMu.Lock()
	delete(_defInflight, key)
	_defInflightMu.Unlock()
	close(e.done)
	return e.hits, e.err
}

// ---- definition キャッシュ ----

const (
	_defCacheTTL = 2 * time.Minute
	_defCacheMax = 200
)

type defCacheEntry struct {
	hits      []search.DefHit
	expiresAt time.Time
}

var (
	_defCacheMu sync.Mutex
	_defCache   = map[string]defCacheEntry{}
)

func defCacheGet(key string) ([]search.DefHit, bool) {
	_defCacheMu.Lock()
	defer _defCacheMu.Unlock()
	e, ok := _defCache[key]
	if !ok || time.Now().After(e.expiresAt) {
		return nil, false
	}
	return e.hits, true
}

func defCacheSet(key string, hits []search.DefHit) {
	_defCacheMu.Lock()
	defer _defCacheMu.Unlock()
	if len(_defCache) >= _defCacheMax {
		for k, v := range _defCache {
			if time.Now().After(v.expiresAt) {
				delete(_defCache, k)
				break
			}
		}
	}
	_defCache[key] = defCacheEntry{hits: hits, expiresAt: time.Now().Add(_defCacheTTL)}
}
