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
	"path/filepath"
	"syscall"
	"unsafe"

	webview "github.com/jchv/go-webview2"
)

// windowTitle は意図的に空。共有画面や通知に写る環境を想定し、ウィンドウタイトル・タスクバー・トレイの
// ツールチップにツール名やファイル名を一切出さない（document.title もミラーしない）。
const windowTitle = ""

// appIconResourceID は exe に埋め込んだアイコングループのリソース ID
// （rsrc_windows_amd64.syso）。0 のままだと WebView2 窓は Windows 汎用アイコンになる。
const appIconResourceID = 1

// OpenWindow は url を埋め込み WebView2 で開き、閉じられるまでブロックする。
// WebView2 はメインスレッドでメッセージループを回すため、メインスレッドから呼ぶこと。
func OpenWindow(url string) error {
	opts := webview.WebViewOptions{
		Debug: false,
		WindowOptions: webview.WindowOptions{
			Title:  windowTitle,
			Width:  1400,
			Height: 900,
			Center: true,
			IconId: appIconResourceID,
		},
	}
	// DataPath 未指定だとライブラリが %APPDATA%\<exe名そのまま> (grepnaviw.exe\ 等) を
	// 掘る。製品名のフォルダへ固定する。
	if appData := os.Getenv("APPDATA"); appData != "" {
		opts.DataPath = filepath.Join(appData, "grepnavi")
	}
	w := webview.NewWithOptions(opts)
	if w == nil {
		return errors.New("failed to create WebView2 window (is the WebView2 runtime installed?)")
	}
	defer w.Destroy()
	fitToWorkArea(w)
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

	procGetWindowRect         = user32.NewProc("GetWindowRect")
	procMonitorFromWindow     = user32.NewProc("MonitorFromWindow")
	procGetMonitorInfoW       = user32.NewProc("GetMonitorInfoW")
	procSystemParametersInfoW = user32.NewProc("SystemParametersInfoW")
	procCallWindowProcW       = user32.NewProc("CallWindowProcW")
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

type winPoint struct{ x, y int32 }

// minMaxInfo は WM_GETMINMAXINFO の MINMAXINFO。
type minMaxInfo struct {
	ptReserved     winPoint
	ptMaxSize      winPoint
	ptMaxPosition  winPoint
	ptMinTrackSize winPoint
	ptMaxTrackSize winPoint
}

type monitorInfo struct {
	cbSize    uint32
	rcMonitor winRect
	rcWork    winRect
	dwFlags   uint32
}

// framelessWndProc は枠を外した窓の2点を補正する。
//
//  1. WM_NCCALCSIZE: 枠をクライアント領域に取り込む。WS_CAPTION を外しても
//     WS_THICKFRAME の上辺は非クライアントのまま残り、Win11 がアクセント色で
//     塗るため天辺に細い色帯が出る。通常時は上辺だけ、最大化中は四辺すべてを
//     取り込む（下の 2 で窓が作業領域ぴったりになるので、枠を残すと縁に隙間が出る）。
//  2. WM_GETMINMAXINFO: 最大化サイズを作業領域に収める。既定ではモニタ全面を
//     覆う大きさになり、シェルがフルスクリーンのアプリとみなしてタスクバーを
//     引っ込めてしまう。
//
// lp は NCCALCSIZE_PARAMS / MINMAXINFO だが、どちらも先頭が扱いたい構造体なので
// *winRect で受けて読み替える（uintptr からの変換を書くと go vet の unsafeptr に当たる）。
func framelessWndProc(hwnd, msg, wp uintptr, r *winRect) uintptr {
	const (
		wmNCCalcSize    = 0x0083
		wmGetMinMaxInfo = 0x0024
	)
	lp := uintptr(unsafe.Pointer(r))
	switch {
	case msg == wmNCCalcSize && wp != 0 && r != nil:
		if z, _, _ := procIsZoomed.Call(hwnd); z != 0 {
			return 0 // 最大化中: 窓全体をクライアントにする（枠の分の隙間を作らない）
		}
		top := r.top
		ret, _, _ := procCallWindowProcW.Call(framelessOrigProc, hwnd, msg, wp, lp)
		r.top = top
		return ret
	case msg == wmGetMinMaxInfo && r != nil:
		if wa, mon, ok := workAreaOf(hwnd); ok {
			mmi := (*minMaxInfo)(unsafe.Pointer(r))
			mmi.ptMaxPosition = winPoint{wa.left - mon.left, wa.top - mon.top}
			mmi.ptMaxSize = winPoint{wa.right - wa.left, wa.bottom - wa.top}
			return 0
		}
	}
	ret, _, _ := procCallWindowProcW.Call(framelessOrigProc, hwnd, msg, wp, lp)
	return ret
}

// workAreaOf は窓が乗っているモニタの作業領域（タスクバーを除く）と、
// モニタ全体の矩形を返す。
func workAreaOf(hwnd uintptr) (work, monitor winRect, ok bool) {
	const monitorDefaultToNearest = 2
	hmon, _, _ := procMonitorFromWindow.Call(hwnd, monitorDefaultToNearest)
	if hmon == 0 {
		return winRect{}, winRect{}, false
	}
	var mi monitorInfo
	mi.cbSize = uint32(unsafe.Sizeof(mi))
	if r, _, _ := procGetMonitorInfoW.Call(hmon, uintptr(unsafe.Pointer(&mi))); r == 0 {
		return winRect{}, winRect{}, false
	}
	return mi.rcWork, mi.rcMonitor, true
}

// fitToWorkArea は既定サイズ 1400x900 がモニタの作業領域（タスクバーを除く）から
// はみ出すとき、収まるサイズへ縮めて中央へ置き直す。スケーリングの効いたノート
// （125〜200% 表示、実効幅 1280〜1368px）では既定サイズのほうが画面より大きい。
func fitToWorkArea(w webview.WebView) {
	const spiGetWorkArea = 0x0030
	const swpNoZOrder = 0x0004
	var wa winRect
	if r, _, _ := procSystemParametersInfoW.Call(spiGetWorkArea, 0, uintptr(unsafe.Pointer(&wa)), 0); r == 0 {
		return
	}
	hwnd := uintptr(w.Window())
	var wr winRect
	if r, _, _ := procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&wr))); r == 0 {
		return
	}
	waW, waH := wa.right-wa.left, wa.bottom-wa.top
	width, height := wr.right-wr.left, wr.bottom-wr.top
	if width <= waW && height <= waH {
		return
	}
	if width > waW {
		width = waW
	}
	if height > waH {
		height = waH
	}
	x := wa.left + (waW-width)/2
	y := wa.top + (waH-height)/2
	procSetWindowPos.Call(hwnd, 0, uintptr(x), uintptr(y), uintptr(width), uintptr(height), swpNoZOrder)
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
