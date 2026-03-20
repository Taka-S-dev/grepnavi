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
  document.getElementById('btn-include-graph').onclick = openIncludeGraph;
  document.getElementById('include-analyze').onclick   = () => startIncludeGraph();
  document.getElementById('include-collapse-all').onclick = incCollapseAll;
  document.getElementById('include-close').onclick     = closeIncludeGraph;

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
function _incNodeWidth(label) { return Math.max(120, Math.min(300, label.length * 7.5 + 24)); }
const _INC_NW = 150;

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
  svg.call(d3.zoom().scaleExtent([0.1,4]).on('zoom', e => _incRootG.attr('transform', e.transform)));
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
  if(_incLoadingId) return;
  if(node.expanded) { _incCollapse(node); return; }

  _incLoadingId = node.id;
  _incRender();

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

  _incLoadingId = null;
  _incRender();
}

function _incLayout() {
  if(!_incRootNode) return;

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

  _incNodeMap.forEach(n => {
    const parentDepth = depthMap.has(n.id) ? depthMap.get(n.id) : 0;
    n.rev.forEach(rn => {
      if(!depthMap.has(rn.id)) depthMap.set(rn.id, parentDepth - 1);
    });
  });

  let minDepth = 0;
  depthMap.forEach(d => { if(d < minDepth) minDepth = d; });
  if(minDepth < 0) depthMap.forEach((d, id) => depthMap.set(id, d - minDepth));

  _incNodeMap.forEach(n => { if(!depthMap.has(n.id)) depthMap.set(n.id, 0); });

  const levels = new Map();
  _incNodeMap.forEach(n => {
    const d = depthMap.get(n.id);
    if(!levels.has(d)) levels.set(d, []);
    levels.get(d).push(n);
  });

  const GAP = 16;
  levels.forEach((nodes, depth) => {
    const widths = nodes.map(n => _incNodeWidth(n._dispLabel || n.label));
    const totalW = widths.reduce((a, b) => a + b, 0) + GAP * (nodes.length - 1);
    let cx = -totalW / 2;
    nodes.forEach((n, i) => {
      n._w = widths[i];
      n._x = cx + widths[i] / 2;
      cx += widths[i] + GAP;
      n._y = depth * _INC_DY * 1.5 + 60;
    });
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
