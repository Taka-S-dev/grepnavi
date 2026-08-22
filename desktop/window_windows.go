//go:build windows

// Package desktop は grepnavi の UI を汎用ブラウザではなく埋め込み WebView2 で表示する。
// WebView2 には拡張機能の仕組みが無いので、ブラウザタブが抱えるアドオン経由の流出経路が
// 構造的に存在しない。
//
// このパッケージは HTTP サーバ・API・グラフストアを参照せず、URL を受け取って窓を開くだけ。
// 配線は main.go に置き、ビューアをアプリ本体から疎結合に保つ。
package desktop

import (
	"errors"
	"os"
	"syscall"
	"unsafe"

	webview "github.com/jchv/go-webview2"
)

// windowTitle は意図的に空。会社利用を想定し、ウィンドウタイトル・タスクバー・トレイの
// ツールチップにツール名やファイル名を一切出さない（document.title もミラーしない）。
const windowTitle = ""

// appIconResourceID は exe に埋め込んだアイコングループのリソース ID
// （rsrc_windows_amd64.syso）。0 のままだと WebView2 窓は Windows 汎用アイコンになる。
const appIconResourceID = 1

// OpenWindow は url を埋め込み WebView2 で開き、閉じられるまでブロックする。
// WebView2 はメインスレッドでメッセージループを回すため、メインスレッドから呼ぶこと。
func OpenWindow(url string) error {
	w := webview.NewWithOptions(webview.WebViewOptions{
		Debug: false,
		WindowOptions: webview.WindowOptions{
			Title:  windowTitle,
			Width:  1400,
			Height: 900,
			Center: true,
			IconId: appIconResourceID,
		},
	})
	if w == nil {
		return errors.New("failed to create WebView2 window (is the WebView2 runtime installed?)")
	}
	defer w.Destroy()
	if os.Getenv("GREPNAVI_NATIVE_TITLEBAR") == "" {
		enableCustomTitlebar(w)
	}
	w.Navigate(url)
	w.Run()
	return nil
}

var (
	user32                = syscall.NewLazyDLL("user32.dll")
	procGetWindowLongPtrW = user32.NewProc("GetWindowLongPtrW")
	procSetWindowLongPtrW = user32.NewProc("SetWindowLongPtrW")
	procSetWindowPos      = user32.NewProc("SetWindowPos")
	procReleaseCapture    = user32.NewProc("ReleaseCapture")
	procPostMessageW      = user32.NewProc("PostMessageW")
	procShowWindow        = user32.NewProc("ShowWindow")
	procIsZoomed          = user32.NewProc("IsZoomed")
	procCallWindowProcW   = user32.NewProc("CallWindowProcW")
)

const (
	wsCaption       = 0x00C00000
	wmClose         = 0x0010
	wmNCLButtonDown = 0x00A1
	htCaption       = 2
	swMinimize      = 6
	swMaximize      = 3
	swRestore       = 9
	// SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_FRAMECHANGED
	swpApplyFrame = 0x0001 | 0x0002 | 0x0004 | 0x0020
)

// gwlStyle は GWL_STYLE (-16)。uintptr に負の定数を直接書けないので補数で表す。
const gwlStyle = ^uintptr(15)

// gwlpWndProc は GWLP_WNDPROC (-4)。
const gwlpWndProc = ^uintptr(3)

type winRect struct{ left, top, right, bottom int32 }

// framelessOrigProc は元のウィンドウプロシージャ。サブクラスから残りの
// メッセージを全部ここへ流す。プロセスにつき窓は1つ（複数窓は -view の
// 子プロセス）なのでグローバルでよい。
var framelessOrigProc uintptr

// framelessWndProc は WM_NCCALCSIZE で上辺の枠をクライアント領域に取り込む。
// WS_CAPTION を外しても WS_THICKFRAME の上辺は非クライアントのまま残り、
// Win11 がアクセント色で塗るため、窓の天辺に細い色帯が出る。既定の計算を
// 呼んだあと上辺だけ元に戻すと、帯はページ側（自前タイトルバー）の下に消える。
// 最大化中は枠が画面外へ張り出す設計なので触らない（触ると天辺が画面外に出る）。
// lp は NCCALCSIZE_PARAMS だが、先頭メンバが rgrc[0] (RECT) なので *winRect で
// 直接受ける（uintptr からの変換を書くと go vet の unsafeptr に当たる）。
func framelessWndProc(hwnd, msg, wp uintptr, r *winRect) uintptr {
	const wmNCCalcSize = 0x0083
	lp := uintptr(unsafe.Pointer(r))
	if msg == wmNCCalcSize && wp != 0 && r != nil {
		if z, _, _ := procIsZoomed.Call(hwnd); z == 0 {
			top := r.top
			ret, _, _ := procCallWindowProcW.Call(framelessOrigProc, hwnd, msg, wp, lp)
			r.top = top
			return ret
		}
	}
	ret, _, _ := procCallWindowProcW.Call(framelessOrigProc, hwnd, msg, wp, lp)
	return ret
}

// enableCustomTitlebar は OS のタイトルバーを外し、ページ側の自前バー（index.html の
// #titlebar）に窓の操作を委ねる。バインドした関数の有無がページ側の表示スイッチを
// 兼ねる: ブラウザで開いたときは関数が無いので自前バーは出ず、OS の枠のまま。
// WS_THICKFRAME は残すので、リサイズ端と Aero スナップは OS ネイティブのまま動く。
// 環境変数 GREPNAVI_NATIVE_TITLEBAR=1 で従来の OS タイトルバーに戻せる（脱出口）。
func enableCustomTitlebar(w webview.WebView) {
	hwnd := uintptr(w.Window())
	style, _, _ := procGetWindowLongPtrW.Call(hwnd, gwlStyle)
	procSetWindowLongPtrW.Call(hwnd, gwlStyle, style&^uintptr(wsCaption))
	framelessOrigProc, _, _ = procSetWindowLongPtrW.Call(hwnd, gwlpWndProc, syscall.NewCallback(framelessWndProc))
	procSetWindowPos.Call(hwnd, 0, 0, 0, 0, 0, swpApplyFrame)

	// ドラッグは JS の mousedown から合図をもらい、非クライアント領域のドラッグとして
	// OS に渡す（WebView2 が全面を覆うため、親窓の WM_NCHITTEST には届かない）。
	// SendMessage だとバインド呼び出しの中で掴みループが回るので Post にする。
	w.Bind("grepnaviWinDrag", func() {
		procReleaseCapture.Call()
		procPostMessageW.Call(hwnd, wmNCLButtonDown, htCaption, 0)
	})
	w.Bind("grepnaviWinMin", func() {
		procShowWindow.Call(hwnd, swMinimize)
	})
	w.Bind("grepnaviWinMax", func() bool {
		if z, _, _ := procIsZoomed.Call(hwnd); z != 0 {
			procShowWindow.Call(hwnd, swRestore)
			return false
		}
		procShowWindow.Call(hwnd, swMaximize)
		return true
	})
	w.Bind("grepnaviWinIsMax", func() bool {
		z, _, _ := procIsZoomed.Call(hwnd)
		return z != 0
	})
	w.Bind("grepnaviWinClose", func() {
		procPostMessageW.Call(hwnd, wmClose, 0, 0)
	})
}
