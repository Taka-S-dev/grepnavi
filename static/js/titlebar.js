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

  // メニューボタンは VSCode 同様の固定ラベル「ファイル」にする（保存アイコンと
  // シェブロンは CSS が隠す）。開いているファイル名はタイトルバーではなく
  // ステータスバーの左側に出す——バーはメニューとボタンだけの純粋な列に保つ。
  const btn = document.getElementById('btn-project-menu');
  btn.insertBefore(document.createTextNode('ファイル'), btn.firstChild);
  document.getElementById('sb').insertBefore(
    document.getElementById('project-name'), document.getElementById('enc-btn'));

  // 「表示」メニュー: アドオンのチップ列 (#inc / ct / jm / map / sm) は略号で
  // 読めないので、デスクトップバーでは正式名のドロップダウンに畳む。チップは
  // #tree-hdr ごと隠れたままボタンとして生きているので、項目のクリックを転送する。
  // 項目は開くたびに #addon-buttons から作り直す（アドオンの読み込みはこの後）。
  const viewBtn = document.createElement('button');
  viewBtn.id = 'btn-view-menu';
  viewBtn.textContent = '表示';
  document.getElementById('tb-center').appendChild(viewBtn);
  const viewMenu = document.createElement('div');
  viewMenu.id = 'view-menu';
  document.body.appendChild(viewMenu);
  viewBtn.onclick = (e) => {
    e.stopPropagation();
    // メニューバーは排他: 表示を開いたらファイルを閉じる（逆も下で）
    document.getElementById('project-menu').classList.remove('open');
    if (viewMenu.classList.toggle('open')) {
      viewMenu.innerHTML = '';
      // ツリーの描き方の切り替え。チェックは隠したボタンの現在状態から毎回読む
      // （btn-view のラベルは「切り替え先」を出すので、'ツリー' 表示中 = グラフ表示中）
      const toggles = [
        { id: 'btn-node-sub', label: 'パス表示', hint: 'Alt+Shift+P', on: b => b.classList.contains('on') },
        { id: 'btn-tree-memo', label: 'メモ表示', hint: 'Alt+Shift+N', on: b => b.classList.contains('on') },
        { id: 'btn-view', label: 'グラフ表示 (D3)', hint: '', on: b => b.textContent === 'ツリー' },
      ];
      for (const t of toggles) {
        const b = document.getElementById(t.id);
        if (!b) continue;
        const item = document.createElement('div');
        item.className = 'pmenu-item';
        const left = document.createElement('span');
        const tick = document.createElement('span');
        tick.className = 'pmenu-tick';
        tick.textContent = t.on(b) ? '✓' : '';
        left.appendChild(tick);
        left.appendChild(document.createTextNode(t.label));
        item.appendChild(left);
        if (t.hint) {
          const hint = document.createElement('span');
          hint.className = 'pmenu-hint';
          hint.textContent = t.hint;
          item.appendChild(hint);
        }
        item.onclick = () => { viewMenu.classList.remove('open'); b.click(); };
        viewMenu.appendChild(item);
      }
      const sep = document.createElement('div');
      sep.className = 'pmenu-separator';
      viewMenu.appendChild(sep);
      for (const b of document.querySelectorAll('#addon-buttons button')) {
        const item = document.createElement('div');
        item.className = 'pmenu-item';
        const label = document.createElement('span');
        label.textContent = b.dataset.menuLabel || b.textContent;
        item.appendChild(label);
        if (b.dataset.menuHint) {
          const hint = document.createElement('span');
          hint.className = 'pmenu-hint';
          hint.textContent = b.dataset.menuHint;
          item.appendChild(hint);
        }
        item.onclick = () => { viewMenu.classList.remove('open'); b.click(); };
        viewMenu.appendChild(item);
      }
      const r = viewBtn.getBoundingClientRect();
      viewMenu.style.top = (r.bottom + 2) + 'px';
      viewMenu.style.left = r.left + 'px';
    }
  };
  document.addEventListener('click', () => viewMenu.classList.remove('open'));
  // ファイル側のハンドラ (app.js) は stopPropagation するので、同じボタンに
  // もう1本リスナを足して表示メニューを閉じる（stopPropagation は同一要素の
  // 他リスナまでは止めない）
  document.getElementById('btn-project-menu').addEventListener('click', () => viewMenu.classList.remove('open'));

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
