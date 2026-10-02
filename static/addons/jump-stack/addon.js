// ===== Jump Stack Addon =====
// 定義や参照へ飛んで潜っている間の「どこから来て、いま何段目か」を一覧で見せる。
// デバッガの呼び出し履歴と同じ見方で、潜ると 1 行増え、畳むと消える。
// ジャンプマップが通った経路を全部残す地図なのに対し、こちらはいま潜っている分だけ。
//
// 段そのものは本体の履歴が持つ（editor.js の jumpStackFrames）。ここは描くだけで、
// 状態は持たない。

(function() {

let _frames = [];

document.addEventListener('DOMContentLoaded', () => {
  document.body.insertAdjacentHTML('beforeend', `
    <div id="jst-sidebar" class="side-panel">
      <div id="jst-resizer"></div>
      <div id="jst-header">
        <span id="jst-title">Jump Stack</span>
        <span id="jst-depth"></span>
        <span id="jst-spacer"></span>
        <button id="jst-tile" title="並べて開く — いまの段を、浮き窓で横に並べて開く（呼ぶ側と呼ばれる側を見比べる）"><span class="jst-ico">⧉</span><span class="jst-lbl">並べて開く</span></button>
        <button id="jst-keep" title="ノードに追加 — いまのスタックの各段を、入れ子のノードとして調査ツリーに追加する（選択中のノードがあればその下）"><span class="jst-ico">＋</span><span class="jst-lbl">ノードに追加</span></button>
        <button id="jst-clear" title="クリア — スタックを全部畳む（いまいる場所は動かない）"><span class="jst-ico">⌫</span><span class="jst-lbl">クリア</span></button>
        <button id="jst-close">×</button>
      </div>
      <div id="jst-body"></div>
      <div id="jst-foot">クリック: その段へ移動　ダブルクリック: そこまで畳む　Alt+T: 1 段戻る</div>
    </div>
  `);

  const addonBar = document.getElementById('addon-buttons');
  if (addonBar) {
    const btn = document.createElement('button');
    btn.id = 'btn-jump-stack';
    btn.className = 'sec';
    btn.textContent = 'stk';
    btn.dataset.menuLabel = 'ジャンプスタック';
    btn.dataset.menuHint = 'Alt+Y';
    btn.title = 'stk — Jump Stack (定義・参照へ飛んで潜っている段の一覧)  Alt+Y';
    addonBar.appendChild(btn);
    // もう一度押したら閉じる（開くだけのボタンは、閉じ方を探させる）
    btn.onclick = () => {
      const p = document.getElementById('jst-sidebar');
      if (p.classList.contains('open')) closePanel();
      else openPanel();
    };
  }

  const resizer = document.getElementById('jst-resizer');
  const sidebar = document.getElementById('jst-sidebar');
  // 狭いモニタで縮めて使えるように、幅に応じて詰めた表示へ切り替える:
  // ボタンは記号だけ、段は 1 行（ソース行を出さない）、脚注も出さない。
  // 幅はドラッグのたびに変わるので、監視して付け外しする
  new ResizeObserver(() => {
    const narrow = sidebar.offsetWidth < JST_NARROW_WIDTH;
    if (sidebar.classList.contains('narrow') === narrow) return;
    sidebar.classList.toggle('narrow', narrow);
    render(); // 段の字下げ幅が変わる
  }).observe(sidebar);
  resizer.addEventListener('mousedown', e => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebar.offsetWidth;
    const onMove = e => {
      sidebar.style.width = Math.max(JST_MIN_WIDTH, Math.min(900, startW + startX - e.clientX)) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // デスクトップ版はボタンの並びを出さず「表示」メニューから開くので、直キーも持つ
  document.addEventListener('keydown', e => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      const p = document.getElementById('jst-sidebar');
      if (p.classList.contains('open')) closePanel();
      else openPanel();
    }
  });

  // ツリーの「色分け」を切り替えたら、こちらも塗り直す（メニューからの切り替えも
  // このボタンのクリックを経由する）
  document.getElementById('btn-tree-bands')?.addEventListener('click', () => setTimeout(render, 0));

  document.getElementById('jst-close').onclick = closePanel;
  document.getElementById('jst-clear').onclick = () => {
    if (typeof navClearOrigins === 'function') navClearOrigins();
  };
  document.getElementById('jst-tile').onclick = tileFrames;
  document.getElementById('jst-keep').onclick = () => {
    if (_frames.length && typeof keepStackAsNodes === 'function') keepStackAsNodes(_frames);
  };
  render();
});

function openPanel() {
  const panel = document.getElementById('jst-sidebar');
  panel.classList.add('open');
  window.closeOtherSidePanels?.(panel);
  render();
}

function closePanel() {
  document.getElementById('jst-sidebar').classList.remove('open');
}

// 本体の履歴が動くたびに呼ばれる。frames は古い順で { idx, file, line, text, name,
// current, top }。current はいま見ている段、top は最後のジャンプで着いた場所（ジャンプ元ではない）。
const JST_MIN_WIDTH = 180;    // これより狭いと場所（file:line）が切れる
const JST_NARROW_WIDTH = 300; // これより狭ければ詰めた表示

window.renderJumpStackPanel = function(frames) {
  _frames = frames || [];
  render();
};

function render() {
  const depth = Math.max(0, _frames.length - 1);
  // パネルを閉じていても、潜っているかどうかはボタンで分かるようにする
  const btn = document.getElementById('btn-jump-stack');
  if (btn) {
    btn.textContent = depth ? `stk ${depth}` : 'stk';
    btn.classList.toggle('on', depth > 0);
  }
  const body = document.getElementById('jst-body');
  if (!body) return;
  document.getElementById('jst-depth').textContent = depth ? `${depth} 段` : '';
  document.getElementById('jst-tile').disabled = !_frames.length;
  document.getElementById('jst-keep').disabled = !_frames.length;
  document.getElementById('jst-clear').disabled = !_frames.length;
  body.textContent = '';
  if (!_frames.length) {
    const empty = document.createElement('div');
    empty.className = 'jst-empty';
    empty.textContent = '定義や参照へ飛ぶと、ここに 1 行ずつ積み上がります。';
    body.appendChild(empty);
    return;
  }
  // ツリーと同じ色分け: 同じディレクトリは同じ色（割り当てもツリーと共有する）。
  // ツリー側の「色分け」を切っているときは、ここも塗らない。
  const bandsOn = typeof bandIndexFor === 'function' && typeof nodeDir === 'function'
    && !document.getElementById('tree')?.classList.contains('no-bands');
  const root = (typeof graph !== 'undefined' && graph && graph.root_dir) || '';
  const dirs = bandsOn ? _frames.map(f => nodeDir(f.file, root)) : [];
  // 色はツリーと同じ割り当てを使う。ただし色数が限られていて別のディレクトリが
  // 同じ色になることがあり、それが隣り合うと境目が消えるので、そこだけずらす
  const bands = bandsOn ? adjacentDistinctBands(dirs, bandIndexFor, 6) : [];
  let prevDir;
  _frames.forEach((f, depthIdx) => {
    const row = document.createElement('div');
    row.className = 'jst-row' + (f.current ? ' jst-cur' : '');
    // 深さの字下げ。狭いときは半分にして、深い段でも名前が残るようにする
    const indent = document.getElementById('jst-sidebar').classList.contains('narrow') ? 7 : 14;
    row.style.paddingLeft = (8 + depthIdx * indent) + 'px';
    const dir = bandsOn ? dirs[depthIdx] : '';
    if (bandsOn) row.classList.add('jst-band-' + bands[depthIdx]);

    const head = document.createElement('div');
    head.className = 'jst-head';
    const mark = document.createElement('span');
    mark.className = 'jst-mark';
    mark.textContent = f.current ? '▶' : (depthIdx ? '└' : '');
    const name = document.createElement('span');
    name.className = 'jst-name';
    name.textContent = f.name || '(関数の外)';
    const loc = document.createElement('span');
    loc.className = 'jst-loc';
    loc.textContent = fileName(f.file) + ':' + f.line;
    head.append(mark, name, loc);
    // 段を浮き窓で開く。吹き出しは 1 つしか出せず、クリックはエディタを移すので、
    // 呼ぶ側と呼ばれる側を並べて見比べるにはこれが要る
    const pop = document.createElement('button');
    pop.className = 'jst-pop';
    pop.textContent = '⧉';
    pop.title = 'この段を浮き窓で開く（開いたまま他の段と並べて見比べられる）';
    pop.onclick = e => { e.stopPropagation(); openFrameFloat(f); };
    pop.ondblclick = e => e.stopPropagation();
    head.appendChild(pop);
    // ディレクトリ名は、前の段と変わった行にだけ出す（そこがモジュールの境目）
    if (bandsOn) row.title = (dir || '(root)') + '\n' + f.file;
    if (bandsOn && dir !== prevDir) {
      const tag = document.createElement('span');
      tag.className = 'jst-dir';
      tag.textContent = bandLabel(dir);
      tag.title = dir || '(root)';
      head.appendChild(tag);
    }
    prevDir = dir;

    const code = document.createElement('div');
    code.className = 'jst-code';
    code.textContent = (f.text || '').trim();

    row.append(head, code);
    // クリックは移動だけ（段は残るので行き来できる）。畳むのはダブルクリック。
    // ダブルクリックは先にクリックが 2 回届くが、移動は何度やっても同じ結果になる。
    row.onclick = () => { if (typeof navGoFrame === 'function') navGoFrame(f.idx); };
    row.ondblclick = () => { if (typeof navCollapseTo === 'function') navCollapseTo(f.idx); };
    // ノードと同じ吹き出しで、移動せずに中身を確かめられる。吹き出しはパネルの左に
    // 出るので、下の段を覆わない。行のどこに乗せても出るようにして、行から吹き出しへ
    // マウスを移す距離を短くする（名前だけを目印にすると、途中で離れて消える）。
    if (typeof scheduleNodePreview === 'function') {
      const pseudo = { id: 'stack:' + f.idx, match: { file: f.file, line: f.line }, memo: '' };
      row.addEventListener('mouseenter', e => { if (!e.buttons) scheduleNodePreview(row, pseudo); });
      row.addEventListener('mouseleave', () => leaveNodePreview());
      row.addEventListener('mousedown', () => hideNodePreview());
    }
    body.appendChild(row);
    if (f.current) setTimeout(() => row.scrollIntoView({ block: 'nearest' }), 0);
  });
}

function frameTitle(f) {
  return (f.name ? f.name + '  ' : '') + fileName(f.file) + ':' + f.line;
}

function openFrameFloat(f, rect) {
  if (typeof window.showFloatingCtx !== 'function') return;
  if (typeof hideNodePreview === 'function') hideNodePreview();
  window.showFloatingCtx(f.file, f.line, { title: frameTitle(f), rect });
}

// 浅い段から深い段へ、左から横一列に並べて開く。置くのはパネルの左の領域。
// 段が多くて入りきらないときは、深い側（いま追っている側）を残す。
const TILE_MAX = 6;
function tileFrames() {
  if (!_frames.length || typeof tileRects !== 'function') return;
  const panelLeft = document.getElementById('jst-sidebar').getBoundingClientRect().left;
  const top = 64;
  const area = { left: 12, top, width: panelLeft - 24, height: Math.max(240, Math.min(window.innerHeight - top - 40, 560)) };
  const want = _frames.slice(-TILE_MAX);
  const { rects, skipped } = tileRects(want.length, area, 8, 320);
  const shown = want.slice(skipped);
  shown.forEach((f, i) => openFrameFloat(f, rects[i]));
  const dropped = _frames.length - shown.length;
  if (dropped > 0 && typeof st === 'function') st(`深い側の ${shown.length} 段を並べました（浅い側の ${dropped} 段は入りきらないので省略）`);
}

function fileName(p) {
  return (p || '').replace(/\\/g, '/').split('/').pop();
}

})();
