// Package proc は外部コマンド起動の共通ラッパー。
//
// windowsgui ビルド（grepnaviw.exe）はコンソールを持たないため、rg / global 等の
// コンソール子プロセスを普通に起動すると Windows が毎回新しいコンソール窓を
// 割り当てて画面がちらつく。全起動箇所をここ経由にして CREATE_NO_WINDOW を付ける。
package proc

import (
	"context"
	"os/exec"
)

// Command は exec.Command と同じだが、Windows ではコンソール窓を抑止する。
func Command(name string, arg ...string) *exec.Cmd {
	cmd := exec.Command(name, arg...)
	hide(cmd)
	return cmd
}

// CommandContext は exec.CommandContext と同じだが、Windows ではコンソール窓を抑止する。
func CommandContext(ctx context.Context, name string, arg ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, arg...)
	hide(cmd)
	return cmd
}
