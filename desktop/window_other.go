//go:build !windows

package desktop

import "errors"

// OpenWindow は Windows 以外では未対応。埋め込み WebView2 は Windows 専用で、
// 他プラットフォームは main.go のブラウザ起動を使う。
func OpenWindow(url string) error {
	return errors.New("window mode is only supported on Windows; use the default browser launch")
}
