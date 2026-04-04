// ===== C言語 インクルード依存グラフ アドオン =====
// このファイル単体で完結しています（HTML注入・イベント登録を含む）。
//
// バックエンド対応ルート（api/handlers.go に登録が必要）:
//   /api/include-file  → search.GetFileIncludes
//   /api/include-by    → search.GetIncludedBy
// バックエンドロジック: search/include.go

// ----- HTML注入 & イベント登録 -----
document.addEventListener('DOMContentLoaded', () => {
  // オーバーレイを body に追加
  document.body.insertAdjacentHTML('beforeend', `
    <div id="include-overlay">
      <div id="include-hdr">
        <span id="include-title">インクルード依存グラフ</span>
        <span id="include-hdr-right">
          <input id="include-start" type="text" placeholder="起点ファイル (自動セット)" spellcheck="false" title="起点ファイルパス">
          <button id="include-analyze">解析</button>
          <button class="sec" id="include-collapse-all" title="すべて折りたたむ">折りたたむ</button>
          <span id="include-count"></span>
          <button class="sec" id="include-export-svg" title="SVG として保存">SVG</button>
          <button class="sec" id="include-export-png" title="PNG として保存">PNG</button>
          <button class="sec" id="include-export-drawio" title="draw.io 形式で保存">draw.io</button>
          <button class="sec" id="include-close" title="閉じる"><i class="codicon codicon-close"></i></button>
        </span>
      </div>
      <div id="include-graph-container"></div>
    </div>
  `);

  // ボタンを #addon-buttons に追加
  const addonBar = document.getElementById('addon-buttons');
  if(addonBar) {
    const btn = document.createElement('button');
    btn.className = 'sec';
    btn.id = 'btn-include-graph';
    btn.title = 'インクルード依存グラフ';
    btn.textContent = '#inc';
    addonBar.appendChild(btn);
  }

  // イベント登録
  document.getElementById('btn-include-graph').onclick    = openIncludeGraph;
  // オーバーレイ内のキー操作がメインアプリに漏れないようにする
  document.getElementById('include-overlay').addEventListener('keydown', e => e.stopPropagation());

  document.getElementById('include-analyze').onclick      = () => startIncludeGraph();
  document.getElementById('include-collapse-all').onclick = incCollapseAll;
  document.getElementById('include-export-svg').onclick   = incExportSvg;
  document.getElementById('include-export-png').onclick   = incExportPng;
  document.getElementById('include-export-drawio').onclick = incExportDrawio;
  document.getElementById('include-close').onclick        = closeIncludeGraph;

  // C ファイルの有無でボタン表示を制御
  _incUpdateBtn();
  // ルート変更を監視して再チェック
  const rootText = document.getElementById('root-chip-text');
  if(rootText) new MutationObserver(_incUpdateBtn).observe(rootText, {childList:true, characterData:true, subtree:true});
});

async function _incUpdateBtn() {
  const btn = document.getElementById('btn-include-graph');
  if(!btn) return;
  try {
    const files = await fetch('/api/files?glob=*.c,*.h,*.cpp,*.hpp,*.cc').then(r => r.json());
    const hasC = Array.isArray(files) && files.length > 0;
    btn.style.display = hasC ? '' : 'none';
  } catch(_) {
    btn.style.display = 'none';
  }
}

// ----- 以下、グラフロジック -----

// ノード: { id, label, expanded, fwd:[], rev:[] }
let _incRootNode = null;
const _incNodeMap = new Map(); // id -> node
let _incSvg = null, _incRootG = null;
let _incLoadingId = null; // 展開中ノードID
let _incAbortCtrl = null; // fetch 中断用

const MAX_INC_REV   = 60; // included-by の表示上限
const MAX_INC_TRANS = 40; // これ以上のノード数ではトランジションをスキップ

function _mkIncNode(inc) {
  return { id: inc.id, label: inc.label, expanded: false, fwd: [], rev: [] };
}

function openIncludeGraph() {
  const peekText = id('peek-file')?.value?.trim() || '';
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

function _incCancelExpand() {
  if(!_incLoadingId) return;
  if(_incAbortCtrl) { _incAbortCtrl.abort(); _incAbortCtrl = null; }
}

function closeIncludeGraph() {
  _incCancelExpand();
  id('include-overlay').classList.remove('open');
  id('include-graph-container').innerHTML = '';
  _incRootNode = null; _incNodeMap.clear();
  _incSvg = null; _incRootG = null;
}

const _INC_NH = 28, _INC_DY = 90;
function _incNodeWidth(label) { return Math.max(120, Math.min(300, label.length * 7.5 + 24)); }
const _INC_NW = 150;

function _incNormId(id) { return id.replace(/\\/g, '/').replace(/\/+$/, ''); }

function _incLoadingBar(on) {
  let ov = document.getElementById('inc-loading-overlay');
  if(!ov) {
    ov = document.createElement('div');
    ov.id = 'inc-loading-overlay';
    ov.innerHTML = '<div id="inc-loading-ring"></div><div id="inc-loading-cancel">ESC でキャンセル</div>';
    ov.style.pointerEvents = 'auto';
    ov.onclick = () => _incCancelExpand();
    const c = document.getElementById('include-graph-container');
    if(c) c.appendChild(ov);
  }
  ov.classList.toggle('active', on);
}

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
  const _incZoom = d3.zoom().scaleExtent([0.1,4]).on('zoom', e => _incRootG.attr('transform', e.transform));
  svg.call(_incZoom);
  // 初期位置を中央に
  svg.call(_incZoom.transform, d3.zoomIdentity.translate(W / 2, 60));
  _incSvg = svg;

  const normFile = _incNormId(file);
  _incRootNode = _mkIncNode({id: normFile, label: normFile.split('/').pop()});
  _incNodeMap.set(normFile, _incRootNode);

  await _incExpand(_incRootNode);
}

function _incNodeClass(node) {
  const ext = node.id.split('.').pop().toLowerCase();
  const typeClass = ['h','hpp','hh'].includes(ext) ? 'h-file' : 'c-file';
  const rootClass = node === _incRootNode ? ' inc-root' : '';
  const expandedClass = node.expanded ? ' inc-expanded' : '';
  return 'inc-node ' + typeClass + rootClass + expandedClass;
}

function _incCollapse(node) {
  node.expanded = false;
  node.fwd = [];
  node.rev = [];
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
  if(_incLoadingId) { _incCancelExpand(); return; }
  if(node.expanded) { _incCollapse(node); return; }

  _incAbortCtrl = new AbortController();
  const signal = _incAbortCtrl.signal;
  _incLoadingId = node.id;
  _incRender();
  _incLoadingBar(true);

  try {
    const [fR, rR] = await Promise.all([
      fetch('/api/include-file?file=' + encodeURIComponent(node.id), {signal}),
      fetch('/api/include-by?file='   + encodeURIComponent(node.id), {signal}),
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
    const revList = rev.length > MAX_INC_REV ? rev.slice(0, MAX_INC_REV) : rev;
    const revOver = rev.length - revList.length;
    revList.forEach(inc => {
      const nid = _incNormId(inc.id);
      let n = _incNodeMap.get(nid);
      if(!n) { n = _mkIncNode({id: nid, label: inc.label}); _incNodeMap.set(nid, n); }
      if(!node.rev.includes(n)) node.rev.push(n);
    });
    if(revOver > 0) {
      const overId = '__more_rev_' + node.id;
      const overNode = _mkIncNode({id: overId, label: `+${revOver} more…`});
      _incNodeMap.set(overId, overNode);
      node.rev.push(overNode);
    }
  } catch(e) {
    if(e.name !== 'AbortError') console.warn('include expand error', e);
  } finally {
    _incLoadingId = null;
    _incAbortCtrl = null;
    _incLoadingBar(false);
    _incRender();
  }
}

function _incLayout() {
  if(!_incRootNode) return;

  const GAP = 24;
  const DY = _INC_DY * 1.5;
  const PASSES = 8;

  // ── 1. レイヤー割り当て（BFS: fwd=下, rev=上）──────────────
  const layerOf = new Map();
  layerOf.set(_incRootNode.id, 0);
  const bfsQ = [_incRootNode];
  while(bfsQ.length) {
    const n = bfsQ.shift();
    const d = layerOf.get(n.id);
    n.fwd.forEach(c => { if(!layerOf.has(c.id)) { layerOf.set(c.id, d+1); bfsQ.push(c); } });
  }
  _incNodeMap.forEach(n => {
    const d = layerOf.has(n.id) ? layerOf.get(n.id) : 0;
    n.rev.forEach(r => { if(!layerOf.has(r.id)) layerOf.set(r.id, d - 1); });
  });
  let minL = 0;
  layerOf.forEach(d => { if(d < minL) minL = d; });
  if(minL < 0) layerOf.forEach((d, id) => layerOf.set(id, d - minL));
  // fwd方向も伝播：各ノードのfwd childrenにレイヤーを割り当て
  let changed = true;
  while(changed) {
    changed = false;
    _incNodeMap.forEach(n => {
      if(!layerOf.has(n.id)) return;
      const d = layerOf.get(n.id);
      n.fwd.forEach(c => {
        if(!layerOf.has(c.id)) { layerOf.set(c.id, d + 1); changed = true; }
        else if(layerOf.get(c.id) < d + 1) { layerOf.set(c.id, d + 1); changed = true; }
      });
    });
  }
  _incNodeMap.forEach(n => { if(!layerOf.has(n.id)) layerOf.set(n.id, 0); });

  // ── 2. レイヤー配列構築 ───────────────────────────────────
  const layerArr = new Map(); // layerIndex → node[]
  _incNodeMap.forEach(n => {
    const l = layerOf.get(n.id);
    if(!layerArr.has(l)) layerArr.set(l, []);
    layerArr.get(l).push(n);
  });
  const sortedL = [...layerArr.keys()].sort((a, b) => a - b);

  // ── 3. バリセンター交差削減（上下交互 PASSES 回）──────────
  // 各ノードの「隣接レイヤーでのインデックス平均」でソート
  function barycenter(nodes, refLayer) {
    const refNodes = layerArr.get(refLayer) || [];
    const idxOf = new Map(refNodes.map((n, i) => [n.id, i]));
    const bary = new Map();
    nodes.forEach(n => {
      const neighbors = [
        ...n.fwd.filter(c => layerOf.get(c.id) === refLayer),
        ...n.rev.filter(r => layerOf.get(r.id) === refLayer),
      ];
      if(!neighbors.length) { bary.set(n.id, idxOf.size / 2); return; }
      const avg = neighbors.reduce((s, nb) => s + (idxOf.get(nb.id) ?? idxOf.size / 2), 0) / neighbors.length;
      bary.set(n.id, avg);
    });
    nodes.sort((a, b) => bary.get(a.id) - bary.get(b.id));
  }

  for(let p = 0; p < PASSES; p++) {
    const layers = p % 2 === 0 ? sortedL : [...sortedL].reverse();
    for(let i = 1; i < layers.length; i++) {
      const cur = layers[i], prev = layers[i - 1];
      const nodes = layerArr.get(cur);
      if(nodes) barycenter(nodes, prev);
    }
  }

  // ── 4. 各レイヤーをバリセンター順で横並び ────────────────────
  sortedL.forEach(l => {
    const nodes = layerArr.get(l);
    if(!nodes) return;
    const widths = nodes.map(n => _incNodeWidth(n._dispLabel || n.label));
    const totalW = widths.reduce((a, b) => a + b, 0) + GAP * (nodes.length - 1);
    let cx = -totalW / 2;
    nodes.forEach((n, i) => {
      n._w = widths[i];
      n._x = cx + widths[i] / 2;
      n._y = l * DY + 60;
      cx += widths[i] + GAP;
    });
  });

  // ── 5. 重なり解消 ────────────────────────────────────────────
  sortedL.forEach(l => {
    const nodes = layerArr.get(l);
    if(!nodes || nodes.length < 2) return;
    for(let i = 1; i < nodes.length; i++) {
      const p = nodes[i-1], c = nodes[i];
      const minX = p._x + p._w / 2 + GAP + c._w / 2;
      if(c._x < minX) c._x = minX;
    }
  });
}

function _incRender() {
  if(!_incRootG) return;

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

  nodeG.selectAll('g.inc-node')
    .on('click',      (e,d) => { e.stopPropagation(); if(e.ctrlKey||e.metaKey) _incOpenFile(d); else _incExpand(d); })
    .on('dblclick',   (_e,d) => _incOpenFile(d))
    .on('mouseenter', (_e,d) => _incHighlight(d))
    .on('mouseleave', ()     => _incHighlight(null));

  // hasRev を事前に O(n) で計算
  const _hasRevSet = new Set();
  _incNodeMap.forEach(n => n.rev.forEach(r => _hasRevSet.add(r.id)));

  const useTransition = allNodes.length <= MAX_INC_TRANS;
  const maybeT = sel => useTransition ? sel.transition().duration(200) : sel;
  maybeT(nodeG.selectAll('g.inc-node'))
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
      return _hasRevSet.has(d.id) && !d.expanded ? '4,2' : null;
    });
  nodeG.selectAll('g.inc-node text')
    .text(d => {
      if(d.id === _incLoadingId) return '⏳ ' + (d._dispLabel || d.label);
      const lbl = d._dispLabel || d.label;
      const maxCh = Math.floor((d._w || _incNodeWidth(lbl)) / 7.5) - 2;
      return lbl.length > maxCh ? lbl.slice(0, maxCh - 1) + '…' : lbl;
    });

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
  _incNodeMap.forEach((_n, id) => { if(id !== _incRootNode.id) _incNodeMap.delete(id); });
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
    _incRootG.selectAll('path.inc-link').classed('inc-dim', false).classed('inc-hi', false);
    _incRootG.selectAll('g.inc-node').classed('inc-dim', false).classed('inc-hi', false);
    return;
  }
  const connectedIds = new Set([node.id]);
  _incRootG.selectAll('path.inc-link').each(function(d) {
    if(d.s === node || d.t === node) { connectedIds.add(d.s.id); connectedIds.add(d.t.id); }
  });
  _incRootG.selectAll('path.inc-link')
    .classed('inc-hi',  d => d.s === node || d.t === node)
    .classed('inc-dim', d => d.s !== node && d.t !== node);
  _incRootG.selectAll('g.inc-node')
    .classed('inc-hi',  d => connectedIds.has(d.id))
    .classed('inc-dim', d => !connectedIds.has(d.id));
}

// ----- エクスポート -----

function _incStemName() {
  const root = _incRootNode ? _incRootNode.label.replace(/[^a-zA-Z0-9_\-]/g, '_') : 'graph';
  return 'include_' + root;
}

function _incBuildExportSvg() {
  if(!_incSvg) return null;
  const svgEl = _incSvg.node();

  // バウンディングボックスを計算して適切な viewBox を設定
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const NH = _INC_NH;
  _incNodeMap.forEach(n => {
    const hw = (n._w || _incNodeWidth(n._dispLabel || n.label)) / 2;
    minX = Math.min(minX, (n._x || 0) - hw);
    maxX = Math.max(maxX, (n._x || 0) + hw);
    minY = Math.min(minY, (n._y || 0) - NH / 2);
    maxY = Math.max(maxY, (n._y || 0) + NH / 2);
  });
  const pad = 40;
  const vx = minX - pad, vy = minY - pad;
  const vw = maxX - minX + pad * 2, vh = maxY - minY + pad * 2;

  // SVG をクローンしてスタイルをインライン化
  const clone = svgEl.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', vw);
  clone.setAttribute('height', vh);
  clone.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`);

  // 背景
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', vx); bg.setAttribute('y', vy);
  bg.setAttribute('width', vw); bg.setAttribute('height', vh);
  bg.setAttribute('fill', '#1e1e1e');
  clone.insertBefore(bg, clone.firstChild);

  // transform を除去してノード座標をそのまま使う（viewBox で調整済み）
  const rootG = clone.querySelector('g');
  if(rootG) rootG.removeAttribute('transform');

  // CSS スタイルをインライン化
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = `
    .inc-node rect{fill:#2d2d2d;stroke:#555;stroke-width:1;rx:4}
    .inc-node.h-file rect{stroke:#9cdcfe}
    .inc-node.c-file rect{stroke:#4ec9b0}
    .inc-node text{fill:#cccccc;font-size:11px;font-family:Consolas,monospace;pointer-events:none}
    path.inc-link{stroke:#555;stroke-width:1;fill:none}
    path.inc-link.reverse{stroke:#666;stroke-dasharray:4,2}
    marker path{fill:#555}
  `;
  clone.insertBefore(style, clone.firstChild);

  return new XMLSerializer().serializeToString(clone);
}

function _incDownload(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function incExportSvg() {
  const svg = _incBuildExportSvg();
  if(!svg) return;
  _incDownload(new Blob([svg], {type: 'image/svg+xml'}), _incStemName() + '.svg');
}

async function incExportPng() {
  const svgStr = _incBuildExportSvg();
  if(!svgStr) return;

  const parser = new DOMParser();
  const doc = parser.parseFromString(svgStr, 'image/svg+xml');
  const svgNode = doc.documentElement;
  const W = +svgNode.getAttribute('width');
  const H = +svgNode.getAttribute('height');

  const scale = 2; // Retina 解像度
  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  const img = new Image();
  const blob = new Blob([svgStr], {type: 'image/svg+xml'});
  const url = URL.createObjectURL(blob);
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = url;
  });
  URL.revokeObjectURL(url);
  ctx.drawImage(img, 0, 0);

  canvas.toBlob(b => _incDownload(b, _incStemName() + '.png'), 'image/png');
}

function incExportDrawio() {
  if(!_incNodeMap.size) return;
  const NH = _INC_NH;

  // ノードIDを安全なセル ID に変換
  const cellId = id => 'n_' + id.replace(/[^a-zA-Z0-9]/g, '_');

  let cells = '<mxCell id="0"/><mxCell id="1" parent="0"/>';

  _incNodeMap.forEach(n => {
    const w = n._w || _incNodeWidth(n._dispLabel || n.label);
    const x = (n._x || 0) - w / 2;
    const y = (n._y || 0) - NH / 2;
    const ext = n.id.split('.').pop().toLowerCase();
    const isH = ['h','hpp','hh'].includes(ext);
    const stroke = n.expanded ? '#4ec9b0' : (isH ? '#9cdcfe' : '#aaaaaa');
    const style = `rounded=1;whiteSpace=wrap;html=1;fillColor=#2d2d2d;strokeColor=${stroke};fontColor=#cccccc;fontSize=11;fontFamily=Courier New;`;
    const lbl = (n._dispLabel || n.label).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    cells += `<mxCell id="${cellId(n.id)}" value="${lbl}" style="${style}" vertex="1" parent="1"><mxGeometry x="${Math.round(x)}" y="${Math.round(y)}" width="${Math.round(w)}" height="${NH}" as="geometry"/></mxCell>`;
  });

  let edgeIdx = 0;
  const edgeSet = new Set();
  const edgeStyle = 'edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;exitX=0.5;exitY=1;entryX=0.5;entryY=0;strokeColor=#555555;';
  _incNodeMap.forEach(n => {
    n.fwd.forEach(c => {
      const key = n.id + '\0' + c.id;
      if(!edgeSet.has(key)) { edgeSet.add(key); cells += `<mxCell id="e${edgeIdx++}" value="" style="${edgeStyle}" edge="1" source="${cellId(n.id)}" target="${cellId(c.id)}" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>`; }
    });
    n.rev.forEach(r => {
      const key = r.id + '\0' + n.id;
      if(!edgeSet.has(key)) { edgeSet.add(key); cells += `<mxCell id="e${edgeIdx++}" value="" style="${edgeStyle}" edge="1" source="${cellId(r.id)}" target="${cellId(n.id)}" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>`; }
    });
  });

  const xml = `<mxGraphModel><root>${cells}</root></mxGraphModel>`;
  _incDownload(new Blob([xml], {type: 'application/xml'}), _incStemName() + '.drawio');
}
