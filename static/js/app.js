// Monaco エディタ内部の非同期キャンセル（Canceled）を抑制
window.addEventListener('unhandledrejection', e => {
  if(e.reason && e.reason.message === 'Canceled') e.preventDefault();
});

// ===== STATE =====
let graph = { nodes:{}, edges:[] };
let selNode = null;
let sse = null, batchTimer = null, spinnerTimer = null;
const SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
let spinnerFrame = 0;
let pending = [], allMatches = [];
let fileGroupMap = {};
const LIMIT = 1000, BATCH_MS = 80, DRAG_STEP = 30;
let dragNodeId = null;
let dragDepth  = 0;
let dragStartX = 0;
let lastDragX  = 0;
let dropHandled = false; // ondrop 済みフラグ（ondragend との二重処理防止）
let dragSeq = 0; // ドラッグ操作ごとに増加。再レンダリング後の古い ondragend を無視するため。
let viewMode = 'tree'; // 'tree' | 'graph'
let d3sim = null;
let showMemos = false;
let graphSel = new Set(); // グラフ複数選択
let edgeMode = 'ref'; // 'ref' | 'seq'

// ===== BOOT =====
addEventListener('DOMContentLoaded', async () => {
  id('btn-s').onclick = doSearch;
  id('btn-stop').onclick = stopSearch;
  id('btn-clr').onclick = clearGraph;
  id('btn-tree-add').onclick = createTree;
  id('btn-view').onclick = toggleView;
  id('root-chip').onclick = () => showRootDialog();
  id('btn-nav-back').onclick = navBack;
  id('btn-nav-fwd').onclick  = navForward;
  document.addEventListener('keydown', e => {
    if(e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); navBack(); }
    if(e.altKey && e.key === 'ArrowRight') { e.preventDefault(); navForward(); }
    if(e.key === 'F3' && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      jumpResult(e.shiftKey ? -1 : 1);
    }
    if((e.ctrlKey || e.metaKey) && e.key === 'p') { e.preventDefault(); openFzf(); }
  });
  // fzf 操作
  id('fzf-input').addEventListener('input', e => fzfRender(e.target.value));
  id('fzf-input').addEventListener('keydown', e => {
    if(e.key === 'ArrowDown')  { e.preventDefault(); fzfMoveSel(1); }
    if(e.key === 'ArrowUp')    { e.preventDefault(); fzfMoveSel(-1); }
    if(e.key === 'Enter')      { if(fzfFiltered[fzfSelIdx]) fzfOpen(fzfFiltered[fzfSelIdx]); }
    if(e.key === 'Escape')     { closeFzf(); }
  });
  id('fzf-overlay').addEventListener('click', e => { if(e.target === id('fzf-overlay')) closeFzf(); });
  // プロジェクトメニュー
  id('btn-project-menu').onclick = e => {
    e.stopPropagation();
    id('project-menu').classList.toggle('open');
  };
  document.addEventListener('click', () => id('project-menu').classList.remove('open'));
  id('pmenu-open').onclick = () => { id('project-menu').classList.remove('open'); showProjectModal('open'); };
  id('pmenu-saveas').onclick = () => { id('project-menu').classList.remove('open'); showProjectModal('save'); };
  id('pmenu-save').onclick = async () => {
    id('project-menu').classList.remove('open');
    const p = getProjectPath();
    if(p) await saveProject(p);
    else showProjectModal('save');
  };
  // Ctrl+S で保存
  document.addEventListener('keydown', async e => {
    if(e.ctrlKey && e.key === 's') {
      e.preventDefault();
      const p = getProjectPath();
      if(p) await saveProject(p);
      else showProjectModal('save');
    }
  });
  id('project-modal-cancel').onclick = closeProjectModal;
  id('project-modal-ok').onclick = onProjectModalOk;
  id('project-modal-input').onkeydown = e => {
    if(e.key === 'Enter') onProjectModalOk();
    if(e.key === 'Escape') closeProjectModal();
  };
  updateProjectUI();
  id('q').onkeydown = e => { if(e.key==='Enter') doSearch(); };
  id('ifdef-apply').onclick = applyIfdefHighlight;
  id('ifdef-clear').onclick = clearIfdefHighlight;
  id('ifdef-cond').onkeydown = e => { if(e.key==='Enter') applyIfdefHighlight(); };
  const btnLmt = id('btn-line-memo-toggle');
  if(btnLmt) {
    btnLmt.onclick = toggleLineMemoInline;
    btnLmt.classList.toggle('on', showLineMemoInline);
    btnLmt.style.background = showLineMemoInline ? '#094771' : '';
  }
  document.addEventListener('keydown', e => {
    if(e.altKey && e.key === 'm') { e.preventDefault(); toggleLineMemoInline(); }
  });

  // 前回の検索設定を復元
  const saved = JSON.parse(localStorage.getItem('grepnavi-settings') || '{}');
  if(saved.dir)  id('dir').value  = saved.dir;
  if(saved.glob) id('glob').value = saved.glob;
  updateRootChip();
  if(saved.regex) id('btn-re').classList.toggle('on', !!saved.regex);
  if(saved.cs)    id('btn-cs').classList.toggle('on', !!saved.cs);
  if(saved.word)  id('btn-wb').classList.toggle('on', !!saved.word);

  // ドラッグ中のX追跡 → バッジ＋ターゲットハイライト
  document.addEventListener('dragover', e => {
    if(!dragNodeId) return;
    lastDragX = e.clientX;
    const dx = lastDragX - dragStartX;
    const delta = Math.round(dx / DRAG_STEP);
    const newDepth = Math.max(0, dragDepth + delta);

    // 実際に移動できる深さに補正（calcDragTarget が undefined = 不可能）
    const targetParentId = delta !== 0 ? calcDragTarget(dragNodeId, dragDepth, newDepth) : null;
    // undefined = 移動不可 → 実効深さは現在のまま
    // 深くする場合は常に1段だけ（前の兄弟の子になる）
    const effectiveDepth = targetParentId === undefined
      ? dragDepth
      : (delta > 0 ? dragDepth + 1 : newDepth);

    // バッジ表示（実効深さで表示）
    const badge = id('level-badge');
    badge.style.display = 'block';
    badge.style.left = (e.clientX + 16) + 'px';
    badge.style.top  = (e.clientY - 24) + 'px';
    id('lv-from').textContent = dragDepth;
    id('lv-to').textContent   = effectiveDepth;
    const arrow = badge.querySelector('.lv-arrow');
    if (effectiveDepth < dragDepth)      { badge.className = 'up';   arrow.textContent = '←'; }
    else if (effectiveDepth > dragDepth) { badge.className = 'down'; arrow.textContent = '→'; }
    else                                 { badge.className = 'same'; arrow.textContent = '─'; }

    // 移動先の親をハイライト + ガイド縦線
    document.querySelectorAll('.node-row.indent-target').forEach(el => el.classList.remove('indent-target'));
    const guide = id('indent-guide');
    if (effectiveDepth !== dragDepth) {
      if (targetParentId) {
        const el = document.querySelector(`.node-row[data-id="${targetParentId}"]`);
        if (el) el.classList.add('indent-target');
      }
      id('drop-root').classList.toggle('drag-over', targetParentId === '');

      // ガイド縦線: 親ノード下端〜挿入ターゲット位置
      if(guide) {
        const INDENT_W = 24;
        const paneEl = id('pane-tree');
        const paneRect = paneEl.getBoundingClientRect();
        const nodeEl = paneEl.querySelector(`.node-row[data-id="${dragNodeId}"]`);
        if(nodeEl) {
          const nodeRect = nodeEl.getBoundingClientRect();
          const currentX = nodeRect.left - paneRect.left;
          const effectiveDelta = effectiveDepth - dragDepth;
          const guideX = Math.max(0, currentX + effectiveDelta * INDENT_W);
          // 上端: 親ノードの下端（ルートの場合はツリーコンテンツ上端）
          const treeContentTop = id('tree').getBoundingClientRect().top - paneRect.top;
          let guideTop;
          if(targetParentId) {
            const parentEl = paneEl.querySelector(`.node-row[data-id="${targetParentId}"]`);
            guideTop = parentEl
              ? parentEl.getBoundingClientRect().bottom - paneRect.top
              : treeContentTop;
          } else {
            guideTop = treeContentTop;
          }
          // 下端: 挿入ターゲットの位置（なければドラッグ中ノード）
          let guideBottom = nodeRect.bottom - paneRect.top;
          const insBeforeRow = paneEl.querySelector('.node.insert-before > .node-row');
          const insAfterRow  = paneEl.querySelector('.node.insert-after > .node-row');
          if(insBeforeRow) {
            guideBottom = insBeforeRow.getBoundingClientRect().top - paneRect.top;
          } else if(insAfterRow) {
            guideBottom = insAfterRow.getBoundingClientRect().bottom - paneRect.top;
          }
          guide.style.left   = guideX + 'px';
          guide.style.top    = guideTop + 'px';
          guide.style.height = Math.max(0, guideBottom - guideTop) + 'px';
          guide.style.bottom = 'auto';
          guide.style.display = 'block';
        } else {
          guide.style.display = 'none';
        }
      }
    } else {
      id('drop-root').classList.remove('drag-over');
      if(guide) guide.style.display = 'none';
    }
  });

  // ルートドロップゾーン
  const dropRoot = id('drop-root');
  dropRoot.ondragover = e => { e.preventDefault(); dropRoot.classList.add('drag-over'); };
  dropRoot.ondragleave = () => dropRoot.classList.remove('drag-over');
  dropRoot.ondrop = e => {
    e.preventDefault();
    dropRoot.classList.remove('drag-over');
    if(dragNodeId) reparent(dragNodeId, ''); // 空 = ルートに昇格
  };

  await loadGraph();
  initSearchBar();
  initFilter();
  initDirPicker();
  initColResizer();
  // root-label クリックでルート変更ダイアログ
  id('root-label').style.cursor = 'pointer';
  id('root-label').title = (projectRoot || '未設定') + ' (クリックで変更)';
  id('root-label').onclick = showRootDialog;
  // root が未設定・デフォルト・存在しないパスなら起動時に自動表示
  const rootOk = await fetch('/api/dirs').then(r=>r.json()).catch(()=>null);
  if(!rootOk || rootOk.length === 0) showRootDialog();
  // 起動時にエディタペインを開いておく
  id('peek').classList.add('visible');
  st('準備完了');
});

// ===== ROOT CHIP =====
function updateRootChip() {
  const chip = id('root-chip');
  const chipText = id('root-chip-text');
  if(!chip || !chipText) return;
  const dirVal = (id('dir')?.value || '').trim();
  const rootName = projectRoot
    ? projectRoot.replace(/\\/g,'/').split('/').filter(Boolean).pop() || projectRoot
    : '未設定';
  if(dirVal) {
    chipText.textContent = rootName + ' / ' + dirVal;
    chip.classList.add('has-subdir');
    chip.title = projectRoot + ' / ' + dirVal + '\n(クリックで設定)';
  } else {
    chipText.textContent = rootName;
    chip.classList.remove('has-subdir');
    chip.title = (projectRoot || '未設定') + '\n(クリックで設定)';
  }
}

// ===== GRAPH =====
let projectRoot = '';

// GraphResponse をクライアント状態に適用する共通関数
function applyGraphResponse(g) {
  const savedRoot = projectRoot || g.root_dir;
  graph = g;
  if(!graph.nodes) graph.nodes = {};
  if(!graph.edges) graph.edges = [];
  graph.root_dir = savedRoot; // 検索ルートは保持
  graph._rootOrder = g.root_order || [];
  if(g.root_dir && !projectRoot) {
    projectRoot = g.root_dir;
    const parts = g.root_dir.replace(/\\/g,'/').split('/');
    id('root-label').textContent = parts[parts.length-1] || g.root_dir;
    id('root-label').title = g.root_dir;
    updateRootChip();
  }
  if(g.line_memos) {
    const existing = getLineMemos();
    Object.assign(existing, g.line_memos);
    localStorage.setItem('grepnavi-line-memos', JSON.stringify(existing));
  }
  renderTreeTabs();
  renderCurrent();
  stGraph();
}

async function loadGraph() {
  try {
    const r = await fetch('/api/graph');
    const g = await r.json();
    applyGraphResponse(g);
  } catch(e){}
}

// ===== TREE TABS =====
function renderTreeTabs() {
  const list = id('tree-tab-list');
  if(!list) return;
  const trees = graph.trees || [];
  const activeId = graph.active_tree_id || graph.id;
  list.innerHTML = '';
  trees.forEach(t => {
    const tab = document.createElement('div');
    tab.className = 'tree-tab' + (t.id === activeId ? ' active' : '');
    tab.dataset.id = t.id;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tree-tab-name';
    nameSpan.textContent = t.name;
    nameSpan.title = t.name;
    tab.appendChild(nameSpan);

    // ダブルクリックでリネーム
    nameSpan.ondblclick = e => { e.stopPropagation(); startTabRename(tab, t.id, t.name); };

    // 削除ボタン（アクティブ以外 or 複数ある場合）
    if(trees.length > 1) {
      const del = document.createElement('span');
      del.className = 'tree-tab-del';
      del.textContent = '✕';
      del.title = '削除';
      del.onclick = async e => { e.stopPropagation(); await deleteTree(t.id); };
      tab.appendChild(del);
    }

    // タブクリックで切り替え
    tab.onclick = () => { if(t.id !== activeId) switchTree(t.id); };
    list.appendChild(tab);
  });
}

function startTabRename(tab, treeId, currentName) {
  const nameSpan = tab.querySelector('.tree-tab-name');
  const inp = document.createElement('input');
  inp.className = 'tree-tab-edit';
  inp.value = currentName;
  tab.replaceChild(inp, nameSpan);
  inp.focus(); inp.select();
  const finish = async () => {
    const name = inp.value.trim() || currentName;
    await renameTree(treeId, name);
  };
  inp.onblur = finish;
  inp.onkeydown = e => {
    if(e.key === 'Enter') inp.blur();
    if(e.key === 'Escape') { inp.value = currentName; inp.blur(); }
  };
}

async function switchTree(treeId) {
  const r = await fetch('/api/trees/' + treeId + '/switch', {method:'POST'});
  const d = await r.json();
  if(d.error) { st('エラー: ' + d.error); return; }
  selNode = null; showDetail(null);
  applyGraphResponse(d);
}

async function createTree() {
  const name = prompt('ツリー名:', '新しいツリー');
  if(name === null) return;
  const r = await fetch('/api/trees', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name: name.trim() || '新しいツリー'})
  });
  const d = await r.json();
  if(d.error) { st('エラー: ' + d.error); return; }
  selNode = null; showDetail(null);
  applyGraphResponse(d);
}

async function renameTree(treeId, name) {
  const r = await fetch('/api/trees/' + treeId, {
    method:'PUT', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name})
  });
  const d = await r.json();
  if(d.error) { st('エラー: ' + d.error); return; }
  applyGraphResponse(d);
}

async function deleteTree(treeId) {
  if(!confirm('このツリーを削除しますか？')) return;
  const r = await fetch('/api/trees/' + treeId, {method:'DELETE'});
  const d = await r.json();
  if(d.error) { st('エラー: ' + d.error); return; }
  selNode = null; showDetail(null);
  applyGraphResponse(d);
}

function renderCurrent() {
  if(viewMode === 'graph') renderGraph(); else renderTree();
}

function renderTree() {
  const el = id('tree');
  const hasParent = new Set((graph.edges||[]).filter(e=>e.label!=='seq').map(e=>e.to));
  const rootSet = Object.values(graph.nodes).filter(n => !hasParent.has(n.id));
  const rootOrder = graph._rootOrder?.filter(id => graph.nodes[id]) || [];
  const roots = rootOrder.length
    ? [...rootOrder.map(id => graph.nodes[id]), ...rootSet.filter(n => !rootOrder.includes(n.id))]
    : rootSet;

  el.innerHTML = '';
  const frag = document.createDocumentFragment();
  roots.forEach(n => frag.appendChild(makeNodeEl(n, 0)));
  el.appendChild(frag);

  // 親が削除されて孤立したノードを追加（折りたたまれた子は除外）
  const collapsedChildren = new Set();
  Object.values(graph.nodes).forEach(n => {
    if(n.expanded === false)
      (n.children||[]).forEach(cid => collapsedChildren.add(cid));
  });
  Object.values(graph.nodes).forEach(n => {
    if(hasParent.has(n.id) && !collapsedChildren.has(n.id) && !el.querySelector(`[data-id="${n.id}"]`))
      el.appendChild(makeNodeEl(n, 0));
  });

  id('tree-count').textContent = Object.keys(graph.nodes).length + ' ノード';
}

// ===== VIEW TOGGLE =====
function toggleView() {
  graphSel.clear();
  viewMode = viewMode === 'tree' ? 'graph' : 'tree';
  id('btn-view').textContent = viewMode === 'tree' ? 'グラフ' : 'ツリー';
  id('tree').style.display        = viewMode === 'tree'  ? '' : 'none';
  id('drop-root').style.display   = 'none';
  id('graph-view').style.display  = viewMode === 'graph' ? 'block' : 'none';
  if(viewMode === 'graph') setTimeout(renderGraph, 50);
  else renderTree();
}

// ===== D3 GRAPH VIEW =====
function computeDepths() {
  const depths = {}, hasParent = new Set((graph.edges||[]).filter(e=>e.label!=='seq').map(e=>e.to));
  const roots = Object.values(graph.nodes).filter(n => !hasParent.has(n.id));
  const visiting = new Set();
  function visit(nid, d) {
    if(visiting.has(nid)) return; // 循環検出
    visiting.add(nid);
    depths[nid] = d;
    (graph.nodes[nid]?.children||[]).forEach(c => visit(c, d+1));
    visiting.delete(nid);
  }
  roots.forEach(n => visit(n.id, 0));
  return depths;
}

const NODE_COLORS = ['#4a9edd','#3dbfa0','#d4875a','#d4c45a','#b87ac8'];

function loadD3() {
  return new Promise((resolve, reject) => {
    if(typeof d3 !== 'undefined') { resolve(); return; }
    // Monaco の AMD loader と衝突しないよう define を一時退避
    const savedDefine = window.define;
    window.define = undefined;
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js';
    s.onload  = () => { window.define = savedDefine; resolve(); };
    s.onerror = () => { window.define = savedDefine; reject(new Error('D3 load failed')); };
    document.head.appendChild(s);
  });
}

// 階層ツリーレイアウト計算（左→右展開）
function treeLayout(nodeArr, edgeArr) {
  const XG = 200, YG = 70; // 列間・行間
  const childMap = {}, pos = {};
  nodeArr.forEach(n => childMap[n.id] = []);
  edgeArr.filter(e=>e.label!=='seq').forEach(e => { if(childMap[e.source] !== undefined) childMap[e.source].push(e.target); });
  const hasParent = new Set(edgeArr.filter(e=>e.label!=='seq').map(e => e.target));
  const roots = nodeArr.filter(n => !hasParent.has(n.id));
  let cursor = 0;
  const placing = new Set();
  function place(nid, depth) {
    if(placing.has(nid)) return; // 循環ガード
    placing.add(nid);
    const kids = childMap[nid] || [];
    if(!kids.length) { pos[nid] = {x: depth*XG + 90, y: cursor*YG + 50}; cursor++; placing.delete(nid); return; }
    const start = cursor;
    kids.forEach(c => place(c, depth+1));
    const end = cursor - 1;
    pos[nid] = {x: depth*XG + 90, y: ((start+end)/2)*YG + 50};
    placing.delete(nid);
  }
  roots.forEach(r => place(r.id, 0));
  // 孤立ノード（エッジなし）
  nodeArr.forEach(n => { if(!pos[n.id]) { pos[n.id] = {x: 90, y: cursor*YG + 50}; cursor++; } });
  return pos;
}

async function renderGraph() {
  try { await loadD3(); } catch(e) { st('D3 読み込み失敗: ' + e); return; }
  if(typeof d3 === 'undefined') { st('D3 初期化失敗'); return; }
  const container = id('graph-view');
  container.innerHTML = '';
  if(d3sim) { d3sim.stop(); d3sim = null; }

  const depths = computeDepths();
  const nodeArr = Object.values(graph.nodes);
  if(!nodeArr.length) { container.innerHTML = '<div style="color:#555;padding:20px">ノードなし</div>'; return; }
  const edgeArr = (graph.edges||[]).map(e => ({source:e.from, target:e.to, label:e.label}));

  // ツールバー（メモ表示トグル + PNG保存）
  container.style.position = 'relative';
  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'position:absolute;top:6px;right:8px;display:flex;gap:4px;z-index:10;pointer-events:all';
  const btnMemo = document.createElement('button');
  btnMemo.textContent = '💬 メモ';
  btnMemo.style.cssText = `font-size:11px;padding:2px 8px;background:${showMemos?'#094771':'#3c3c3c'};color:#ccc;border:1px solid #555;border-radius:3px;cursor:pointer`;
  btnMemo.onclick = () => { showMemos = !showMemos; renderGraph(); };


  const btnPng = document.createElement('button');
  btnPng.textContent = '🖼 PNG';
  btnPng.style.cssText = 'font-size:11px;padding:2px 8px;background:#3c3c3c;color:#ccc;border:1px solid #555;border-radius:3px;cursor:pointer';
  btnPng.onclick = exportGraphPNG;

  const btnDrawio = document.createElement('button');
  btnDrawio.textContent = '📐 draw.io';
  btnDrawio.style.cssText = 'font-size:11px;padding:2px 8px;background:#3c3c3c;color:#ccc;border:1px solid #555;border-radius:3px;cursor:pointer';
  btnDrawio.onclick = exportGraphDrawio;

  const btnExpand = document.createElement('button');
  btnExpand.textContent = '⇔ 伸ばす';
  btnExpand.style.cssText = 'font-size:11px;padding:2px 8px;background:#3c3c3c;color:#ccc;border:1px solid #555;border-radius:3px;cursor:pointer';

  const btnShrink = document.createElement('button');
  btnShrink.textContent = '⇔ 縮める';
  btnShrink.style.cssText = 'font-size:11px;padding:2px 8px;background:#3c3c3c;color:#ccc;border:1px solid #555;border-radius:3px;cursor:pointer';

  toolbar.append(btnShrink, btnExpand, btnMemo, btnPng, btnDrawio);
  container.appendChild(toolbar);

  const W = container.offsetWidth  || 800;
  const H = container.offsetHeight || 600;
  if(W < 10 || H < 10) { setTimeout(renderGraph, 100); return; }
  const NW = 180;
  const NH = () => 48;
  const SN_LINE_H = 16;   // メモ1行の高さ
  const SN_MAX_LINES = 6; // 最大表示行
  function memoLines(d) {
    if(!showMemos || !d.memo) return [];
    return wrapTextNL(d.memo, 22, SN_MAX_LINES);
  }

  // ツリーレイアウトで初期座標を決定（既存座標があれば保持）
  const pos = treeLayout(nodeArr, edgeArr);
  nodeArr.forEach(n => { if(n.gx === undefined) { n.gx = pos[n.id].x; n.gy = pos[n.id].y; } });

  const svg = d3.select(container).append('svg')
    .attr('width', W).attr('height', H).style('display','block');
  const root = svg.append('g');
  svg.call(d3.zoom().scaleExtent([0.15, 4]).on('zoom', e => root.attr('transform', e.transform)));
  svg.on('click', () => { graphSel.clear(); refreshGraphSel(); });

  const defs = svg.append('defs');
  defs.append('marker')
    .attr('id','arr').attr('viewBox','0 -4 8 8')
    .attr('refX', 8).attr('refY', 0)
    .attr('markerWidth',6).attr('markerHeight',6).attr('orient','auto')
    .append('path').attr('d','M0,-4L8,0L0,4').attr('fill','#555');
  defs.append('marker')
    .attr('id','arr-seq').attr('viewBox','0 -4 8 8')
    .attr('refX', 8).attr('refY', 0)
    .attr('markerWidth',6).attr('markerHeight',6).attr('orient','auto')
    .append('path').attr('d','M0,-4L8,0L0,4').attr('fill','#d4875a');
  // 付箋用ドロップシャドウ
  const flt = defs.append('filter').attr('id','sticky-shadow')
    .attr('x','-15%').attr('y','-15%').attr('width','140%').attr('height','140%');
  flt.append('feDropShadow')
    .attr('dx','2').attr('dy','3').attr('stdDeviation','3')
    .attr('flood-color','#00000077');

  // エッジ（ベジェ曲線）
  const linkG = root.append('g');
  const labelG = root.append('g');
  const nodeG  = root.append('g');

  function nodeById(id_) { return nodeArr.find(n => n.id === id_); }
  function edgePath(e) {
    const s = nodeById(e.source), t = nodeById(e.target);
    if(!s||!t) return '';
    if(e.label === 'seq') {
      // 縦方向: 下端 → 上端
      const sx = s.gx, sy = s.gy + NH()/2;
      const tx = t.gx, ty = t.gy - NH()/2;
      const my = (sy + ty) / 2;
      return `M${sx},${sy} C${sx},${my} ${tx},${my} ${tx},${ty}`;
    }
    const sx = s.gx + NW/2, sy = s.gy;
    const tx = t.gx - NW/2, ty = t.gy;
    const mx = (sx+tx)/2;
    return `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`;
  }

  // クリック用の太い透明パス（ヒット領域）
  linkG.selectAll('path.edge-hit').data(edgeArr).enter().append('path')
    .attr('class','edge-hit')
    .attr('fill','none').attr('stroke','transparent').attr('stroke-width',12)
    .attr('d', edgePath)
    .style('cursor','pointer')
    .on('click', (e, d) => { e.stopPropagation(); showEdgeMenu(e, d); });

  linkG.selectAll('path.edge-vis').data(edgeArr).enter().append('path')
    .attr('class','edge-vis')
    .attr('fill','none')
    .attr('stroke', e => e.label === 'seq' ? '#d4875a' : '#444')
    .attr('stroke-width', 1.5)
    .attr('stroke-dasharray', e => e.label === 'seq' ? '6,4' : 'none')
    .attr('marker-end', e => e.label === 'seq' ? 'url(#arr-seq)' : 'url(#arr)')
    .attr('d', edgePath);

  // ルートノード間の自動seq矢印（保存不要・描画のみ）
  const hasParentSet = new Set(edgeArr.filter(e=>e.label!=='seq').map(e=>e.target));
  const rootNodes = nodeArr.filter(n => !hasParentSet.has(n.id)).sort((a,b) => a.gy - b.gy);
  const autoSeqArr = [];
  for(let i = 0; i < rootNodes.length - 1; i++)
    autoSeqArr.push({source: rootNodes[i].id, target: rootNodes[i+1].id, label:'seq'});

  linkG.selectAll('path.auto-seq').data(autoSeqArr).enter().append('path')
    .attr('class','auto-seq')
    .attr('fill','none').attr('stroke','#d4875a').attr('stroke-width',1.5)
    .attr('stroke-dasharray','6,4').attr('marker-end','url(#arr-seq)')
    .attr('d', edgePath);

  // "ref" 以外ラベル
  const linkLabel = labelG.selectAll('text')
    .data(edgeArr.filter(e=>e.label&&e.label!=='ref')).enter()
    .append('text').text(d=>d.label)
    .attr('fill','#888').attr('font-size','10px').attr('text-anchor','middle')
    .attr('x', d => { const s=nodeById(d.source),t=nodeById(d.target); return s&&t?(s.gx+NW/2+t.gx-NW/2)/2:0; })
    .attr('y', d => { const s=nodeById(d.source),t=nodeById(d.target); return s&&t?(s.gy+t.gy)/2:0; });

  // ノード
  let tempLine = null, edgeSrc = null;

  const node = nodeG.selectAll('g').data(nodeArr).enter()
    .append('g').attr('class', d => 'gnode'+(selNode===d.id?' sel':''))
    .attr('transform', d => `translate(${d.gx},${d.gy})`)
    .call(d3.drag()
      .on('start', function(e, d) {
        if(e.sourceEvent.shiftKey) {
          // Shift+ドラッグ → エッジ作成モード
          edgeSrc = d;
          const svgPt = svg.node().createSVGPoint();
          svgPt.x = e.sourceEvent.clientX; svgPt.y = e.sourceEvent.clientY;
          const pt = svgPt.matrixTransform(root.node().getScreenCTM().inverse());
          tempLine = root.append('line')
            .attr('class','temp-edge')
            .attr('x1', d.gx).attr('y1', d.gy)
            .attr('x2', pt.x).attr('y2', pt.y)
            .attr('stroke','#007acc').attr('stroke-width',1.5)
            .attr('stroke-dasharray','6,3').attr('pointer-events','none');
        } else {
          // 選択外ノードをドラッグ → そのノードだけ選択
          if(!graphSel.has(d.id)) {
            graphSel.clear();
            graphSel.add(d.id);
            refreshGraphSel();
          }
        }
      })
      .on('drag', function(e, d) {
        if(edgeSrc) {
          // エッジ描画中
          const svgPt = svg.node().createSVGPoint();
          svgPt.x = e.sourceEvent.clientX; svgPt.y = e.sourceEvent.clientY;
          const pt = svgPt.matrixTransform(root.node().getScreenCTM().inverse());
          tempLine.attr('x2', pt.x).attr('y2', pt.y);
          // ホバー中のノードをハイライト
          nodeG.selectAll('g.gnode rect.hover-hl').attr('stroke-width', 1.5);
          const hover = nodeArr.find(n => n.id !== edgeSrc.id &&
            Math.abs(n.gx - pt.x) < NW/2 && Math.abs(n.gy - pt.y) < NH()/2);
          if(hover) {
            nodeG.selectAll('g.gnode').filter(n => n.id === hover.id)
              .select('rect').attr('stroke-width', 3);
          }
        } else {
          // 複数選択中 → 選択ノードを全て移動
          if(graphSel.size > 1 && graphSel.has(d.id)) {
            graphSel.forEach(id => {
              const n = nodeArr.find(n => n.id === id);
              if(n) { n.gx += e.dx; n.gy += e.dy; }
            });
            nodeG.selectAll('g.gnode').filter(n => graphSel.has(n.id))
              .attr('transform', n => `translate(${n.gx},${n.gy})`);
          } else {
            d.gx += e.dx; d.gy += e.dy;
            d3.select(this).attr('transform', `translate(${d.gx},${d.gy})`);
          }
          linkG.selectAll('path').attr('d', edgePath);
          // auto-seqの順序をy座標の変化に合わせて更新
          rootNodes.sort((a,b) => a.gy - b.gy);
          autoSeqArr.length = 0;
          for(let i = 0; i < rootNodes.length - 1; i++)
            autoSeqArr.push({source: rootNodes[i].id, target: rootNodes[i+1].id, label:'seq'});
          linkG.selectAll('path.auto-seq').data(autoSeqArr).attr('d', edgePath);
          linkLabel
            .attr('x', d => { const s=nodeById(d.source),t=nodeById(d.target); return s&&t?(s.gx+NW/2+t.gx-NW/2)/2:0; })
            .attr('y', d => { const s=nodeById(d.source),t=nodeById(d.target); return s&&t?(s.gy+t.gy)/2:0; });
        }
      })
      .on('end', function(e, _d) {
        if(edgeSrc && tempLine) {
          tempLine.remove(); tempLine = null;
          nodeG.selectAll('g.gnode rect').attr('stroke-width', 1.5);
          const svgPt = svg.node().createSVGPoint();
          svgPt.x = e.sourceEvent.clientX; svgPt.y = e.sourceEvent.clientY;
          const pt = svgPt.matrixTransform(root.node().getScreenCTM().inverse());
          const tgt = nodeArr.find(n => n.id !== edgeSrc.id &&
            Math.abs(n.gx - pt.x) < NW/2 && Math.abs(n.gy - pt.y) < NH()/2);
          if(tgt) addGraphEdge(edgeSrc.id, tgt.id, edgeMode);
          edgeSrc = null;
        }
      }))
    .on('click', (e, d) => {
      e.stopPropagation();
      if(e.ctrlKey || e.metaKey) {
        // Ctrl+クリック → 複数選択トグル
        if(graphSel.has(d.id)) graphSel.delete(d.id); else graphSel.add(d.id);
      } else {
        graphSel.clear();
        graphSel.add(d.id);
        selectNode(d.id);
      }
      refreshGraphSel();
    })
    .on('mouseenter', (e,d) => { if(d.memo) showMemoTip(e, d); })
    .on('mousemove',  (e)   => { moveMemoTip(e); d3.select(e.currentTarget).style('cursor', e.shiftKey ? 'crosshair' : 'grab'); })
    .on('mouseleave', ()    => hideMemoTip());

  // ノード背景
  node.append('rect')
    .attr('width', NW).attr('height', NH())
    .attr('x', -NW/2).attr('y', -NH()/2).attr('rx', 4)
    .attr('fill', d => NODE_COLORS[Math.min(depths[d.id]||0,4)]+'22')
    .attr('stroke', d => NODE_COLORS[Math.min(depths[d.id]||0,4)])
    .attr('stroke-width', 1.5);

  // コード行テキスト
  node.append('text')
    .text(d => trunc(d.label||(d.match?.text||'').trim()||'', 22))
    .attr('text-anchor','middle').attr('y', -8)
    .attr('font-size','11px').attr('fill','#e0e0e0').attr('font-weight','bold');

  // ファイル:行
  node.append('text')
    .text(d => shortPath(d.match?.file||'')+(d.match?.line?':'+d.match.line:''))
    .attr('text-anchor','middle').attr('y', 9)
    .attr('font-size','10px').attr('fill','#778');

  // 付箋（showMemos ON かつ memo あり）
  node.each(function(d) {
    const ml = memoLines(d);
    if(!ml.length) return;
    const g = d3.select(this);
    const SNW = NW + 16;
    const FOLD = 12;
    const SNH = ml.length * SN_LINE_H + 22;
    const noteY = NH() / 2;

    // メモボックスグループ
    const ng = g.append('g')
      .attr('transform', `translate(${-SNW/2},${noteY})`)
      .attr('filter', 'url(#sticky-shadow)');

    // 付箋本体（折れ角付き）
    ng.append('path')
      .attr('d', `M0,0 L${SNW-FOLD},0 L${SNW},${FOLD} L${SNW},${SNH} L0,${SNH} Z`)
      .attr('fill', '#fef08a').attr('stroke', 'none');

    // 折れ角（暗め）
    ng.append('path')
      .attr('d', `M${SNW-FOLD},0 L${SNW},${FOLD} L${SNW-FOLD},${FOLD} Z`)
      .attr('fill', '#c8a200');

    // テキスト
    ml.forEach((line, i) => {
      ng.append('text')
        .text(line || ' ')
        .attr('x', 8).attr('y', 16 + i * SN_LINE_H)
        .attr('font-size', '11px').attr('fill', '#111')
        .attr('font-family', 'Consolas,monospace');
    });
  });

  // ノード間隔スケール
  function scaleNodes(factor) {
    const cx = nodeArr.reduce((s, n) => s + n.gx, 0) / nodeArr.length;
    const cy = nodeArr.reduce((s, n) => s + n.gy, 0) / nodeArr.length;
    nodeArr.forEach(n => { n.gx = cx + (n.gx - cx) * factor; n.gy = cy + (n.gy - cy) * factor; });
    nodeG.selectAll('g.gnode').attr('transform', d => `translate(${d.gx},${d.gy})`);
    linkG.selectAll('path').attr('d', edgePath);
    rootNodes.sort((a, b) => a.gy - b.gy);
    autoSeqArr.length = 0;
    for(let i = 0; i < rootNodes.length - 1; i++)
      autoSeqArr.push({source: rootNodes[i].id, target: rootNodes[i+1].id, label:'seq'});
    linkG.selectAll('path.auto-seq').data(autoSeqArr).attr('d', edgePath);
    linkLabel
      .attr('x', d => { const s=nodeById(d.source),t=nodeById(d.target); return s&&t?(s.gx+NW/2+t.gx-NW/2)/2:0; })
      .attr('y', d => { const s=nodeById(d.source),t=nodeById(d.target); return s&&t?(s.gy+t.gy)/2:0; });
  }
  btnExpand.onclick = () => scaleNodes(1.2);
  btnShrink.onclick = () => scaleNodes(1 / 1.2);

}

function showEdgeMenu(e, edgeData) {
  // 既存メニュー削除
  document.querySelectorAll('.edge-menu').forEach(el => el.remove());
  const menu = document.createElement('div');
  menu.className = 'edge-menu';
  menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;
    background:#2d2d2d;border:1px solid #555;border-radius:3px;
    padding:4px 0;z-index:3000;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,0.5)`;
  const del = document.createElement('div');
  del.textContent = '× エッジを削除';
  del.style.cssText = 'padding:4px 12px;cursor:pointer;color:#f88';
  del.onmouseenter = () => del.style.background = '#3a2020';
  del.onmouseleave = () => del.style.background = '';
  del.onclick = async () => {
    menu.remove();
    await deleteGraphEdge(edgeData.source, edgeData.target);
  };
  menu.appendChild(del);
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), {once:true}), 0);
}

async function deleteGraphEdge(from, to) {
  const fromId = typeof from === 'object' ? from.id : from;
  const toId   = typeof to   === 'object' ? to.id   : to;
  const r = await fetch('/api/graph/edge/delete', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({from: fromId, to: toId})
  });
  const d = await r.json();
  if(d.error){ st('エラー: '+d.error); return; }
  graph.edges = graph.edges.filter(e => !(e.from===fromId && e.to===toId));
  if(graph.nodes[fromId])
    graph.nodes[fromId].children = (graph.nodes[fromId].children||[]).filter(c=>c!==toId);
  renderGraph();
  st('エッジ削除');
}


async function autoConnectSeq() {
  // ルートノードのみをy座標順に並べてseqで接続（seqエッジは親子関係に含めない）
  const hasParent = new Set(
    (graph.edges || []).filter(e => e.label !== 'seq').map(e => e.to || e.target)
  );
  const roots = Object.values(graph.nodes)
    .filter(n => !hasParent.has(n.id))
    .sort((a, b) => (a.gy ?? 0) - (b.gy ?? 0));

  let count = 0;
  for (let i = 0; i < roots.length - 1; i++) {
    const from = roots[i].id, to = roots[i + 1].id;
    const exists = graph.edges.some(e =>
      (e.from || e.source) === from && (e.to || e.target) === to && e.label === 'seq'
    );
    if (!exists) { await addGraphEdge(from, to, 'seq'); count++; }
  }
  st(count > 0 ? `処理順エッジを ${count} 本追加` : '追加するエッジはありません');
}

async function addGraphEdge(fromId, toId, label = 'ref') {
  const r = await fetch('/api/graph/edge', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({from: fromId, to: toId, label,
      id: fromId.slice(0,8)+'->'+toId.slice(0,8)})
  });
  const d = await r.json();
  if(d.error){ st('エラー: '+d.error); return; }
  graph.edges.push(d);
  // seq エッジはツリーの親子構造を変えない
  if(label !== 'seq' && graph.nodes[fromId] && !graph.nodes[fromId].children?.includes(toId))
    (graph.nodes[fromId].children = graph.nodes[fromId].children||[]).push(toId);
  renderGraph();
  st('エッジ追加');
}

function refreshGraphSel() {
  d3.selectAll('.gnode').classed('sel', d => d.id === selNode);
  d3.selectAll('.gnode').classed('multi-sel', d => graphSel.has(d.id));
}

function makeNodeEl(node, depth, visited = new Set()) {
  if(visited.has(node.id) || depth > 30) return document.createElement('div');
  visited.add(node.id);
  const m = node.match || {};
  const children = (node.children || []).map(cid => graph.nodes[cid]).filter(Boolean);

  const wrap = document.createElement('div');
  wrap.className = `node depth-${Math.min(depth, 4)}`;
  wrap.dataset.id = node.id;

  const row = document.createElement('div');
  row.className = 'node-row' + (selNode===node.id ? ' sel' : '');
  row.dataset.id = node.id;

  const tog = document.createElement('div');
  tog.className = 'tog';
  tog.textContent = children.length ? (node.expanded===false ? '▶' : '▼') : ' ';

  const body = document.createElement('div');
  body.className = 'node-body';

  // ラベル = マッチしたコード行（なければファイル:行）
  const matchText = (m.text || '').trim();
  const lbl = document.createElement('div');
  lbl.className = 'node-label';
  lbl.textContent = node.label || matchText || labelFrom(m);

  // 下段 = ファイル:行（クリックでエディタ）
  const sub = document.createElement('div');
  sub.className = 'node-sub';
  const subLink = document.createElement('span');
  subLink.textContent = shortPath(m.file||'') + (m.line ? ':'+m.line : '');
  subLink.title = 'クリックでエディタで開く';
  subLink.style.cssText = 'cursor:pointer;text-decoration:underline';
  subLink.onclick = e => { e.stopPropagation(); openFile(m.file, m.line); };
  sub.appendChild(subLink);

  const ifdefText = (m.ifdef_stack||[]).map(f=>'#'+f.directive+' '+f.condition).join(' > ');
  if(ifdefText) {
    const ifd = document.createElement('div');
    ifd.className = 'node-ifdef';
    ifd.textContent = ifdefText;
    body.appendChild(lbl); body.appendChild(sub); body.appendChild(ifd);
  } else {
    body.appendChild(lbl); body.appendChild(sub);
  }

  row.appendChild(tog);
  row.appendChild(body);

  const handle = document.createElement('div');
  handle.className = 'indent-handle';
  handle.textContent = '⠿';
  handle.title = '左右にドラッグしてレベル変更';
  attachIndentDrag(handle, node.id, depth);

  const delBtn = document.createElement('button');
  delBtn.className = 'node-del';
  delBtn.textContent = '×';
  delBtn.title = '削除';
  delBtn.onclick = e => { e.stopPropagation(); removeNode(node.id); };

  row.insertBefore(handle, row.firstChild);
  if(node.memo) {
    const memoIcon = document.createElement('span');
    memoIcon.className = 'node-memo-dot';
    memoIcon.title = node.memo;
    memoIcon.textContent = '💬';
    row.appendChild(memoIcon);
  }
  row.appendChild(delBtn);
  row.onclick = e => { e.stopPropagation(); selectNode(node.id); };
  lbl.ondblclick = e => {
    e.stopPropagation();
    const original = node.label || matchText || labelFrom(m);
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = original;
    inp.style.cssText = 'width:100%;background:#1a1a1a;border:1px solid #555;color:#e0e0e0;font:12px Consolas,monospace;padding:1px 4px;border-radius:2px;box-sizing:border-box';
    lbl.textContent = '';
    lbl.appendChild(inp);
    inp.focus(); inp.select();
    const save = async () => {
      const val = inp.value.trim() || original;
      const r = await fetch('/api/graph/node/' + node.id, {
        method: 'PUT', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({label: val})
      });
      const n = await r.json();
      graph.nodes[node.id] = n;
      renderCurrent();
      if(selNode === node.id) showDetail(node.id);
      st('ラベル保存');
    };
    const cancel = () => {
      lbl.textContent = original;
      if(node.memo) {
        const icon = document.createElement('span');
        icon.className = 'node-memo-dot'; icon.title = node.memo; icon.textContent = '💬';
        lbl.appendChild(icon);
      }
    };
    inp.onblur = save;
    inp.onkeydown = e2 => {
      if(e2.key === 'Enter')  { e2.preventDefault(); inp.blur(); }
      if(e2.key === 'Escape') { e2.stopPropagation(); inp.onblur = null; cancel(); }
    };
  };
  tog.onclick = e => { e.stopPropagation(); toggleNode(node.id); };
  if(node.memo) {
    row.addEventListener('mouseenter', e => showMemoTip(e, node));
    row.addEventListener('mousemove',  e => moveMemoTip(e));
    row.addEventListener('mouseleave', hideMemoTip);
  }
  if(m.file && m.line) attachPreview(row, m.file, m.line);

  // D&D
  row.draggable = true;
  row.ondragstart = e => {
    dragNodeId = node.id;
    dragDepth  = depth;
    dragStartX = e.clientX;
    lastDragX  = e.clientX;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    id('drop-root').style.display = '';
    row._dragSeq = ++dragSeq; // このドラッグ操作の識別子
  };
  // ---- 設計原則 ----
  // レベル変更モード (delta !== 0): ondragend のみが reparent を実行。
  //   ondragover は insert インジケーターを出さない。ondrop は何もしない。
  // 挿入モード (delta === 0): ondrop のみが reorderNode/reparent を実行。
  //   dropHandled = true にして ondragend の二重処理を防ぐ。
  // -----------------------------------------------------------------------

  row.ondragend = _e => {
    // 再レンダリングで切り離された古い row の ondragend が遅延発火した場合は無視する。
    // これがないと新しいドラッグ中に dragNodeId が null にリセットされてドロップ不能になる。
    if(row._dragSeq !== dragSeq) return;
    row.classList.remove('dragging');
    id('drop-root').style.display = 'none';
    id('level-badge').style.display = 'none';
    const g = id('indent-guide'); if(g) g.style.display = 'none';
    // drag-over と indent-target はすぐクリア。insert-before/after はギャップ判定後にクリア
    document.querySelectorAll('.drag-over,.indent-target').forEach(el => {
      el.classList.remove('drag-over','indent-target');
    });
    if(!dropHandled) {
      // ノード間ギャップにドロップされた場合: 残っているインジケーターで処理
      const insertBefore = document.querySelector('.node.insert-before');
      const insertAfter  = document.querySelector('.node.insert-after');
      const targetWrap   = insertBefore || insertAfter;
      if(targetWrap && targetWrap.dataset.id && targetWrap.dataset.id !== node.id) {
        const targetId = targetWrap.dataset.id;
        document.querySelectorAll('.node.insert-before,.node.insert-after').forEach(el => {
          el.classList.remove('insert-before','insert-after');
        });
        reorderNode(node.id, targetId, insertBefore ? 'before' : 'after');
        dragNodeId = null;
        dropHandled = false;
        return;
      }
      document.querySelectorAll('.node.insert-before,.node.insert-after').forEach(el => {
        el.classList.remove('insert-before','insert-after');
      });
      // インジケーターなし → レベル変更を適用
      const dx = lastDragX - dragStartX;
      const delta = Math.round(dx / DRAG_STEP);
      if(delta !== 0) {
        const newDepth = Math.max(0, depth + delta);
        const targetParentId = calcDragTarget(node.id, depth, newDepth);
        if(targetParentId !== undefined) reparent(node.id, targetParentId);
      }
    } else {
      document.querySelectorAll('.node.insert-before,.node.insert-after').forEach(el => {
        el.classList.remove('insert-before','insert-after');
      });
    }
    dropHandled = false;
    dragNodeId = null;
  };
  row.ondragover = e => {
    if(!dragNodeId || dragNodeId === node.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    // 挿入インジケーターを常に表示（レベル変更中でも）
    document.querySelectorAll('.node-row.drag-over').forEach(el => el.classList.remove('drag-over'));
    document.querySelectorAll('.node.insert-before,.node.insert-after').forEach(el => {
      el.classList.remove('insert-before','insert-after');
    });
    const rect = row.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    if(ratio < 0.35) {
      wrap.classList.add('insert-before');
    } else if(ratio > 0.65) {
      wrap.classList.add('insert-after');
    } else {
      row.classList.add('drag-over');
    }
  };
  row.ondragleave = e => {
    if(!row.contains(e.relatedTarget)) {
      row.classList.remove('drag-over');
      // insert-before/after はギャップ通過時も保持し、
      // 次のノードの ondragover または ondragend でクリアする
    }
  };
  row.ondrop = e => {
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove('drag-over');
    const isBefore = wrap.classList.contains('insert-before');
    const isAfter  = wrap.classList.contains('insert-after');
    wrap.classList.remove('insert-before','insert-after');
    if(!dragNodeId || dragNodeId === node.id) return;

    const dx = lastDragX - dragStartX;
    const delta = Math.round(dx / DRAG_STEP);
    dropHandled = true;

    if(delta !== 0) {
      // レベル変更 + 挿入位置を同時適用
      const newDepth = Math.max(0, dragDepth + delta);
      const targetParentId = calcDragTarget(dragNodeId, dragDepth, newDepth);
      if(targetParentId === undefined) { dropHandled = false; return; }
      if(clientIsDescendant(targetParentId, dragNodeId)) { st('循環参照になるため移動できません'); dropHandled = false; return; }
      if(isBefore || isAfter) {
        // reparent後に挿入位置を指定
        reparent(dragNodeId, targetParentId).then(() =>
          reorderNode(dragNodeId, node.id, isBefore ? 'before' : 'after', true)
        );
      } else {
        reparent(dragNodeId, targetParentId);
      }
    } else {
      // 挿入のみ（深さ変更なし）
      if(isBefore || isAfter) {
        reorderNode(dragNodeId, node.id, isBefore ? 'before' : 'after');
      } else {
        if(clientIsDescendant(node.id, dragNodeId)) { st('循環参照になるため移動できません'); dropHandled = false; return; }
        reparent(dragNodeId, node.id);
      }
    }
  };

  wrap.appendChild(row);

  if(children.length && node.expanded !== false) {
    const ch = document.createElement('div');
    ch.className = 'children';
    children.forEach(c => ch.appendChild(makeNodeEl(c, depth + 1, new Set(visited))));
    wrap.appendChild(ch);
  }

  return wrap;
}

function selectNode(id_) {
  selNode = id_;
  document.querySelectorAll('.node-row').forEach(el => {
    el.classList.toggle('sel', el.dataset.id === id_);
  });
  const n = graph.nodes[id_];
  showDetail(n);
  if(n && n.match && n.match.file) openPeek(n.match.file, n.match.line);
}

// 指定ノードの親IDを返す（なければ空文字）
function findParent(nodeId) {
  for(const n of Object.values(graph.nodes)) {
    if((n.children||[]).includes(nodeId)) return n.id;
  }
  return '';
}

// 指定ノードの祖父母IDを返す（親がいなければ空文字 = ルートに昇格）
function findGrandparent(nodeId) {
  return findParent(findParent(nodeId));
}

// ancestorId が nodeId の祖先かどうかを返す（循環参照チェック用）
function clientIsDescendant(ancestorId, nodeId) {
  if(!ancestorId || !nodeId) return false;
  const visited = new Set();
  function check(id) {
    if(visited.has(id)) return false;
    visited.add(id);
    const n = graph.nodes[id];
    if(!n) return false;
    const children = n.children || [];
    if(children.includes(ancestorId)) return true;
    return children.some(c => check(c));
  }
  return check(nodeId);
}

async function reorderNode(nodeId, refNodeId, position, reorderOnly = false) {
  // 同じ親を持つ兄弟間での順序変更
  const parentId = findParent(refNodeId);
  const nodeParentId = findParent(nodeId);

  if(parentId !== nodeParentId) {
    if(reorderOnly) return; // 既にreparent済みなので親が合わなければスキップ
    // 異なる親 → refNodeの親の子にしてから並び替え
    if(clientIsDescendant(parentId, nodeId)) { st('循環参照になるため移動できません'); return; }
    await reparent(nodeId, parentId);
    // reparentで再描画されるので再度並び替え
    const parent = graph.nodes[parentId];
    if(!parent) return;
    const children = parent.children || [];
    const fromIdx = children.indexOf(nodeId);
    let toIdx = children.indexOf(refNodeId);
    if(fromIdx === -1 || toIdx === -1) return;
    children.splice(fromIdx, 1);
    toIdx = children.indexOf(refNodeId);
    children.splice(position === 'before' ? toIdx : toIdx + 1, 0, nodeId);
    await saveChildrenOrder(parentId, children);
    return;
  }

  // 同じ親 → children配列の順序を変更
  const parent = parentId ? graph.nodes[parentId] : null;
  const siblings = parent
    ? (parent.children || [])
    : (() => {
        const hasParent = new Set((graph.edges||[]).filter(e=>e.label!=='seq').map(e=>e.to));
        const rootIds = Object.values(graph.nodes).filter(n => !hasParent.has(n.id)).map(n => n.id);
        const existing = (graph._rootOrder || []).filter(id => graph.nodes[id]);
        const missing = rootIds.filter(id => !existing.includes(id));
        return [...existing, ...missing];
      })();

  const arr = [...siblings];
  const fromIdx = arr.indexOf(nodeId);
  if(fromIdx === -1) return;
  arr.splice(fromIdx, 1);
  let toIdx = arr.indexOf(refNodeId);
  if(toIdx === -1) return;
  arr.splice(position === 'before' ? toIdx : toIdx + 1, 0, nodeId);

  if(parent) {
    parent.children = arr;
    await saveChildrenOrder(parentId, arr);
  } else {
    // ルートノードの並び替え: 各ノードのchildren順序は変えず表示順だけ管理
    // graph.rootOrder に保存（なければgraph.nodesのキー順）
    graph._rootOrder = arr;
    await saveRootOrder(arr);
  }
}

async function saveChildrenOrder(parentId, children) {
  const r = await fetch('/api/graph/node/' + parentId, {
    method: 'PUT', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({children})
  });
  const d = await r.json();
  if(d.error) { st('エラー: ' + d.error); return; }
  graph.nodes[parentId].children = children;
  renderCurrent();
  stGraph();
}

async function saveRootOrder(order) {
  await fetch('/api/graph/rootorder', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({order})
  });
  renderCurrent();
}

async function reparent(nodeId, newParentId) {
  const r = await fetch('/api/graph/reparent', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({node_id: nodeId, new_parent_id: newParentId, edge_label: 'ref'})
  });
  const d = await r.json();
  if(d.error) { st('エラー: '+d.error); return; }
  applyGraphResponse(d);
  stGraph();
}

async function toggleNode(id_) {
  const n = graph.nodes[id_];
  if(!n) return;
  const expanded = n.expanded === false ? true : false;
  await fetch('/api/graph/node/'+id_, {
    method:'PUT', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({expanded})
  });
  n.expanded = expanded;
  renderCurrent();
}

// ===== DETAIL =====
// アコーディオンセクション開閉状態を記憶
const accState = {loc:true, ifdef:false, snippet:false, memo:true, expand:false};

function makeAccSection(key, title, bodyHTML, defaultOpen) {
  const open = accState[key] !== undefined ? accState[key] : defaultOpen;
  const sec = document.createElement('div');
  sec.className = 'acc-sec';
  const hdr = document.createElement('div');
  hdr.className = 'acc-hdr';
  hdr.innerHTML = `<span class="acc-arrow">${open?'▼':'▶'}</span><span class="acc-title">${title}</span>`;
  const body = document.createElement('div');
  body.className = 'acc-body' + (open ? '' : ' closed');
  body.innerHTML = bodyHTML;
  hdr.onclick = () => {
    const isOpen = !body.classList.contains('closed');
    body.classList.toggle('closed', isOpen);
    hdr.querySelector('.acc-arrow').textContent = isOpen ? '▶' : '▼';
    accState[key] = !isOpen;
  };
  sec.append(hdr, body);
  return sec;
}

function showDetail(n) {
  const el = id('detail');
  if(!n) { el.innerHTML='<div id="no-sel" style="color:#555;text-align:center;margin-top:30px;font-size:12px">ノードを選択</div>'; return; }
  const m = n.match || {};
  const stack = m.ifdef_stack || [];
  const snippet = (m.snippet||[]).map(s =>
    `<span class="${s.is_match?'snip-hi':''}">${pad(s.line)} ${esc(s.text)}</span>`
  ).join('\n') || esc(m.text||'');

  el.innerHTML = '';

  // ラベル編集
  const labelSec = makeAccSection('loc', 'ラベル', `
    <div style="display:flex;gap:4px;align-items:center">
      <input id="label-inp" type="text" value="${esc(n.label||'')}" placeholder="${esc((m.text||'').trim() || labelFrom(m))}"
        style="flex:1;background:#1a1a1a;border:1px solid #444;color:#e0e0e0;font:12px Consolas,monospace;padding:2px 5px;border-radius:2px">
      <button id="btn-label" style="flex-shrink:0">保存</button>
    </div>
    <div style="color:#555;font-size:11px;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
         title="${esc((m.text||'').trim())}">元: ${esc((m.text||'').trim() || labelFrom(m))}</div>
    <div class="dv" id="d-filelink" style="cursor:pointer;color:#569cd6;text-decoration:underline;font-size:11px;margin-top:2px">${esc(m.file||'')}:${m.line||''}</div>`, true);
  el.appendChild(labelSec);

  // ifdef スタック（あるときのみ）
  if(stack.length) {
    const ifdefSec = makeAccSection('ifdef', '#ifdef スタック',
      `<div class="ifdef-chips">${stack.map(f=>`<span class="chip" title="line ${f.line}">#${f.directive} ${esc(f.condition)}</span>`).join('')}</div>`, false);
    el.appendChild(ifdefSec);
  }

  // スニペット
  const snipSec = makeAccSection('snippet', 'スニペット',
    `<div class="snippet">${snippet}</div>`, false);
  el.appendChild(snipSec);

  // メモ
  const memoSec = makeAccSection('memo', 'メモ', `
    <textarea id="memo-ta">${esc(n.memo||'')}</textarea>
    <div class="row" style="margin-top:4px">
      <button id="btn-memo">保存</button>
      <button class="sec" id="btn-del">削除</button>
    </div>`, true);
  el.appendChild(memoSec);

  // 展開
  const expSec = makeAccSection('expand', '展開', `
    <div class="row">
      <input id="expand-q" placeholder="パターン" value="${esc(extractSym(m.text||''))}">
      <input id="expand-lbl" placeholder="ラベル" value="ref">
      <input id="expand-glob" placeholder="glob">
    </div>
    <div style="margin-top:4px"><button id="btn-expand">展開</button></div>`, false);
  el.appendChild(expSec);

  id('btn-label').onclick = saveLabel;
  id('btn-memo').onclick = saveMemo;
  id('btn-del').onclick = deleteNode;
  id('btn-expand').onclick = doExpand;
  id('d-filelink').onclick = () => openFile(m.file, m.line);
  id('label-inp').onkeydown = e => { if(e.key === 'Enter') saveLabel(); };
}

async function saveLabel() {
  if(!selNode) return;
  const label = id('label-inp').value.trim();
  const r = await fetch('/api/graph/node/'+selNode, {
    method:'PUT', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({label})
  });
  const n = await r.json();
  graph.nodes[selNode] = n;
  renderCurrent();
  showDetail(selNode);
  st('ラベル保存');
}

async function saveMemo() {
  if(!selNode) return;
  const memo = id('memo-ta').value;
  const r = await fetch('/api/graph/node/'+selNode, {
    method:'PUT', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({memo})
  });
  const n = await r.json();
  graph.nodes[selNode] = n;
  renderCurrent();
  st('メモ保存');
}

async function removeNode(nid) {
  await fetch('/api/graph/node/'+nid, {method:'DELETE'});
  delete graph.nodes[nid];
  graph.edges = (graph.edges||[]).filter(e=>e.from!==nid&&e.to!==nid);
  for(const n of Object.values(graph.nodes))
    n.children = (n.children||[]).filter(c=>c!==nid);
  if(selNode === nid) { selNode=null; showDetail(null); }
  renderCurrent();
  stGraph();
  refreshGraphDecorations();
}

async function deleteNode() {
  if(!selNode) return;
  if(!confirm('削除しますか？')) return;
  await removeNode(selNode);
}

// ===== SEARCH =====
function doSearch() {
  const q = id('q').value.trim(); if(!q) return;
  const dir = id('dir').value.trim();
  const glob = id('glob').value.trim();
  // 設定を保存
  localStorage.setItem('grepnavi-settings', JSON.stringify({dir, glob, regex:id('btn-re').classList.contains('on'), cs:id('btn-cs').classList.contains('on'), word:id('btn-wb').classList.contains('on')}));

  const params = new URLSearchParams({q, regex:id('btn-re').classList.contains('on')?'1':'0', case:id('btn-cs').classList.contains('on')?'1':'0', word:id('btn-wb').classList.contains('on')?'1':'0'});
  if(dir) params.set('dir',dir);
  if(glob) params.set('glob',glob);

  stopSearch();
  allMatches=[]; pending=[]; fileGroupMap={};
  id('results').innerHTML='';
  id('filter-input').value=''; filterTokens=[]; id('filter-input').classList.remove('active'); id('filter-clear').style.display='none';
  id('sh-title').textContent='検索中... "'+q+'"';
  id('sh-over').textContent='';
  id('btn-stop').style.display='';
  spinnerFrame = 0;
  spinnerTimer = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
    st(SPINNER_FRAMES[spinnerFrame] + ' 検索中... ' + allMatches.length + ' 件');
  }, 80);
  st(SPINNER_FRAMES[0] + ' 検索中... 0 件');
  // 検索開始フラッシュ
  const qWrap = id('q-wrap');
  qWrap.classList.remove('search-flash');
  requestAnimationFrame(() => requestAnimationFrame(() => qWrap.classList.add('search-flash')));

  batchTimer = setInterval(()=>flushBatch(q), BATCH_MS);
  sse = new EventSource('/api/search/stream?'+params);

  sse.onmessage = e => {
    const m = JSON.parse(e.data);
    allMatches.push(m); pending.push(m);
  };
  sse.addEventListener('done', e => {
    const d = JSON.parse(e.data);
    stopSearch();
    flushBatch(q);
    const over = d.count - LIMIT;
    const fcount = Object.keys(fileGroupMap).length;
    id('sh-title').textContent = `${fcount} ファイル · ${d.count} 件  "${q}"`;
    id('sh-over').textContent = over>0 ? `先頭${LIMIT}件のみ表示` : '';
    st(`${d.count} 件ヒット  F3: 次へ  Shift+F3: 前へ`);
  });
  sse.onerror = () => { stopSearch(); flushBatch(q); st('完了'); };
}

function stopSearch() {
  if(sse){sse.close();sse=null;}
  if(batchTimer){clearInterval(batchTimer);batchTimer=null;}
  if(spinnerTimer){clearInterval(spinnerTimer);spinnerTimer=null;}
  id('btn-stop').style.display='none';
}

// Material Icon Theme (MIT License, PKief/vscode-material-icon-theme)
const MIT_ICON_BASE = 'https://cdn.jsdelivr.net/gh/PKief/vscode-material-icon-theme@main/icons/';
const EXT_TO_ICON = {
  c:'c',h:'h',cpp:'cpp',cc:'cpp',cxx:'cpp',hpp:'hpp',
  go:'go',
  js:'javascript',mjs:'javascript',cjs:'javascript',
  ts:'typescript',tsx:'react_ts',jsx:'react',
  html:'html',htm:'html',
  css:'css',scss:'scss',sass:'sass',less:'less',
  json:'json',jsonc:'json',
  py:'python',
  rs:'rust',
  md:'markdown',
  sh:'shell',bash:'shell',zsh:'shell',
  bat:'windows_cmd',cmd:'windows_cmd',
  yaml:'yaml',yml:'yaml',
  xml:'xml',
  sql:'database',
  rb:'ruby',
  java:'java',
  cs:'csharp',
  php:'php',
  vue:'vue',
  svelte:'svelte',
  kt:'kotlin',kts:'kotlin',
  swift:'swift',
  r:'r',
  lua:'lua',
  cmake:'cmake',
  makefile:'makefile',mk:'makefile',
  toml:'toml',
  lock:'lock',
  env:'dotenv',
};
const _iconCache = {};
function fileIcon(filename) {
  const base = filename.split(/[\\/]/).pop() || filename;
  const ext = (base.split('.').pop()||'').toLowerCase();
  const name = EXT_TO_ICON[ext] || EXT_TO_ICON[base.toLowerCase()];
  const url = name ? MIT_ICON_BASE + name + '.svg' : null;
  if(!url) {
    // フォールバック: 色付き文字バッジ
    const label = ext.slice(0,4) || '?';
    return `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0;vertical-align:middle"><rect width="16" height="16" rx="2" fill="#607d8b"/><text x="8" y="11.5" font-size="${label.length>2?4.5:6}" font-family="Consolas,monospace" font-weight="bold" fill="#fff" text-anchor="middle">${label}</text></svg>`;
  }
  if(_iconCache[url]) return _iconCache[url];
  const html = `<img src="${url}" width="16" height="16" style="flex-shrink:0;vertical-align:middle" onerror="this.replaceWith(fileIconFallback('${ext}'))">`;
  _iconCache[url] = html;
  return html;
}
function fileIconFallback(ext) {
  const label = ext.slice(0,4)||'?';
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('width','16');svg.setAttribute('height','16');svg.setAttribute('viewBox','0 0 16 16');
  svg.style.cssText='flex-shrink:0;vertical-align:middle';
  svg.innerHTML=`<rect width="16" height="16" rx="2" fill="#607d8b"/><text x="8" y="11.5" font-size="${label.length>2?4.5:6}" font-family="Consolas,monospace" font-weight="bold" fill="#fff" text-anchor="middle">${label}</text>`;
  return svg;
}

// ===== フィルター =====
let filterTokens = [];

function parseFilter(raw) {
  if(!raw.trim()) return null;
  const orGroups = raw.toLowerCase().split(/\s*\|\s*/).map(g => {
    const tokens = g.trim().split(/\s+/).filter(Boolean);
    const must = tokens.filter(t => !t.startsWith('-'));
    const not  = tokens.filter(t => t.startsWith('-')).map(t => t.slice(1)).filter(Boolean);
    return {must, not};
  }).filter(g => g.must.length > 0 || g.not.length > 0);
  return orGroups;
}

function matchFilter(haystack, orGroups) {
  if(!orGroups || orGroups.length === 0) return true;
  return orGroups.some(g =>
    g.must.every(t => haystack.includes(t)) &&
    g.not.every(t => !haystack.includes(t))
  );
}

function applyFilter() {
  const raw = id('filter-input').value;
  const groups = parseFilter(raw);
  const active = raw.trim().length > 0;
  id('filter-input').classList.toggle('active', active);
  id('filter-clear').style.display = active ? '' : 'none';

  document.querySelectorAll('.rg-file-group').forEach(group => {
    let groupHasVisible = false;
    group.querySelectorAll('.ri').forEach(row => {
      const file = (row.title || '').toLowerCase();
      const text = (row.querySelector('.ri-text')||{}).textContent?.toLowerCase() || '';
      const haystack = file + ' ' + text;
      const match = matchFilter(haystack, groups);
      row.classList.toggle('fz-hidden', !match);
      if(match) groupHasVisible = true;
    });
    group.classList.toggle('fz-hidden', !groupHasVisible);
  });
}

// ===== ディレクトリピッカー =====
let dirList = null; // キャッシュ

async function fetchDirs() {
  if(dirList) return dirList;
  try {
    const r = await fetch('/api/dirs');
    dirList = await r.json();
  } catch(e) { dirList = []; }
  return dirList;
}

function highlightMatch(text, query) {
  if(!query) return esc(text);
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  let result = esc(text);
  tokens.forEach(tok => {
    const idx = result.toLowerCase().indexOf(tok);
    if(idx >= 0) {
      result = result.slice(0,idx) + `<span class="dir-hl">${result.slice(idx,idx+tok.length)}</span>` + result.slice(idx+tok.length);
    }
  });
  return result;
}

async function setRoot(newRoot) {
  const r = await fetch('/api/root', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({root: newRoot})
  });
  if(!r.ok) {
    const e = await r.json().catch(()=>({}));
    st('エラー: ' + (e.error || r.statusText));
    return false;
  }
  const data = await r.json();
  projectRoot = data.root;
  const parts = data.root.replace(/\\/g,'/').split('/');
  id('root-label').textContent = parts[parts.length-1] || data.root;
  id('root-label').title = data.root + ' (クリックで変更)';
  dirList = null; // キャッシュクリア
  fzfFiles = null; // ファイル一覧キャッシュクリア
  id('dir').value = ''; // 入力欄もクリア
  updateRootChip();
  st('ルート変更: ' + data.root);
  return true;
}

function showRootDialog() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center';
  const box = document.createElement('div');
  box.style.cssText = 'background:#252526;border:1px solid #555;border-radius:6px;padding:20px;width:480px;display:flex;flex-direction:column;gap:10px';
  box.innerHTML = `
    <div style="font-size:13px;color:#ccc;font-weight:600">プロジェクトルートを設定</div>
    <div style="font-size:11px;color:#888">検索対象のルートディレクトリの絶対パスを入力してください</div>
    <input id="root-inp" type="text" value="${esc(projectRoot)}" placeholder="例: C:\\Users\\you\\project" style="width:100%;box-sizing:border-box;background:#3c3c3c;border:1px solid #555;color:#ccc;padding:6px 8px;border-radius:3px;font-size:12px;font-family:Consolas,monospace">
    <div style="display:flex;gap:6px;justify-content:flex-end">
      <button id="root-cancel" class="sec">キャンセル</button>
      <button id="root-ok">設定</button>
    </div>`;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  const inp = box.querySelector('#root-inp');
  inp.focus(); inp.select();
  const close = () => document.body.removeChild(overlay);
  box.querySelector('#root-cancel').onclick = close;
  box.querySelector('#root-ok').onclick = async () => {
    const val = inp.value.trim();
    if(!val) return;
    const ok = await setRoot(val);
    if(ok) close();
  };
  inp.onkeydown = async e => {
    if(e.key === 'Enter') { box.querySelector('#root-ok').click(); }
    if(e.key === 'Escape') close();
  };
  overlay.onclick = e => { if(e.target === overlay) close(); };
}

function initDirPicker() {
  const inp = id('dir');
  const drop = id('dir-drop');

  let activeIdx = -1;

  function getItems() { return (itemsContainer||drop).querySelectorAll('.dir-item'); }

  function setActive(idx) {
    const items = getItems();
    items.forEach((el,i) => el.classList.toggle('active', i===idx));
    activeIdx = idx;
    if(items[idx]) items[idx].scrollIntoView({block:'nearest'});
  }

  // filter input は一度だけ生成、アイテムだけ更新
  let filterInp = null;
  let itemsContainer = null;

  function renderItems(query) {
    const q = (query||'').toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean);
    const filtered = (dirList||[]).filter(d => {
      if(d === '.') return false;
      if(!tokens.length) return true;
      return tokens.every(t => d.toLowerCase().includes(t));
    }).slice(0, 200);

    itemsContainer.innerHTML = '';
    if(!filtered.length) {
      itemsContainer.insertAdjacentHTML('beforeend', '<div class="dir-item" style="color:#555">一致なし</div>');
    } else {
      filtered.forEach(d => {
        const el = document.createElement('div');
        el.className = 'dir-item';
        el.innerHTML = highlightMatch(d, query);
        el.onmousedown = e => { e.preventDefault(); inp.value = d; clearBtn.style.display = ''; closeDrop(); };
        itemsContainer.appendChild(el);
      });
    }
    activeIdx = -1;
  }

  function openDrop() {
    const rect = id('dir-wrap').getBoundingClientRect();
    drop.style.left  = rect.left + 'px';
    drop.style.top   = rect.bottom + 2 + 'px';
    drop.style.width = Math.max(320, rect.width) + 'px';

    // 初回のみ filter input と items container を生成
    if(!filterInp) {
      const hdr = document.createElement('div');
      hdr.style.cssText = 'display:flex;align-items:center;border-bottom:1px solid #444;background:#1e1e1e';
      filterInp = document.createElement('input');
      filterInp.className = 'dir-filter';
      filterInp.placeholder = '絞り込み...';
      filterInp.autocomplete = 'off';
      filterInp.spellcheck = false;
      filterInp.style.flex = '1';
      filterInp.style.borderBottom = 'none';
      const closeBtn = document.createElement('button');
      closeBtn.textContent = '✕';
      closeBtn.title = '閉じる (Esc)';
      closeBtn.style.cssText = 'background:none;border:none;color:#666;cursor:pointer;font-size:11px;padding:0 6px;line-height:1;flex-shrink:0';
      closeBtn.onmousedown = e => { e.preventDefault(); closeDrop(); };
      closeBtn.onmouseover = () => closeBtn.style.color='#ccc';
      closeBtn.onmouseout  = () => closeBtn.style.color='#666';
      hdr.append(filterInp, closeBtn);
      drop.appendChild(hdr);
      itemsContainer = document.createElement('div');
      drop.appendChild(itemsContainer);
      filterInp.addEventListener('input', e => renderItems(e.target.value));
      filterInp.addEventListener('keydown', handleDropKey);
    }
    filterInp.value = '';
    drop.classList.add('open');
    renderItems('');
    filterInp.focus();
  }

  let suppressOpen = false;
  let opening = false;
  function closeDrop() {
    drop.classList.remove('open');
    activeIdx = -1;
  }
  function closeDropAndBlur() {
    suppressOpen = true;
    closeDrop();
    inp.blur();
    setTimeout(() => { suppressOpen = false; }, 200);
  }

  function handleDropKey(e) {
    const items = getItems();
    if(e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(activeIdx+1, items.length-1)); }
    else if(e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(activeIdx-1, 0)); }
    else if(e.key === 'Enter') {
      e.preventDefault();
      if(activeIdx >= 0 && items[activeIdx]) { inp.value = items[activeIdx].textContent.trim(); clearBtn.style.display=''; closeDrop(); }
      else closeDrop();
    }
    else if(e.key === 'Escape') { closeDropAndBlur(); }
  }

  const clearBtn = id('dir-clear');
  clearBtn.onclick = e => { e.stopPropagation(); inp.value = ''; clearBtn.style.display = 'none'; updateRootChip(); inp.focus(); };
  inp.addEventListener('input', () => { clearBtn.style.display = inp.value ? '' : 'none'; updateRootChip(); });
  inp.addEventListener('change', () => { clearBtn.style.display = inp.value ? '' : 'none'; updateRootChip(); });

  async function tryOpen() {
    if(suppressOpen || opening || drop.classList.contains('open')) return;
    opening = true;
    await fetchDirs();
    opening = false;
    if(!dirList || dirList.length === 0) { showRootDialog(); return; }
    if(!drop.classList.contains('open')) openDrop();
  }
  inp.addEventListener('focus', tryOpen);
  inp.addEventListener('click', () => { if(!drop.classList.contains('open')) tryOpen(); });
  inp.addEventListener('keydown', handleDropKey);

  // 外クリック・Esc で閉じる
  document.addEventListener('mousedown', e => {
    if(!id('dir-wrap').contains(e.target) && !drop.contains(e.target)) closeDrop();
  });
  document.addEventListener('keydown', e => {
    if(e.key === 'Escape' && drop.classList.contains('open')) {
      e.stopPropagation();
      closeDropAndBlur();
    }
  }, true);
}

function initColResizer() {
  const resizer = id('col-resizer');
  const left = id('pane-left');
  let startX, startW;
  resizer.addEventListener('mousedown', e => {
    startX = e.clientX;
    startW = left.offsetWidth;
    resizer.classList.add('active');
    const onMove = e => {
      const w = Math.max(200, Math.min(600, startW + e.clientX - startX));
      left.style.width = w + 'px';
    };
    const onUp = () => {
      resizer.classList.remove('active');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      localStorage.setItem('grepnavi-col-w', left.offsetWidth);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  // 前回幅を復元
  const saved = localStorage.getItem('grepnavi-col-w');
  if(saved) left.style.width = saved + 'px';
}

function initSearchBar() {
  // Aa / .* トグルボタン
  id('btn-cs').onclick = () => id('btn-cs').classList.toggle('on');
  id('btn-wb').onclick = () => id('btn-wb').classList.toggle('on');
  id('btn-re').onclick = () => id('btn-re').classList.toggle('on');
  // Alt+C / Alt+W / Alt+R / Ctrl+Shift+F ショートカット
  document.addEventListener('keydown', e => {
    if(e.altKey && e.key.toLowerCase() === 'c') { e.preventDefault(); id('btn-cs').click(); }
    if(e.altKey && e.key.toLowerCase() === 'w') { e.preventDefault(); id('btn-wb').click(); }
    if(e.altKey && e.key.toLowerCase() === 'r') { e.preventDefault(); id('btn-re').click(); }
    if(e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); id('q').focus(); id('q').select(); }
  });
  // ⚙ サブバー開閉
  id('btn-toggle-sub').onclick = () => {
    const sub = id('bar-sub');
    const open = sub.classList.toggle('open');
    id('btn-toggle-sub').classList.toggle('open', open);
  };
}

// マッチ文字列をハイライト
function hlText(text, query, isRegex, cs) {
  if(!query || !text) return esc(text||'');
  try {
    const flags = cs ? 'g' : 'gi';
    const pat = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(pat, flags);
    const result = [];
    let last = 0;
    let m;
    re.lastIndex = 0;
    while((m = re.exec(text)) !== null) {
      result.push(esc(text.slice(last, m.index)));
      result.push(`<span class="ri-match-hl">${esc(m[0])}</span>`);
      last = m.index + m[0].length;
      if(m[0].length === 0) { re.lastIndex++; }
    }
    result.push(esc(text.slice(last)));
    return result.join('');
  } catch(e) { return esc(text||''); }
}

function initFilter() {
  const inp = id('filter-input');
  const btn = id('filter-clear');
  btn.style.display = 'none';
  inp.addEventListener('input', applyFilter);
  inp.addEventListener('keydown', e => {
    if(e.key === 'Escape') { inp.value=''; applyFilter(); inp.blur(); }
    // ↑↓ で結果ナビゲート
    if(e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const rows = [...document.querySelectorAll('.ri:not(.fz-hidden)')];
      if(!rows.length) return;
      const sel = document.querySelector('.ri.sel');
      const idx = sel ? rows.indexOf(sel) : -1;
      const next = e.key === 'ArrowDown' ? rows[idx+1]||rows[0] : rows[idx-1]||rows[rows.length-1];
      if(next) next.click();
    }
  });
  btn.onclick = () => { inp.value=''; applyFilter(); inp.focus(); };
}

function getOrCreateFileGroup(file) {
  if(fileGroupMap[file]) return fileGroupMap[file];
  const group = document.createElement('div');
  group.className = 'rg-file-group';
  const hdr = document.createElement('div');
  hdr.className = 'rg-file-hdr';
  const toggle = document.createElement('span');
  toggle.className = 'rg-toggle'; toggle.textContent = '▼';
  const iconEl = document.createElement('span');
  iconEl.innerHTML = fileIcon(file);
  const fname = document.createElement('span');
  fname.className = 'rg-fname'; fname.textContent = shortPath(file); fname.title = file;
  const fcount = document.createElement('span');
  fcount.className = 'rg-fcount'; fcount.textContent = '0件';
  hdr.append(toggle, iconEl, fname, fcount);
  const items = document.createElement('div');
  items.className = 'rg-file-items';
  hdr.onclick = () => {
    const collapsed = items.style.display === 'none';
    items.style.display = collapsed ? '' : 'none';
    toggle.textContent = collapsed ? '▼' : '▶';
  };
  group.append(hdr, items);
  id('results').appendChild(group);
  fileGroupMap[file] = {items, fcount, count: 0};
  return fileGroupMap[file];
}

function flushBatch(q) {
  if(!pending.length) return;
  const batch = pending.splice(0);
  const rendered = id('results').querySelectorAll('.ri').length;
  let added = 0;
  for(const m of batch) {
    if(rendered+added >= LIMIT) break;
    const fg = getOrCreateFileGroup(m.file);
    fg.items.appendChild(makeRI(m, true));
    fg.count++;
    fg.fcount.textContent = fg.count + '件';
    added++;
  }
  id('sh-title').textContent = `検索中... ${allMatches.length}件 "${q}"`;
}

function defKind(text, snippet, matchLine) {
  const t = (text||'').trim();
  if (/^#\s*define\s+\w/.test(t)) return 'define';
  if (/^(struct|union)\s+\w+\s*(\{|$)/.test(t)) return 'struct';
  if (/^enum\s+\w+\s*\{/.test(t)) return 'enum';
  if (/\btypedef\b/.test(t)) return 'typedef';
  const parenIdx = t.indexOf('(');
  if (!/^(if|else|while|for|switch|return|case|do)\b/.test(t) &&
      !t.startsWith('{') &&
      !t.startsWith('!') &&
      !t.startsWith('/*') &&
      !t.startsWith('//') &&
      !t.startsWith('*') &&
      !/;\s*$/.test(t) &&
      !/[&|]\s*$/.test(t) &&
      parenIdx > 0 && !/=/.test(t.slice(0, parenIdx)) &&
      !/[->.:]/.test(t.slice(0, parenIdx)) &&
      /\w+\s*\(/.test(t)) {
    if (/\{\s*$/.test(t)) return 'func';
    if(Array.isArray(snippet)) {
      const after = snippet.filter(s => s.line > matchLine).slice(0, 3);
      for(const s of after) {
        const st = (s.text||'').trim();
        if (/^\{/.test(st) || /\{\s*$/.test(st)) return 'func';
        if (st && !/^[a-zA-Z0-9_\s,*()]/.test(st)) break;
      }
    }
  }
  return null;
}
const KIND_LABEL = {define:'macro', struct:'struct', enum:'enum', typedef:'typedef', func:'fn'};
const KIND_COLOR = {define:'#a06000', struct:'#4a5bbf', enum:'#4a5bbf', typedef:'#1e7d82', func:'#1e6e40'};

function makeRI(m, compact=false) {
  const ifd = (m.ifdef_stack||[]).map(f=>'#'+f.directive+' '+f.condition).join(' > ');
  const kind = defKind(m.text, m.snippet, m.line);
  const badge = kind
    ? `<span style="background:${KIND_COLOR[kind]};color:#fff;font-size:10px;padding:1px 4px;border-radius:3px;flex-shrink:0">${KIND_LABEL[kind]}</span>`
    : '';
  const isRe = id('btn-re').classList.contains('on');
  const isCs = id('btn-cs').classList.contains('on');
  const rawText = (m.text||'').trim();
  const hlText_ = hlText(trunc(rawText, compact?120:80), m.query||'', isRe, isCs);
  const div = document.createElement('div');
  div.className = 'ri';
  div.title = ifd ? (m.file||'') + ':' + m.line + '\n' + ifd : (m.file||'') + ':' + m.line;
  if(compact) {
    div.innerHTML =
      `<span class="ri-lnum ri-open">${m.line}</span>`+
      `<span class="ri-text">${hlText_}</span>`+
      (ifd ? `<span class="ri-ifdef">${esc(ifd.split(' > ').pop())}</span>` : '')+
      badge+
      `<button class="ri-add">+</button>`;
  } else {
    div.innerHTML =
      `<span class="ri-lnum ri-open">${esc(shortPath(m.file))}:${m.line}</span>`+
      `<span class="ri-text">${hlText_}</span>`+
      (ifd ? `<span class="ri-ifdef">${esc(ifd)}</span>` : '')+
      badge+
      `<button class="ri-add">+</button>`;
  }
  div.querySelector('.ri-add').onclick = e => { e.stopPropagation(); addToGraph(m,null,'ref'); };
  div.querySelector('.ri-open').onclick = e => { e.stopPropagation(); openFile(m.file, m.line); };
  div.onclick = () => previewMatch(m, div);
  if(m.file && m.line) attachPreview(div, m.file, m.line);
  return div;
}

function previewMatch(m, el) {
  document.querySelectorAll('.ri').forEach(r=>r.classList.remove('sel'));
  el.classList.add('sel');
  showDetail({id:'__preview__', match:m, memo:'', label:labelFrom(m), children:[], expanded:true});
  const bd = id('btn-del');
  if(bd) bd.style.display='none';
  if(m.file) openPeek(m.file, m.line);
}

// ===== EXPAND =====
async function doExpand() {
  if(!selNode) { st('エラー: グラフのノードを選択してから展開してください'); return; }
  const q = id('expand-q').value.trim(); if(!q) return;
  const lbl = id('expand-lbl').value.trim()||'ref';
  const glob = id('expand-glob').value.trim();
  const dir = id('dir').value.trim();
  st('展開中...');
  try {
    const r = await fetch('/api/graph/expand', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({node_id:selNode, query:q, dir, edge_label:lbl, glob})
    });
    const d = await r.json();
    if(d.error) { st('エラー: ' + d.error); return; }
    (d.new_nodes||[]).forEach(n=>{ graph.nodes[n.id]=n; });
    (d.new_edges||[]).forEach(e=>{ graph.edges.push(e); });
    if(graph.nodes[selNode]) {
      graph.nodes[selNode].children = graph.nodes[selNode].children || [];
      (d.new_nodes||[]).forEach(n=>{
        if(!graph.nodes[selNode].children.includes(n.id))
          graph.nodes[selNode].children.push(n.id);
      });
    }
    renderCurrent();
    stGraph();
    st(`展開: ${(d.new_nodes||[]).length}件追加`);
  } catch(e) {
    st('展開エラー: ' + e.message);
  }
}

// ===== PROJECT FILE (保存/開く) =====
const LS_PROJECT_PATH = 'grepnavi_project_path';
const LS_PROJECT_HISTORY = 'grepnavi_project_history';
const HISTORY_MAX = 8;

function getProjectPath() {
  return localStorage.getItem(LS_PROJECT_PATH) || '';
}
function setProjectPath(p) {
  localStorage.setItem(LS_PROJECT_PATH, p);
  addProjectHistory(p);
  updateProjectUI();
}
function getProjectHistory() {
  try { return JSON.parse(localStorage.getItem(LS_PROJECT_HISTORY) || '[]'); } catch { return []; }
}
function addProjectHistory(p) {
  if(!p) return;
  let hist = getProjectHistory().filter(h => h !== p);
  hist.unshift(p);
  if(hist.length > HISTORY_MAX) hist = hist.slice(0, HISTORY_MAX);
  localStorage.setItem(LS_PROJECT_HISTORY, JSON.stringify(hist));
}
function updateProjectUI() {
  const p = getProjectPath();
  const el = id('project-name');
  if(!el) return;
  const name = p ? p.replace(/\\/g, '/').split('/').pop() : '無題';
  el.textContent = name;
  el.title = p || '';
  const saveItem = id('pmenu-save');
  if(saveItem) saveItem.style.color = p ? '' : '#666';
}

let _projectModalMode = 'save';
function showProjectModal(mode) {
  _projectModalMode = mode;
  id('project-modal-title').textContent = mode === 'save' ? '名前を付けて保存' : 'プロジェクトを開く';
  id('project-modal-input').value = getProjectPath();
  renderProjectHistory();
  id('project-modal').classList.add('open');
  setTimeout(() => { id('project-modal-input').focus(); id('project-modal-input').select(); }, 50);
}

function renderProjectHistory() {
  const hist = getProjectHistory();
  const el = id('project-history');
  el.innerHTML = '';
  if(!hist.length) return;
  hist.forEach(p => {
    const name = p.replace(/\\/g, '/').split('/').pop();
    const div = document.createElement('div');
    div.className = 'phist-item';
    div.innerHTML = `<span class="phist-name">${esc(name)}</span><span class="phist-path">${esc(p)}</span>`;
    div.onclick = async () => {
      closeProjectModal();
      if(_projectModalMode === 'save') await saveProject(p);
      else await openProject(p);
    };
    el.appendChild(div);
  });
}
function closeProjectModal() {
  id('project-modal').classList.remove('open');
}
async function onProjectModalOk() {
  const p = id('project-modal-input').value.trim();
  if(!p) return;
  closeProjectModal();
  if(_projectModalMode === 'save') await saveProject(p);
  else await openProject(p);
}

async function saveProject(path) {
  const lineMemos = getLineMemos();
  const r = await fetch('/api/graph/saveas', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({path, line_memos: lineMemos})
  });
  const d = await r.json();
  if(d.error) { st('保存エラー: ' + d.error); return; }
  setProjectPath(path);
  st('保存しました: ' + path);
}

async function openProject(path) {
  const r = await fetch('/api/graph/openfile', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({path})
  });
  const d = await r.json();
  if(d.error) { st('読み込みエラー: ' + d.error); return; }
  selNode = null; showDetail(null);
  fzfFiles = null; // ルートが変わるのでキャッシュクリア
  projectRoot = ''; // 新しいプロジェクトのルートを適用させる
  applyGraphResponse(d.graph);
  setProjectPath(path);
  st('読み込みました: ' + path);
}

// ===== ADD TO GRAPH =====
async function addToGraph(match, parentId, edgeLabel, label) {
  const r = await fetch('/api/graph/node', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({match, parent_id:parentId||'', edge_label:edgeLabel||'ref', label:label||''})
  });
  const d = await r.json();
  if(d.error){st('エラー:'+d.error);return;}
  graph.nodes[d.node.id] = d.node;
  if(d.edge) graph.edges.push(d.edge);
  if(parentId && graph.nodes[parentId]) {
    const p = graph.nodes[parentId];
    p.children = p.children||[];
    if(!p.children.includes(d.node.id)) p.children.push(d.node.id);
  }
  renderCurrent();
  selectNode(d.node.id);
  stGraph();
  refreshGraphDecorations();
}

// ===== CLEAR =====
async function clearGraph() {
  if(!confirm('このツリーのノードを全消去しますか？')) return;
  const r = await fetch('/api/graph', {method:'DELETE'});
  const d = await r.json();
  if(d.error) { st('エラー: ' + d.error); return; }
  selNode = null; showDetail(null);
  applyGraphResponse(d);
}

// ===== PEEK PANEL (Monaco Editor) =====
let peekResizing = false, peekStartY = 0, peekStartH = 0;
let leftResizing = false, leftStartY = 0, leftStartH = 0;
let monacoEditor = null, monacoDecoIds = [], monacoReady = false;
// タブ管理
let tabs = []; // {file, line, label, model, decoIds}
let activeTabIdx = -1;
// ナビゲーション履歴
const navHistory = []; // [{file, line}]
let navIndex = -1;
let navSkipPush = false;
let graphDecoIds = []; // グラフ登録済み行のデコレーション
let lineMemoDecoIds = []; // 行メモのデコレーション
let showLineMemoInline = true; // 行メモインライン表示ON/OFF

// ===== 行メモ (localStorage) =====
function getLineMemos() {
  try { return JSON.parse(localStorage.getItem('grepnavi-line-memos') || '{}'); } catch { return {}; }
}
function setLineMemo(file, line, memo) {
  const memos = getLineMemos();
  const key = file + '::' + line;
  if(memo) memos[key] = memo; else delete memos[key];
  localStorage.setItem('grepnavi-line-memos', JSON.stringify(memos));
}
function refreshLineMemoDecorations() {
  if(!monacoEditor) return;
  const file = tabs[activeTabIdx]?.file;

  // グリフ装飾（常に表示）
  if(!file) {
    lineMemoDecoIds = monacoEditor.deltaDecorations(lineMemoDecoIds, []);
    renderLineMemoOverlay();
    return;
  }
  const memos = getLineMemos();
  const decos = Object.entries(memos)
    .filter(([key]) => key.startsWith(file + '::'))
    .map(([key, memo]) => {
      const line = parseInt(key.split('::')[1]);
      return {
        range: new monaco.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: 'line-memo-glyph',
          glyphMarginHoverMessage: { value: memo.split('\n').join('\n\n') },
        }
      };
    });
  lineMemoDecoIds = monacoEditor.deltaDecorations(lineMemoDecoIds, decos);
  renderLineMemoOverlay();
}

let _lineMemoScrollDispose = null;
function renderLineMemoOverlay() {
  // 既存オーバーレイ削除
  document.getElementById('line-memo-overlay')?.remove();
  if(!monacoEditor || !showLineMemoInline) return;
  const file = tabs[activeTabIdx]?.file;
  if(!file) return;
  const memos = Object.entries(getLineMemos()).filter(([k]) => k.startsWith(file + '::'));
  if(!memos.length) return;

  const container = id('monaco-container');
  const overlay = document.createElement('div');
  overlay.id = 'line-memo-overlay';
  overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden;z-index:5';
  container.style.position = 'relative';
  container.appendChild(overlay);

  const lineH    = monacoEditor.getOption(monaco.editor.EditorOption.lineHeight);
  const fontSize = monacoEditor.getOption(monaco.editor.EditorOption.fontSize);
  const layoutInfo = monacoEditor.getLayoutInfo();
  // コンテンツ領域の左端（グリフ幅＋行番号幅）
  const contentLeft = layoutInfo.contentLeft;

  function positionItems() {
    overlay.innerHTML = '';
    const scrollTop = monacoEditor.getScrollTop();
    memos.forEach(([key, memo]) => {
      const line = parseInt(key.split('::')[1]);
      const top  = monacoEditor.getTopForLineNumber(line) - scrollTop;
      if(top < -lineH || top > container.offsetHeight) return; // 画面外スキップ
      // 行末のピクセルX位置を取得
      const model   = monacoEditor.getModel();
      const endCol  = model ? model.getLineMaxColumn(line) : 1;
      const pos     = monacoEditor.getScrolledVisiblePosition({lineNumber: line, column: endCol});
      const left    = pos ? pos.left : contentLeft + 200;
      const el = document.createElement('div');
      el.className = 'line-memo-overlay-item';
      el.style.cssText = `position:absolute;top:${top}px;left:${left + 8}px;height:${lineH}px;line-height:${lineH}px;font-size:${fontSize}px`;
      el.textContent = '// ' + memo.split('\n').join(' ↵ ');
      overlay.appendChild(el);
    });
  }

  positionItems();
  // スクロール追従
  _lineMemoScrollDispose?.dispose();
  _lineMemoScrollDispose = monacoEditor.onDidScrollChange(positionItems);
}
function toggleLineMemoInline() {
  showLineMemoInline = !showLineMemoInline;
  const btn = id('btn-line-memo-toggle');
  if(btn) { btn.classList.toggle('on', showLineMemoInline); btn.style.background = showLineMemoInline ? '#094771' : ''; }
  refreshLineMemoDecorations();
}
function showLineMemoInput(file, line) {
  document.getElementById('line-memo-popup')?.remove();
  const current = getLineMemos()[file + '::' + line] || '';
  const popup = document.createElement('div');
  popup.id = 'line-memo-popup';
  popup.style.cssText = 'position:fixed;z-index:9999;background:#2d2d2d;border:1px solid #555;border-radius:4px;padding:8px;box-shadow:0 4px 12px rgba(0,0,0,0.6);width:300px';
  const edRect = id('monaco-container').getBoundingClientRect();
  const lineH = monacoEditor.getOption(monaco.editor.EditorOption.lineHeight);
  const top = Math.min(edRect.top + (line - 1) * lineH - monacoEditor.getScrollTop() + lineH, window.innerHeight - 140);
  popup.style.left = (edRect.left + 64) + 'px';
  popup.style.top  = Math.max(top, edRect.top) + 'px';
  popup.innerHTML  = `<div style="color:#aaa;font-size:11px;margin-bottom:4px">行 ${line} のメモ</div>`;
  const ta = document.createElement('textarea');
  ta.value = current;
  ta.style.cssText = 'width:100%;height:64px;background:#1a1a1a;border:1px solid #444;color:#ccc;font:11px Consolas,monospace;padding:4px;resize:vertical;box-sizing:border-box;border-radius:2px';
  ta.placeholder = 'Ctrl+Enter で保存 / Esc でキャンセル';
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:4px;margin-top:6px;justify-content:flex-end';
  const mkBtn = (label, bg) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `font-size:11px;padding:2px 8px;background:${bg};color:#ccc;border:1px solid #555;border-radius:2px;cursor:pointer`;
    return b;
  };
  const btnSave   = mkBtn('保存', '#0e639c');
  const btnDel    = mkBtn('削除', '#3c3c3c');
  const btnCancel = mkBtn('キャンセル', '#3c3c3c');
  btnDel.style.display = current ? '' : 'none';
  btnRow.append(btnDel, btnCancel, btnSave);
  popup.append(ta, btnRow);
  document.body.appendChild(popup);
  ta.focus(); ta.select();
  const save = () => {
    setLineMemo(file, line, ta.value.trim());
    popup.remove();
    refreshLineMemoDecorations();
  };
  const cancel = () => popup.remove();
  btnSave.onclick = save;
  btnCancel.onclick = cancel;
  btnDel.onclick = () => { setLineMemo(file, line, ''); popup.remove(); refreshLineMemoDecorations(); };
  ta.addEventListener('keydown', e => {
    if(e.key === 'Escape') { e.stopPropagation(); cancel(); }
    if(e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
  });
  setTimeout(() => document.addEventListener('mousedown', e => {
    if(!popup.contains(e.target)) cancel();
  }, {once: true}), 0);
}

function refreshGraphDecorations() {
  if(!monacoEditor) return;
  const file = tabs[activeTabIdx]?.file;
  if(!file) { graphDecoIds = monacoEditor.deltaDecorations(graphDecoIds, []); return; }
  const decos = Object.values(graph.nodes)
    .filter(n => n.match?.file === file && n.match?.line)
    .map(n => ({
      range: new monaco.Range(n.match.line, 1, n.match.line, 1),
      options: {
        isWholeLine: true,
        className: 'graph-node-line',
        glyphMarginClassName: 'graph-node-glyph',
        glyphMarginHoverMessage: {value: `**グラフ登録済み** ${n.label || ''}${n.memo ? '\n\n' + n.memo : ''}`},
      }
    }));
  graphDecoIds = monacoEditor.deltaDecorations(graphDecoIds, decos);
}

function attachPreview(_el, _file, _line) {}

function loadMonaco() {
  return new Promise(resolve => {
    if(monacoReady){ resolve(); return; }
    require(['vs/editor/editor.main'], () => { monacoReady = true; resolve(); });
  });
}

async function ensureEditor() {
  await loadMonaco();
  if(monacoEditor) return;
  monaco.editor.defineTheme('grepnavi-dark', {
    base: 'vs-dark', inherit: true, rules: [],
    colors: {
      'editor.wordHighlightBackground':       '#f0c04055',
      'editor.wordHighlightBorder':           '#f0c040',
      'editor.wordHighlightStrongBackground': '#ff606055',
      'editor.wordHighlightStrongBorder':     '#ff6060',
      'editor.wordHighlightTextBackground':   '#f0c04055',
      'editor.wordHighlightTextBorder':       '#f0c040',
    }
  });
  monacoEditor = monaco.editor.create(id('monaco-container'), {
    value: '',
    language: 'plaintext',
    theme: 'grepnavi-dark',
    readOnly: true,
    minimap: {enabled: true, scale: 1, showSlider: 'mouseover'},
    scrollBeyondLastLine: false,
    fontSize: 12,
    lineNumbers: 'on',
    wordWrap: 'off',
    occurrencesHighlight: 'singleFile',
    selectionHighlight: true,
    renderLineHighlight: 'line',
    stickyScroll: {enabled: true, defaultModel: 'outlineModel', maxLineCount: 3},
    breadcrumbs: {enabled: true},
    glyphMargin: true,
  });
  new ResizeObserver(() => monacoEditor.layout()).observe(id('monaco-container'));

  // Hover プロバイダー: 単語にホバー → ripgrep で使用箇所数を表示
  const HOVER_LANGS = ['c','cpp','go','python','javascript','typescript','rust','java'];
  HOVER_LANGS.forEach(lang => {
    monaco.languages.registerHoverProvider(lang, {
      provideHover: async (model, position, token) => {
        const word = model.getWordAtPosition(position);
        if(!word || word.word.length < 2) return null;
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        const dir = id('dir').value.trim();
        const p = new URLSearchParams({q: word.word, regex:'0', case:'0', limit:'50'});
        if(dir) p.set('dir', dir);
        try {
          const r = await fetch('/api/search?' + p, {signal: controller.signal});
          const d = await r.json();
          const currentFile = tabs[activeTabIdx]?.file || '';
          const contents = [];

          // ── グラフノードのメモ（現在のファイル:行 or 単語が一致するノード）──
          const memoNodes = Object.values(graph.nodes).filter(n => n.memo && (
            (n.match?.file === currentFile && n.match?.line === position.lineNumber) ||
            (n.match?.file === currentFile && (n.match?.text||'').includes(word.word))
          ));
          if(memoNodes.length) {
            memoNodes.forEach(n => {
              contents.push({value:
                `💬 **${n.label || shortPath(n.match?.file||'')+':'+(n.match?.line||'')}**\n\n${n.memo}`
              });
            });
            contents.push({value: '---'});
          }

          // ── 定義（#define / struct / enum / typedef）──
          const dir2 = id('dir').value.trim();
          const glob2 = id('glob').value.trim();
          const dp = new URLSearchParams({word: word.word});
          if(dir2)  dp.set('dir',  dir2);
          if(glob2) dp.set('glob', glob2);
          const dr = await fetch('/api/definition?' + dp, {signal: controller.signal});
          const defs = await dr.json();
          if(Array.isArray(defs) && defs.length) {
            const kindIcon = {define:'#️⃣', struct:'🏗', enum:'🔢', union:'🔀', typedef:'🔤'};
            const lines = defs.slice(0,5).map(d =>
              `${kindIcon[d.kind]||'·'} \`${d.text}\`  \n*${shortPath(d.file)}:${d.line}*`
            );
            contents.push({value: lines.join('\n\n')});
            contents.push({value: '---'});
          }

          // ── ripgrep ヒット数 ──
          if(d.matches?.length) {
            const count = d.count;
            const files = [...new Set(d.matches.map(m => shortPath(m.file)))].slice(0, 5);
            contents.push({value: `**\`${word.word}\`** — ${count} 件ヒット`});
            contents.push({value: files.map(f=>`- ${f}`).join('\n') + (count > 5 ? `\n- ...他` : '')});
          }

          if(!contents.length) return null;
          return {
            range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
            contents
          };
        } catch { return null; }
      }
    });
  });

  // シンボルプロバイダー（Go バックエンドに委譲）
  ['c','cpp','go','python','javascript','typescript','rust','java'].forEach(lang => {
    monaco.languages.registerDocumentSymbolProvider(lang, {
      provideDocumentSymbols: async (model) => {
        const file = model.uri.scheme === 'grepnavi'
          ? model.uri.path.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g,'\\')
          : null;
        if (!file) return [];
        try {
          const r = await fetch('/api/symbols?' + new URLSearchParams({file}));
          const d = await r.json();
          if (!Array.isArray(d)) return [];
          return d.map(s => ({
            name: s.name, detail: s.detail,
            kind: monaco.languages.SymbolKind.Function,
            range: new monaco.Range(s.start_line, 1, s.end_line, 1),
            selectionRange: new monaco.Range(s.start_line, 1, s.start_line, 1),
          }));
        } catch { return []; }
      }
    });
  });

  // Ctrl+クリック → 定義ジャンプ
  monacoEditor.onMouseDown(e => {
    if(!e.event.ctrlKey) return;
    const pos = e.target.position;
    if(!pos) return;
    const word = monacoEditor.getModel()?.getWordAtPosition(pos);
    if(word) { e.event.preventDefault(); jumpToDefinition(word.word); }
  });

  // F12 → 定義ジャンプ
  monacoEditor.addAction({
    id: 'grepnavi-goto-def', label: '定義へジャンプ',
    keybindings: [monaco.KeyCode.F12],
    run: ed => {
      const word = ed.getModel()?.getWordAtPosition(ed.getPosition());
      if(word) jumpToDefinition(word.word);
    }
  });

  // Alt+N / 右クリック → 行メモを追加/編集
  monacoEditor.addAction({
    id: 'grepnavi-line-memo', label: '行メモを追加/編集 (Alt+N)',
    keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyN],
    contextMenuGroupId: 'grepnavi',
    contextMenuOrder: 2,
    run: ed => {
      const file = tabs[activeTabIdx]?.file;
      const line = ed.getPosition()?.lineNumber;
      if(!file || !line) return;
      showLineMemoInput(file, line);
    }
  });

  // 右クリック → 選択テキストを検索
  monacoEditor.addAction({
    id: 'grepnavi-grep-selection', label: '選択テキストを検索',
    contextMenuGroupId: 'grepnavi',
    contextMenuOrder: 0,
    run: ed => {
      const sel = ed.getSelection();
      const model = ed.getModel();
      if(!sel || !model) return;
      const text = model.getValueInRange(sel).trim();
      if(!text) return;
      id('q').value = text;
      doSearch();
    }
  });

  // Alt+G / 右クリック → 選択行をノードに追加
  monacoEditor.addAction({
    id: 'grepnavi-add-node', label: 'ノードに追加 (Alt+G)',
    keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyG],
    contextMenuGroupId: 'grepnavi',
    contextMenuOrder: 1,
    run: ed => {
      const sel   = ed.getSelection();
      const model = ed.getModel();
      const file  = tabs[activeTabIdx]?.file;
      if(!sel || !model || !file) return;
      const line = sel.startLineNumber;
      const selectedText = model.getValueInRange(sel).split('\n')[0].trim();
      const text = selectedText || model.getLineContent(line).trim();
      const id = (crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b=>b.toString(16).padStart(2,'0')).join(''));
      addToGraph({id, file, line, text}, selNode||'', 'ref', text);
    }
  });
}

// ===== Ctrl+P ファイルクイックオープン =====
let fzfFiles = null; // キャッシュ
let fzfSelIdx = 0;
let fzfFiltered = [];

async function openFzf() {
  if(!fzfFiles) {
    try {
      const r = await fetch('/api/files');
      fzfFiles = await r.json();
    } catch { fzfFiles = []; }
  }
  id('fzf-overlay').classList.add('open');
  id('fzf-input').value = '';
  fzfRender('');
  setTimeout(() => id('fzf-input').focus(), 30);
}

function closeFzf() {
  id('fzf-overlay').classList.remove('open');
}

// 1トークンのファジーマッチ。ヒットした位置セットとスコアを返す
function fzfMatchToken(path, token) {
  const p = path.toLowerCase(), q = token.toLowerCase();
  const matched = new Set();
  let pi = 0, qi = 0, score = 0, consecutive = 0;
  while(pi < p.length && qi < q.length) {
    if(p[pi] === q[qi]) { matched.add(pi); qi++; score += 1 + consecutive; consecutive++; }
    else { consecutive = 0; }
    pi++;
  }
  return qi === q.length ? {score, matched} : null;
}

// スペース区切り AND マッチ。全トークンがヒットしたらスコア合計、それ以外 -1
function fzfScore(path, query) {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if(!tokens.length) return 0;
  let total = 0;
  for(const t of tokens) {
    const r = fzfMatchToken(path, t);
    if(!r) return -1;
    total += r.score;
  }
  return total;
}

// 全トークンのマッチ位置をまとめてハイライト
function fzfHighlight(path, query) {
  if(!query) return esc(path);
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const matched = new Set();
  for(const t of tokens) {
    const r = fzfMatchToken(path, t);
    if(r) r.matched.forEach(i => matched.add(i));
  }
  return [...path].map((c, i) =>
    matched.has(i) ? `<span class="fzf-hl">${esc(c)}</span>` : esc(c)
  ).join('');
}

function fzfRender(query) {
  const list = id('fzf-list');
  if(query.trim()) {
    fzfFiltered = fzfFiles
      .map(f => ({f, s: fzfScore(f, query)}))
      .filter(x => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 100)
      .map(x => x.f);
  } else {
    fzfFiltered = fzfFiles.slice(0, 100);
  }
  id('fzf-count').textContent = `${fzfFiltered.length} / ${fzfFiles.length}`;
  fzfSelIdx = 0;
  list.innerHTML = '';
  fzfFiltered.forEach((f, i) => {
    const parts = f.replace(/\\/g, '/').split('/');
    const name = parts.pop();
    const dir  = parts.join('/');
    const div = document.createElement('div');
    div.className = 'fzf-item' + (i === 0 ? ' fzf-sel' : '');
    div.innerHTML = `<span class="fzf-name">${fzfHighlight(name, query)}</span>`
                  + (dir ? `<span class="fzf-dir">${fzfHighlight(dir+'/', query)}</span>` : '');
    div.onclick = () => fzfOpen(f);
    list.appendChild(div);
  });
}

function fzfMoveSel(delta) {
  const items = id('fzf-list').querySelectorAll('.fzf-item');
  if(!items.length) return;
  items[fzfSelIdx]?.classList.remove('fzf-sel');
  fzfSelIdx = Math.max(0, Math.min(items.length - 1, fzfSelIdx + delta));
  items[fzfSelIdx]?.classList.add('fzf-sel');
  items[fzfSelIdx]?.scrollIntoView({block:'nearest'});
}

async function fzfOpen(relPath) {
  closeFzf();
  const r = await fetch('/api/root');
  const d = await r.json();
  const abs = (d.root || '').replace(/\\/g,'/').replace(/\/$/, '') + '/' + relPath;
  await openPeek(abs, 1);
}

// ===== F3 検索結果ナビゲーション =====
function getVisibleResultRows() {
  return [...document.querySelectorAll('#results .ri:not(.fz-hidden)')];
}

function jumpResult(delta) {
  const rows = getVisibleResultRows();
  if(!rows.length) return;
  const cur = rows.findIndex(r => r.classList.contains('sel'));
  const next = cur === -1
    ? (delta > 0 ? 0 : rows.length - 1)
    : (cur + delta + rows.length) % rows.length;
  rows[next].click();
  rows[next].scrollIntoView({block:'nearest'});
}

// ===== NAVIGATION HISTORY =====
function navPush(file, line) {
  if(navSkipPush) return;
  const last = navHistory[navIndex];
  if(last && last.file === file && last.line === line) return;
  navHistory.splice(navIndex + 1);
  navHistory.push({file, line});
  if(navHistory.length > 100) { navHistory.shift(); }
  navIndex = navHistory.length - 1;
  updateNavButtons();
}

async function navBack() {
  if(navIndex <= 0) return;
  navIndex--;
  const h = navHistory[navIndex];
  navSkipPush = true;
  await openPeek(h.file, h.line);
  navSkipPush = false;
  updateNavButtons();
}

async function navForward() {
  if(navIndex >= navHistory.length - 1) return;
  navIndex++;
  const h = navHistory[navIndex];
  navSkipPush = true;
  await openPeek(h.file, h.line);
  navSkipPush = false;
  updateNavButtons();
}

function updateNavButtons() {
  const b = id('btn-nav-back'), f = id('btn-nav-fwd');
  if(b) b.disabled = navIndex <= 0;
  if(f) f.disabled = navIndex >= navHistory.length - 1;
}

async function openPeek(file, line) {
  if(!file) return;
  navPush(file, line);
  await ensureEditor();
  id('peek').classList.add('visible');
  id('peek-placeholder')?.classList.add('hidden');
  id('peek-open').onclick = () => openFile(file, line);

  // 既存タブを探す（同ファイル）
  const existIdx = tabs.findIndex(t => t.file === file);
  if(existIdx >= 0) {
    tabs[existIdx].line = line;
    await switchTab(existIdx);
    // マッチ行だけ更新
    const matchLine = parseInt(line) || 1;
    tabs[existIdx].decoIds = monacoEditor.deltaDecorations(tabs[existIdx].decoIds || [], [{
      range: new monaco.Range(matchLine, 1, matchLine, 1),
      options: {isWholeLine: true, className: 'peek-match-decoration'}
    }]);
    monacoEditor.revealLineInCenter(matchLine);
    return;
  }

  // 新しいタブを作成
  const r = await fetch('/api/file?' + new URLSearchParams({file}));
  if(!r.ok) return;
  const text = await r.text();
  const lang = detectLang(file);
  const uri = monaco.Uri.from({scheme:'grepnavi', path: file.replace(/\\/g,'/')});
  const model = monaco.editor.getModel(uri) || monaco.editor.createModel(text, lang || 'plaintext', uri);
  const tab = {file, line, label: file.replace(/\\/g,'/').split('/').pop(), model, decoIds: []};
  tabs.push(tab);
  await switchTab(tabs.length - 1);

  const matchLine = parseInt(line) || 1;
  tab.decoIds = monacoEditor.deltaDecorations([], [{
    range: new monaco.Range(matchLine, 1, matchLine, 1),
    options: {isWholeLine: true, className: 'peek-match-decoration'}
  }]);
  monacoEditor.revealLineInCenter(matchLine);
}

async function switchTab(idx) {
  if(idx < 0 || idx >= tabs.length) return;
  // 現在のタブの viewState を保存
  if(activeTabIdx >= 0 && activeTabIdx < tabs.length)
    tabs[activeTabIdx].viewState = monacoEditor.saveViewState();
  activeTabIdx = idx;
  const tab = tabs[idx];
  monacoEditor.setModel(tab.model);
  if(tab.viewState) try { monacoEditor.restoreViewState(tab.viewState); } catch(_) {}
  id('peek-file').textContent = tab.file + ':' + tab.line;
  refreshGraphDecorations();
  refreshLineMemoDecorations();
  const isC = /\.(c|h|cpp|cc|cxx|hpp)$/i.test(tab.file);
  id('ifdef-ui').style.display = isC ? 'flex' : 'none';
  if(!isC) clearIfdefHighlight();
  renderTabs();
}

function closeTab(idx) {
  if(idx < 0 || idx >= tabs.length) return;
  tabs[idx].model.dispose();
  tabs.splice(idx, 1);
  if(!tabs.length) { id('peek').classList.remove('visible'); activeTabIdx = -1; renderTabs(); return; }
  const next = Math.min(idx, tabs.length - 1);
  activeTabIdx = -1; // force re-apply
  switchTab(next);
}

function renderTabs() {
  const bar = id('peek-tabs');
  bar.innerHTML = '';
  tabs.forEach((t, i) => {
    const tab = document.createElement('div');
    tab.className = 'ptab' + (i === activeTabIdx ? ' active' : '');
    const lbl = document.createElement('span');
    lbl.textContent = t.label;
    lbl.title = t.file;
    lbl.onclick = () => switchTab(i);
    const cls = document.createElement('span');
    cls.className = 'ptab-close';
    cls.textContent = '×';
    cls.onclick = e => { e.stopPropagation(); closeTab(i); };
    tab.appendChild(lbl);
    tab.appendChild(cls);
    bar.appendChild(tab);
    if(i === activeTabIdx) tab.scrollIntoView({block:'nearest', inline:'nearest'});
  });
}

function closePeek() {
  id('peek').classList.remove('visible');
  tabs.forEach(t => t.model.dispose());
  tabs = []; activeTabIdx = -1;
  renderTabs();
}

// ===== 定義ジャンプ (grep ベース) =====
async function jumpToDefinition(word) {
  if(!word || word.length < 2) return;
  let sf = 0;
  const stimer = setInterval(() => { sf=(sf+1)%SPINNER_FRAMES.length; st(SPINNER_FRAMES[sf]+' 定義を検索中: '+word); }, 80);
  st(SPINNER_FRAMES[0]+' 定義を検索中: '+word);
  const currentFile = tabs[activeTabIdx]?.file || '';
  const dir = id('dir').value.trim();
  const glob = id('glob').value.trim();

  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const p = new URLSearchParams({q: `\\b${escaped}\\b`, regex: '1', case: id('btn-cs').classList.contains('on') ? '1' : '0'});
  if(dir)  p.set('dir', dir);
  if(glob) p.set('glob', glob);
  const r = await fetch('/api/search?' + p);
  clearInterval(stimer);
  const d = await r.json();
  let hits = d.matches || [];

  if(hits.length === 0) { st('見つかりません: ' + word); return; }

  // 現在のファイルを優先
  if(currentFile) {
    const inCurrent = hits.filter(m => m.file === currentFile);
    if(inCurrent.length) hits = [...inCurrent, ...hits.filter(m => m.file !== currentFile)];
  }

  // 結果をファイルグループ表示
  fileGroupMap = {};
  id('results').innerHTML = '';
  hits.slice(0, LIMIT).forEach(m => {
    const fg = getOrCreateFileGroup(m.file);
    fg.items.appendChild(makeRI(m, true));
    fg.count++;
    fg.fcount.textContent = fg.count + '件';
  });
  id('sh-title').textContent = `"${word}" ${d.count}件`;
  id('sh-over').textContent = d.count > LIMIT ? `先頭${LIMIT}件` : '';
  st(`${d.count}件ヒット`);
}

function detectLang(file) {
  const ext = (file||'').split('.').pop().toLowerCase();
  const map = {c:'c',h:'c',cpp:'cpp',cc:'cpp',cxx:'cpp',hpp:'cpp',
    go:'go',py:'python',js:'javascript',ts:'typescript',
    rs:'rust',java:'java',sh:'shell',rb:'ruby'};
  return map[ext] || null;
}

// リサイズハンドラ
addEventListener('DOMContentLoaded', () => {
  // Peek リサイズ（peek-hdrドラッグ）
  id('peek-hdr').addEventListener('mousedown', e => {
    if(e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
    peekResizing = true;
    peekStartY = e.clientY;
    peekStartH = id('peek').offsetHeight;
    document.body.style.cursor = 'ns-resize';
    e.preventDefault();
  });

  // 左列リサイズ（left-resizerドラッグ）
  id('left-resizer').addEventListener('mousedown', e => {
    leftResizing = true;
    leftStartY = e.clientY;
    leftStartH = id('pane-search').offsetHeight;
    id('left-resizer').classList.add('active');
    document.body.style.cursor = 'ns-resize';
    e.preventDefault();
  });

  addEventListener('mousemove', e => {
    if(peekResizing) {
      const delta = peekStartY - e.clientY;
      const newH = Math.max(120, Math.min(peekStartH + delta, id('pane-right').offsetHeight * 0.8));
      id('peek').style.height = newH + 'px';
      id('peek').style.maxHeight = 'none';
      if(monacoEditor) monacoEditor.layout();
    }
    if(leftResizing) {
      const newH = Math.max(80, leftStartH + (e.clientY - leftStartY));
      id('pane-search').style.flex = 'none';
      id('pane-search').style.height = newH + 'px';
    }
  });

  addEventListener('mouseup', () => {
    if(peekResizing) {
      peekResizing = false;
      document.body.style.cursor = '';
      const h = id('peek').offsetHeight;
      if(h) localStorage.setItem('grepnavi-peek-h', h);
    }
    if(leftResizing) {
      leftResizing = false;
      document.body.style.cursor = '';
      id('left-resizer').classList.remove('active');
      const h = id('pane-search').offsetHeight;
      if(h) localStorage.setItem('grepnavi-left-search-h', h);
    }
  });

  // 前回の高さを復元
  const savedPeekH = localStorage.getItem('grepnavi-peek-h');
  if(savedPeekH) {
    id('peek').style.height = savedPeekH + 'px';
    id('peek').style.maxHeight = 'none';
  }
  const savedLeftH = localStorage.getItem('grepnavi-left-search-h');
  if(savedLeftH) {
    id('pane-search').style.flex = 'none';
    id('pane-search').style.height = savedLeftH + 'px';
  }
});

// ===== OPEN IN EDITOR =====
function openFile(file, line) {
  if(!file) return;
  const params = new URLSearchParams({file});
  if(line) params.set('line', line);
  fetch('/api/open?' + params);
}

// ===== STATUS =====
function st(msg){ id('st').textContent=msg; }
function stGraph(){
  const nc=Object.keys(graph.nodes).length, ec=(graph.edges||[]).length;
  st(`${nc}ノード / ${ec}エッジ | 保存済`);
}

// ===== UTILS =====
const id = s => document.getElementById(s);
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const trunc = (s,n) => s&&s.length>n ? s.slice(0,n)+'…' : s||'';
const pad = n => String(n).padStart(4,' ');
function wrapText(text, maxChars, maxLines = 3) {
  return wrapTextNL(text.replace(/\n/g, ' '), maxChars, maxLines);
}

// 改行文字を保持したままラップ
function wrapTextNL(text, maxChars, maxLines = 6) {
  const lines = [];
  for(const para of text.split('\n')) {
    if(lines.length >= maxLines) break;
    if(!para.trim()) { lines.push(''); continue; }
    const words = para.split(/\s+/);
    let cur = '';
    for(const w of words) {
      if(lines.length >= maxLines) break;
      const next = cur ? cur + ' ' + w : w;
      if(next.length > maxChars) {
        if(cur) lines.push(cur);
        cur = w.slice(0, maxChars);
      } else {
        cur = next;
      }
    }
    if(cur && lines.length < maxLines) lines.push(cur);
  }
  return lines.length ? lines : [text.slice(0, maxChars)];
}

function exportGraphPNG() {
  const svgEl = id('graph-view')?.querySelector('svg');
  if(!svgEl) { st('グラフビューを開いてください'); return; }
  const W = svgEl.getAttribute('width') || 800;
  const H = svgEl.getAttribute('height') || 600;
  const xml = new XMLSerializer().serializeToString(svgEl);
  const blob = new Blob([xml], {type:'image/svg+xml;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    const a = document.createElement('a');
    a.download = 'grepnavi-graph.png';
    a.href = canvas.toDataURL('image/png');
    a.click();
    st('PNG 保存しました');
  };
  img.onerror = () => { URL.revokeObjectURL(url); st('PNG 生成失敗'); };
  img.src = url;
}

function exportGraphDrawio() {
  const nodeArr = Object.values(graph.nodes);
  if(!nodeArr.length) { st('ノードがありません'); return; }

  const depths = computeDepths();
  const NW = 180, NH = 48;

  function xe(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  // ノードIDをXML IDとして安全に使う
  function nid(id) { return 'n-' + id.replace(/[^a-zA-Z0-9_-]/g, '_'); }

  const cells = [];

  // ノード
  for(const n of nodeArr) {
    const color = NODE_COLORS[Math.min(depths[n.id]||0, 4)];
    const matchText = n.label || (n.match?.text||'').trim() || '';
    const fileLine  = shortPath(n.match?.file||'') + (n.match?.line ? ':'+n.match.line : '');
    const label = xe(`<b>${matchText}</b><br><font color="#445566">${fileLine}</font>`);
    const x = Math.round((n.gx ?? 0) - NW/2);
    const y = Math.round((n.gy ?? 0) - NH/2);
    const tooltip = n.memo ? xe(n.memo) : '';
    cells.push(
      `<mxCell id="${nid(n.id)}" value="${label}" tooltip="${tooltip}" ` +
      `style="rounded=1;whiteSpace=wrap;html=1;fillColor=${color};fillOpacity=13;strokeColor=${color};` +
      `fontColor=#1a1a1a;fontSize=11;fontFamily=Consolas,monospace;align=center;" ` +
      `vertex="1" parent="1">` +
      `<mxGeometry x="${x}" y="${y}" width="${NW}" height="${NH}" as="geometry"/></mxCell>`
    );

    // メモ → 付箋ノード
    if(n.memo) {
      const lines = n.memo.split('\n').length;
      const memoH = Math.max(44, lines * 16 + 16);
      cells.push(
        `<mxCell id="${nid(n.id)}-memo" value="${xe(n.memo)}" ` +
        `style="shape=note;whiteSpace=wrap;html=0;backgroundOutline=1;fontSize=11;fontFamily=Consolas,monospace;` +
        `fillColor=#fff9c4;strokeColor=#d6b656;fontColor=#111;align=left;verticalAlign=top;size=12;" ` +
        `vertex="1" parent="1">` +
        `<mxGeometry x="${x-8}" y="${y+NH}" width="${NW+16}" height="${memoH}" as="geometry"/></mxCell>`
      );
    }
  }

  // エッジ
  const edgeArr = graph.edges||[];
  edgeArr.forEach((e, i) => {
    const isSeq = e.label === 'seq';
    const style = isSeq
      ? 'edgeStyle=orthogonalEdgeStyle;html=1;exitX=0.5;exitY=1;exitDx=0;exitDy=0;entryX=0.5;entryY=0;entryDx=0;entryDy=0;dashed=1;strokeColor=#d4875a;endArrow=block;endFill=1;'
      : 'edgeStyle=orthogonalEdgeStyle;html=1;exitX=1;exitY=0.5;exitDx=0;exitDy=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;strokeColor=#666;endArrow=block;endFill=1;';
    const label = (e.label && e.label !== 'ref' && e.label !== 'seq') ? xe(e.label) : '';
    cells.push(
      `<mxCell id="e${i}" value="${label}" style="${style}" ` +
      `edge="1" source="${nid(e.from)}" target="${nid(e.to)}" parent="1">` +
      `<mxGeometry relative="1" as="geometry"/></mxCell>`
    );
  });

  // auto-seq（保存されていないルートノード間の順序矢印）
  const hasParentSet = new Set(edgeArr.filter(e=>e.label!=='seq').map(e=>e.to));
  const rootNodes = nodeArr.filter(n => !hasParentSet.has(n.id)).sort((a,b) => (a.gy||0)-(b.gy||0));
  for(let i = 0; i < rootNodes.length - 1; i++) {
    const from = rootNodes[i].id, to = rootNodes[i+1].id;
    if(!edgeArr.some(e => e.from===from && e.to===to && e.label==='seq')) {
      cells.push(
        `<mxCell id="aseq${i}" value="" ` +
        `style="edgeStyle=orthogonalEdgeStyle;html=1;exitX=0.5;exitY=1;exitDx=0;exitDy=0;entryX=0.5;entryY=0;entryDx=0;entryDy=0;dashed=1;strokeColor=#d4875a;endArrow=block;endFill=1;" ` +
        `edge="1" source="${nid(from)}" target="${nid(to)}" parent="1">` +
        `<mxGeometry relative="1" as="geometry"/></mxCell>`
      );
    }
  }

  const xml = `<mxfile host="grepnavi"><diagram name="調査グラフ">` +
    `<mxGraphModel grid="0" tooltips="1" connect="1" arrows="1" fold="1" page="0" math="0" shadow="0">` +
    `<root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root>` +
    `</mxGraphModel></diagram></mxfile>`;

  const blob = new Blob([xml], {type:'application/xml'});
  const a = document.createElement('a');
  a.download = 'grepnavi-graph.drawio';
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  st('draw.io ファイルを保存しました');
}

function shortPath(p) {
  if(!p) return '';
  const parts = p.replace(/\\/g,'/').split('/');
  return parts.length<=2 ? p : parts.slice(-2).join('/');
}
function labelFrom(m) {
  if(!m) return '';
  return shortPath(m.file||'') + (m.line?':'+m.line:'');
}
function extractSym(text) {
  const m = text.match(/\b([a-zA-Z_][a-zA-Z0-9_]{2,})\b/);
  return m ? m[1] + '(' : '';
}

// ===== メモツールチップ =====
function showMemoTip(e, node) {
  if(!node.memo) return;
  const tt = id('memo-tooltip');
  tt.innerHTML = `<span class="mt-label">💬 ${esc(node.label || shortPath(node.match?.file||'')+(node.match?.line?':'+node.match.line:''))}</span>${esc(node.memo)}`;
  tt.style.display = 'block';
  moveMemoTip(e);
}
function moveMemoTip(e) {
  const tt = id('memo-tooltip');
  if(tt.style.display === 'none') return;
  const x = e.clientX + 18, y = e.clientY - 10;
  tt.style.left = Math.min(x, window.innerWidth  - tt.offsetWidth  - 8) + 'px';
  tt.style.top  = Math.max(4, Math.min(y, window.innerHeight - tt.offsetHeight - 8)) + 'px';
}
function hideMemoTip() { id('memo-tooltip').style.display = 'none'; }

let ifdefDecoIds = [];

async function applyIfdefHighlight() {
  const condStr = id('ifdef-cond').value.trim();
  if (!condStr) { st('条件を入力: 例 WIN32=1 DEBUG=0'); return; }
  if (!monacoEditor) { st('先にファイルを開いてください'); return; }
  const file = tabs[activeTabIdx]?.file;
  if (!file) { st('ファイルを開いてください'); return; }
  try {
    const r = await fetch('/api/ifdef?' + new URLSearchParams({file, defines: condStr}));
    const d = await r.json();
    if (d.error) { st('エラー: ' + d.error); return; }
    const inactive = new Set(d);
    const model = monacoEditor.getModel();
    const lineCount = model.getLineCount();
    const decos = [];
    let rs = null;
    for (let i = 1; i <= lineCount + 1; i++) {
      if (inactive.has(i)) { if (rs === null) rs = i; }
      else if (rs !== null) {
        decos.push({ range: new monaco.Range(rs, 1, i-1, model.getLineMaxColumn(i-1)),
          options: { isWholeLine: true, inlineClassName: 'ifdef-inactive-text',
            overviewRuler: {color: '#2a2a2a', position: monaco.editor.OverviewRulerLane.Full} }
        });
        rs = null;
      }
    }
    ifdefDecoIds = monacoEditor.deltaDecorations(ifdefDecoIds, decos);
    st(`プリプロセッサ適用: ${d.length} 行がグレーアウト`);
  } catch(e) { st('エラー: ' + e.message); }
}

function clearIfdefHighlight() {
  if (!monacoEditor) return;
  ifdefDecoIds = monacoEditor.deltaDecorations(ifdefDecoIds, []);
  st('#ifdef ハイライト解除');
}

// ===== INDENT DRAG (レベル変更) =====
// レベル変更先の親IDを返す（'' = ルート、undefined = 変更不可）
function calcDragTarget(nodeId, fromDepth, toDepth) {
  if (toDepth < fromDepth) {
    const stepsUp = fromDepth - toDepth;
    let pid = findParent(nodeId);
    for (let i = 0; i < stepsUp; i++) {
      const p = findParent(pid);
      if (p === '' && i < stepsUp - 1) { pid = ''; break; }
      pid = p;
    }
    return pid;
  } else {
    const parent = findParent(nodeId);
    const siblings = parent
      ? (graph.nodes[parent]?.children || [])
      : Object.values(graph.nodes).filter(n => !Object.values(graph.nodes).some(p => (p.children||[]).includes(n.id))).map(n => n.id);
    const idx = siblings.indexOf(nodeId);
    return idx > 0 ? siblings[idx - 1] : undefined;
  }
}

function attachIndentDrag(handle, nodeId, depth) {
  const STEP = DRAG_STEP;
  let startX = 0, dragging = false;

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    startX = e.clientX;
    dragging = true;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp, {once: true});
  });

  function calcNewDepth(clientX) {
    const dx = clientX - startX;
    const delta = Math.round(dx / STEP);
    return Math.max(0, depth + delta);
  }

  function showDragFeedback(e, newDepth) {
    const badge = id('level-badge');
    badge.style.display = 'block';
    badge.style.left = (e.clientX + 16) + 'px';
    badge.style.top  = (e.clientY - 24) + 'px';
    id('lv-from').textContent = depth;
    id('lv-to').textContent   = newDepth;
    const arrow = badge.querySelector('.lv-arrow');
    if (newDepth < depth)      { badge.className = 'up';   arrow.textContent = '←'; }
    else if (newDepth > depth) { badge.className = 'down'; arrow.textContent = '→'; }
    else                       { badge.className = 'same'; arrow.textContent = '─'; }

    // 既存ハイライト・インジケーターをクリア
    document.querySelectorAll('.node-row.indent-target').forEach(el => el.classList.remove('indent-target'));
    document.querySelectorAll('.node.insert-before,.node.insert-after').forEach(el => {
      el.classList.remove('insert-before','insert-after');
    });

    // 移動先の親を一度だけ計算（undefined = 移動不可、'' = ルートへ昇格）
    const targetParent = newDepth !== depth ? calcDragTarget(nodeId, depth, newDepth) : undefined;
    id('drop-root').classList.toggle('drag-over', targetParent === '');

    // レベルガイド縦線
    const guide = id('indent-guide');
    if(!guide) return;
    const INDENT_W = 24;
    const paneEl = id('pane-tree');
    const paneRect = paneEl.getBoundingClientRect();
    const nodeEl = paneEl.querySelector(`.node-row[data-id="${nodeId}"]`);
    if(nodeEl && newDepth !== depth && targetParent !== undefined) {
      const nodeRect = nodeEl.getBoundingClientRect();
      const currentX = nodeRect.left - paneRect.left;
      const guideX = Math.max(0, currentX + (newDepth - depth) * INDENT_W);
      // 上端: 移動先の親ノード下端（ルートの場合はツリーコンテンツ上端）
      const treeContentTop = id('tree').getBoundingClientRect().top - paneRect.top;
      let guideTop;
      if(targetParent) {
        const parentEl = paneEl.querySelector(`.node-row[data-id="${targetParent}"]`);
        guideTop = parentEl
          ? parentEl.getBoundingClientRect().bottom - paneRect.top
          : treeContentTop;
      } else {
        guideTop = treeContentTop;
      }
      const nodeBottom = nodeRect.bottom - paneRect.top;
      guide.style.left   = guideX + 'px';
      guide.style.top    = guideTop + 'px';
      guide.style.height = Math.max(0, nodeBottom - guideTop) + 'px';
      guide.style.bottom = 'auto';
      guide.style.display = 'block';
    } else {
      guide.style.display = 'none';
    }

    if (targetParent === undefined) return;

    if (newDepth < depth) {
      // 左ドラッグ（昇格）→ 現在の親ノードの「直後」に入る
      const currentParent = findParent(nodeId);
      if (currentParent) {
        const parentWrap = id('tree').querySelector(`.node[data-id="${currentParent}"]`);
        if (parentWrap) parentWrap.classList.add('insert-after');
      } else if (targetParent === '') {
        id('drop-root').classList.add('drag-over');
      }
    } else if (newDepth > depth) {
      // 右ドラッグ（降格）→ 前の兄弟の子になる
      if (targetParent) {
        const el = document.querySelector(`.node-row[data-id="${targetParent}"]`);
        if (el) el.classList.add('indent-target');
      }
    }
  }

  function onMove(e) {
    if (!dragging) return;
    showDragFeedback(e, calcNewDepth(e.clientX));
  }

  function onUp(e) {
    dragging = false;
    document.removeEventListener('mousemove', onMove);
    id('level-badge').style.display = 'none';
    document.querySelectorAll('.node-row.indent-target').forEach(el => el.classList.remove('indent-target'));
    document.querySelectorAll('.node.insert-before,.node.insert-after').forEach(el => {
      el.classList.remove('insert-before','insert-after');
    });
    id('drop-root').classList.remove('drag-over');
    const g = id('indent-guide'); if(g) g.style.display = 'none';

    const newDepth = calcNewDepth(e.clientX);
    if (newDepth === depth) return;
    const targetParentId = calcDragTarget(nodeId, depth, newDepth);
    if (targetParentId !== undefined) reparent(nodeId, targetParentId);
  }
}
