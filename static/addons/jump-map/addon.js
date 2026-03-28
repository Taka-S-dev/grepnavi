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
           edge:'#4a90d9', curFileBorder:'#7ec8ff', curSymBg:'#1a6aaa', curSymBorder:'#7ec8ff' },
  muted: { fileBg:'#1e2830', fileBorder:'#5a7a9a', symBg:'#253545', symBorder:'#5a7a9a',
           edge:'#5a7a9a', curFileBorder:'#8ab0c8', curSymBg:'#2a4a5a', curSymBorder:'#8ab0c8' },
  dark:  { fileBg:'#1a1e22', fileBorder:'#3a4a55', symBg:'#1e2830', symBorder:'#3a4a55',
           edge:'#3a4a55', curFileBorder:'#5a7080', curSymBg:'#1e3040', curSymBorder:'#5a7080' },
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
    .selector('node[type="file"]').style({'background-color': c.fileBg, 'border-color': c.fileBorder})
    .selector('node[type="file"].current-file').style({'border-color': c.curFileBorder})
    .selector('node[type="sym"]').style({'background-color': c.symBg, 'border-color': c.symBorder})
    .selector('node[type="sym"].current').style({'background-color': c.curSymBg, 'border-color': c.curSymBorder})
    .selector('edge').style({'line-color': c.edge, 'target-arrow-color': c.edge})
    .update();
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
    if(_cy) _cy.add(n);
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

// 右クリックから手動追加（REC不要）
window.addToJumpMap = function(symbol, file, line) {
  _jmEnsureCy().then(() => {
    const fileNode = _jmGetOrCreateFile(file);
    const symNode  = _jmGetOrCreateSym(fileNode, symbol, line);
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
      {
        selector: 'node:selected',
        style: { 'border-color': '#ffaa00', 'border-width': 2.5 }
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
        style: { 'line-color': '#ffaa00', 'target-arrow-color': '#ffaa00', 'opacity': 1 }
      },
    ],
    layout: { name: 'preset' },
    userZoomingEnabled: true,
    userPanningEnabled: true,
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

  // ズーム変更時に入力欄を同期
  _cy.on('zoom', () => {
    const el = document.getElementById('jm-zoom-val');
    if(el) el.value = Math.round(_cy.zoom() * 100);
  });

  // 保存済み色プリセットを適用
  if(_jmColorPreset !== 'vivid') _jmApplyColorPreset(_jmColorPreset);

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
  _cy.layout({
    name: 'breadthfirst',
    animate: false,
    fit: true,
    padding: JM_FIT_PADDING,
    spacingFactor: 1.0,
    nodeDimensionsIncludeLabels: true,
  }).run();
  setTimeout(() => {
    if(!_cy) return;
    if(_cy.zoom() > JM_MAX_ZOOM) _cy.zoom({ level: JM_MAX_ZOOM, renderedPosition: { x: _cy.width()/2, y: _cy.height()/2 } });
  }, 50);
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
  if(_cy) { _cy.destroy(); _cy = null; }
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
        <button id="jm-fit"   class="sec" title="全体表示">Fit</button>
        <span id="jm-zoom-wrap" style="display:inline-flex;align-items:center;gap:2px">
          <button id="jm-zoom-out" class="sec" title="縮小 (−5%)">−</button>
          <input id="jm-zoom-val" type="number" min="10" max="500" step="5" value="100" title="ズーム率(%)" style="width:46px;text-align:center;background:#2a2a2a;border:1px solid #444;color:#ccc;font-size:11px;padding:1px 2px;border-radius:3px">
          <button id="jm-zoom-in"  class="sec" title="拡大 (+5%)">+</button>
        </span>
        <button id="jm-color" class="sec" title="ノード色切り替え: 鮮→淡→暗">${JM_COLOR_LABELS[_jmColorPreset]}</button>
        <button id="jm-clear" class="sec" title="クリア">Clear</button>
      </div>
      <div id="jm-status" style="color:#888;font-size:11px;padding:4px 12px;flex-shrink:0"></div>
      <div id="jm-cy" style="flex:1;min-height:0"></div>
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
          _cy.add([..._jmElements.nodes, ..._jmElements.edges]);
          _jmRelayout();
        }
      }
    };
  }

  document.getElementById('jm-close').onclick = () =>
    document.getElementById('jm-panel').classList.remove('open');
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
  document.getElementById('jm-fit').onclick = () => { if(_cy) { _cy.fit(JM_FIT_PADDING); _jmSyncZoomVal(); } };

  function _jmSyncZoomVal() {
    const el = document.getElementById('jm-zoom-val');
    if(el && _cy) el.value = Math.round(_cy.zoom() * 100);
  }
  function _jmSetZoom(pct) {
    if(!_cy) return;
    const level = Math.max(0.1, Math.min(5, pct / 100));
    _cy.zoom({ level, renderedPosition: { x: _cy.width() / 2, y: _cy.height() / 2 } });
    _jmSyncZoomVal();
  }
  document.getElementById('jm-zoom-out').onclick = () => { if(_cy) _jmSetZoom(Math.round(_cy.zoom() * 100) - 5); };
  document.getElementById('jm-zoom-in' ).onclick = () => { if(_cy) _jmSetZoom(Math.round(_cy.zoom() * 100) + 5); };
  document.getElementById('jm-zoom-val').addEventListener('change', e => _jmSetZoom(Number(e.target.value)));
  document.getElementById('jm-zoom-val').addEventListener('keydown', e => {
    if(e.key === 'ArrowUp')   { e.preventDefault(); _jmSetZoom(Number(e.target.value) + 5); }
    if(e.key === 'ArrowDown') { e.preventDefault(); _jmSetZoom(Number(e.target.value) - 5); }
  });
  document.getElementById('jm-color').onclick = function() {
    const idx = JM_COLOR_PRESET_ORDER.indexOf(_jmColorPreset);
    _jmApplyColorPreset(JM_COLOR_PRESET_ORDER[(idx + 1) % JM_COLOR_PRESET_ORDER.length]);
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
