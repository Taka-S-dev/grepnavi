// 枠なしデスクトップ窓の自前タイトルバー。
// Go 側（desktop/window_windows.go の enableCustomTitlebar）が window.grepnaviWin* を
// バインドしたときだけ動く。ブラウザで開いたときはバインドが無い = OS の枠があるので
// バーごと出さない。サーバに聞かずに済ませるための、バインド有無による自己判定。
(function () {
  if (typeof window.grepnaviWinDrag !== 'function') return;
  document.body.classList.add('frameless');
  const bar = document.getElementById('titlebar');
  const syncMax = (z) => bar.classList.toggle('maximized', !!z);

  let lastDown = 0;
  document.getElementById('titlebar-drag').addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    // ドラッグは OS の掴みループ（WM_NCLBUTTONDOWN）に渡すが、そのループが
    // mouseup を飲むため dblclick イベントが発火しない。時刻の自前判定で
    // 「素早い2回押し = 最大化トグル」を拾う
    const now = Date.now();
    if (now - lastDown < 350) {
      lastDown = 0;
      window.grepnaviWinMax().then(syncMax);
      return;
    }
    lastDown = now;
    window.grepnaviWinDrag();
  });

  document.getElementById('tb-min').onclick = () => window.grepnaviWinMin();
  document.getElementById('tb-max').onclick = () => window.grepnaviWinMax().then(syncMax);
  document.getElementById('tb-close').onclick = () => window.grepnaviWinClose();

  // Win+↑ や画面端スナップなど、ボタン以外の経路で最大化されてもグリフを追従させる
  window.addEventListener('resize', () => window.grepnaviWinIsMax().then(syncMax));
  window.grepnaviWinIsMax().then(syncMax);
})();
