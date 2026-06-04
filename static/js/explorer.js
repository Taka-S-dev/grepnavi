// ===== File Explorer =====

(function() {

const ITEM_H = 22;  // ツリー行の高さ
const FLAT_H = 20;  // フィルタ結果行の高さ（1行表示）

let _files    = null;
let _tree     = null;
let _expanded = new Set();
let _query    = '';
let _selPath  = '';
let _selIdx   = -1;   // キーボード選択インデックス（フィルタ時）
let _scrollEl = null;
let _allItems = [];
let _filtered  = false; // フィルタ中かどうか
let _rendering = false; // 再入防止

// ---- tree building ----

function buildTree(files) {
  const root = { children: {}, files: [] };
  for (const abs of files) insertFileIntoTree(root, abs);
  return root;
}

function insertFileIntoTree(tree, abs) {
  const base = (projectRoot || '').replace(/\\/g, '/').replace(/\/$/, '');
  const rel = abs.replace(/\\/g, '/');
  const stripped = base && rel.startsWith(base + '/') ? rel.slice(base.length + 1) : rel;
  const parts = stripped.split('/').filter(Boolean);
  if (parts.length === 0) return;
  let node = tree;
  for (let i = 0; i < parts.length - 1; i++) {
    const d = parts[i];
    if (!node.children[d]) {
      node.children[d] = { children: {}, files: [], dirPath: parts.slice(0, i + 1).join('/') };
    }
    node = node.children[d];
  }
  node.files.push({ name: parts[parts.length - 1], abs });
}

function collectItems(node, depth, items) {
  const dirs  = Object.keys(node.children).sort((a, b) => a.localeCompare(b));
  const files = node.files.slice().sort((a, b) => a.name.localeCompare(b.name));
  for (const d of dirs) {
    const child = node.children[d];
    const expanded = _expanded.has(child.dirPath);
    items.push({ type: 'dir', name: d, dirPath: child.dirPath, depth, expanded });
    if (expanded) collectItems(child, depth + 1, items);
  }
  for (const f of files) {
    items.push({ type: 'file', name: f.name, abs: f.abs, depth });
  }
}

// ---- substring filter ----

function exFilter(files, query) {
  if (!query.trim()) return [];
  const base   = (projectRoot || '').replace(/\\/g, '/').replace(/\/$/, '');
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const results = [];

  for (const abs of files) {
    const rel      = abs.replace(/\\/g, '/');
    const stripped = base && rel.startsWith(base + '/') ? rel.slice(base.length + 1) : rel;
    const slashIdx = stripped.lastIndexOf('/');
    const name     = stripped.slice(slashIdx + 1).toLowerCase();
    const dir      = slashIdx >= 0 ? stripped.slice(0, slashIdx + 1).toLowerCase() : '';
    const full     = stripped.toLowerCase();

    let totalScore = 0;
    let ok = true;
    const allPos = new Set();

    for (const t of tokens) {
      // ファイル名で部分一致 → 高スコア
      const ni = name.indexOf(t);
      if (ni >= 0) {
        totalScore += t.length * 3 + 100;
        for (let k = 0; k < t.length; k++) allPos.add(dir.length + ni + k);
        continue;
      }
      // フルパスで部分一致
      const pi = full.indexOf(t);
      if (pi >= 0) {
        totalScore += t.length;
        for (let k = 0; k < t.length; k++) allPos.add(pi + k);
        continue;
      }
      ok = false; break;
    }
    if (ok) results.push({ abs, score: totalScore, positions: allPos });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 300);
}

function highlightByPos(str, positions, offset) {
  return [...str].map((c, i) =>
    positions.has(offset + i) ? `<span class="ex-hl">${escHtml(c)}</span>` : escHtml(c)
  ).join('');
}

function absToRel(abs) {
  const base = (projectRoot || '').replace(/\\/g, '/').replace(/\/$/, '');
  const rel = abs.replace(/\\/g, '/');
  return base && rel.startsWith(base + '/') ? rel.slice(base.length + 1) : rel;
}

// ---- render ----

function render() {
  if (!_scrollEl) return;
  if (_query.trim()) {
    renderFiltered();
  } else {
    _filtered = false;
    renderTree();
  }
}

function renderFiltered() {
  _filtered = true;
  const matched = exFilter(_files || [], _query);
  _allItems = matched.map(r => ({ type: 'file-flat', abs: r.abs, positions: r.positions }));
  if (_selIdx >= _allItems.length) _selIdx = _allItems.length - 1;
  renderVirtual();
}

function renderTree() {
  _allItems = [];
  if (_tree) collectItems(_tree, 0, _allItems);
  renderVirtual();
}

function rowH() { return _filtered ? FLAT_H : ITEM_H; }

function updateRootName() {
  const el = document.getElementById('explorer-root-name');
  if (!el) return;
  const root = (projectRoot || '').replace(/\\/g, '/').replace(/\/$/, '');
  el.textContent = (root.split('/').pop() || 'EXPLORER').toUpperCase();
}

function updateStickyFolder() {
  const stickyEl = document.getElementById('explorer-sticky-folder');
  if (!stickyEl) return;
  if (_filtered || _scrollEl.scrollTop <= 0) { stickyEl.style.display = 'none'; return; }

  const firstIdx = Math.floor(_scrollEl.scrollTop / ITEM_H);
  const firstItem = _allItems[firstIdx];
  if (!firstItem || firstItem.depth === 0) { stickyEl.style.display = 'none'; return; }

  // 先頭可視アイテムの直接親フォルダを後ろ向きに探す
  const parentDepth = firstItem.depth - 1;
  let stickyDir = null;
  for (let i = firstIdx - 1; i >= 0; i--) {
    const item = _allItems[i];
    if (item && item.type === 'dir' && item.depth === parentDepth) { stickyDir = item; break; }
  }
  if (!stickyDir) { stickyEl.style.display = 'none'; return; }

  stickyEl.style.display = 'flex';
  stickyEl.innerHTML =
    `<span style="width:${4 + parentDepth * INDENT}px;flex-shrink:0"></span>` +
    dirIconOpen(stickyDir.name) +
    `<span>${escHtml(stickyDir.name)}</span>`;
  stickyEl.onclick = () => {
    const idx = _allItems.indexOf(stickyDir);
    if (idx >= 0) _scrollEl.scrollTop = Math.max(0, idx * ITEM_H - 4);
  };
}

function renderVirtual() {
  if (_rendering) return;
  _rendering = true;
  const el  = _scrollEl;
  const rh  = rowH();
  const totalH   = _allItems.length * rh;
  const scrollTop = el.scrollTop;
  const viewH    = el.clientHeight || 400;
  const startIdx = Math.max(0, Math.floor(scrollTop / rh) - 3);
  const endIdx   = Math.min(_allItems.length, Math.ceil((scrollTop + viewH) / rh) + 3);

  const frag = document.createDocumentFragment();
  const top = document.createElement('div');
  top.style.height = (startIdx * rh) + 'px';
  frag.appendChild(top);

  for (let i = startIdx; i < endIdx; i++) {
    frag.appendChild(makeItemEl(_allItems[i], i));
  }

  const bot = document.createElement('div');
  bot.style.height = Math.max(0, totalH - endIdx * rh) + 'px';
  frag.appendChild(bot);

  el.innerHTML = '';
  el.appendChild(frag);
  el.scrollTop = scrollTop;
  _rendering = false;
  updateStickyFolder();
}

function scrollSelIntoView() {
  if (_selIdx < 0) return;
  const rh = rowH();
  const top = _selIdx * rh;
  const bot = top + rh;
  const viewH = _scrollEl.clientHeight || 400;
  if (top < _scrollEl.scrollTop) {
    _scrollEl.scrollTop = top;
  } else if (bot > _scrollEl.scrollTop + viewH) {
    _scrollEl.scrollTop = bot - viewH;
  }
}

// ---- item element ----

const INDENT = 16;
const GUIDE_X = 8;

function addGuides(el, depth) {
  for (let d = 0; d < depth; d++) {
    const g = document.createElement('span');
    g.className = 'ex-guide';
    g.style.left = (GUIDE_X + d * INDENT) + 'px';
    el.appendChild(g);
  }
}

function makeItemEl(item, idx) {
  const el = document.createElement('div');

  if (item.type === 'dir') {
    el.style.height = ITEM_H + 'px';
    el.style.lineHeight = ITEM_H + 'px';
    el.className = 'ex-item ex-dir' + (item.expanded ? ' ex-open' : '');
    el.style.paddingLeft = (4 + item.depth * INDENT) + 'px';
    addGuides(el, item.depth);
    el.innerHTML +=
      `<span class="ex-arrow">&#x276F;</span>` +
      (item.expanded ? dirIconOpen(item.name) : dirIcon(item.name)) +
      `<span class="ex-name">${escHtml(item.name)}</span>`;
    el.onclick = () => {
      if (_expanded.has(item.dirPath)) _expanded.delete(item.dirPath);
      else _expanded.add(item.dirPath);
      render();
    };
    el.oncontextmenu = e => {
      e.preventDefault();
      const base = (projectRoot || '').replace(/\\/g, '/').replace(/\/$/, '');
      const absDir = base ? base + '/' + item.dirPath : item.dirPath;
      showDirCtxMenu(absDir, item.dirPath, e.clientX, e.clientY);
    };

  } else if (item.type === 'file') {
    el.style.height = ITEM_H + 'px';
    el.style.lineHeight = ITEM_H + 'px';
    el.className = 'ex-item ex-file' + (item.abs === _selPath ? ' ex-sel' : '');
    el.style.paddingLeft = (4 + item.depth * INDENT) + 'px';
    addGuides(el, item.depth);
    const _unopen = typeof window.isUnopenableFile === 'function' && window.isUnopenableFile(item.abs);
    el.innerHTML +=
      `<span style="width:16px;flex-shrink:0"></span>` +
      fileIcon(item.name) +
      `<span class="ex-name" style="${_unopen ? 'opacity:0.35' : ''}">${escHtml(item.name)}</span>`;
    el.onclick = () => { _selPath = item.abs; openPeek(item.abs, 1); render(); };
    el.ondblclick = () => { openPeekPermanent(item.abs, 1); };
    el.oncontextmenu = e => { e.preventDefault(); showFileCtxMenu(item.abs, e.clientX, e.clientY); };

  } else { // file-flat (フィルタ結果)
    el.style.height = FLAT_H + 'px';
    const isSel = idx === _selIdx;
    el.className = 'ex-item ex-flat' + (isSel ? ' ex-sel' : '');
    el.dataset.idx = idx;

    const rel      = absToRel(item.abs);
    const slashIdx = rel.lastIndexOf('/');
    const name     = slashIdx >= 0 ? rel.slice(slashIdx + 1) : rel;
    const dir      = slashIdx >= 0 ? rel.slice(0, slashIdx + 1) : '';
    const pos      = item.positions || new Set();
    const nameHL   = highlightByPos(name, pos, dir.length);
    const dirHL    = highlightByPos(dir,  pos, 0);

    el.innerHTML =
      `<div class="ex-flat-icon">${fileIcon(name)}</div>` +
      `<span class="ex-flat-name">${nameHL}</span>` +
      `<span class="ex-flat-path">${dirHL}</span>` +
      `<span class="ex-folder-btn" title="フォルダをツリーで表示"><i class="codicon codicon-folder"></i></span>`;

    el.onclick = () => {
      _selIdx = idx;
      _selPath = item.abs;
      renderVirtual();
      _scrollEl.focus({ preventScroll: true });
    };
    el.ondblclick = () => {
      openPeekPermanent(item.abs, 1);
    };
    el.oncontextmenu = e => { e.preventDefault(); showFileCtxMenu(item.abs, e.clientX, e.clientY); };
    el.querySelector('.ex-folder-btn').onclick = e => {
      e.stopPropagation();
      revealFolderInTree(item.abs);
    };
  }
  return el;
}

function dirIcon(_name) {
  return `<img src="${MIT_ICON_BASE}folder-closed.svg" width="16" height="16" style="vertical-align:middle;flex-shrink:0;margin-right:3px">`;
}
function dirIconOpen(_name) {
  return `<img src="${MIT_ICON_BASE}folder-open.svg" width="16" height="16" style="vertical-align:middle;flex-shrink:0;margin-right:3px">`;
}
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ---- Context menu ----

let _ctxMenu = null;

function createCtxMenu() {
  if (_ctxMenu) return;
  _ctxMenu = document.createElement('div');
  _ctxMenu.style.cssText = 'display:none;position:fixed;z-index:var(--z-context-menu);background:#2d2d2d;border:1px solid #555;border-radius:3px;box-shadow:0 4px 12px rgba(0,0,0,.5);padding:3px 0;min-width:180px;font-size:12px;user-select:none';
  document.body.appendChild(_ctxMenu);
  document.addEventListener('mousedown', e => {
    if (!_ctxMenu.contains(e.target)) hideCtxMenu();
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') hideCtxMenu();
  }, true);
}

function hideCtxMenu() {
  if (_ctxMenu) _ctxMenu.style.display = 'none';
}

function ctxItem(label, action) {
  const div = document.createElement('div');
  div.textContent = label;
  div.style.cssText = 'padding:5px 16px;cursor:pointer;color:#ccc;white-space:nowrap';
  div.onmouseenter = () => { div.style.background = '#094771'; };
  div.onmouseleave = () => { div.style.background = ''; };
  div.onclick = () => { hideCtxMenu(); action(); };
  return div;
}

function positionCtxMenu(x, y) {
  _ctxMenu.style.display = 'block';
  const w = _ctxMenu.offsetWidth || 190;
  const h = _ctxMenu.offsetHeight || 100;
  _ctxMenu.style.left = Math.min(x, window.innerWidth  - w - 4) + 'px';
  _ctxMenu.style.top  = Math.min(y, window.innerHeight - h - 4) + 'px';
}

function showFileCtxMenu(abs, x, y) {
  createCtxMenu();
  _ctxMenu.innerHTML = '';
  _ctxMenu.appendChild(ctxItem('エクスプローラで開く', () => {
    fetch('/api/reveal?' + new URLSearchParams({ file: abs }));
  }));
  _ctxMenu.appendChild(ctxItem('パスをコピー', () => {
    navigator.clipboard.writeText(abs.replace(/\//g, '\\'));
  }));
  positionCtxMenu(x, y);
}

function showDirCtxMenu(absDir, relDir, x, y) {
  createCtxMenu();
  _ctxMenu.innerHTML = '';
  _ctxMenu.appendChild(ctxItem('エクスプローラで開く', () => {
    fetch('/api/reveal?' + new URLSearchParams({ file: absDir }));
  }));
  _ctxMenu.appendChild(ctxItem('このフォルダで検索', () => {
    const dirEl = document.getElementById('dir');
    if (dirEl) {
      dirEl.value = relDir.replace(/\//g, '\\');
      const clearEl = document.getElementById('dir-clear');
      if (clearEl) clearEl.style.display = '';
    }
    const sub = document.getElementById('bar-sub');
    if (sub && !sub.classList.contains('open')) {
      sub.classList.add('open');
      document.getElementById('btn-toggle-sub')?.classList.add('open');
    }
    document.getElementById('tab-search')?.click();
    document.getElementById('q')?.focus();
  }));
  _ctxMenu.appendChild(ctxItem('パスをコピー', () => {
    navigator.clipboard.writeText(absDir.replace(/\//g, '\\'));
  }));
  positionCtxMenu(x, y);
}

// ---- ツリーで表示 ----

function revealFolderInTree(abs) {
  const base = (projectRoot || '').replace(/\\/g, '/').replace(/\/$/, '');
  const rel  = abs.replace(/\\/g, '/');
  const stripped = base && rel.startsWith(base + '/') ? rel.slice(base.length + 1) : rel;
  const parts = stripped.split('/').filter(Boolean);
  const dirPath = parts.slice(0, -1).join('/');
  if (!dirPath) return;

  _query = '';
  _selIdx = -1;
  const filterEl = document.getElementById('explorer-filter');
  const clearEl  = document.getElementById('explorer-filter-clear');
  if (filterEl) filterEl.value = '';
  if (clearEl)  clearEl.style.display = 'none';

  const dirParts = dirPath.split('/');
  for (let i = 1; i <= dirParts.length; i++) {
    _expanded.add(dirParts.slice(0, i).join('/'));
  }

  _selPath = abs.replace(/\\/g, '/');
  _filtered = false;
  renderTree();

  const fileIdx = _allItems.findIndex(it => it.type === 'file' && it.abs.replace(/\\/g, '/') === _selPath);
  const scrollToIdx = fileIdx >= 0 ? fileIdx : _allItems.findIndex(it => it.type === 'dir' && it.dirPath === dirPath);
  if (scrollToIdx >= 0) {
    // すでにビューポート内に見えている場合はスクロールしない。
    // (ユーザがエクスプローラ上で自分でクリックしたファイルが、
    //  switchTab → explorerRevealFile 経由で勝手に中央へ移動する症状を防ぐ)
    const itemTop  = scrollToIdx * ITEM_H;
    const viewH    = _scrollEl.clientHeight || 400;
    const curTop   = _scrollEl.scrollTop;
    const visible  = itemTop >= curTop && itemTop + ITEM_H <= curTop + viewH;
    if (!visible) {
      _scrollEl.scrollTop = Math.max(0, itemTop - Math.floor(viewH / 2));
    }
  }
}

// ---- public API ----

// chunk ごとに renderTree を直叩きすると大規模 tree で collectItems が UI を詰まらせる。
let _incRenderTimer = null;
function _scheduleIncrementalRender() {
  if (_incRenderTimer || !_scrollEl) return;
  _incRenderTimer = setTimeout(() => {
    _incRenderTimer = null;
    if (!_query.trim()) renderTree();
  }, 100);
}

async function explorerLoad() {
  if (_files) return;
  _files = [];
  _tree  = { children: {}, files: [] };
  const base = (projectRoot || '').replace(/\\/g, '/').replace(/\/$/, '');
  try {
    const r = await fetch('/api/files?stream=1');
    if (!r.ok || !r.body) {
      // 旧 server (stream 未対応) 用フォールバック。
      const fallback = await fetch('/api/files');
      const rel = await fallback.json();
      _files = base ? rel.map(f => base + '/' + f) : rel;
      _tree  = buildTree(_files);
      return;
    }
    const reader  = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let firstChunk = true;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line) continue;
        let rel;
        try { rel = JSON.parse(line); } catch { continue; }
        const abs = base ? base + '/' + rel : rel;
        _files.push(abs);
        insertFileIntoTree(_tree, abs);
      }
      if (firstChunk && _scrollEl) {
        _scrollEl.innerHTML = '';
        firstChunk = false;
      }
      _scheduleIncrementalRender();
    }
    if (buffer.trim()) {
      try {
        const rel = JSON.parse(buffer);
        const abs = base ? base + '/' + rel : rel;
        _files.push(abs);
        insertFileIntoTree(_tree, abs);
      } catch {}
    }
    if (_incRenderTimer) { clearTimeout(_incRenderTimer); _incRenderTimer = null; }
  } catch (_) {
    // 途中で reader が落ちたら cache を捨てる。空 array を残すと次回 click で
    // `if (_files) return;` が hit して再試行されない。
    _files = null;
    _tree  = null;
  }
}

window.explorerInvalidate = function() {
  _files = null; _tree = null; _expanded = new Set(); _query = ''; _selIdx = -1;
};

window.initExplorer = async function() {
  const filterEl = document.getElementById('explorer-filter');
  const clearEl  = document.getElementById('explorer-filter-clear');
  _scrollEl = document.getElementById('explorer-tree');

  filterEl.addEventListener('input', () => {
    _query = filterEl.value;
    _selIdx = 0;
    clearEl.style.display = _query ? '' : 'none';
    render();
  });

  filterEl.addEventListener('keydown', e => {
    if (_filtered && _allItems.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = _selIdx;
        _selIdx = e.key === 'ArrowDown'
          ? Math.min(_selIdx + 1, _allItems.length - 1)
          : Math.max(_selIdx - 1, 0);
        if (_selIdx === prev) return;
        const rh = rowH();
        const needsScroll = (_selIdx * rh < _scrollEl.scrollTop) ||
          ((_selIdx + 1) * rh > _scrollEl.scrollTop + (_scrollEl.clientHeight || 400));
        if (needsScroll) {
          scrollSelIntoView();
          renderVirtual();
        } else {
          // DOM再生成せずクラスだけ更新してちらつき防止
          _scrollEl.querySelector('[data-idx="' + prev + '"]')?.classList.remove('ex-sel');
          _scrollEl.querySelector('[data-idx="' + _selIdx + '"]')?.classList.add('ex-sel');
        }
        return;
      }
      if (e.key === 'Enter') {
        const it = _allItems[_selIdx];
        if (it) { _selPath = it.abs; openPeekPermanent(it.abs, 1); }
        return;
      }
      if (e.key === 'ArrowRight') {
        const it = _allItems[_selIdx];
        if (it) revealFolderInTree(it.abs);
        return;
      }
    }
    if (e.key === 'Escape') {
      filterEl.value = ''; _query = ''; _selIdx = -1;
      clearEl.style.display = 'none';
      render();
    }
  });

  clearEl.onclick = () => {
    filterEl.value = ''; _query = ''; _selIdx = -1;
    clearEl.style.display = 'none';
    render();
    filterEl.focus();
  };

  _scrollEl.addEventListener('scroll', () => { renderVirtual(); updateStickyFolder(); }, { passive: true });

  _scrollEl.addEventListener('keydown', e => {
    if (!_filtered || !_allItems.length) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const it = _allItems[_selIdx];
      if (it) revealFolderInTree(it.abs);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      _selIdx = e.key === 'ArrowDown'
        ? Math.min(_selIdx + 1, _allItems.length - 1)
        : Math.max(_selIdx - 1, 0);
      scrollSelIntoView();
      renderVirtual();
    } else if (e.key === 'Enter') {
      const it = _allItems[_selIdx];
      if (it) { _selPath = it.abs; openPeek(it.abs, 1); }
    }
  });

  document.getElementById('explorer-collapse-all')?.addEventListener('click', () => {
    _expanded.clear();
    render();
  });

  updateRootName();
};

window.explorerRevealFile = function(absPath) {
  if (!absPath) return;
  revealFolderInTree(absPath);
};

window.explorerShow = async function() {
  _scrollEl = document.getElementById('explorer-tree');
  if (!_files) {
    _scrollEl.innerHTML = '<div class="ex-loading">読み込み中...</div>';
  }
  await explorerLoad();
  updateRootName();
  // 現在 monaco で開いているファイルがあればツリーで reveal + 選択状態に。
  // VSCode の「Reveal in Explorer」と同等の体験。
  // revealFolderInTree は内部で renderTree() するので、ここでの render() は省略。
  const activeFile = typeof tabs !== 'undefined' && tabs[activeTabIdx]?.file;
  if (activeFile) {
    revealFolderInTree(activeFile);
  } else {
    render();
  }
  document.getElementById('explorer-filter')?.focus();
};

})();
