// 枠なしデスクトップ窓の自前タイトルバー。
// Go 側（desktop/window_windows.go の enableCustomTitlebar）が window.grepnaviWin* を
// バインドしたときだけ動く。ブラウザで開いたときはバインドが無い = OS の枠があるので
// バーごと出さない。サーバに聞かずに済ませるための、バインド有無による自己判定。
(function () {
  if (typeof window.grepnaviWinDrag !== 'function') return;
  document.body.classList.add('frameless');
  const bar = document.getElementById('titlebar');
  const syncMax = (z) => bar.classList.toggle('maximized', !!z);

  // グラフヘッダ (#tree-hdr) の中身をタイトルバーへ移し、ヘッダ行ごと畳む
  // （body.frameless の CSS が #tree-hdr を消す）。VSCode の一列型と同じ発想で、
  // OS バーを外して得た帯を「死んだ余白」でなくツールバーとして使う。
  // 各要素の動作は getElementById で配線されているため、移動しても生きている。
  document.getElementById('tb-center').appendChild(document.getElementById('tree-hdr-center'));
  document.getElementById('tb-addons').appendChild(document.getElementById('addon-buttons'));

  // メニューボタンは VSCode 同様の固定ラベル「ファイル」にする（保存アイコンと
  // シェブロンは CSS が隠す）。開いているファイル名はタイトルバーではなく
  // ステータスバーの左側に出す——バーはメニューとボタンだけの純粋な列に保つ。
  const btn = document.getElementById('btn-project-menu');
  btn.insertBefore(document.createTextNode('ファイル'), btn.firstChild);
  document.getElementById('sb').insertBefore(
    document.getElementById('project-name'), document.getElementById('enc-btn'));

  let lastDown = 0;
  const onDragDown = (e) => {
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
  };
  for (const z of document.querySelectorAll('#titlebar .tb-drag')) {
    z.addEventListener('mousedown', onDragDown);
  }

  document.getElementById('tb-min').onclick = () => window.grepnaviWinMin();
  document.getElementById('tb-max').onclick = () => window.grepnaviWinMax().then(syncMax);
  document.getElementById('tb-close').onclick = () => window.grepnaviWinClose();

  // Win+↑ や画面端スナップなど、ボタン以外の経路で最大化されてもグリフを追従させる
  window.addEventListener('resize', () => window.grepnaviWinIsMax().then(syncMax));
  window.grepnaviWinIsMax().then(syncMax);
})();
