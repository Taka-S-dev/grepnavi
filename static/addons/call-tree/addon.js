// ===== Call Tree Addon =====
// 関数のコールツリー（callers / callees）を専用パネルで表示する。

(function() {

// ----- state -----
let _ctMode = 'callers'; // 'callers' | 'callees'
let _ctRootFunc = '';
let _ctTree = null; // ルートノード（現在のモード）
let _ctTrees = { callers: null, callees: null }; // タブごとにツリー状態を保持
let _ctAbort = null; // 進行中の検索キャンセル用

// ノード形状:
// { func, file, line, callLine, children: null|[], expanded: bool, loading: bool }

// ----- init -----
document.addEventListener('DOMContentLoaded', () => {
  // HTML injection - 右端からスライドインするサイドバー
  document.body.insertAdjacentHTML('beforeend', `
    <div id="ct-sidebar">
      <div id="ct-resizer"></div>
      <div id="ct-header">
        <span>Call Tree</span>
        <button id="ct-close">×</button>
      </div>
      <div id="ct-search-row">
        <input id="ct-input" type="text" placeholder="関数名を入力..." spellcheck="false" autocomplete="off">
        <button id="ct-go">検索</button>
      </div>
      <div id="ct-tabs">
        <button class="ct-tab active" data-mode="callers">Callers</button>
        <button class="ct-tab" data-mode="callees">Callees</button>
        <span id="ct-engine-label"></span>
      </div>
      <div id="ct-body"></div>
    </div>
  `);

  // ボタンを #addon-buttons に追加
  const addonBar = document.getElementById('addon-buttons');
  if (addonBar) {
    const btn = document.createElement('button');
    btn.id = 'btn-call-tree';
    btn.className = 'sec';
    btn.textContent = 'ct';
    btn.title = 'Call Tree (Ctrl+Shift+T)';
    addonBar.appendChild(btn);
    btn.onclick = () => openCallTree();
  }

  // リサイズハンドル
  const resizer = document.getElementById('ct-resizer');
  const sidebar = document.getElementById('ct-sidebar');
  resizer.addEventListener('mousedown', e => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebar.offsetWidth;
    const onMove = e => {
      const w = Math.max(200, Math.min(800, startW + startX - e.clientX));
      sidebar.style.width = w + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // events
  document.getElementById('ct-close').onclick = closeCallTree;
  document.getElementById('ct-go').onclick = ctSearch;
  document.getElementById('ct-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') ctSearch();
    if (e.key === 'Escape') {
      const input = document.getElementById('ct-input');
      if (input.value.trim() || _ctRootFunc) {
        // 入力あり or 結果表示中 → クリア
        input.value = '';
        _ctRootFunc = '';
        _ctTree = null;
        _ctTrees.callers = null;
        _ctTrees.callees = null;
        document.getElementById('ct-body').innerHTML = '';
      } else {
        closeCallTree();
      }
    }
  });
  document.querySelectorAll('.ct-tab').forEach(tab => {
    tab.onclick = () => {
      _ctMode = tab.dataset.mode;
      document.querySelectorAll('.ct-tab').forEach(t => t.classList.toggle('active', t === tab));
      updateCtEngineLabel(_ctMode);
      if (_ctRootFunc) {
        // 同じルート関数のツリーが保持済みなら再検索せず表示を切り替えるだけ
        const cached = _ctTrees[_ctMode];
        if (cached && cached.func === _ctRootFunc) {
          _ctTree = cached;
          ctRender();
        } else {
          ctSearch();
        }
      }
    };
  });

  // キーボードショートカット
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'T') {
      e.preventDefault();
      openCallTree();
    }
    // コールツリーがアクティブな状態で Esc → 入力欄にフォーカスして結果クリア
    if (e.key === 'Escape' && document.getElementById('ct-sidebar').classList.contains('open')) {
      const input = document.getElementById('ct-input');
      // 入力欄以外にフォーカスがある場合は入力欄にフォーカスするだけ
      if (document.activeElement !== input) {
        e.preventDefault();
        input.focus();
        input.select();
        return;
      }
    }
  });

  // パネルモード登録
  if(typeof registerPanel === 'function') {
    registerPanel({
      id: 'calltree',
      label: 'コールツリー',
      containerId: 'ct-sidebar',
      onOpen: openCallTree,
    });
  }
});

function updateCtEngineLabel(mode) {
  const label = document.getElementById('ct-engine-label');
  if (!label) return;
  const useGtags = mode === 'callers' && typeof gtagsEnabled === 'function' && gtagsEnabled();
  label.textContent = useGtags ? 'GNU Global' : 'ripgrep';
}

// ----- open / close -----
function openCallTree(funcName) {
  document.getElementById('ct-sidebar').classList.add('open');
  if (funcName) {
    document.getElementById('ct-input').value = funcName;
    _ctRootFunc = funcName;
    ctSearch();
  } else {
    document.getElementById('ct-input').focus();
  }
}

function closeCallTree() {
  document.getElementById('ct-sidebar').classList.remove('open');
}

// ホバーパネルなど外部から呼び出せるよう公開
window.openCallTree = openCallTree;

// ----- search -----
async function ctSearch() {
  const input = document.getElementById('ct-input');
  const word = input.value.trim();
  if (!word) return;
  // ルート関数が変わったときは両タブのキャッシュをリセット
  if (word !== _ctRootFunc) {
    _ctTrees.callers = null;
    _ctTrees.callees = null;
  }
  _ctRootFunc = word;

  // 前回の検索を中断
  if (_ctAbort) _ctAbort.abort();
  _ctAbort = new AbortController();
  const signal = _ctAbort.signal;

  const body = document.getElementById('ct-body');
  body.innerHTML = '<div class="ct-empty">検索中...</div>';

  const dir  = (document.getElementById('dir')  || {}).value || '';
  const glob = (document.getElementById('glob') || {}).value || '';

  const useGtags = typeof gtagsEnabled === 'function' && gtagsEnabled();
  updateCtEngineLabel(_ctMode);

  try {
    if (_ctMode === 'callers') {
      const params = new URLSearchParams({ word });
      if (dir)  params.set('dir', dir);
      if (glob) params.set('glob', glob);
      if (!useGtags) params.set('gtags', '0');
      const res = await fetch('/api/callers?' + params, { signal });
      if (!res.ok) { body.innerHTML = '<div class="ct-empty">エラー</div>'; return; }
      const hits = await res.json();

      if (!hits.length) {
        body.innerHTML = `<div class="ct-empty">${escHtml(word)} を呼び出す関数が見つかりません</div>`;
        return;
      }
      _ctTree = {
        func: word, file: '', line: 0,
        children: hits.map(h => ({ func: h.func, file: h.file, line: h.line, callLine: h.call_line, children: null, expanded: false })),
        expanded: true,
      };
      _ctTrees.callers = _ctTree;
    } else {
      // callees: ripgrep固定（updateCtEngineLabel は ctSearch 冒頭で呼び済み）
      // まず定義を探して file:line を取得
      const hoverParams = new URLSearchParams({ word });
      if (dir) hoverParams.set('dir', dir);
      const hRes = await fetch('/api/hover?' + hoverParams, { signal });
      let defFile = '', defLine = 0;
      if (hRes.ok) {
        const hHits = await hRes.json();
        const funcHit = hHits.find(h => h.kind === 'func' && !h.decl) || hHits.find(h => h.kind === 'func');
        if (funcHit) { defFile = funcHit.file; defLine = funcHit.line; }
      }
      if (!defFile) {
        body.innerHTML = `<div class="ct-empty">${escHtml(word)} の定義が見つかりません</div>`;
        return;
      }
      const calleeParams = new URLSearchParams({ file: defFile, line: defLine });
      const cRes = await fetch('/api/callees?' + calleeParams, { signal });
      if (!cRes.ok) { body.innerHTML = '<div class="ct-empty">エラー</div>'; return; }
      const names = await cRes.json();

      if (!names.length) {
        body.innerHTML = `<div class="ct-empty">${escHtml(word)} が呼び出す関数が見つかりません</div>`;
        return;
      }
      _ctTree = {
        func: word, file: defFile, line: defLine,
        children: names.filter(n => n !== word).map(n => ({ func: n, file: '', line: 0, callLine: 0, children: null, expanded: false })),
        expanded: true,
      };
      _ctTrees.callees = _ctTree;
    }
  } catch(e) {
    if (e.name === 'AbortError') return; // 新しい検索に切り替わった
    body.innerHTML = '<div class="ct-empty">エラー</div>';
    return;
  }

  ctRender();
}

// ----- render -----
function ctRender() {
  const body = document.getElementById('ct-body');
  body.innerHTML = '';
  if (!_ctTree) return;

  // ガイド線ハイライト用オーバーレイ
  const guideHL = document.createElement('div');
  guideHL.id = 'ct-guide-highlight';
  body.appendChild(guideHL);
  body.addEventListener('mouseover', e => {
    const node = e.target.closest('.ct-node');
    if (!node) { guideHL.style.display = 'none'; return; }
    const depth = parseInt(node.dataset.depth || '0');
    if (depth === 0) { guideHL.style.display = 'none'; return; }

    // 同じ深さの兄弟グループの範囲だけハイライト（親で打ち止め）
    const allNodes = Array.from(body.querySelectorAll('.ct-node'));
    const idx = allNodes.indexOf(node);
    let topNode = node, bottomIdx = idx;
    for (let i = idx - 1; i >= 0; i--) {
      const d = parseInt(allNodes[i].dataset.depth || '0');
      if (d < depth) break;
      if (d === depth) topNode = allNodes[i];
    }
    for (let i = idx + 1; i < allNodes.length; i++) {
      const d = parseInt(allNodes[i].dataset.depth || '0');
      if (d < depth) break;
      bottomIdx = i;
    }
    const bottomNode = allNodes[bottomIdx];
    const bodyRect = body.getBoundingClientRect();
    const topPx    = topNode.getBoundingClientRect().top    - bodyRect.top + body.scrollTop;
    const botPx    = bottomNode.getBoundingClientRect().bottom - bodyRect.top + body.scrollTop;

    guideHL.style.left   = ((depth - 1) * 16 + 15 + 8) + 'px';
    guideHL.style.top    = topPx + 'px';
    guideHL.style.height = (botPx - topPx) + 'px';
    guideHL.style.display = 'block';
  });
  body.addEventListener('mouseleave', () => { guideHL.style.display = 'none'; });

  // root label
  const rootEl = document.createElement('div');
  rootEl.className = 'ct-node';
  rootEl.innerHTML = `<span style="color:#888;font-size:11px;">▼</span> <span class="ct-func">${escHtml(_ctTree.func)}</span>`;
  rootEl.querySelector('.ct-func').onclick = () => ctJumpToFunc(_ctTree);
  body.appendChild(rootEl);

  renderChildren(body, _ctTree, 1, new Set([_ctTree.func]));
}

function renderChildren(container, node, depth, ancestors) {
  if (!node.children) return;
  const shown = node.children.slice(0, 100);
  for (const child of shown) {
    const isCycle = ancestors.has(child.func);
    container.appendChild(makeNodeEl(child, depth, isCycle));
    if (!isCycle && child.expanded && child.children) {
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(child.func);
      renderChildren(container, child, depth + 1, nextAncestors);
    }
  }
  if (node.children.length > 100) {
    const more = document.createElement('div');
    more.className = 'ct-more';
    more.textContent = `... 他 ${node.children.length - 100} 件`;
    container.appendChild(more);
  }
}

function makeNodeEl(node, depth, isCycle = false) {
  const el = document.createElement('div');
  el.className = 'ct-node';
  el.dataset.depth = depth;

  // indent
  const indent = document.createElement('span');
  indent.className = 'ct-indent';
  indent.style.width = (depth * 16) + 'px';

  // expander
  const exp = document.createElement('span');
  exp.className = 'ct-expander';
  if (isCycle) {
    exp.textContent = '↻';
    exp.style.color = '#c08040';
  } else {
    exp.textContent = node.expanded ? '▼' : '▶';
    if (node.loading) { exp.textContent = '…'; exp.classList.add('loading'); }
    exp.onclick = () => ctToggle(node, el);
  }

  // func name
  const fn = document.createElement('span');
  fn.className = _ctMode === 'callers' ? 'ct-func' : 'ct-callee-name';
  fn.textContent = node.func;
  if (isCycle) fn.style.opacity = '0.5';
  else fn.onclick = () => ctJumpToFunc(node);

  // location
  const loc = document.createElement('span');
  loc.className = 'ct-loc';
  if (node.file) {
    const displayFile = shortFilePath(node.file);
    const jumpLine = _ctMode === 'callers' ? (node.callLine || node.line) : node.line;
    loc.textContent = `${displayFile}:${jumpLine}`;
    loc.onclick = () => ctJumpToLine(node.file, jumpLine);
  }

  el.appendChild(indent);
  el.appendChild(exp);
  el.appendChild(fn);
  if (node.file) el.appendChild(loc);
  return el;
}

// ----- expand/collapse -----
async function ctToggle(node, el) {
  if (node.expanded) {
    node.expanded = false;
    ctRender();
    return;
  }
  if (node.children !== null) {
    node.expanded = true;
    ctRender();
    return;
  }

  // load children
  node.loading = true;
  ctRender();

  const dir  = (document.getElementById('dir')  || {}).value || '';
  const glob = (document.getElementById('glob') || {}).value || '';

  if (_ctMode === 'callers') {
    const params = new URLSearchParams({ word: node.func });
    if (dir)  params.set('dir', dir);
    if (glob) params.set('glob', glob);
    if (typeof gtagsEnabled === 'function' && !gtagsEnabled()) params.set('gtags', '0');
    const res = await fetch('/api/callers?' + params).catch(() => null);
    if (res && res.ok) {
      const hits = await res.json();
      node.children = hits.map(h => ({ func: h.func, file: h.file, line: h.line, callLine: h.call_line, children: null, expanded: false, _callerCached: true }));
    } else {
      node.children = [];
    }
  } else {
    // callees: まず定義を取得
    if (!node.file) {
      const hoverParams = new URLSearchParams({ word: node.func });
      if (dir) hoverParams.set('dir', dir);
      const hRes = await fetch('/api/hover?' + hoverParams).catch(() => null);
      if (hRes && hRes.ok) {
        const hHits = await hRes.json();
        const funcHit = hHits.find(h => h.kind === 'func' && !h.decl) || hHits.find(h => h.kind === 'func');
        const anyHit = funcHit || hHits[0];
        // 表示用（定義場所）はどの種別でもセット
        if (anyHit) { node.file = anyHit.file; node.line = anyHit.line; }
        // ジャンプ用: decl:false（実装）が見つかった場合だけ _defFile/_defLine にキャッシュ
        // decl しか見つからない場合はキャッシュしない（ctJumpToFunc で hover API を再呼び出し）
        const defHit = hHits.find(h => h.kind === 'func' && !h.decl);
        if (defHit) { node._defFile = defHit.file; node._defLine = defHit.line; }
        // callees API は関数本体が必要なので func のみ使用
        node._funcFile = funcHit ? funcHit.file : '';
        node._funcLine = funcHit ? funcHit.line : 0;
      }
    }
    if (node._funcFile && node._funcLine) {
      const params = new URLSearchParams({ file: node._funcFile, line: node._funcLine });
      const res = await fetch('/api/callees?' + params).catch(() => null);
      if (res && res.ok) {
        const names = await res.json();
        node.children = names.filter(n => n !== node.func).map(n => ({ func: n, file: '', line: 0, callLine: 0, children: null, expanded: false }));
      } else {
        node.children = [];
      }
    } else {
      node.children = [];
    }
  }

  node.loading = false;
  node.expanded = true;
  ctRender();
}

// ----- jump -----
function ctJumpToLine(file, line) {
  if (typeof openPeek === 'function') openPeek(file, line);
}

async function ctJumpToFunc(node) {
  // _defFile/_defLine: ctToggle で decl:false と確認済みの実装場所
  if (node._defFile && node._defLine) {
    ctJumpToLine(node._defFile, node._defLine);
    return;
  }
  // callers の子ノードは findContainingFunc が返した実装行をキャッシュ済みなのでそのまま使う
  // （callers では node.file/line は実装行が入る）
  if (node.file && node.line && node._callerCached) {
    ctJumpToLine(node.file, node.line);
    return;
  }
  // hover API で定義（decl:false 優先）を検索
  const dir = (document.getElementById('dir') || {}).value || '';
  const params = new URLSearchParams({ word: node.func });
  if (dir) params.set('dir', dir);
  const res = await fetch('/api/hover?' + params).catch(() => null);
  if (res && res.ok) {
    const hits = await res.json();
    const h = hits.find(h => h.kind === 'func' && !h.decl) || hits.find(h => h.kind === 'func') || hits[0];
    if (h) {
      node._defFile = h.file;
      node._defLine = h.line;
      ctJumpToLine(h.file, h.line);
      return;
    }
  }
  if (typeof st === 'function') st(`定義が見つかりません: ${node.func}`);
}

// ----- utils -----
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function shortFilePath(p) {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : parts[parts.length - 1];
}

// openPeek は core（editor.js）のグローバル関数を利用する

})();
