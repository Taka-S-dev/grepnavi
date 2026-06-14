//go:build windows

package desktop

import (
	_ "embed"
	"log/slog"
	"os"
	"os/exec"

	"fyne.io/systray"
)

//go:embed tray_icon.ico
var trayIcon []byte

// RunTray は grepnavi をトレイ常駐させる。サーバ（呼び出し側が起動済み）はバックグラウンドで
// 動き続け、このプロセスはトレイに居座る。「開く」は同じ exe を -view <url> で別プロセス起動する
// ——トレイと WebView2 窓で Windows のメッセージループを共有させないため、窓は埋め込みでなく
// 子プロセスにしている。「終了」は開いた窓を閉じて終了。
//
// ユーザが終了するまでブロックする。systray が内部で OS スレッドをロックするので、
// メインゴルーチンから呼ぶこと。
func RunTray(url string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}

	onReady := func() {
		systray.SetIcon(trayIcon)
		systray.SetTooltip(windowTitle)
		mOpen := systray.AddMenuItem("開く", "ウィンドウを開く")
		systray.AddSeparator()
		mQuit := systray.AddMenuItem("終了", "終了する")

		go func() {
			// children はこのゴルーチンだけが触るのでロック不要。
			var children []*exec.Cmd
			open := func() {
				cmd := exec.Command(exe, "-view", url)
				if err := cmd.Start(); err != nil {
					slog.Warn("failed to open window", "err", err)
					return
				}
				children = append(children, cmd)
			}
			open() // トレイ表示と同時に窓を1枚開く
			for {
				select {
				case <-mOpen.ClickedCh:
					open()
				case <-mQuit.ClickedCh:
					for _, c := range children {
						if c.Process != nil {
							_ = c.Process.Kill()
						}
					}
					systray.Quit()
					return
				}
			}
		}()
	}

	systray.Run(onReady, func() { os.Exit(0) })
	return nil
}
