// grepnavi -lsp への接続だけを行う定型拡張。ロジックはサーバ側（Go）にあり、
// ここは「C/C++ ファイルが開いたら grepnavi を -lsp で起動して stdio で繋ぐ」以上の
// ことをしない。会社などで拡張名を出したくない場合は package.json の displayName を
// 変えてから vsce package し直せばよい。
const os = require('os');
const { workspace, window, StatusBarAlignment } = require('vscode');
const { LanguageClient, State } = require('vscode-languageclient/node');

let client;
let status;

// ステータスバーに接続状態を出す。LSP は裏で黙って動くので、「本当に繋がって
// いるのか」「他の拡張が答えているのか」が見えないと使い手が確信を持てない。
function showState(state, serverPath) {
  const label = { [State.Running]: '$(check) grepnavi', [State.Starting]: '$(sync~spin) grepnavi',
                  [State.Stopped]: '$(circle-slash) grepnavi' }[state] || 'grepnavi';
  status.text = label;
  const detail = { [State.Running]: '接続中', [State.Starting]: '起動中',
                   [State.Stopped]: '停止（Output の grepnavi を確認）' }[state] || '';
  status.tooltip = 'grepnavi LSP: ' + detail + '\n' + serverPath;
  status.show();
}

function activate(context) {
  // serverPath は machine スコープ（package.json 側で宣言）: ワークスペース設定から
  // 上書きできない。ここで受ける値はユーザー自身が自分のマシンに書いたものだけ、が
  // この spawn の安全性の根拠なので、スコープを緩めるときはこの前提ごと見直すこと。
  const serverPath = workspace.getConfiguration('grepnavi').get('serverPath') || 'grepnavi';
  client = new LanguageClient(
    'grepnavi',
    'grepnavi',
    // cwd をホームに固定する: Windows の実行ファイル探索はカレントディレクトリを
    // 含むため、既定値のような裸のコマンド名のとき、開いたリポジトリ直下に
    // 置かれた同名 exe を拾ってしまう（binary planting）。作業場所を
    // ワークスペースの外に固定すれば、その経路は成立しない。
    // transport は指定しない: 既定が stdio であり、TransportKind.stdio を明示すると
    // クライアントが引数に --stdio を足してくる（サーバ側でも受けるが、二重に備えない）。
    { command: serverPath, args: ['-lsp'], options: { cwd: os.homedir() } },
    {
      documentSelector: [
        { scheme: 'file', language: 'c' },
        { scheme: 'file', language: 'cpp' },
      ],
    },
  );
  status = window.createStatusBarItem(StatusBarAlignment.Right, 50);
  status.command = 'workbench.action.output.toggleOutput';
  context.subscriptions.push(status);
  client.onDidChangeState((e) => showState(e.newState, serverPath));
  showState(State.Starting, serverPath);
  client.start();
}

function deactivate() {
  return client ? client.stop() : undefined;
}

module.exports = { activate, deactivate };
