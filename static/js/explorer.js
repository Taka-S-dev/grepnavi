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
  const base = (projectRoot || '').replace(/\\/g, '/').replace(/\/$/, '');
  for (const abs of files) {
    const rel = abs.replace(/\\/g, '/');
    const stripped = base && rel.startsWith(base + '/') ? rel.slice(base.length + 1) : rel;
    const parts = stripped.split('/').filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const d = parts[i];
      if (!node.children[d]) node.children[d] = { children: {}, files: [], dirPath: parts.slice(0, i + 1).join('/') };
      node = node.children[d];
    }
    node.files.push({ name: parts[parts.length - 1], abs });
  }
  return root;
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
      (item.expanded ? dirIconOpen() : dirIcon()) +
      `<span class="ex-name">${escHtml(item.name)}</span>`;
    el.onclick = () => {
      if (_expanded.has(item.dirPath)) _expanded.delete(item.dirPath);
      else _expanded.add(item.dirPath);
      render();
    };

  } else if (item.type === 'file') {
    el.style.height = ITEM_H + 'px';
    el.style.lineHeight = ITEM_H + 'px';
    el.className = 'ex-item ex-file' + (item.abs === _selPath ? ' ex-sel' : '');
    el.style.paddingLeft = (4 + item.depth * INDENT) + 'px';
    addGuides(el, item.depth);
    el.innerHTML +=
      `<span style="width:16px;flex-shrink:0"></span>` +
      fileIcon(item.name) +
      `<span class="ex-name">${escHtml(item.name)}</span>`;
    el.onclick = () => { _selPath = item.abs; openPeek(item.abs, 1); render(); };

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
      `<span class="ex-folder-btn" title="フォルダをツリーで表示"><i class="codicon codicon-folder-opened"></i></span>`;

    el.onclick = () => {
      _selIdx = idx;
      _selPath = item.abs;
      openPeek(item.abs, 1);
      renderVirtual();
    };
    el.querySelector('.ex-folder-btn').onclick = e => {
      e.stopPropagation();
      revealFolderInTree(item.abs);
    };
  }
  return el;
}

function dirIcon() {
  return `<img src="${MIT_ICON_BASE}folder-base.svg" width="16" height="16" style="vertical-align:middle;flex-shrink:0;margin-right:3px">`;
}
function dirIconOpen() {
  return `<img src="${MIT_ICON_BASE}folder-base-open.svg" width="16" height="16" style="vertical-align:middle;flex-shrink:0;margin-right:3px">`;
}
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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
    _scrollEl.scrollTop = Math.max(0, scrollToIdx * ITEM_H - Math.floor((_scrollEl.clientHeight || 400) / 2));
  }
}

// ---- public API ----

async function explorerLoad() {
  if (_files) return;
  try {
    const r = await fetch('/api/files');
    const rel = await r.json();
    const base = (projectRoot || '').replace(/\\/g, '/').replace(/\/$/, '');
    _files = base ? rel.map(f => base + '/' + f) : rel;
  } catch { _files = []; }
  _tree = buildTree(_files);
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
        if (it) { _selPath = it.abs; openPeek(it.abs, 1); }
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

  _scrollEl.addEventListener('scroll', () => renderVirtual(), { passive: true });
};

window.explorerShow = async function() {
  _scrollEl = document.getElementById('explorer-tree');
  await explorerLoad();
  _tree = buildTree(_files);
  render();
  document.getElementById('explorer-filter')?.focus();
};

})();
