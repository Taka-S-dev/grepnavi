// grepnavi -lsp への接続を行う定型拡張。ロジックはサーバ側（Go）にあり、
// ここは「C/C++ ファイルが開いたら grepnavi を -lsp で起動して stdio で繋ぐ」と、
// サーバからの独自通知（無効領域）を装飾に変える以上のことをしない。
//
// 利用者に見える名前は package.json の displayName から取る（ステータスバー・
// Output のチャンネル名・クラッシュ通知）。ツール名を表に出したくない環境では
// displayName を変えて vsce package し直せば、名前の出る場所がすべて揃って変わる。
// 拡張 ID と設定キー grepnavi.* は変えない: 変えると別拡張の扱いになり設定が
// 引き継がれない。
const os = require('os');
const { workspace, window, StatusBarAlignment, Range } = require('vscode');
const { LanguageClient, State } = require('vscode-languageclient/node');

let client;
let status;
let brand = 'grepnavi';

// ステータスバーに接続状態を出す。LSP は裏で黙って動くので、「本当に繋がって
// いるのか」「他の拡張が答えているのか」が見えないと使い手が確信を持てない。
// 文字は設定 statusBarLabel で差し替えられる（null = displayName、"" = アイコンだけ）。
function showState(state, serverPath) {
  const icon = { [State.Running]: '$(check)', [State.Starting]: '$(sync~spin)',
                 [State.Stopped]: '$(circle-slash)' }[state] || '';
  const custom = workspace.getConfiguration('grepnavi').get('statusBarLabel');
  const label = custom === null || custom === undefined ? brand : custom;
  status.text = [icon, label].filter(Boolean).join(' ');
  const detail = { [State.Running]: '接続中', [State.Starting]: '起動中',
                   [State.Stopped]: `停止（Output の ${brand} を確認）` }[state] || '';
  status.tooltip = `${brand}: ${detail}\n${serverPath}`;
  status.show();
}

// 無効領域（構成で偽になる #if ブロックと #if 0）。サーバが grepnavi/inactiveRegions
// で送ってくる行範囲を、GUI のグレーアウトと同じく薄くする。URI ごとに覚えて
// おき、エディタが切り替わっても塗り直せるようにする。
const inactiveDecoration = window.createTextEditorDecorationType({ opacity: '0.45' });
const inactiveByUri = new Map();

function applyInactive(editor) {
  if (!editor) return;
  const ranges = inactiveByUri.get(editor.document.uri.toString()) || [];
  editor.setDecorations(inactiveDecoration,
    ranges.map((r) => new Range(r.start.line, 0, r.end.line, Number.MAX_SAFE_INTEGER)));
}

function activate(context) {
  brand = context.extension.packageJSON.displayName || brand;
  // serverPath は machine スコープ（package.json 側で宣言）: ワークスペース設定から
  // 上書きできない。ここで受ける値はユーザー自身が自分のマシンに書いたものだけ、が
  // この spawn の安全性の根拠なので、スコープを緩めるときはこの前提ごと見直すこと。
  const config = workspace.getConfiguration('grepnavi');
  const serverPath = config.get('serverPath') || 'grepnavi';
  client = new LanguageClient(
    'grepnavi',
    brand,
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
      // #ifdef の構成。GUI の条件リストと同じ "CONFIG_X=1 DEBUG=0" の書き方。
      // 関数にしておくと restart のたびに読み直され、設定変更が効く
      initializationOptions: () => ({ defines: workspace.getConfiguration('grepnavi').get('defines') || '' }),
    },
  );
  status = window.createStatusBarItem(StatusBarAlignment.Right, 50);
  status.name = brand;
  status.command = 'workbench.action.output.toggleOutput';
  context.subscriptions.push(status, inactiveDecoration);
  client.onDidChangeState((e) => showState(e.newState, serverPath));
  client.onNotification('grepnavi/inactiveRegions', (p) => {
    inactiveByUri.set(p.uri, p.ranges || []);
    for (const ed of window.visibleTextEditors) {
      if (ed.document.uri.toString() === p.uri) applyInactive(ed);
    }
  });
  context.subscriptions.push(
    window.onDidChangeActiveTextEditor(applyInactive),
    workspace.onDidChangeConfiguration((e) => {
      // 構成を変えたらサーバを起動し直す（initializationOptions で渡すため）
      if (e.affectsConfiguration('grepnavi.defines')) client.restart();
      if (e.affectsConfiguration('grepnavi.statusBarLabel')) showState(client.state, serverPath);
    }),
  );
  showState(State.Starting, serverPath);
  client.start();
}

function deactivate() {
  return client ? client.stop() : undefined;
}

module.exports = { activate, deactivate };
