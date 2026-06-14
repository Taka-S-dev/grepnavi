//go:build !windows

package desktop

import "errors"

// RunTray は Windows 以外では未対応。トレイ常駐は Windows 専用。
func RunTray(url string) error {
	return errors.New("tray mode is only supported on Windows")
}
