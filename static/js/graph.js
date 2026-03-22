// ===== GRAPH =====

// GraphResponse をクライアント状態に適用する共通関数
function applyGraphResponse(g) {
  const savedRoot = projectRoot || g.root_dir;
  if(g.file_path) window._serverGraphFile = g.file_path;
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
    if(typeof markClean === 'function') markClean();
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

    // 削除ボタン（複数ある場合）
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
  const r = await fetch('/api/trees', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name: '新しいツリー'})
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
  const hasParent = new Set();
  Object.values(graph.nodes).forEach(n => (n.children||[]).forEach(c => hasParent.add(c)));
  const rootSet = Object.values(graph.nodes).filter(n => !hasParent.has(n.id));
  // hasParent に含まれるノード（子になったノード）は rootOrder から除外する
  const rootOrder = (graph._rootOrder || []).filter(id => graph.nodes[id] && !hasParent.has(id));
  const roots = rootOrder.length
    ? [...rootOrder.map(id => graph.nodes[id]), ...rootSet.filter(n => !rootOrder.includes(n.id))]
    : rootSet;

  el.innerHTML = '';
  const frag = document.createDocumentFragment();
  roots.forEach(n => frag.appendChild(makeNodeEl(n, 0)));
  el.appendChild(frag);

  // 親が削除されて孤立したノードを追加（折りたたまれた子孫は除外）
  const collapsedChildren = new Set();
  function collectCollapsed(nodeId, visited = new Set()) {
    if(visited.has(nodeId)) return;
    visited.add(nodeId);
    (graph.nodes[nodeId]?.children || []).forEach(cid => {
      collapsedChildren.add(cid);
      collectCollapsed(cid, visited);
    });
  }
  Object.values(graph.nodes).forEach(n => {
    if(n.expanded === false) collectCollapsed(n.id);
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
function computeDepths(nodes, edges) {
  const depths = {}, hasParent = new Set((edges||[]).filter(e=>e.label!=='seq').map(e=>e.to));
  const roots = Object.values(nodes).filter(n => !hasParent.has(n.id));
  const visiting = new Set();
  function visit(nid, d) {
    if(visiting.has(nid)) return;
    visiting.add(nid);
    depths[nid] = d;
    (nodes[nid]?.children||[]).forEach(c => visit(c, d+1));
    visiting.delete(nid);
  }
  roots.forEach(n => visit(n.id, 0));
  return depths;
}

function loadD3() {
  return new Promise((resolve, reject) => {
    if(typeof d3 !== 'undefined') { resolve(); return; }
    // Monaco の AMD loader と衝突しないよう define を一時退避
    const savedDefine = window.define;
    window.define = undefined;
    const s = document.createElement('script');
    s.src = '/d3.min.js';
    s.onload  = () => { window.define = savedDefine; resolve(); };
    s.onerror = () => { window.define = savedDefine; reject(new Error('D3 load failed')); };
    document.head.appendChild(s);
  });
}

// 階層ツリーレイアウト計算（左→右展開）
function treeLayout(nodeArr, edgeArr) {
  const XG = 200, YG = 70;
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

  const depths = computeDepths(graph.nodes, graph.edges);
  const nodeArr = Object.values(graph.nodes);
  if(!nodeArr.length) { container.innerHTML = '<div style="color:#555;padding:20px">ノードなし</div>'; return; }
  const edgeArr = (graph.edges||[]).map(e => ({source:e.from, target:e.to, label:e.label}));

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
  const SN_LINE_H = 16;
  const SN_MAX_LINES = 6;
  function memoLines(d) {
    if(!showMemos || !d.memo) return [];
    return wrapTextNL(d.memo, 22, SN_MAX_LINES);
  }

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
  const flt = defs.append('filter').attr('id','sticky-shadow')
    .attr('x','-15%').attr('y','-15%').attr('width','140%').attr('height','140%');
  flt.append('feDropShadow')
    .attr('dx','2').attr('dy','3').attr('stdDeviation','3')
    .attr('flood-color','#00000077');

  const linkG = root.append('g');
  const labelG = root.append('g');
  const nodeG  = root.append('g');

  function nodeById(id_) { return nodeArr.find(n => n.id === id_); }
  function edgePath(e) {
    const s = nodeById(e.source), t = nodeById(e.target);
    if(!s||!t) return '';
    if(e.label === 'seq') {
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

  const linkLabel = labelG.selectAll('text')
    .data(edgeArr.filter(e=>e.label&&e.label!=='ref')).enter()
    .append('text').text(d=>d.label)
    .attr('fill','#888').attr('font-size','10px').attr('text-anchor','middle')
    .attr('x', d => { const s=nodeById(d.source),t=nodeById(d.target); return s&&t?(s.gx+NW/2+t.gx-NW/2)/2:0; })
    .attr('y', d => { const s=nodeById(d.source),t=nodeById(d.target); return s&&t?(s.gy+t.gy)/2:0; });

  let tempLine = null, edgeSrc = null;

  const node = nodeG.selectAll('g').data(nodeArr).enter()
    .append('g').attr('class', d => 'gnode'+(selNode===d.id?' sel':''))
    .attr('transform', d => `translate(${d.gx},${d.gy})`)
    .call(d3.drag()
      .on('start', function(e, d) {
        if(e.sourceEvent.shiftKey) {
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
          if(!graphSel.has(d.id)) {
            graphSel.clear();
            graphSel.add(d.id);
            refreshGraphSel();
          }
        }
      })
      .on('drag', function(e, d) {
        if(edgeSrc) {
          const svgPt = svg.node().createSVGPoint();
          svgPt.x = e.sourceEvent.clientX; svgPt.y = e.sourceEvent.clientY;
          const pt = svgPt.matrixTransform(root.node().getScreenCTM().inverse());
          tempLine.attr('x2', pt.x).attr('y2', pt.y);
          nodeG.selectAll('g.gnode rect.hover-hl').attr('stroke-width', 1.5);
          const hover = nodeArr.find(n => n.id !== edgeSrc.id &&
            Math.abs(n.gx - pt.x) < NW/2 && Math.abs(n.gy - pt.y) < NH()/2);
          if(hover) {
            nodeG.selectAll('g.gnode').filter(n => n.id === hover.id)
              .select('rect').attr('stroke-width', 3);
          }
        } else {
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

  node.append('rect')
    .attr('width', NW).attr('height', NH())
    .attr('x', -NW/2).attr('y', -NH()/2).attr('rx', 4)
    .attr('fill', d => NODE_COLORS[Math.min(depths[d.id]||0,4)]+'22')
    .attr('stroke', d => NODE_COLORS[Math.min(depths[d.id]||0,4)])
    .attr('stroke-width', 1.5);

  node.append('text')
    .text(d => trunc(d.label||(d.match?.text||'').trim()||'', 22))
    .attr('text-anchor','middle').attr('y', -8)
    .attr('font-size','11px').attr('fill','#e0e0e0').attr('font-weight','bold');

  node.append('text')
    .text(d => shortPath(d.match?.file||'')+(d.match?.line?':'+d.match.line:''))
    .attr('text-anchor','middle').attr('y', 9)
    .attr('font-size','10px').attr('fill','#778');

  node.each(function(d) {
    const ml = memoLines(d);
    if(!ml.length) return;
    const g = d3.select(this);
    const SNW = NW + 16;
    const FOLD = 12;
    const SNH = ml.length * SN_LINE_H + 22;
    const noteY = NH() / 2;
    const ng = g.append('g')
      .attr('transform', `translate(${-SNW/2},${noteY})`)
      .attr('filter', 'url(#sticky-shadow)');
    ng.append('path')
      .attr('d', `M0,0 L${SNW-FOLD},0 L${SNW},${FOLD} L${SNW},${SNH} L0,${SNH} Z`)
      .attr('fill', '#fef08a').attr('stroke', 'none');
    ng.append('path')
      .attr('d', `M${SNW-FOLD},0 L${SNW},${FOLD} L${SNW-FOLD},${FOLD} Z`)
      .attr('fill', '#c8a200');
    ml.forEach((line, i) => {
      ng.append('text')
        .text(line || ' ')
        .attr('x', 8).attr('y', 16 + i * SN_LINE_H)
        .attr('font-size', '11px').attr('fill', '#111')
        .attr('font-family', 'Consolas,monospace');
    });
  });

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
  if(label !== 'seq' && graph.nodes[fromId] && !graph.nodes[fromId].children?.includes(toId))
    (graph.nodes[fromId].children = graph.nodes[fromId].children||[]).push(toId);
  renderGraph();
  st('エッジ追加');
}

function refreshGraphSel() {
  d3.selectAll('.gnode').classed('sel', d => d.id === selNode);
  d3.selectAll('.gnode').classed('multi-sel', d => graphSel.has(d.id));
}

function makeNodeBody(node, m) {
  const body = document.createElement('div');
  body.className = 'node-body';
  const matchText = (m.text || '').trim();
  const lbl = document.createElement('div');
  lbl.className = 'node-label';
  lbl.textContent = node.label || matchText || labelFrom(m);
  const sub = document.createElement('div');
  sub.className = 'node-sub';
  const subLink = document.createElement('span');
  subLink.textContent = shortPath(m.file||'') + (m.line ? ':'+m.line : '');
  subLink.title = 'Ctrl+クリックでエディタで開く';
  subLink.style.cssText = 'cursor:pointer;text-decoration:underline';
  subLink.onclick = e => { e.stopPropagation(); if(e.ctrlKey || e.metaKey) openFile(m.file, m.line); };
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
  return {body, lbl};
}

function attachLabelInlineEdit(lbl, node, m) {
  const matchText = (m.text || '').trim();
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
    const cancel = () => { lbl.textContent = original; };
    inp.onblur = save;
    inp.onkeydown = e2 => {
      if(e2.key === 'Enter')  { e2.preventDefault(); inp.blur(); }
      if(e2.key === 'Escape') { e2.stopPropagation(); inp.onblur = null; cancel(); }
    };
  };
}

function attachNodeDragDrop(row, wrap, node) {
  row.draggable = true;
  row.ondragstart = e => {
    dragNodeId = node.id;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    id('drop-root').style.display = '';
    row._dragSeq = ++dragSeq;
  };
  row.ondragend = e => {
    if(row._dragSeq !== dragSeq) return;
    row.classList.remove('dragging');
    id('drop-root').style.display = 'none';
    const insertBefore = !dropHandled ? document.querySelector('.node.insert-before') : null;
    const insertAfter  = !dropHandled ? document.querySelector('.node.insert-after')  : null;
    document.querySelectorAll('.node-row.drag-over,.node-row.indent-target').forEach(el => {
      el.classList.remove('drag-over','indent-target');
    });
    document.querySelectorAll('.node.insert-before,.node.insert-after').forEach(el => {
      el.classList.remove('insert-before','insert-after');
    });
    if(!dropHandled && e.dataTransfer.dropEffect !== 'none') {
      const targetWrap = insertBefore || insertAfter;
      if(targetWrap && targetWrap.dataset.id && targetWrap.dataset.id !== node.id) {
        reorderNode(node.id, targetWrap.dataset.id, insertBefore ? 'before' : 'after');
      }
    }
    dropHandled = false;
    dragNodeId = null;
  };
  row.ondragover = e => {
    if(!dragNodeId || dragNodeId === node.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.node-row.drag-over').forEach(el => el.classList.remove('drag-over'));
    document.querySelectorAll('.node.insert-before,.node.insert-after').forEach(el => {
      el.classList.remove('insert-before','insert-after');
    });
    const rect = row.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    if(ratio < 0.3)      wrap.classList.add('insert-before');
    else if(ratio > 0.7) wrap.classList.add('insert-after');
    else                 row.classList.add('drag-over');
  };
  row.ondragleave = e => {
    if(!row.contains(e.relatedTarget)) row.classList.remove('drag-over');
  };
  row.ondrop = e => {
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove('drag-over');
    const isBefore = wrap.classList.contains('insert-before');
    const isAfter  = wrap.classList.contains('insert-after');
    wrap.classList.remove('insert-before','insert-after');
    if(!dragNodeId || dragNodeId === node.id) return;
    const movedId = dragNodeId;
    dropHandled = true;
    if(isBefore || isAfter) {
      reorderNode(movedId, node.id, isBefore ? 'before' : 'after');
    } else {
      if(clientIsDescendant(node.id, movedId, graph.nodes)) { st('循環参照になるため移動できません'); dropHandled = false; return; }
      reparent(movedId, node.id);
    }
  };
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

  const {body, lbl} = makeNodeBody(node, m);
  row.appendChild(tog);
  row.appendChild(body);

  const handle = document.createElement('div');
  handle.className = 'indent-handle';
  handle.textContent = '⠿';
  handle.title = '左右にドラッグしてレベル変更';
  attachIndentDrag(handle, row, node.id, depth);

  const delBtn = document.createElement('button');
  delBtn.className = 'node-del';
  delBtn.textContent = '×';
  delBtn.title = '削除';
  delBtn.onclick = e => { e.stopPropagation(); removeNode(node.id); };

  row.insertBefore(handle, row.firstChild);
  if(node.badge_color) {
    const badge = document.createElement('span');
    badge.className = 'node-badge';
    badge.style.background = node.badge_color;
    badge.textContent = node.badge_text || '';
    row.appendChild(badge);
  }
  if(node.memo) {
    const memoIcon = document.createElement('span');
    memoIcon.className = 'node-memo-dot';
    memoIcon.title = node.memo;
    memoIcon.textContent = '💬';
    row.appendChild(memoIcon);
  }
  row.appendChild(delBtn);
  row.onclick = e => { e.stopPropagation(); selectNode(node.id); document.getElementById('tree')?.focus({preventScroll:true}); };
  tog.onclick = e => { e.stopPropagation(); toggleNode(node.id); };
  attachLabelInlineEdit(lbl, node, m);
  if(node.memo) {
    row.addEventListener('mouseenter', e => showMemoTip(e, node));
    row.addEventListener('mousemove',  e => moveMemoTip(e));
    row.addEventListener('mouseleave', hideMemoTip);
  }
  attachNodeDragDrop(row, wrap, node);

  wrap.appendChild(row);
  if(node.memo && showTreeMemos) {
    const memoInline = document.createElement('div');
    memoInline.className = 'node-memo-inline';
    memoInline.textContent = node.memo;
    wrap.appendChild(memoInline);
  }
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
  // 選択ノードの補助線強調: 以前のハイライトをクリアして付け直す
  document.querySelectorAll('.children.guide-sel').forEach(el => el.classList.remove('guide-sel'));
  if(id_) {
    const wrap = document.querySelector(`.node[data-id="${id_}"]`);
    if(wrap) {
      // 選択ノードから子へ伸びる縦線
      const childrenEl = wrap.querySelector(':scope > .children');
      if(childrenEl) childrenEl.classList.add('guide-sel');
      // 選択ノードが属する親の縦線
      const parentChildren = wrap.parentElement?.closest('.children');
      if(parentChildren) parentChildren.classList.add('guide-sel');
    }
  }
  const n = graph.nodes[id_];
  showDetail(n);
  if(n && n.match && n.match.file) openPeek(n.match.file, n.match.line);
}

function findParent(nodeId, nodes) {
  for(const n of Object.values(nodes)) {
    if((n.children||[]).includes(nodeId)) return n.id;
  }
  return '';
}

function findGrandparent(nodeId, nodes) {
  return findParent(findParent(nodeId, nodes), nodes);
}

function clientIsDescendant(ancestorId, nodeId, nodes) {
  if(!ancestorId || !nodeId) return false;
  const visited = new Set();
  function check(id) {
    if(visited.has(id)) return false;
    visited.add(id);
    const n = nodes[id];
    if(!n) return false;
    const children = n.children || [];
    if(children.includes(ancestorId)) return true;
    return children.some(c => check(c));
  }
  return check(nodeId);
}

function getNodeSiblings(nodeId, nodes, rootOrder) {
  const parentId = findParent(nodeId, nodes);
  if(parentId) return nodes[parentId]?.children || [];
  const hasParent = new Set();
  Object.values(nodes).forEach(n => (n.children||[]).forEach(c => hasParent.add(c)));
  const rootIds = Object.values(nodes).filter(n => !hasParent.has(n.id)).map(n => n.id);
  const existing = (rootOrder || []).filter(id => nodes[id]);
  const missing = rootIds.filter(id => !existing.includes(id));
  return [...existing, ...missing];
}

async function moveNodeUp() {
  if(!selNode) return;
  const siblings = getNodeSiblings(selNode, graph.nodes, graph._rootOrder);
  const idx = siblings.indexOf(selNode);
  if(idx <= 0) return;
  await reorderNode(selNode, siblings[idx-1], 'before', true);
}

async function moveNodeDown() {
  if(!selNode) return;
  const siblings = getNodeSiblings(selNode, graph.nodes, graph._rootOrder);
  const idx = siblings.indexOf(selNode);
  if(idx < 0 || idx >= siblings.length - 1) return;
  await reorderNode(selNode, siblings[idx+1], 'after', true);
}

async function moveNodeLevelUp() {
  if(!selNode) return;
  const parentId = findParent(selNode, graph.nodes);
  if(!parentId) return;
  await reparent(selNode, findParent(parentId, graph.nodes));
}

async function moveNodeLevelDown() {
  if(!selNode) return;
  const siblings = getNodeSiblings(selNode, graph.nodes, graph._rootOrder);
  const idx = siblings.indexOf(selNode);
  if(idx <= 0) return;
  const prevSibId = siblings[idx-1];
  if(clientIsDescendant(selNode, prevSibId, graph.nodes)) return;
  await reparent(selNode, prevSibId);
}

async function reorderNode(nodeId, refNodeId, position, reorderOnly = false) {
  const parentId = findParent(refNodeId, graph.nodes);
  const nodeParentId = findParent(nodeId, graph.nodes);

  if(parentId !== nodeParentId) {
    if(reorderOnly) return;
    if(clientIsDescendant(parentId, nodeId, graph.nodes)) { st('循環参照になるため移動できません'); return; }
    await reparent(nodeId, parentId);
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

  const parent = parentId ? graph.nodes[parentId] : null;
  const siblings = parent
    ? (parent.children || [])
    : (() => {
        const hasParent = new Set();
        Object.values(graph.nodes).forEach(n => (n.children||[]).forEach(c => hasParent.add(c)));
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


  const BADGE_COLORS = [
    {color:'', label:'なし'},
    {color:'#e05252', label:'赤'},
    {color:'#e09a30', label:'橙'},
    {color:'#c8c825', label:'黄'},
    {color:'#4caf50', label:'緑'},
    {color:'#4a9edd', label:'青'},
    {color:'#9c6fe4', label:'紫'},
    {color:'#888',    label:'灰'},
  ];
  const badgeSwatches = BADGE_COLORS.map(b =>
    `<span class="badge-swatch${(n.badge_color||'')===b.color?' sel':''}" data-color="${esc(b.color)}" title="${b.label}"
      style="background:${b.color||'transparent'};${!b.color?'border:1px dashed #555;':''}">${!b.color?'✕':''}</span>`
  ).join('');
  const labelSec = makeAccSection('loc', 'ラベル', `
    <div style="display:flex;gap:4px;align-items:center">
      <input id="label-inp" type="text" value="${esc(n.label||'')}" placeholder="${esc((m.text||'').trim() || labelFrom(m))}"
        style="flex:1;background:#1a1a1a;border:1px solid #444;color:#e0e0e0;font:12px Consolas,monospace;padding:2px 5px;border-radius:2px">
    </div>
    <div style="color:#555;font-size:11px;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
         title="${esc((m.text||'').trim())}">元: ${esc((m.text||'').trim() || labelFrom(m))}</div>
    <div class="dv" id="d-filelink" title="Ctrl+クリックでエディタで開く" style="cursor:pointer;color:#569cd6;text-decoration:underline;font-size:11px;margin-top:2px">${esc(m.file||'')}:${m.line||''}</div>
    <div style="margin-top:6px">
      <div style="font-size:11px;color:#888;margin-bottom:3px">バッジ</div>
      <div id="badge-swatches" style="display:flex;gap:4px;margin-bottom:4px">${badgeSwatches}</div>
      <input id="badge-text-inp" type="text" value="${esc(n.badge_text||'')}" placeholder="テキスト（省略可）"
        style="width:100%;box-sizing:border-box;background:#1a1a1a;border:1px solid #444;color:#e0e0e0;font:11px Consolas,monospace;padding:2px 4px;border-radius:2px">
    </div>`, true);
  el.appendChild(labelSec);

  if(stack.length) {
    const ifdefSec = makeAccSection('ifdef', '#ifdef スタック',
      `<div class="ifdef-chips">${stack.map(f=>`<span class="chip" title="line ${f.line}">#${f.directive} ${esc(f.condition)}</span>`).join('')}</div>`, false);
    el.appendChild(ifdefSec);
  }

  const snipSec = makeAccSection('snippet', 'スニペット',
    `<div class="snippet">${snippet}</div>`, false);
  el.appendChild(snipSec);

  const memoSec = makeAccSection('memo', 'メモ', `
    <textarea id="memo-ta">${esc(n.memo||'')}</textarea>`, true);
  el.appendChild(memoSec);

  const expSec = makeAccSection('expand', '展開', `
    <div class="row">
      <input id="expand-q" placeholder="パターン" value="${esc(extractSym(m.text||''))}">
      <input id="expand-lbl" placeholder="ラベル" value="ref">
      <input id="expand-glob" placeholder="glob">
    </div>
    <div style="margin-top:4px"><button id="btn-expand">展開</button></div>`, false);
  el.appendChild(expSec);

  id('btn-expand').onclick = doExpand;
  id('d-filelink').onclick = e => { if(e.ctrlKey || e.metaKey) openFile(m.file, m.line); };
  id('label-inp').onkeydown = e => { if(e.key === 'Enter') saveLabel(); };
  id('label-inp').onblur = saveLabel;
  id('memo-ta').onblur = saveMemo;
  // バッジ: スウォッチクリックで色を選択→即保存
  id('badge-swatches').querySelectorAll('.badge-swatch').forEach(sw => {
    sw.onclick = () => {
      id('badge-swatches').querySelectorAll('.badge-swatch').forEach(s => s.classList.remove('sel'));
      sw.classList.add('sel');
      saveBadge(sw.dataset.color, id('badge-text-inp').value.trim());
    };
  });
  id('badge-text-inp').onblur = () => {
    const sel = id('badge-swatches').querySelector('.badge-swatch.sel');
    saveBadge(sel ? sel.dataset.color : (n.badge_color||''), id('badge-text-inp').value.trim());
  };
  id('badge-text-inp').onkeydown = e => { if(e.key === 'Enter') e.target.blur(); };
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
  showDetail(graph.nodes[selNode]);
  st('ラベル保存');
}

async function saveBadge(color, text) {
  if(!selNode) return;
  const r = await fetch('/api/graph/node/'+selNode, {
    method:'PUT', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({badge_color: color, badge_text: text})
  });
  const n = await r.json();
  graph.nodes[selNode] = n;
  renderCurrent();
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
  } else if(!parentId) {
    // ルートノードとして追加された場合、既存ルートノードを含む完全な順序リストを再構築して末尾に追加
    const hp = new Set();
    Object.values(graph.nodes).forEach(n => (n.children||[]).forEach(c => hp.add(c)));
    const ordered = (graph._rootOrder || []).filter(id => graph.nodes[id] && !hp.has(id));
    const unordered = Object.values(graph.nodes).filter(n => !hp.has(n.id) && !ordered.includes(n.id)).map(n => n.id);
    const full = [...ordered, ...unordered];
    if(!full.includes(d.node.id)) full.push(d.node.id);
    graph._rootOrder = full;
    await saveRootOrder(graph._rootOrder);
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

// ===== EXPORT =====
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

  const depths = computeDepths(graph.nodes, graph.edges);
  const NW = 180, NH = 48;

  function xe(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function nid(id) { return 'n-' + id.replace(/[^a-zA-Z0-9_-]/g, '_'); }

  const cells = [];

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

// ===== INDENT DRAG (レベル変更) =====
function calcDragTarget(nodeId, fromDepth, toDepth) {
  if (toDepth < fromDepth) {
    const stepsUp = fromDepth - toDepth;
    let pid = findParent(nodeId, graph.nodes);
    for (let i = 0; i < stepsUp; i++) {
      const p = findParent(pid, graph.nodes);
      if (p === '' && i < stepsUp - 1) { pid = ''; break; }
      pid = p;
    }
    return pid;
  } else {
    const parent = findParent(nodeId, graph.nodes);
    const siblings = parent
      ? (graph.nodes[parent]?.children || [])
      : Object.values(graph.nodes).filter(n => !Object.values(graph.nodes).some(p => (p.children||[]).includes(n.id))).map(n => n.id);
    const idx = siblings.indexOf(nodeId);
    return idx > 0 ? siblings[idx - 1] : undefined;
  }
}

function attachIndentDrag(handle, row, nodeId, depth) {
  const STEP = DRAG_STEP;
  let startX = 0, dragging = false;

  // ハンドル操作中に row の HTML5 D&D が起動するとマウスイベントが乗っ取られて
  // mousemove/mouseup が届かなくなるため、dragstart を明示的にキャンセルする
  function preventDragStart(e) { e.preventDefault(); e.stopPropagation(); }

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    startX = e.clientX;
    dragging = true;
    row.addEventListener('dragstart', preventDragStart);
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

    document.querySelectorAll('.node-row.indent-target').forEach(el => el.classList.remove('indent-target'));
    document.querySelectorAll('.node.insert-before,.node.insert-after').forEach(el => {
      el.classList.remove('insert-before','insert-after');
    });

    const targetParent = newDepth !== depth ? calcDragTarget(nodeId, depth, newDepth) : undefined;
    id('drop-root').classList.toggle('drag-over', targetParent === '');

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
      const currentParent = findParent(nodeId, graph.nodes);
      if (currentParent) {
        const parentWrap = id('tree').querySelector(`.node[data-id="${currentParent}"]`);
        if (parentWrap) parentWrap.classList.add('insert-after');
      } else if (targetParent === '') {
        id('drop-root').classList.add('drag-over');
      }
    } else if (newDepth > depth) {
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
    row.removeEventListener('dragstart', preventDragStart);
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

// インクルード依存グラフ機能は static/js/include-graph.js に分離されています。

if (typeof module !== 'undefined') module.exports = { computeDepths, findParent, findGrandparent, clientIsDescendant, getNodeSiblings };
