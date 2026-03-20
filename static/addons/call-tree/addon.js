// ===== Call Tree Addon =====
// 関数のコールツリー（callers / callees）を専用パネルで表示する。

(function() {

// ----- state -----
let _ctMode = 'callers'; // 'callers' | 'callees'
let _ctRootFunc = '';
let _ctTree = null; // ルートノード
let _ctAbort = null; // 進行中の検索キャンセル用

// ノード形状:
// { func, file, line, callLine, children: null|[], expanded: bool, loading: bool }

// ----- init -----
document.addEventListener('DOMContentLoaded', () => {
  // HTML injection - 右端からスライドインするサイドバー
  document.body.insertAdjacentHTML('beforeend', `
    <div id="ct-sidebar">
      <div id="ct-header">
        <span>Call Tree</span>
        <button id="ct-close">×</button>
      </div>
      <div id="ct-search-row">
        <input id="ct-input" type="text" placeholder="関数名を入力..." spellcheck="false">
        <button id="ct-go">検索</button>
      </div>
      <div id="ct-tabs">
        <button class="ct-tab active" data-mode="callers">Callers</button>
        <button class="ct-tab" data-mode="callees">Callees</button>
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

  // events
  document.getElementById('ct-close').onclick = closeCallTree;
  document.getElementById('ct-go').onclick = ctSearch;
  document.getElementById('ct-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') ctSearch();
    if (e.key === 'Escape') closeCallTree();
  });
  document.querySelectorAll('.ct-tab').forEach(tab => {
    tab.onclick = () => {
      _ctMode = tab.dataset.mode;
      document.querySelectorAll('.ct-tab').forEach(t => t.classList.toggle('active', t === tab));
      if (_ctRootFunc) ctSearch();
    };
  });

  // キーボードショートカット
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'T') {
      e.preventDefault();
      openCallTree();
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
  _ctRootFunc = word;

  // 前回の検索を中断
  if (_ctAbort) _ctAbort.abort();
  _ctAbort = new AbortController();
  const signal = _ctAbort.signal;

  const body = document.getElementById('ct-body');
  body.innerHTML = '<div class="ct-empty">検索中...</div>';

  const dir  = (document.getElementById('dir')  || {}).value || '';
  const glob = (document.getElementById('glob') || {}).value || '';

  try {
    if (_ctMode === 'callers') {
      const params = new URLSearchParams({ word });
      if (dir)  params.set('dir', dir);
      if (glob) params.set('glob', glob);
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
    } else {
      // callees: まず定義を探して file:line を取得
      const hoverParams = new URLSearchParams({ word });
      if (dir) hoverParams.set('dir', dir);
      const hRes = await fetch('/api/hover?' + hoverParams, { signal });
      let defFile = '', defLine = 0;
      if (hRes.ok) {
        const hHits = await hRes.json();
        const funcHit = hHits.find(h => h.kind === 'func');
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

  // root label
  const rootEl = document.createElement('div');
  rootEl.className = 'ct-node';
  rootEl.innerHTML = `<span style="color:#888;font-size:11px;">▼</span> <span class="ct-func">${escHtml(_ctTree.func)}</span>`;
  body.appendChild(rootEl);

  renderChildren(body, _ctTree, 1);
}

function renderChildren(container, node, depth) {
  if (!node.children) return;
  const shown = node.children.slice(0, 100);
  for (const child of shown) {
    container.appendChild(makeNodeEl(child, depth));
    if (child.expanded && child.children) {
      renderChildren(container, child, depth + 1);
    }
  }
  if (node.children.length > 100) {
    const more = document.createElement('div');
    more.className = 'ct-more';
    more.textContent = `... 他 ${node.children.length - 100} 件`;
    container.appendChild(more);
  }
}

function makeNodeEl(node, depth) {
  const el = document.createElement('div');
  el.className = 'ct-node';

  // indent
  const indent = document.createElement('span');
  indent.className = 'ct-indent';
  indent.style.width = (depth * 16) + 'px';

  // expander
  const exp = document.createElement('span');
  exp.className = 'ct-expander';
  exp.textContent = node.expanded ? '▼' : '▶';
  if (node.loading) { exp.textContent = '…'; exp.classList.add('loading'); }
  exp.onclick = () => ctToggle(node, el);

  // func name
  const fn = document.createElement('span');
  fn.className = _ctMode === 'callers' ? 'ct-func' : 'ct-callee-name';
  fn.textContent = node.func;
  fn.onclick = () => ctJumpToFunc(node);

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
    const res = await fetch('/api/callers?' + params).catch(() => null);
    if (res && res.ok) {
      const hits = await res.json();
      node.children = hits.map(h => ({ func: h.func, file: h.file, line: h.line, callLine: h.call_line, children: null, expanded: false }));
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
        const funcHit = hHits.find(h => h.kind === 'func');
        if (funcHit) { node.file = funcHit.file; node.line = funcHit.line; }
      }
    }
    if (node.file && node.line) {
      const params = new URLSearchParams({ file: node.file, line: node.line });
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
  if (node.file && node.line) {
    ctJumpToLine(node.file, node.line);
    return;
  }
  // 定義を検索（func → define の順で fallback）
  const dir = (document.getElementById('dir') || {}).value || '';
  const params = new URLSearchParams({ word: node.func });
  if (dir) params.set('dir', dir);
  const res = await fetch('/api/hover?' + params).catch(() => null);
  if (res && res.ok) {
    const hits = await res.json();
    const h = hits.find(h => h.kind === 'func') || hits[0];
    if (h) {
      node.file = h.file;
      node.line = h.line;
      ctJumpToLine(h.file, h.line);
      return;
    }
  }
  // 見つからない場合はステータスに表示
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
