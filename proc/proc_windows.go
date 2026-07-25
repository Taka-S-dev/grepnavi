//go:build windows

package proc

import (
	"os/exec"
	"syscall"
)

// CREATE_NO_WINDOW: コンソールサブシステムの子プロセスにコンソールを割り当てない。
// GUI 子プロセス（explorer / ブラウザ等）の窓表示には影響しない。
const createNoWindow = 0x08000000

func hide(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNoWindow}
}
