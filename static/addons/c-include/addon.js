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
  (document.getElementById('pane-right') || document.body).insertAdjacentHTML('beforeend', `
    <div id="include-overlay">
      <div id="include-hdr">
        <span id="include-title">インクルード依存グラフ</span>
        <span id="include-hdr-right">
          <input id="include-start" type="text" placeholder="起点ファイル (自動セット)" spellcheck="false" title="起点ファイルパス">
          <button id="include-analyze">解析</button>
          <button class="sec" id="include-collapse-all" title="すべて折りたたむ">折りたたむ</button>
          <button class="sec" id="include-recenter" title="ルートを中央に戻す">中央へ</button>
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
    btn.title = '#inc — インクルード依存グラフ (#include の依存関係を D3.js で可視化)';
    btn.textContent = '#inc';
    addonBar.appendChild(btn);
  }

  // イベント登録
  document.getElementById('btn-include-graph').onclick    = openIncludeGraph;
  // オーバーレイ内のキー操作がメインアプリに漏れないようにする
  document.getElementById('include-overlay').addEventListener('keydown', e => e.stopPropagation());
  // Monaco のアクティブファイルが変わったら include-start も追従させる
  // (overlay 表示中のみ)。自動再解析はしない (ユーザが「解析」を押す前提)。
  document.addEventListener('grepnavi:active-file-changed', e => {
    const overlay = document.getElementById('include-overlay');
    if(!overlay?.classList.contains('open')) return;
    const f = (e.detail || '').replace(/\\/g, '/');
    if(f) document.getElementById('include-start').value = f;
  });

  document.getElementById('include-analyze').onclick      = () => startIncludeGraph();
  document.getElementById('include-collapse-all').onclick = incCollapseAll;
  document.getElementById('include-recenter').onclick     = _incCenterOnRoot;
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
let _incSvg = null, _incRootG = null, _incMiniSvg = null;
let _incContainerW = 1200;
let _incLoadingId = null; // 展開中ノードID
let _incPinnedId  = null; // ハイライト固定中ノードID
let _incZoomRef   = null; // zoom ハンドラ参照
let _incAbortCtrl = null; // fetch 中断用

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
  _incSvg = null; _incRootG = null; _incMiniSvg = null;
}

const _INC_NH = 28;
function _incNodeWidth(label) { return Math.max(120, Math.min(300, label.length * 7.5 + 24)); }
const _INC_NW = 150;

function _incNormId(id) { return id.replace(/\\/g, '/').replace(/\/+$/, ''); }

// ----- フォルダ色 -----

const _INC_DIR_COLORS = [
  '#4ec9b0','#9cdcfe','#ce9178','#dcdcaa','#c586c0',
  '#f44747','#4fc1ff','#b5cea8','#d7ba7d','#569cd6',
  '#6796e6','#cd9731','#80cb4a','#e06c75','#56b6c2',
];

function _incFileDir(id) {
  const i = id.lastIndexOf('/');
  return i > 0 ? id.slice(0, i) : '';
}

function _incDirHash(dir) {
  let h = 0;
  for(let i = 0; i < dir.length; i++) h = (h * 31 + dir.charCodeAt(i)) >>> 0;
  return h;
}

function _incDirColor(dir) {
  if(!dir) return 'transparent';
  return _INC_DIR_COLORS[_incDirHash(dir) % _INC_DIR_COLORS.length];
}

// パターン定義（色 + 模様でフォルダを区別）
const _INC_STRIPE_PAT_COUNT = 5;
function _incEnsureStripePattern(dir) {
  if(!dir || !_incSvg) return _incDirColor(dir);
  const h = _incDirHash(dir);
  const col = _INC_DIR_COLORS[h % _INC_DIR_COLORS.length];
  // 色のインデックスとは独立してパターンを決める
  const patIdx = Math.floor(h / 97) % _INC_STRIPE_PAT_COUNT;
  const patId = `inc-sp-${h % 100003}`;
  if(_incSvg.select(`#${patId}`).empty()) {
    const defs = _incSvg.select('defs');
    const p = defs.append('pattern')
      .attr('id', patId)
      .attr('patternUnits', 'userSpaceOnUse')
      .attr('width', 6).attr('height', 6);
    // 背景色（共通）
    p.append('rect').attr('width', 6).attr('height', 6).attr('fill', col).attr('opacity', 0.7);
    switch(patIdx) {
      case 0: // solid（模様なし）
        break;
      case 1: // 白斜線 /
        p.append('path').attr('d','M-1,7 l8,-8 M-1,1 l2,-2 M5,7 l2,-2')
          .attr('stroke', 'rgba(255,255,255,0.55)').attr('stroke-width', 1.5);
        break;
      case 2: // 白斜線 \
        p.append('path').attr('d','M7,7 l-8,-8 M1,7 l-2,-2 M7,1 l2,2')
          .attr('stroke', 'rgba(255,255,255,0.55)').attr('stroke-width', 1.5);
        break;
      case 3: // 白ドット
        p.append('circle').attr('cx', 3).attr('cy', 3).attr('r', 1.2)
          .attr('fill', 'rgba(255,255,255,0.6)');
        break;
      case 4: // 白横線
        p.append('line').attr('x1',0).attr('y1',2).attr('x2',6).attr('y2',2)
          .attr('stroke', 'rgba(255,255,255,0.55)').attr('stroke-width', 1.5);
        p.append('line').attr('x1',0).attr('y1',5).attr('x2',6).attr('y2',5)
          .attr('stroke', 'rgba(255,255,255,0.55)').attr('stroke-width', 1.5);
        break;
    }
  }
  return `url(#${patId})`;
}

// peek panel が下から overlay を覆ってる量だけ padding-bottom を入れて、
// スピナーが「peek の上の見える範囲」の中央に来るようにする。
function _incUpdateSpinnerCenter() {
  const ov = document.getElementById('inc-loading-overlay');
  const container = document.getElementById('include-graph-container');
  if(!ov || !container) return;
  const peek = document.getElementById('peek');
  if(!peek || !peek.classList.contains('visible')) {
    ov.style.paddingBottom = '';
    return;
  }
  const cr = container.getBoundingClientRect();
  const pr = peek.getBoundingClientRect();
  const overlap = Math.max(0, cr.bottom - pr.top);
  ov.style.paddingBottom = overlap + 'px';
}
let _incPeekResizeObs = null;
function _ensurePeekResizeWatch() {
  if(_incPeekResizeObs || !window.ResizeObserver) return;
  const peek = document.getElementById('peek');
  if(!peek) return;
  _incPeekResizeObs = new ResizeObserver(_incUpdateSpinnerCenter);
  _incPeekResizeObs.observe(peek);
}

let _incLoadingTimer = null;
let _incLoadingStart = 0;
function _incLoadingBar(on) {
  let ov = document.getElementById('inc-loading-overlay');
  if(!ov) {
    ov = document.createElement('div');
    ov.id = 'inc-loading-overlay';
    ov.innerHTML = '<div id="inc-loading-ring"></div>'
                 + '<div id="inc-loading-elapsed"></div>'
                 + '<div id="inc-loading-cancel">ESC でキャンセル</div>';
    ov.style.pointerEvents = 'auto';
    ov.onclick = () => _incCancelExpand();
    const c = document.getElementById('include-graph-container');
    if(c) c.appendChild(ov);
  }
  ov.classList.toggle('active', on);
  if(on) { _ensurePeekResizeWatch(); _incUpdateSpinnerCenter(); }

  const elapsed = document.getElementById('inc-loading-elapsed');
  if(_incLoadingTimer) { clearInterval(_incLoadingTimer); _incLoadingTimer = null; }
  if(on) {
    _incLoadingStart = performance.now();
    const tick = () => {
      const s = (performance.now() - _incLoadingStart) / 1000;
      const msg = s >= 5
        ? `${s.toFixed(1)} 秒経過 — 大規模プロジェクトでは時間がかかります`
        : `${s.toFixed(1)} 秒経過`;
      if(elapsed) elapsed.textContent = msg;
    };
    tick();
    _incLoadingTimer = setInterval(tick, 200);
  } else if(elapsed) {
    elapsed.textContent = '';
  }
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

  const svg = d3.select(container).append('svg')
    .attr('width', '100%').attr('height', '100%').style('display','block');
  svg.append('defs').append('marker')
    .attr('id','inc-arrow').attr('viewBox','0 -5 10 10')
    .attr('refX', 8).attr('refY', 0)
    .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient','auto')
    .append('path').attr('d','M0,-5L10,0L0,5').attr('fill','#555');
  _incRootG = svg.append('g');
  const _incZoom = d3.zoom().scaleExtent([0.1,4]).on('zoom', e => {
    _incRootG.attr('transform', e.transform);
    _incRenderMinimap();
  });
  svg.call(_incZoom);
  svg.on('click', () => { if(_incPinnedId) { _incPinnedId = null; _incHighlight(null); } });
  _incSvg = svg;
  _incZoomRef = _incZoom;

  // ミニマップ SVG（コンテナ内に絶対配置）
  _incMiniSvg = d3.select(container).append('svg')
    .attr('id', 'inc-minimap')
    .on('mousedown', _incMinimapPointerDown);

  const normFile = _incNormId(file);
  _incRootNode = _mkIncNode({id: normFile, label: normFile.split('/').pop()});
  _incNodeMap.set(normFile, _incRootNode);

  // 解析中も root が中央上部に表示されるよう、先にレンダー + 中央配置してから fetch。
  _incRender();
  requestAnimationFrame(_incCenterOnRoot);

  await _incExpand(_incRootNode);

  // 子ノードが入るとレイアウトが変わるので再センタリング。
  requestAnimationFrame(_incCenterOnRoot);
}

function _incCenterOnRoot() {
  if(!_incSvg || !_incZoomRef || !_incRootNode) return;
  const container = document.getElementById('include-graph-container');
  const rect = container ? container.getBoundingClientRect() : _incSvg.node().getBoundingClientRect();
  const W = rect.width  || 900;
  const H = rect.height || 600;
  // peek panel が下から container を覆っている分を可視高から引く
  const peek = document.getElementById('peek');
  const pr = (peek?.classList.contains('visible')) ? peek.getBoundingClientRect() : null;
  const overlap = pr ? Math.max(0, rect.bottom - pr.top) : 0;
  const Hv = Math.max(60, H - overlap);
  const rx = _incRootNode._x ?? 0;
  const ry = _incRootNode._y ?? 0;
  _incSvg.call(_incZoomRef.transform, d3.zoomIdentity.translate(W / 2 - rx, Hv / 4 - ry));
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
  // 残存ノードの fwd/rev から削除済みノードへの参照を除去（dangling edge 防止）
  _incNodeMap.forEach(n => {
    n.fwd = n.fwd.filter(c => _incNodeMap.has(c.id));
    n.rev = n.rev.filter(r => _incNodeMap.has(r.id));
  });
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
    const isRoot = node === _incRootNode;
    const fetches = [fetch('/api/include-file?file=' + encodeURIComponent(node.id), {signal})];
    if(isRoot) fetches.push(fetch('/api/include-by?file=' + encodeURIComponent(node.id), {signal}));
    const [fR, rR] = await Promise.all(fetches);
    const fwd = fR.ok ? await fR.json() : [];
    const rev = (isRoot && rR?.ok) ? await rR.json() : [];

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
  } catch(e) {
    if(e.name !== 'AbortError') console.warn('include expand error', e);
  } finally {
    _incLoadingId = null;
    _incAbortCtrl = null;
    _incLoadingBar(false);
    _incRender();
    requestAnimationFrame(_incCenterOnRoot);
  }
}

function _incLayout() {
  if(!_incRootNode) return;

  const container = document.getElementById('include-graph-container');
  if(container && container.offsetWidth > 0) _incContainerW = container.offsetWidth;

  const GAP = 24;
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
  const layerArr = new Map();
  _incNodeMap.forEach(n => {
    const l = layerOf.get(n.id);
    if(!layerArr.has(l)) layerArr.set(l, []);
    layerArr.get(l).push(n);
  });
  const sortedL = [...layerArr.keys()].sort((a, b) => a - b);

  // ── 3. バリセンター交差削減（上下交互 PASSES 回）──────────
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

  // ── 4. 各レイヤーをバリセンター順で横並び（幅超過時は折り返し）──────
  const ROW_WRAP_W = Math.max(900, _incContainerW - 80);
  const ROW_H = _INC_NH + 10;
  const LAYER_GAP = 50;

  const layerStartY = new Map();
  let cumY = 60;
  sortedL.forEach(l => {
    layerStartY.set(l, cumY);
    const nodes = layerArr.get(l);
    if(!nodes || nodes.length === 0) { cumY += ROW_H + LAYER_GAP; return; }
    const widths = nodes.map(n => _incNodeWidth(n._dispLabel || n.label));
    let rowCount = 1, curRowW = 0;
    widths.forEach(w => {
      const needed = curRowW === 0 ? w : curRowW + GAP + w;
      if(curRowW > 0 && needed > ROW_WRAP_W) { rowCount++; curRowW = w; }
      else curRowW = needed;
    });
    cumY += rowCount * ROW_H + LAYER_GAP;
  });

  sortedL.forEach(l => {
    const nodes = layerArr.get(l);
    if(!nodes) return;
    const widths = nodes.map(n => _incNodeWidth(n._dispLabel || n.label));
    const startY = layerStartY.get(l);
    const rows = [[]];
    let curRowW = 0;
    nodes.forEach((n, i) => {
      const w = widths[i];
      const needed = curRowW === 0 ? w : curRowW + GAP + w;
      if(rows[rows.length-1].length > 0 && needed > ROW_WRAP_W) { rows.push([]); curRowW = 0; }
      rows[rows.length-1].push({n, w});
      curRowW = rows[rows.length-1].length === 1 ? w : curRowW + GAP + w;
    });
    rows.forEach((row, ri) => {
      const totalW = row.reduce((s, {w}) => s + w, 0) + GAP * (row.length - 1);
      let cx = -totalW / 2;
      row.forEach(({n, w}) => {
        n._w = w; n._x = cx + w / 2; n._y = startY + ri * ROW_H;
        n._layer = l; // グループ枠計算用にレイヤー番号を保持
        cx += w + GAP;
      });
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

  // ── リンク ──
  const linkMap = new Map();
  _incNodeMap.forEach(n => {
    n.fwd.forEach(c => linkMap.set(n.id+'→'+c.id, {s:n, t:c, isRev:false}));
  });
  _incNodeMap.forEach(n => {
    n.rev.forEach(r => { const k = r.id+'→'+n.id; if(!linkMap.has(k)) linkMap.set(k, {s:r, t:n, isRev:true}); });
  });
  const allLinks = [...linkMap.values()];

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

  // ── ノード ──
  const nodeSel = _incRootG.selectAll('g.inc-node-g').data([0]);
  const nodeG = nodeSel.enter().append('g').attr('class','inc-node-g').merge(nodeSel);
  const glowSel = _incRootG.selectAll('g.inc-glow-layer').data([0]);
  const glowG = glowSel.enter().append('g').attr('class','inc-glow-layer').merge(glowSel);
  const allNodes = [..._incNodeMap.values()];
  const nd = nodeG.selectAll('g.inc-node').data(allNodes, d => d.id);
  const enter = nd.enter().append('g')
    .attr('class', _incNodeClass)
    .attr('transform', d => `translate(${d._x||0},${d._y||0})`);
  enter.append('rect').attr('height',NH).attr('y',-NH/2);
  enter.append('rect').attr('class','inc-dir-stripe').attr('y',-NH/2).attr('width',6).attr('height',NH).attr('rx',2);
  enter.append('text').attr('text-anchor','middle').attr('dy','0.35em');
  nd.exit().remove();

  nodeG.selectAll('g.inc-node')
    .on('click',       (e,d) => { e.stopPropagation(); if(e.ctrlKey||e.metaKey) _incOpenFile(d); else _incExpand(d); })
    .on('dblclick',    (_e,d) => _incOpenFile(d))
    .on('contextmenu', (e,d) => {
      e.preventDefault(); e.stopPropagation();
      if(_incPinnedId === d.id) { _incPinnedId = null; _incHighlight(null); }
      else { _incPinnedId = d.id; _incHighlight(d); }
    })
    .on('mouseenter', (_e,d) => {
      if(!_incPinnedId) _incHighlight(d);
    })
    .on('mouseleave', () => {
      if(!_incPinnedId) _incHighlight(null);
    });

  const useTransition = allNodes.length <= MAX_INC_TRANS;
  const maybeT = sel => useTransition ? sel.transition().duration(200) : sel;
  maybeT(nodeG.selectAll('g.inc-node'))
    .attr('transform', d => `translate(${d._x||0},${d._y||0})`)
    .attr('class', d => _incNodeClass(d) + (d.id === _incLoadingId ? ' inc-loading' : ''));
  nodeG.selectAll('g.inc-node rect:first-child')
    .attr('width', d => d._w || _incNodeWidth(d.label))
    .attr('x',     d => -(d._w || _incNodeWidth(d.label)) / 2);
  nodeG.selectAll('g.inc-node .inc-dir-stripe')
    .attr('x',    d => -(d._w || _incNodeWidth(d.label)) / 2)
    .style('fill', d => _incEnsureStripePattern(_incFileDir(d.id)))
    .style('pointer-events', 'all')
    .style('cursor', 'default')
    .on('mouseenter', function(_e, d) {
      _e.stopPropagation();
      const dir = _incFileDir(d.id);
      const col = _incDirColor(dir);
      glowG.selectAll('*').remove();
      if(dir) {
        _incRootG.selectAll('g.inc-node').each(function(n) {
          if(_incFileDir(n.id) !== dir) return;
          const w = n._w || _incNodeWidth(n.label);
          glowG.append('rect')
            .attr('x', n._x - w / 2)
            .attr('y', n._y - NH / 2)
            .attr('width', 5).attr('height', NH).attr('rx', 2)
            .attr('fill', col)
            .style('filter', `drop-shadow(0 0 8px #fff) brightness(1.5)`)
            .style('pointer-events', 'none');
        });
      }
    })
    .on('mouseleave', function(_e) {
      _e.stopPropagation();
      glowG.selectAll('*').remove();
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

  _incRenderMinimap();
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
  const nid  = d.id.replace(/\\/g, '/');
  // 絶対パス（C:/ または / 始まり）はそのまま使う
  const isAbs = /^[A-Za-z]:\//.test(nid) || nid.startsWith('/');
  const root = (projectRoot || '').replace(/\\/g, '/').replace(/\/$/, '');
  const p = isAbs ? nid : (root ? root + '/' + nid.replace(/^\//, '') : nid);
  if(typeof openPeek === 'function') openPeek(p, 1);
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
    if(d.s.id === node.id || d.t.id === node.id) { connectedIds.add(d.s.id); connectedIds.add(d.t.id); }
  });
  _incRootG.selectAll('path.inc-link')
    .classed('inc-hi',  d => d.s.id === node.id || d.t.id === node.id)
    .classed('inc-dim', d => d.s.id !== node.id && d.t.id !== node.id);
  _incRootG.selectAll('g.inc-node')
    .classed('inc-hi',  d => connectedIds.has(d.id))
    .classed('inc-dim', d => !connectedIds.has(d.id));
}

// ----- ミニマップ -----

function _incMiniParams() {
  const NH = _INC_NH, pad = 4, mmW = 180, mmH = 120;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  _incNodeMap.forEach(n => {
    if(n._x === undefined) return;
    const hw = (n._w || _incNodeWidth(n._dispLabel || n.label)) / 2;
    minX = Math.min(minX, (n._x||0) - hw);
    maxX = Math.max(maxX, (n._x||0) + hw);
    minY = Math.min(minY, (n._y||0) - NH/2);
    maxY = Math.max(maxY, (n._y||0) + NH/2);
  });
  const gW = maxX - minX || 1, gH = maxY - minY || 1;
  // グラフ範囲の 60% をパディングとして追加し、viewport 矩形が相対的に小さく見えるようにする
  const px = gW * 0.6, py = gH * 0.6;
  minX -= px; maxX += px; minY -= py; maxY += py;
  const eW = maxX - minX, eH = maxY - minY;
  const scale = Math.min((mmW - pad*2) / eW, (mmH - pad*2) / eH);
  const offX = pad - minX * scale + (mmW - pad*2 - eW*scale) / 2;
  const offY = pad - minY * scale + (mmH - pad*2 - eH*scale) / 2;
  return {scale, offX, offY, NH, mmW, mmH};
}

function _incRenderMinimap() {
  if(!_incMiniSvg || !_incSvg || !_incNodeMap.size) return;
  const {scale, offX, offY, NH} = _incMiniParams();

  const allNodes = [..._incNodeMap.values()].filter(n => n._x !== undefined);
  const rects = _incMiniSvg.selectAll('rect.mm-node').data(allNodes, d => d.id);
  rects.enter().append('rect')
    .attr('class', d => {
      const ext = d.id.split('.').pop().toLowerCase();
      return 'mm-node ' + (['h','hpp','hh'].includes(ext) ? 'h-file' : 'c-file');
    })
    .merge(rects)
    .attr('x',      d => (d._x||0)*scale + offX - (d._w||_incNodeWidth(d._dispLabel||d.label))/2*scale)
    .attr('y',      d => (d._y||0)*scale + offY - NH/2*scale)
    .attr('width',  d => (d._w||_incNodeWidth(d._dispLabel||d.label))*scale)
    .attr('height', NH*scale);
  rects.exit().remove();

  const t = d3.zoomTransform(_incSvg.node());
  const container = document.getElementById('include-graph-container');
  const cW = container?.offsetWidth || 900;
  const cH = container?.offsetHeight || 600;
  const vx1 = (-t.x)/t.k, vy1 = (-t.y)/t.k;
  const vx2 = (cW-t.x)/t.k, vy2 = (cH-t.y)/t.k;
  _incMiniSvg.selectAll('rect.mm-viewport').data([0]).join('rect')
    .attr('class', 'mm-viewport')
    .attr('x',      vx1*scale + offX)
    .attr('y',      vy1*scale + offY)
    .attr('width',  (vx2-vx1)*scale)
    .attr('height', (vy2-vy1)*scale);
}

function _incMinimapPointerDown(event) {
  if(!_incSvg || !_incZoomRef || !_incNodeMap.size) return;
  event.preventDefault();
  const mmEl = _incMiniSvg.node();

  function moveTo(clientX, clientY) {
    const rect = mmEl.getBoundingClientRect();
    const {scale, offX, offY} = _incMiniParams();
    const gx = (clientX - rect.left - offX) / scale;
    const gy = (clientY - rect.top  - offY) / scale;
    _incSvg.call(_incZoomRef.translateTo, gx, gy);
  }

  moveTo(event.clientX, event.clientY);

  function onMove(e) { moveTo(e.clientX, e.clientY); }
  function onUp()    { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
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
