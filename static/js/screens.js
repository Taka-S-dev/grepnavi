// ===== 画面 =====
// 画面は「ファイルタブの並び・アクティブなタブ・移動の履歴」の組。Neovim の
// タブページにあたる。ファイルの中身（Monaco のモデル）は画面をまたいで共有し、
// 画面ごとに持つのは見え方だけ。state.js の tabs / activeTabIdx / navHistory は
// 「いまの画面」の中身で、画面を切り替えるときに差し替える。
//
// モデルの寿命はここだけが決める。タブを閉じるときに直接 dispose すると、別の
// 画面で同じファイルを開いていたときに、その画面のエディタが空になる。

const _screens = [{ tabs: [], activeTabIdx: -1, nav: { history: [], index: -1 } }];
let _screenIdx = 0;

// どの画面のどのタブからも使われていないモデルだけを捨てる。
// 呼ぶ側は、タブを一覧から外した「後」に呼ぶ（外す前だと自分が使用者に数えられる）
function releaseTabModel(model) {
  if (!model || model.isDisposed?.()) return;
  for (let i = 0; i < _screens.length; i++) {
    const list = i === _screenIdx ? tabs : _screens[i].tabs;
    if (list.some(t => t.model === model)) return;
  }
  model.dispose();
}

// 全画面のタブを捨てる（プロジェクトの切り替えなど、開いているものを全部閉じるとき）
function resetScreens() {
  for (let i = 0; i < _screens.length; i++) {
    const list = i === _screenIdx ? tabs : _screens[i].tabs;
    for (const t of list) { try { t.model?.dispose(); } catch (_) {} }
  }
  _screens.length = 1;
  _screens[0] = { tabs: [], activeTabIdx: -1, nav: { history: [], index: -1 } };
  _screenIdx = 0;
  tabs = []; activeTabIdx = -1;
  navHistory.length = 0; navIndex = -1;
}
