// ===== インクルード依存グラフ（C言語アドオン） =====
// このファイルを index.html から除外するだけで機能を無効化できます。
// 対応する除外箇所:
//   static/index.html  … <link> タグ・<script> タグ・#include-overlay ブロック・#btn-include-graph ボタン
//   api/handlers.go    … /api/include-graph, /api/include-file, /api/include-by の3ルート
//   search/include.go  … ファイルごと削除可能

// ノード: { id, label, expanded, fwd:[], rev:[] }
let _incRootNode = null;
const _incNodeMap = new Map(); // id -> node
let _incSvg = null, _incRootG = null;
let _incLoadingId = null; // 展開中ノードID
const _INC_SPIN = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
let _incSpinFrame = 0, _incSpinTimer = null;

function _incLoadingBar(on) {
  let bar = document.getElementById('inc-loading-bar');
  if(!bar) {
    bar = document.createElement('div');
    bar.id = 'inc-loading-bar';
    const c = document.getElementById('include-graph-container');
    if(c) c.appendChild(bar);
  }
  bar.classList.toggle('active', on);
}

function _incSpinStart() {
  _incSpinFrame = 0;
  _incLoadingBar(true);
  if(_incSpinTimer) return;
  _incSpinTimer = setInterval(() => {
    _incSpinFrame = (_incSpinFrame + 1) % _INC_SPIN.length;
    if(_incLoadingId && _incSvg) {
      _incSvg.selectAll('g.inc-node text')
        .filter(d => d.id === _incLoadingId)
        .text(_INC_SPIN[_incSpinFrame] + ' ' + (_incNodeMap.get(_incLoadingId)?._dispLabel || _incNodeMap.get(_incLoadingId)?.label || ''));
    }
  }, 80);
}

function _incSpinStop() {
  if(_incSpinTimer) { clearInterval(_incSpinTimer); _incSpinTimer = null; }
  _incLoadingBar(false);
}

function _mkIncNode(inc) {
  return { id: inc.id, label: inc.label, expanded: false, fwd: [], rev: [] };
}

function openIncludeGraph() {
  const peekText = id('peek-file')?.textContent?.trim() || '';
  const curFile = peekText.replace(/:(\d+)$/, '');
  id('include-start').value = curFile;
  id('include-overlay').classList.add('open');
  id('include-count').textContent = '';
  id('include-graph-container').innerHTML = '';
  _incRootNode = null;
  _incNodeMap.clear();
  _incSvg = null; _incRootG = null;
  if(curFile) startIncludeGraph(curFile);
}

function closeIncludeGraph() {
  id('include-overlay').classList.remove('open');
  id('include-graph-container').innerHTML = '';
  _incRootNode = null; _incNodeMap.clear();
  _incSvg = null; _incRootG = null;
}

const _INC_NH = 28, _INC_DY = 90;
// ノード幅はラベル長に応じて動的計算
function _incNodeWidth(label) { return Math.max(120, Math.min(300, label.length * 7.5 + 24)); }
// 固定幅定数はレンダー関数が参照するため互換用
const _INC_NW = 150;

// IDを正規化（バックスラッシュ→スラッシュ、末尾スラッシュ除去）
function _incNormId(id) { return id.replace(/\\/g, '/').replace(/\/+$/, ''); }

async function startIncludeGraph(file) {
  if(!file) {
    file = id('include-start').value.trim();
    if(!file) return;
  }
  _incRootNode = null; _incNodeMap.clear();
  _incSvg = null; _incRootG = null;

  try { await loadD3(); } catch(e) { return; }

  const container = id('include-graph-container');
  container.innerHTML = '';
  const W = container.offsetWidth || 900;
  const H = container.offsetHeight || 600;

  const svg = d3.select(container).append('svg')
    .attr('width', W).attr('height', H).style('display','block');
  svg.append('defs').append('marker')
    .attr('id','inc-arrow').attr('viewBox','0 -5 10 10')
    .attr('refX', 8).attr('refY', 0)
    .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient','auto')
    .append('path').attr('d','M0,-5L10,0L0,5').attr('fill','#555');
  _incRootG = svg.append('g');
  const _incZoom = d3.zoom()
    .scaleExtent([0.1, 4])
    .filter(e => e.type === 'wheel' ? e.ctrlKey : !e.button)
    .on('zoom', e => _incRootG.attr('transform', e.transform));
  svg.call(_incZoom);
  // スクロール(ホイール)でパン、Ctrl+ホイールでズーム
  svg.on('wheel.pan', e => {
    e.preventDefault();
    _incZoom.translateBy(svg, -e.deltaX, -e.deltaY);
  });
  svg.style('cursor', 'grab');
  svg.on('mousedown.cursor', () => svg.style('cursor', 'grabbing'));
  svg.on('mouseup.cursor',   () => svg.style('cursor', 'grab'));
  _incSvg = svg;

  const normFile = _incNormId(file);
  _incRootNode = _mkIncNode({id: normFile, label: normFile.split('/').pop()});
  _incNodeMap.set(normFile, _incRootNode);

  await _incExpand(_incRootNode);
}

function _incNodeClass(node) {
  const ext = node.id.split('.').pop().toLowerCase();
  return 'inc-node ' + (['h','hpp','hh'].includes(ext) ? 'h-file' : 'c-file');
}

// 折りたたみ：ルートから到達できないノードをすべて削除
function _incCollapse(node) {
  node.expanded = false;
  node.fwd = [];
  node.rev = [];

  // ルートから到達可能なノードを再計算
  const reachable = new Set();
  function mark(n) {
    if(reachable.has(n.id)) return;
    reachable.add(n.id);
    n.fwd.forEach(mark);
    n.rev.forEach(mark);
  }
  if(_incRootNode) mark(_incRootNode);

  _incNodeMap.forEach((_, id) => { if(!reachable.has(id)) _incNodeMap.delete(id); });
  _incRender();
}

async function _incExpand(node) {
  if(_incLoadingId) return; // 展開中は無視
  if(node.expanded) { _incCollapse(node); return; }

  _incLoadingId = node.id;
  _incRender(); // ローディング状態を反映
  _incSpinStart();

  const [fR, rR] = await Promise.all([
    fetch('/api/include-file?file=' + encodeURIComponent(node.id)),
    fetch('/api/include-by?file='   + encodeURIComponent(node.id)),
  ]);
  const fwd = fR.ok ? await fR.json() : [];
  const rev = rR.ok ? await rR.json() : [];

  node.expanded = true;
  fwd.forEach(inc => {
    const nid = _incNormId(inc.id);
    let n = _incNodeMap.get(nid);
    if(!n) { n = _mkIncNode({id: nid, label: inc.label}); _incNodeMap.set(nid, n); }
    if(!node.fwd.includes(n)) node.fwd.push(n);
  });
  rev.forEach(inc => {
    const nid = _incNormId(inc.id);
    let n = _incNodeMap.get(nid);
    if(!n) { n = _mkIncNode({id: nid, label: inc.label}); _incNodeMap.set(nid, n); }
    if(!node.rev.includes(n)) node.rev.push(n);
  });

  _incSpinStop();
  _incLoadingId = null;
  _incRender();
}

// 階層レイアウト計算
function _incLayout() {
  if(!_incRootNode) return;

  // Step1: fwd BFS でルートからの深さを確定（DAG対応: 初回訪問のみ）
  const depthMap = new Map();
  depthMap.set(_incRootNode.id, 0);
  const q = [_incRootNode];
  while(q.length) {
    const n = q.shift();
    const d = depthMap.get(n.id);
    n.fwd.forEach(c => {
      if(!depthMap.has(c.id)) { depthMap.set(c.id, d+1); q.push(c); }
    });
  }

  // Step2: rev ノードに深さを割り当て（親の深さ - 1）
  // 複数の親を持つ場合は最初に見つかった深さを使用 → 1ノード1配置
  _incNodeMap.forEach(n => {
    const parentDepth = depthMap.has(n.id) ? depthMap.get(n.id) : 0;
    n.rev.forEach(rn => {
      if(!depthMap.has(rn.id)) {
        depthMap.set(rn.id, parentDepth - 1);
      }
    });
  });

  // Step3: 深さを 0 起点に正規化（rev で負になる場合を吸収）
  let minDepth = 0;
  depthMap.forEach(d => { if(d < minDepth) minDepth = d; });
  if(minDepth < 0) {
    depthMap.forEach((d, id) => depthMap.set(id, d - minDepth));
  }

  // Step4: depthMap に載っていないノードを補完
  _incNodeMap.forEach(n => {
    if(!depthMap.has(n.id)) depthMap.set(n.id, 0);
  });

  // Step5: 深さごとにノードを集める
  const levels = new Map();
  _incNodeMap.forEach(n => {
    const d = depthMap.get(n.id);
    if(!levels.has(d)) levels.set(d, []);
    levels.get(d).push(n);
  });

  // Step6: 各レベルにx,yを割り当て（ノード幅に応じた間隔）
  const GAP = 16;
  levels.forEach((nodes, depth) => {
    const widths = nodes.map(n => _incNodeWidth(n._dispLabel || n.label));
    const totalW = widths.reduce((a, b) => a + b, 0) + GAP * (nodes.length - 1);
    let cx = -totalW / 2;
    nodes.forEach((n, i) => {
      const w = widths[i];
      n._w = w;
      n._x = cx + w / 2;
      cx += w + GAP;
      n._y = depth * _INC_DY * 1.5 + 60;
    });
  });
}

function _incRender() {
  if(!_incRootG) return;

  // 同じ basename を持つノードに親ディレクトリを付加（レイアウト前に確定）
  const labelCount = new Map();
  _incNodeMap.forEach(n => { labelCount.set(n.label, (labelCount.get(n.label) || 0) + 1); });
  _incNodeMap.forEach(n => {
    if(labelCount.get(n.label) > 1) {
      const parts = n.id.split('/');
      n._dispLabel = parts.length >= 2 ? parts[parts.length-2] + '/' + n.label : n.label;
    } else {
      n._dispLabel = n.label;
    }
  });

  _incLayout();

  const NH = _INC_NH;

  // --- エッジ ---
  const allLinks = [];
  _incNodeMap.forEach(n => {
    n.fwd.forEach(c => allLinks.push({s:n, t:c, isRev:false}));
    n.rev.forEach(r => allLinks.push({s:r, t:n, isRev:true}));
  });

  const linkSel = _incRootG.selectAll('g.inc-link-g').data([0]);
  const linkG = linkSel.enter().append('g').attr('class','inc-link-g').merge(linkSel);

  const lk = linkG.selectAll('path.inc-link').data(allLinks, d => d.s.id+'→'+d.t.id);
  lk.enter().append('path')
    .attr('class', d => 'inc-link' + (d.isRev ? ' reverse' : ''))
    .merge(lk)
    .attr('d', d => {
      const x1=d.s._x||0, y1=(d.s._y||0)+NH/2;
      const x2=d.t._x||0, y2=(d.t._y||0)-NH/2;
      const my = (y1+y2)/2;
      return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
    })
    .attr('marker-end','url(#inc-arrow)');
  lk.exit().remove();

  // --- ノード ---
  const nodeSel = _incRootG.selectAll('g.inc-node-g').data([0]);
  const nodeG = nodeSel.enter().append('g').attr('class','inc-node-g').merge(nodeSel);

  const allNodes = [..._incNodeMap.values()];

  const nd = nodeG.selectAll('g.inc-node').data(allNodes, d => d.id);

  const enter = nd.enter().append('g')
    .attr('class', _incNodeClass)
    .attr('transform', d => `translate(${d._x||0},${d._y||0})`);
  enter.append('rect').attr('height',NH).attr('y',-NH/2);
  enter.append('text').attr('text-anchor','middle').attr('dy','0.35em');

  nd.exit().remove();

  // 全ノードにハンドラを毎回付け直す（新規・既存どちらにも適用）
  nodeG.selectAll('g.inc-node')
    .on('click',      (e,d) => {
      e.stopPropagation();
      if(e.ctrlKey || e.metaKey) { _incOpenFile(d); }
      else { _incExpand(d); }
    })
    .on('dblclick',   (_e,d) => _incOpenFile(d))
    .on('mouseenter', (_e,d) => _incHighlight(d))
    .on('mouseleave', ()     => _incHighlight(null));

  nodeG.selectAll('g.inc-node')
    .transition().duration(200)
    .attr('transform', d => `translate(${d._x||0},${d._y||0})`)
    .attr('class', d => _incNodeClass(d) + (d.id === _incLoadingId ? ' inc-loading' : ''));
  nodeG.selectAll('g.inc-node rect')
    .attr('width', d => d._w || _incNodeWidth(d.label))
    .attr('x',     d => -(d._w || _incNodeWidth(d.label)) / 2)
    .attr('stroke', d => {
      if(d.id === _incLoadingId) return '#f0a500';
      return d.expanded ? '#4ec9b0' : (['h','hpp','hh'].includes(d.id.split('.').pop().toLowerCase()) ? '#9cdcfe' : '#555');
    })
    .attr('stroke-dasharray', d => {
      const hasRev = [..._incNodeMap.values()].some(m => m.rev.includes(d));
      return hasRev && !d.expanded ? '4,2' : null;
    });
  nodeG.selectAll('g.inc-node text')
    .text(d => {
      if(d.id === _incLoadingId) return _INC_SPIN[_incSpinFrame] + ' ' + (d._dispLabel || d.label);
      const lbl = d._dispLabel || d.label;
      const maxCh = Math.floor((d._w || _incNodeWidth(lbl)) / 7.5) - 2;
      return lbl.length > maxCh ? lbl.slice(0, maxCh - 1) + '…' : lbl;
    });

  // ツールチップ（title要素）
  nodeG.selectAll('g.inc-node').selectAll('title').remove();
  nodeG.selectAll('g.inc-node').append('title')
    .text(d => {
      const hint = d.id === _incLoadingId ? '解析中...' :
        (d.expanded ? 'クリック: 折りたたむ' : 'クリック: 展開') +
        '\nCtrl+クリック / ダブルクリック: ファイルを開く';
      return d.id + '\n' + hint;
    });

  id('include-count').textContent = _incLoadingId
    ? '解析中…'
    : `${_incNodeMap.size} ファイル（クリック: 展開/折りたたみ　Ctrl+クリック: ファイルを開く）`;
}

function incCollapseAll() {
  if(!_incRootNode) return;
  // ルート以外を全削除、ルートだけ残して未展開に戻す
  _incNodeMap.forEach((_n, id) => {
    if(id !== _incRootNode.id) _incNodeMap.delete(id);
  });
  _incRootNode.expanded = false;
  _incRootNode.fwd = [];
  _incRootNode.rev = [];
  _incRender();
}

function _incOpenFile(d) {
  const root = (projectRoot || '').replace(/\\/g, '/').replace(/\/$/, '');
  const rel  = d.id.replace(/\\/g, '/').replace(/^\//, '');
  const p = root ? root + '/' + rel : rel;
  closeIncludeGraph();
  openPeek(p, 1);
  st('開く: ' + d.label);
}

function _incHighlight(node) {
  if(!_incRootG) return;
  if(!node) {
    // リセット
    _incRootG.selectAll('path.inc-link').classed('inc-dim', false).classed('inc-hi', false);
    _incRootG.selectAll('g.inc-node').classed('inc-dim', false).classed('inc-hi', false);
    return;
  }
  // 接続しているノードIDセットを作成
  const connectedIds = new Set([node.id]);
  _incRootG.selectAll('path.inc-link').each(function(d) {
    if(d.s === node || d.t === node) {
      connectedIds.add(d.s.id);
      connectedIds.add(d.t.id);
    }
  });
  // エッジ: 接続あり→強調、なし→暗く
  _incRootG.selectAll('path.inc-link')
    .classed('inc-hi',  d => d.s === node || d.t === node)
    .classed('inc-dim', d => d.s !== node && d.t !== node);
  // ノード: 接続あり→強調、なし→暗く
  _incRootG.selectAll('g.inc-node')
    .classed('inc-hi',  d => connectedIds.has(d.id))
    .classed('inc-dim', d => !connectedIds.has(d.id));
}
