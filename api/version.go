package api

import (
	"runtime/debug"
	"sync"
)

var (
	buildOnce  sync.Once
	buildStamp string
)

// BuildStamp はこのバイナリのコミットとビルド時刻。「動いているのは直した版か」
// が現地で分からないと、修正済みの症状を古いバイナリで再報告する往復が起きる
// （実際に2回起きた）。go build が埋める VCS 情報なので、ソース側の更新は不要。
func BuildStamp() string {
	buildOnce.Do(func() {
		buildStamp = "unknown"
		bi, ok := debug.ReadBuildInfo()
		if !ok {
			return
		}
		rev, at, dirty := "", "", ""
		for _, s := range bi.Settings {
			switch s.Key {
			case "vcs.revision":
				rev = s.Value
				if len(rev) > 9 {
					rev = rev[:9]
				}
			case "vcs.time":
				at = s.Value
			case "vcs.modified":
				if s.Value == "true" {
					dirty = "+dirty"
				}
			}
		}
		if rev != "" {
			buildStamp = rev + dirty + " " + at
		}
	})
	return buildStamp
}
