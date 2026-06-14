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

	webview "github.com/jchv/go-webview2"
)

// windowTitle は意図的に空。会社利用を想定し、ウィンドウタイトル・タスクバー・トレイの
// ツールチップにツール名やファイル名を一切出さない（document.title もミラーしない）。
const windowTitle = ""

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
		},
	})
	if w == nil {
		return errors.New("failed to create WebView2 window (is the WebView2 runtime installed?)")
	}
	defer w.Destroy()
	w.Navigate(url)
	w.Run()
	return nil
}
