// ===== Jump Map Addon =====
// 定義ジャンプの経路をファイルグループ + シンボルノードで可視化する。
// Cytoscape.js を使用（コンパウンドノード対応）。

(function() {

// ----- 定数 -----
const JM_PANEL_MIN_W    = 280;   // パネル最小幅(px)
const JM_PREVIEW_MIN_H  = 80;    // プレビュー最小高(px)
const JM_PREVIEW_MAX_H  = 600;   // プレビュー最大高(px)
const JM_HOVER_DELAY    = 200;   // ホバー発火遅延(ms)
const JM_SCROLL_DELAY   = 160;   // プレビューopen後スクロール遅延(ms) ※CSS transition 0.15s に合わせる
const JM_FIT_PADDING    = 40;    // グラフfit時のpadding(px)
const JM_MAX_ZOOM       = 1.2;   // relayout後の最大ズーム倍率
const JM_SNIPPET_CTX    = 25;    // プレビュー前後行数

// ----- 色プリセット -----
const JM_COLOR_PRESETS = {
  vivid: { fileBg:'#1e2a35', fileBorder:'#4a90d9', symBg:'#2d4a6a', symBorder:'#4a90d9',
           edge:'#4a90d9', curFileBorder:'#7ec8ff', curSymBg:'#1a6aaa', curSymBorder:'#7ec8ff',
           folderBg:'#0d1820', folderBorder:'#2a5080' },
  muted: { fileBg:'#1e2830', fileBorder:'#5a7a9a', symBg:'#253545', symBorder:'#5a7a9a',
           edge:'#5a7a9a', curFileBorder:'#8ab0c8', curSymBg:'#2a4a5a', curSymBorder:'#8ab0c8',
           folderBg:'#0d1820', folderBorder:'#2a4060' },
  dark:  { fileBg:'#1a1e22', fileBorder:'#3a4a55', symBg:'#1e2830', symBorder:'#3a4a55',
           edge:'#3a4a55', curFileBorder:'#5a7080', curSymBg:'#1e3040', curSymBorder:'#5a7080',
           folderBg:'#0d1015', folderBorder:'#1a2530' },
};
const JM_COLOR_PRESET_ORDER = ['vivid','muted','dark'];
const JM_COLOR_LABELS = {vivid:'色:鮮', muted:'色:淡', dark:'色:暗'};
let _jmColorPreset = localStorage.getItem('grepnavi-jm-color-preset') || 'vivid';

function _jmApplyColorPreset(preset) {
  _jmColorPreset = preset;
  localStorage.setItem('grepnavi-jm-color-preset', preset);
  const c = JM_COLOR_PRESETS[preset];
  if(!_cy) return;
  _cy.style()
    .selector('node[type="folder"]').style({'background-color': c.folderBg, 'border-color': c.folderBorder})
    .selector('node[type="file"]').style({'background-color': c.fileBg, 'border-color': c.fileBorder})
    .selector('node[type="file"].current-file').style({'border-color': c.curFileBorder})
    .selector('node[type="sym"]').style({'background-color': c.symBg, 'border-color': c.symBorder})
    .selector('node[type="sym"].current').style({'background-color': c.curSymBg, 'border-color': c.curSymBorder})
    .selector('edge').style({'line-color': c.edge, 'target-arrow-color': c.edge})
    .selector('edge:selected').style({'line-color': '#00ccff', 'target-arrow-color': '#00ccff', 'width': 3, 'opacity': 1})
    .update();
  // プリセット変更後に kind bypass スタイルを再適用（プリセットが border-color を上書きするため）
  const kindBorder = { define:'#d9a040', struct:'#4ad990', union:'#4ad990', enum:'#40d9b8', typedef:'#a060d9' };
  _cy.nodes('[type="sym"]').forEach(n => {
    const k = n.data('kind');
    if(k && kindBorder[k]) n.style('border-color', kindBorder[k]);
  });
  const btn = document.getElementById('jm-color');
  if(btn) btn.textContent = JM_COLOR_LABELS[preset] || '色';
}

// ----- Cytoscape 遅延ロード -----
let _cy = null;

function _loadScript(url) {
  return new Promise((resolve, reject) => {
    const savedDefine = window.define;
    window.define = undefined;
    const s = document.createElement('script');
    s.src = url;
    s.onload  = () => { window.define = savedDefine; resolve(); };
    s.onerror = () => { window.define = savedDefine; reject(new Error('load failed: ' + url)); };
    document.head.appendChild(s);
  });
}
function _loadCytoscape() {
  if(typeof cytoscape !== 'undefined') return Promise.resolve();
  return _loadScript('https://cdn.jsdelivr.net/npm/cytoscape@3.28.1/dist/cytoscape.min.js');
}
async function _loadHighlightJs() {
  if(typeof hljs !== 'undefined') return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css';
  document.head.appendChild(link);
  // CDNリリースビルド（ブラウザ向けIIFE、AMD干渉なし）
  await _loadScript('https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js');
}
function _extToLang(file) {
  const ext = (file || '').split('.').pop().toLowerCase();
  return { c:'c', h:'c', cpp:'cpp', cc:'cpp', cxx:'cpp', hpp:'cpp',
           go:'go', py:'python', js:'javascript', ts:'typescript',
           rs:'rust', java:'java', sh:'bash', bash:'bash' }[ext] || 'plaintext';
}

// ----- state -----
// ノード: {id, type:'file'|'sym', label, file, line, parent?}
// エッジ: {id, source, target}
const _jmElements = { nodes: [], edges: [] };
let _jmLastSymId = null;
let _jmElemId = 0;
let _edgeDrawing = false;
let _tracking = false;
let _previewEnabled = false;
let _folderView = false;
let _jmHasLayout = false;  // 初回レイアウト済みフラグ
let _jmNav = null;         // cytoscape-navigator インスタンス

function _jmNodeId() { return 'n' + _jmElemId++; }
function _jmEdgeId() { return 'e' + _jmElemId++; }

function _jmFileName(file) {
  return (file || '').replace(/\\/g, '/').split('/').pop() || file;
}
function _jmFindFile(file) {
  return _jmElements.nodes.find(n => n.data.type === 'file' && n.data.file === file);
}
function _jmFindSym(file, symbol, line) {
  return _jmElements.nodes.find(n => n.data.type === 'sym' && n.data.file === file && n.data.symbol === symbol && n.data.line === line);
}

function _jmGetOrCreateFile(file) {
  let n = _jmFindFile(file);
  if(!n) {
    n = { data: { id: _jmNodeId(), type: 'file', label: _jmFileName(file), file } };
    _jmElements.nodes.push(n);
    if(_cy) {
      if(_folderView) {
        // フォルダ構造が変わる可能性があるため全体を再構築
        _jmRebuildView();
      } else {
        _cy.add(n);
      }
    }
  }
  return n;
}
function _jmGetOrCreateSym(fileNode, symbol, line) {
  let n = _jmFindSym(fileNode.data.file, symbol, line);
  if(!n) {
    n = { data: { id: _jmNodeId(), type: 'sym', label: symbol, file: fileNode.data.file, symbol, line, parent: fileNode.data.id } };
    _jmElements.nodes.push(n);
    if(_cy) _cy.add(n);
  }
  return n;
}

// シンボルの kind を非同期取得してノードに反映
// func はデフォルト扱いで何もしない → 他言語で func 以外が取れなくても安全
async function _jmFetchKind(symbol, file, line, nodeId) {
  try {
    const dir = (typeof projectRoot !== 'undefined' ? projectRoot : '');
    const url = `/api/definition?word=${encodeURIComponent(symbol)}&dir=${encodeURIComponent(dir)}&glob=`;
    const res = await fetch(url);
    if(!res.ok) { console.warn('[jm-kind] fetch failed', res.status, url); return; }
    const hits = await res.json();
    if(!Array.isArray(hits) || !hits.length) return;
    const hit = hits.find(h => h.file === file && h.line === line)
             || hits.find(h => h.file === file)
             || hits[0];
    if(!hit || !hit.kind || hit.kind === 'func') return;
    const kind = hit.kind === 'typedef_close' ? 'typedef'
               : hit.kind === 'enum_member'   ? 'enum'
               : hit.kind;
    // bypass スタイルで強制適用（データセレクタの優先度問題を回避）
    const kindBorder = { define:'#d9a040', struct:'#4ad990', union:'#4ad990', enum:'#40d9b8', typedef:'#a060d9' };
    const border = kindBorder[kind];
    if(!border) return;
    const nodeData = _jmElements.nodes.find(n => n.data.id === nodeId);
    if(nodeData) nodeData.data.kind = kind;
    if(_cy) {
      const n = _cy.getElementById(nodeId);
      if(n && n.length) {
        n.data('kind', kind);
        n.style('border-color', border);  // bypass: すべてのシートルールを上書き
      }
    }
  } catch(_) {}
}

// 右クリックから手動追加（REC不要）
window.addToJumpMap = function(symbol, file, line) {
  _jmEnsureCy().then(() => {
    const fileNode = _jmGetOrCreateFile(file);
    const symNode  = _jmGetOrCreateSym(fileNode, symbol, line);
    _jmFetchKind(symbol, file, line, symNode.data.id);
    if(_cy) {
      _cy.nodes().removeClass('current');
      _cy.getElementById(symNode.data.id).addClass('current');
      _jmRelayout();
    }
  });
};

// editor.js から呼ばれる
window.recordJump = function(symbol, fromFile, fromLine, toFile, toLine) {
  if(!_tracking) return;
  _jmEnsureCy().then(() => {
    const toFileNode = _jmGetOrCreateFile(toFile);
    const toSymNode  = _jmGetOrCreateSym(toFileNode, symbol, toLine);
    const toId = toSymNode.data.id;
    if(!toSymNode.data.kind) _jmFetchKind(symbol, toFile, toLine, toId);

    if(_jmLastSymId && _jmLastSymId !== toId) {
      const alreadyEdge = _jmElements.edges.find(e => e.data.source === _jmLastSymId && e.data.target === toId);
      if(!alreadyEdge) {
        const edge = { data: { id: _jmEdgeId(), source: _jmLastSymId, target: toId } };
        _jmElements.edges.push(edge);
        if(_cy) _cy.add(edge);
      }
    }
    _jmLastSymId = toId;

    // 現在のシンボルをハイライト
    if(_cy) {
      _cy.nodes().removeClass('current');
      _cy.getElementById(toId).addClass('current');
      _jmRelayout();
    }
  });
};

async function _jmEnsureCy() {
  if(_cy) return;
  const panel = document.getElementById('jm-panel');
  if(!panel || !panel.classList.contains('open')) return;
  await _jmInitCy();
}

function _jmSetStatus(msg) {
  const el = document.getElementById('jm-status');
  if(el) el.textContent = msg;
}

async function _jmInitCy() {
  if(_cy) return;
  _jmSetStatus('Cytoscape読み込み中...');
  try {
    await _loadCytoscape();
  } catch(e) { _jmSetStatus('Cytoscape読み込み失敗: ' + e.message); return; }
  _jmSetStatus('');

  const container = document.getElementById('jm-cy');
  if(!container) return;

  _cy = cytoscape({
    container,
    elements: [],
    style: [
      {
        selector: 'node[type="folder"]',
        style: {
          'background-color': '#0d1820',
          'background-opacity': 0.85,
          'border-color': '#2a5080',
          'border-width': 1,
          'border-style': 'dashed',
          'label': 'data(label)',
          'text-valign': 'top',
          'text-halign': 'center',
          'color': '#5a8aaa',
          'font-size': 10,
          'padding': '22px',
          'shape': 'round-rectangle',
          'text-margin-y': -4,
        }
      },
      {
        selector: 'node[type="file"]',
        style: {
          'background-color': '#1e2a35',
          'background-opacity': 0.9,
          'border-color': '#4a90d9',
          'border-width': 1.5,
          'label': 'data(label)',
          'text-valign': 'top',
          'text-halign': 'center',
          'color': '#aaa',
          'font-size': 10,
          'padding': '28px',
          'shape': 'round-rectangle',
          'text-margin-y': -4,
        }
      },
      {
        selector: 'node[type="file"].current-file',
        style: { 'border-color': '#7ec8ff', 'border-width': 2.5 }
      },
      {
        selector: 'node[type="sym"]',
        style: {
          'background-color': '#2d4a6a',
          'border-color': '#4a90d9',
          'border-width': 1.5,
          'label': 'data(label)',
          'text-valign': 'center',
          'text-halign': 'right',
          'color': '#ccc',
          'font-size': 9,
          'width': 18,
          'height': 18,
          'text-margin-x': 4,
        }
      },
      {
        selector: 'node[type="sym"].current',
        style: { 'background-color': '#1a6aaa', 'border-color': '#7ec8ff', 'border-width': 2.5 }
      },
      // kind 別ボーダー色（func はデフォルト、他言語では kind が付かないので安全）
      { selector: 'node[type="sym"][kind="define"]',        style: { 'border-color': '#d9a040' } },
      { selector: 'node[type="sym"][kind="struct"]',        style: { 'border-color': '#4ad990' } },
      { selector: 'node[type="sym"][kind="union"]',         style: { 'border-color': '#4ad990' } },
      { selector: 'node[type="sym"][kind="enum"]',          style: { 'border-color': '#40d9b8' } },
      { selector: 'node[type="sym"][kind="typedef"]',       style: { 'border-color': '#a060d9' } },
      {
        selector: 'node:selected',
        style: { 'border-width': 3.5,
                 'outline-color': '#ffaa00', 'outline-width': 4, 'outline-opacity': 0.6 }
      },
      {
        selector: 'node.draw-src',
        style: { 'border-color': '#ff6600', 'border-width': 3 }
      },
      {
        selector: 'edge',
        style: {
          'width': 1.5,
          'line-color': '#4a90d9',
          'target-arrow-color': '#4a90d9',
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
          'opacity': 0.7,
        }
      },
      {
        selector: 'edge[?sameFile]',
        style: { 'line-color': '#777', 'target-arrow-color': '#777' }
      },
      {
        selector: 'edge:selected',
        style: { 'line-color': '#00ccff', 'target-arrow-color': '#00ccff', 'width': 3, 'opacity': 1 }
      },
    ],
    layout: { name: 'preset' },
    userZoomingEnabled: true,
    userPanningEnabled: true,
    wheelSensitivity: 0.2,
  });

  // ドラッグ閾値: 5px未満の移動はクリックとみなして元の位置に戻す
  _cy.on('grabon', 'node', e => {
    const n = e.target;
    n.scratch('_grabPos', { x: n.position('x'), y: n.position('y') });
  });
  _cy.on('free', 'node', e => {
    const n = e.target;
    const orig = n.scratch('_grabPos');
    if(!orig) return;
    const dx = n.position('x') - orig.x;
    const dy = n.position('y') - orig.y;
    if(Math.sqrt(dx*dx + dy*dy) < 5) n.position(orig);
    n.removeScratch('_grabPos');
  });

  // 保存済み色プリセットを適用
  if(_jmColorPreset !== 'vivid') _jmApplyColorPreset(_jmColorPreset);

  // ファイルノードリサイズハンドル
  _initFileResize();

  // ミニマップ（cytoscape-navigator）
  _loadScript('/addons/jump-map/cytoscape-navigator.js')
    .then(() => {
      if(_jmNav || !_cy) return;
      if(typeof _cy.navigator !== 'function') {
        _jmSetStatus('ミニマップ: navigator 未登録');
        return;
      }
      if(!document.getElementById('jm-nav-style')) {
        const s = document.createElement('style');
        s.id = 'jm-nav-style';
        s.textContent = `
          #jm-nav-wrap {
            position:absolute; bottom:8px; right:8px; z-index:10; }
          #jm-nav {
            position:relative;
            background:#0d1520; border:1px solid #2a4060;
            border-radius:4px; opacity:0.9; overflow:hidden; }
          #jm-nav canvas {
            position:absolute!important; top:0!important; left:0!important; z-index:101!important; }
          #jm-nav .cytoscape-navigatorView {
            position:absolute!important; top:0; left:0; cursor:move!important; z-index:102!important;
            border:1px solid #4a90d9!important;
            background:rgba(74,144,217,0.15)!important; }
          #jm-nav .cytoscape-navigatorOverlay {
            position:absolute!important; top:0; right:0; bottom:0; left:0; z-index:103!important; }
          #jm-nav-handle {
            position:absolute; top:0; left:0; width:12px; height:12px;
            cursor:nw-resize; z-index:200;
            background:linear-gradient(135deg,#4a90d9 0%,#4a90d9 40%,transparent 40%);
            border-radius:4px 0 0 0; opacity:0.7; }
          #jm-nav-handle:hover { opacity:1; }
        `;
        document.head.appendChild(s);
      }
      // ラッパーとコンテナを #jm-cy 内に作成（一度だけ）
      // ハンドルはラッパー直下に置き、#jm-nav の innerHTML クリアで消えないようにする
      let wrapEl = document.getElementById('jm-nav-wrap');
      if(!wrapEl) {
        wrapEl = document.createElement('div');
        wrapEl.id = 'jm-nav-wrap';
        const handleEl = document.createElement('div');
        handleEl.id = 'jm-nav-handle';
        const navEl = document.createElement('div');
        navEl.id = 'jm-nav';
        wrapEl.appendChild(handleEl);
        wrapEl.appendChild(navEl);
        document.getElementById('jm-panel').appendChild(wrapEl);

        // リサイズハンドル（一度だけ登録）
        handleEl.addEventListener('mousedown', e => {
          e.preventDefault(); e.stopPropagation();
          const startX = e.clientX, startY = e.clientY;
          const startW = wrapEl.offsetWidth, startH = wrapEl.offsetHeight;
          const onMove = e => {
            const panel = document.getElementById('jm-panel');
            const cyEl  = document.getElementById('jm-cy');
            const maxW = panel ? Math.floor(panel.offsetWidth  * 0.8) : 320;
            const maxH = cyEl  ? Math.floor(cyEl.offsetHeight  * 0.5) : 240;
            const w = _clamp(startW - (e.clientX - startX), 120, maxW);
            const h = _clamp(startH - (e.clientY - startY),  80, maxH);
            _applyNavSize(w, h);
          };
          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            localStorage.setItem('grepnavi-jm-nav-w', navEl.offsetWidth);
            localStorage.setItem('grepnavi-jm-nav-h', navEl.offsetHeight);
            _jmCreateNav();
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        });
      }
      // 保存済みサイズを復元（デフォルト:220x150、最小120x80、最大320x240）
      const _clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));
      const _jmPanel = document.getElementById('jm-panel');
      const _jmCyEl  = document.getElementById('jm-cy');
      const _maxNavW = _jmPanel ? Math.floor(_jmPanel.offsetWidth * 0.8) : 320;
      const _maxNavH = _jmCyEl  ? Math.floor(_jmCyEl.offsetHeight * 0.5) : 240;
      const navW = _clamp(parseInt(localStorage.getItem('grepnavi-jm-nav-w') || '220'), 120, _maxNavW);
      const navH = _clamp(parseInt(localStorage.getItem('grepnavi-jm-nav-h') || '150'),  80, _maxNavH);
      const navEl = document.getElementById('jm-nav');
      const _applyNavSize = (w, h) => {
        wrapEl.style.width = w + 'px'; wrapEl.style.height = h + 'px';
        navEl.style.width  = w + 'px'; navEl.style.height  = h + 'px';
      };
      _applyNavSize(navW, navH);

      function _jmCreateNav() {
        if(_jmNav) { try { _jmNav.destroy(); } catch(_) {} _jmNav = null; }
        _jmNav = _cy.navigator({
          container: '#jm-nav',
          removeCustomContainer: false,
          viewLiveFramerate: 30,
          thumbnailEventFramerate: 30,
          thumbnailLiveFramerate: false,
          dblClickDelay: 200,
          rerenderDelay: 100,
        });
        // サムネイル再描画を促す（onRender を確実に発火させる）
        setTimeout(() => { if(_cy) _cy.forceRender(); }, 50);
      }
      _jmCreateNav();
    }).catch(e => _jmSetStatus('ミニマップ読み込み失敗: ' + e.message));

  // 線引きモード: クリックで接続元→接続先を指定してエッジ作成
  let _drawSrc = null;
  _cy.on('tap', 'node[type="sym"]', e => {
    if(!_edgeDrawing) return;
    const node = e.target;
    if(!_drawSrc) {
      _drawSrc = node;
      node.addClass('draw-src');
      _jmSetStatus('接続先のノードをクリック');
    } else if(_drawSrc.id() !== node.id()) {
      const sid = _drawSrc.id(), tid = node.id();
      if(!_cy.edges(`[source="${sid}"][target="${tid}"]`).length) {
        const edge = { data: { id: _jmEdgeId(), source: sid, target: tid } };
        _jmElements.edges.push(edge);
        _cy.add(edge);
      }
      _drawSrc.removeClass('draw-src');
      _drawSrc = null;
      _jmSetStatus('接続元のノードをクリック');
    }
  });

  // ホバーでパネル内コードプレビュー
  const _preview = document.getElementById('jm-preview');
  let _previewTimer = null;

  _cy.on('mouseover', 'node[type="sym"]', e => {
    if(!_previewEnabled) return;
    const d = e.target.data();
    clearTimeout(_previewTimer);
    _previewTimer = setTimeout(async () => {
      try {
        const [res] = await Promise.all([
          fetch(`/api/snippet?file=${encodeURIComponent(d.file)}&line=${d.line}&ctx=${JM_SNIPPET_CTX}`),
          _loadHighlightJs(),
        ]);
        const lines = await res.json();
        if(!Array.isArray(lines)) return;
        const lang = _extToLang(d.file);
        const rawCode = lines.map(l => l.text).join('\n');
        const highlighted = (typeof hljs !== 'undefined')
          ? hljs.highlight(rawCode, { language: lang, ignoreIllegals: true }).value.split('\n')
          : lines.map(l => l.text.replace(/&/g,'&amp;').replace(/</g,'&lt;'));
        const html = lines.map((l, i) => {
          const text = highlighted[i] ?? l.text.replace(/&/g,'&amp;').replace(/</g,'&lt;');
          return l.is_match
            ? `<div class="jm-pv-match"><span class="jm-pv-ln">${l.line}</span>${text}</div>`
            : `<div class="jm-pv-line"><span class="jm-pv-ln">${l.line}</span>${text}</div>`;
        }).join('');
        const safeFile = d.file.replace(/&/g,'&amp;').replace(/</g,'&lt;');
        _preview.innerHTML = `<div class="jm-pv-file">${safeFile}:${d.line}<button class="jm-pv-close">×</button></div><div class="jm-pv-body">${html}</div>`;
        const previewResizer = document.getElementById('jm-preview-resizer');
        _preview.querySelector('.jm-pv-close').onclick = _jmClosePreview;
        _preview.classList.add('open');
        previewResizer.classList.add('visible');
        // トランジション後にスクロール
        setTimeout(() => {
          const matchEl = _preview.querySelector('.jm-pv-match');
          if(matchEl) matchEl.scrollIntoView({ block: 'center' });
        }, JM_SCROLL_DELAY);
      } catch(_) {}
    }, JM_HOVER_DELAY);
  });

  _cy.on('mouseout', 'node[type="sym"]', () => {
    clearTimeout(_previewTimer);
  });

  // ダブルクリックでジャンプ
  _cy.on('dblclick', 'node[type="sym"]', e => {
    const d = e.target.data();
    if(typeof openPeek === 'function') openPeek(d.file, d.line);
  });
  _cy.on('dblclick', 'node[type="file"]', e => {
    const d = e.target.data();
    if(typeof openPeek === 'function') openPeek(d.file, 1);
  });

  // Delete キーでノード削除（前後を自動つなぎ直し）
  document.addEventListener('keydown', e => {
    const panel = document.getElementById('jm-panel');
    if(!panel || !panel.classList.contains('open')) return;
    if(e.key === 'Delete' && _cy) {
      const sel = _cy.$(':selected');
      if(!sel.length) return;
      // sym ノード削除時: 手前→先へ自動つなぎ直し
      sel.filter('node[type="sym"]').forEach(el => {
        const preds = el.incomers('node');
        const succs = el.outgoers('node');
        preds.forEach(p => succs.forEach(s => {
          if(p.id() !== s.id() && !_cy.edges(`[source="${p.id()}"][target="${s.id()}"]`).length) {
            const edge = { data: { id: _jmEdgeId(), source: p.id(), target: s.id() } };
            _jmElements.edges.push(edge);
            _cy.add(edge);
          }
        }));
      });
      // エッジ削除: _jmElements から除去
      sel.filter('edge').forEach(el => {
        const id = el.id();
        _jmElements.edges = _jmElements.edges.filter(e => e.data.id !== id);
      });
      // ノード削除
      sel.connectedEdges().remove();
      sel.remove();
      sel.filter('node').forEach(el => {
        const id = el.id();
        const ni = _jmElements.nodes.findIndex(n => n.data.id === id);
        if(ni >= 0) _jmElements.nodes.splice(ni, 1);
        _jmElements.edges = _jmElements.edges.filter(e => e.data.source !== id && e.data.target !== id);
      });
    }
  });
}

function _jmRelayout() {
  if(!_cy) return;
  const isFirst = !_jmHasLayout;
  const opts = _folderView
    ? { name: 'cose', animate: false, fit: isFirst, padding: JM_FIT_PADDING,
        nodeRepulsion: () => 2048, idealEdgeLength: () => 50, edgeElasticity: () => 100,
        gravity: 2, componentSpacing: 30, nestingFactor: 1.2,
        nodeDimensionsIncludeLabels: true, randomize: false }
    : { name: 'breadthfirst', animate: false, fit: isFirst, padding: JM_FIT_PADDING,
        directed: true, spacingFactor: 0.6, nodeDimensionsIncludeLabels: true };
  _cy.layout(opts).run();
  _jmHasLayout = true;
  setTimeout(() => {
    if(!_cy) return;
    if(isFirst) {
      if(_cy.zoom() > JM_MAX_ZOOM) _cy.zoom({ level: JM_MAX_ZOOM, renderedPosition: { x: _cy.width()/2, y: _cy.height()/2 } });
    } else if(_jmLastSymId) {
      // 初回以降は最後に追加したノードにパンするだけ（ズームは維持）
      const node = _cy.getElementById(_jmLastSymId);
      if(node && node.length) _cy.animate({ center: { eles: node }, duration: 250 });
    }
  }, 50);
}

// ビューモードに応じて Cytoscape の要素を再構築する。
// _jmElements はソースオブトゥルース（folder ノードは含まない）。
function _jmRebuildView(resetFit = false) {
  if(!_cy) return;
  if(resetFit) _jmHasLayout = false;
  _cy.elements().remove();

  const fileNodes = _jmElements.nodes.filter(n => n.data.type === 'file');
  const symNodes  = _jmElements.nodes.filter(n => n.data.type === 'sym');

  if(_folderView) {
    // ファイルの直接の親ディレクトリでグループ化
    // 例: net/ipv4/tcp.c → "net/ipv4"、blacklist.c → "(root)"
    const folderKey = file => {
      const parts = file.replace(/\\/g, '/').split('/');
      return parts.length >= 2 ? parts.slice(0, -1).join('/') : '(root)';
    };
    const root = (typeof projectRoot !== 'undefined' ? projectRoot : '')
      .replace(/\\/g, '/').replace(/\/$/, '');
    const toRelLabel = dir => {
      if(!dir || dir === '(root)') return '(root)';
      return (root && dir.startsWith(root + '/')) ? dir.slice(root.length + 1) + '/' : dir + '/';
    };
    const folderIds = new Map();
    for(const fn of fileNodes) {
      const dir = folderKey(fn.data.file);
      if(!folderIds.has(dir)) {
        const fid = 'jmf_' + dir;
        folderIds.set(dir, fid);
        _cy.add({ data: { id: fid, type: 'folder', label: toRelLabel(dir) } });
      }
      _cy.add({ data: { ...fn.data, parent: folderIds.get(dir) } });
    }
  } else {
    for(const fn of fileNodes) _cy.add({ data: { ...fn.data } });
  }

  for(const n of symNodes)  _cy.add(n);
  for(const e of _jmElements.edges) _cy.add(e);

  // kind bypass スタイル再適用（remove→re-add でバイパスが消えるため）
  const _kb = { define:'#d9a040', struct:'#4ad990', union:'#4ad990', enum:'#40d9b8', typedef:'#a060d9' };
  _cy.nodes('[type="sym"]').forEach(n => {
    const k = n.data('kind');
    if(k && _kb[k]) n.style('border-color', _kb[k]);
  });

  _jmRelayout();
}

function _jmClosePreview() {
  const p = document.getElementById('jm-preview');
  const r = document.getElementById('jm-preview-resizer');
  if(p) { p.classList.remove('open'); p.style.height = ''; }
  if(r) r.classList.remove('visible');
}

function _jmClear() {
  _jmElements.nodes.length = 0;
  _jmElements.edges.length = 0;
  _jmLastSymId = null;
  _jmElemId = 0;
  _jmHasLayout = false;
  if(_jmNav) { try { _jmNav.destroy(); } catch(_) {} _jmNav = null; }
  if(_cy) { _cy.destroy(); _cy = null; }
}

function _initFileResize() {
  const cyEl = document.getElementById('jm-cy');
  if(!cyEl) return;

  const handle = document.createElement('div');
  handle.id = 'jm-file-resize-handle';
  handle.style.cssText = 'position:absolute;width:10px;height:10px;background:#4a90d9;border-radius:2px;cursor:se-resize;z-index:20;display:none;box-shadow:0 0 3px rgba(0,0,0,.5);';
  cyEl.appendChild(handle);

  let _hoverNode = null;
  let _resizing = false;

  const updatePos = () => {
    if(!_hoverNode || !_hoverNode.length) { handle.style.display = 'none'; return; }
    const bb = _hoverNode.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
    handle.style.left = (bb.x2 - 6) + 'px';
    handle.style.top  = (bb.y2 - 6) + 'px';
    handle.style.display = 'block';
  };

  _cy.on('mouseover', 'node[type="file"]', e => {
    _hoverNode = e.target;
    updatePos();
  });
  _cy.on('mouseout', 'node[type="file"]', () => {
    if(!_resizing) { _hoverNode = null; handle.style.display = 'none'; }
  });
  _cy.on('zoom pan', updatePos);

  handle.addEventListener('mouseleave', () => {
    if(!_resizing) { _hoverNode = null; handle.style.display = 'none'; }
  });

  handle.addEventListener('mousedown', e => {
    if(!_hoverNode) return;
    e.preventDefault(); e.stopPropagation();
    _resizing = true;

    const fileNode = _hoverNode;
    const bb = fileNode.boundingBox();
    const anchorX = bb.x1, anchorY = bb.y1;
    const origW = bb.w, origH = bb.h;
    const children = fileNode.children().map(n => ({
      node: n,
      rx: origW > 1 ? (n.position().x - anchorX) / origW : 0.5,
      ry: origH > 1 ? (n.position().y - anchorY) / origH : 0.5,
    }));
    const startX = e.clientX, startY = e.clientY;

    const onMove = e => {
      const dx = (e.clientX - startX) / _cy.zoom();
      const dy = (e.clientY - startY) / _cy.zoom();
      const newW = Math.max(60, origW + dx);
      const newH = Math.max(40, origH + dy);
      children.forEach(({ node, rx, ry }) => {
        node.position({ x: anchorX + rx * newW, y: anchorY + ry * newH });
      });
      updatePos();
    };
    const onUp = () => {
      _resizing = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      updatePos();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function _jmExportDrawio() {
  if(!_cy || !_jmElements.nodes.length) return;

  const cellId = id => 'n_' + id.replace(/[^a-zA-Z0-9]/g, '_');
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  // projectRoot相対パスに変換
  const root = (typeof projectRoot !== 'undefined' ? projectRoot : '').replace(/\\/g, '/').replace(/\/$/, '');
  const relPath = f => {
    const fp = (f || '').replace(/\\/g, '/');
    return (root && fp.startsWith(root + '/')) ? fp.slice(root.length + 1) : fp;
  };

  const kindStroke = { define:'#d9a040', struct:'#4ad990', union:'#4ad990', enum:'#40d9b8', enum_member:'#40d9b8', typedef:'#a060d9' };

  let cells = '<mxCell id="0"/><mxCell id="1" parent="0"/>';

  // ノード
  for(const n of _jmElements.nodes) {
    const cy_n = _cy.getElementById(n.data.id);
    if(!cy_n || !cy_n.length) continue;
    const pos = cy_n.position();

    let lbl, w, h, x, y, style;

    if(n.data.type === 'folder') {
      lbl = esc(relPath(n.data.label));
      w = Math.max(160, lbl.length * 7 + 24); h = 30;
      x = Math.round(pos.x - w / 2); y = Math.round(pos.y - h / 2);
      style = 'rounded=1;fillColor=#0d1820;strokeColor=#2a5080;fontColor=#aaaaaa;fontSize=10;fontFamily=Courier New;align=left;spacingLeft=8;';
    } else if(n.data.type === 'file') {
      lbl = esc(relPath(n.data.file));
      const fbb = cy_n.boundingBox({ includeLabels: true, includeOverlays: false });
      const pad = 8;
      x = Math.round(fbb.x1 - pad); y = Math.round(fbb.y1 - pad);
      w = Math.round(fbb.w + pad * 2); h = Math.round(fbb.h + pad * 2);
      style = 'rounded=1;fillColor=#1e2a35;strokeColor=#4a90d9;fontColor=#aaaaaa;fontSize=10;fontFamily=Courier New;align=left;spacingLeft=8;verticalAlign=top;spacingTop=4;';
    } else {
      lbl = esc(n.data.label);
      w = cy_n.width(); h = cy_n.height();
      x = Math.round(pos.x - w / 2); y = Math.round(pos.y - h / 2);
      const stroke = kindStroke[n.data.kind] || '#4a90d9';
      style = `ellipse;fillColor=#2d4a6a;strokeColor=${stroke};fontColor=#cccccc;fontSize=9;fontFamily=Courier New;labelPosition=right;verticalLabelPosition=middle;align=left;verticalAlign=middle;`;
    }
    cells += `<mxCell id="${cellId(n.data.id)}" value="${lbl}" style="${style}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${Math.round(w)}" height="${Math.round(h)}" as="geometry"/></mxCell>`;
  }

  // エッジ
  const edgeStyle = 'edgeStyle=orthogonalEdgeStyle;rounded=1;strokeColor=#4a90d9;exitX=0.5;exitY=1;entryX=0.5;entryY=0;';
  let edgeIdx = 0;
  for(const e of _jmElements.edges) {
    cells += `<mxCell id="e${edgeIdx++}" value="" style="${edgeStyle}" edge="1" source="${cellId(e.data.source)}" target="${cellId(e.data.target)}" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>`;
  }

  const xml = `<mxGraphModel><root>${cells}</root></mxGraphModel>`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([xml], {type: 'application/xml'}));
  a.download = 'jump-map.drawio';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ----- init -----
document.addEventListener('DOMContentLoaded', () => {
  document.body.insertAdjacentHTML('beforeend', `
    <div id="jm-panel">
      <div id="jm-resizer"></div>
      <div id="jm-header">
        <span>Jump Map</span>
        <button id="jm-close">×</button>
      </div>
      <div id="jm-toolbar">
        <button id="jm-rec" class="sec" title="ジャンプ追跡の開始/停止">● REC</button>
        <button id="jm-peek-toggle" class="sec" title="ホバープレビューの表示/非表示">Preview</button>
        <button id="jm-edge-mode" class="sec" title="エッジ描画モード">線引き</button>
        <button id="jm-folder-view" class="sec" title="ファイル単位/フォルダ単位 切り替え">フォルダ</button>
        <button id="jm-fit"   class="sec" title="全体表示">Fit</button>
        <button id="jm-color" class="sec" title="ノード色切り替え: 鮮→淡→暗">${JM_COLOR_LABELS[_jmColorPreset]}</button>
        <span style="width:1px;background:#444;align-self:stretch;margin:2px 2px"></span>
        <button id="jm-clear" class="sec" title="クリア">Clear</button>
      </div>
      <div id="jm-export-bar" style="display:flex;align-items:center;gap:4px;padding:2px 8px;border-bottom:1px solid #222;background:#161616;flex-shrink:0">
        <span style="color:#555;font-size:10px;flex-shrink:0">Export:</span>
        <button id="jm-drawio" class="sec" title="draw.io 形式でエクスポート" style="font-size:10px;padding:1px 6px;">draw.io</button>
      </div>
      <div id="jm-status" style="color:#888;font-size:11px;padding:4px 12px;flex-shrink:0"></div>
      <div id="jm-cy" style="flex:1;min-height:0;position:relative"></div>
      <div id="jm-preview-resizer"></div>
      <div id="jm-preview"></div>
    </div>
  `);

  const addonBar = document.getElementById('addon-buttons');
  if(addonBar) {
    const btn = document.createElement('button');
    btn.id = 'btn-jump-map'; btn.className = 'sec';
    btn.textContent = 'jm'; btn.title = 'Jump Map';
    addonBar.appendChild(btn);
    btn.onclick = async () => {
      const panel = document.getElementById('jm-panel');
      const isOpen = panel.classList.contains('open');
      panel.classList.toggle('open', !isOpen);
      if(!isOpen) {
        await _jmInitCy();
        // 蓄積済みのデータを再投入
        if(_cy && _jmElements.nodes.length && _cy.nodes().length === 0) {
          _jmRebuildView();
        }
      }
    };
  }

  document.getElementById('jm-close').onclick = () =>
    document.getElementById('jm-panel').classList.remove('open');
  document.getElementById('jm-drawio').onclick = _jmExportDrawio;
  document.getElementById('jm-clear').onclick = _jmClear;
  document.getElementById('jm-peek-toggle').onclick = function() {
    _previewEnabled = !_previewEnabled;
    this.classList.toggle('on', _previewEnabled);
    if(!_previewEnabled) _jmClosePreview();
  };
  document.getElementById('jm-rec').onclick = function() {
    _tracking = !_tracking;
    this.classList.toggle('rec-on', _tracking);
    if(!_tracking) _jmLastSymId = null; // 追跡停止時はチェーンをリセット
  };
  document.getElementById('jm-fit').onclick = () => { if(_cy) _cy.fit(JM_FIT_PADDING); };
  document.getElementById('jm-color').onclick = function() {
    const idx = JM_COLOR_PRESET_ORDER.indexOf(_jmColorPreset);
    _jmApplyColorPreset(JM_COLOR_PRESET_ORDER[(idx + 1) % JM_COLOR_PRESET_ORDER.length]);
  };

  document.getElementById('jm-folder-view').onclick = function() {
    _folderView = !_folderView;
    this.classList.toggle('on', _folderView);
    this.title = _folderView
      ? 'フォルダ単位表示 — クリックでファイル単位に切り替え'
      : 'ファイル単位表示 — クリックでフォルダ単位に切り替え';
    _jmRebuildView(true);
  };

  document.getElementById('jm-edge-mode').onclick = function() {
    _edgeDrawing = !_edgeDrawing;
    this.classList.toggle('on', _edgeDrawing);
    if(_edgeDrawing) {
      _jmSetStatus('接続元のノードをクリック');
    } else {
      if(_cy) _cy.$('.draw-src').removeClass('draw-src');
      _jmSetStatus('');
    }
  };

  // プレビュー高さリサイズ
  const previewResizer = document.getElementById('jm-preview-resizer');
  const preview = document.getElementById('jm-preview');
  previewResizer.addEventListener('mousedown', e => {
    e.preventDefault();
    preview.style.transition = 'none';
    const startY = e.clientY, startH = preview.offsetHeight;
    const onMove = e => {
      preview.style.height = Math.max(JM_PREVIEW_MIN_H, Math.min(JM_PREVIEW_MAX_H, startH + startY - e.clientY)) + 'px';
    };
    const onUp = () => {
      preview.style.transition = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // リサイズ
  const resizer = document.getElementById('jm-resizer');
  const panel   = document.getElementById('jm-panel');
  resizer.addEventListener('mousedown', e => {
    e.preventDefault();
    const startX = e.clientX, startW = panel.offsetWidth;
    const onMove = e => {
      panel.style.width = Math.max(JM_PANEL_MIN_W, Math.min(window.innerWidth - 100, startW + startX - e.clientX)) + 'px';
      if(_cy) _cy.resize();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if(_cy) _cy.fit(JM_FIT_PADDING);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
});

})();
