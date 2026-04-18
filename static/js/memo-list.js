// ===== マーク一覧パネル =====
// 依存: utils.js (id, esc, showInputModal), editor.js (getLineMemos, setLineMemo,
//        getRangeMemos, saveRangeMemos, refreshLineMemoDecorations,
//        refreshRangeMemoDecorations, openPeek)

let _memoListOpen = false;
let _memoListFilter = '';
let _memoListTypeFilter = new Set();
let _memoListSelectedId = null;
let _memoListNavAbort = null;

function getMemoListOrder() {
  try { return JSON.parse(localStorage.getItem('grepnavi-memo-list-order') || 'null'); } catch { return null; }
}
function saveMemoListOrder(arr) {
  localStorage.setItem('grepnavi-memo-list-order', JSON.stringify(arr));
}
function getMemoGroups() {
  try { return JSON.parse(localStorage.getItem('grepnavi-memo-groups') || '[]'); } catch { return []; }
}
function saveMemoGroups(arr) {
  localStorage.setItem('grepnavi-memo-groups', JSON.stringify(arr));
}

function getAllMemosOrdered() {
  const lineMemos = getLineMemos();
  const rangeMemos = getRangeMemos();
  const items = [];

  for (const [key, memo] of Object.entries(lineMemos)) {
    const idx = key.lastIndexOf('::');
    const file = key.substring(0, idx);
    const line = parseInt(key.substring(idx + 2));
    items.push({ kind: 'line', id: 'line::' + key, file, line, memo });
  }
  for (const m of rangeMemos) {
    items.push({ kind: 'range', id: 'range::' + m.id, file: m.file, line: m.startLine, endLine: m.endLine, memo: m.memo, _rangeId: m.id });
  }

  const bookmarks = typeof getBookmarks === 'function' ? getBookmarks() : {};
  for (const [key, text] of Object.entries(bookmarks)) {
    const idx = key.lastIndexOf('::');
    const file = key.substring(0, idx);
    const line = parseInt(key.substring(idx + 2));
    items.push({ kind: 'bookmark', id: 'bookmark::' + key, file, line, memo: text || '' });
  }

  const order = getMemoListOrder();
  if (order) {
    const orderMap = new Map(order.map((id, i) => [id, i]));
    items.sort((a, b) => {
      const ai = orderMap.has(a.id) ? orderMap.get(a.id) : Infinity;
      const bi = orderMap.has(b.id) ? orderMap.get(b.id) : Infinity;
      if (ai !== bi) return ai - bi;
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      return a.line - b.line;
    });
  } else {
    items.sort((a, b) => {
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      return a.line - b.line;
    });
  }
  return items;
}

function _deleteMemoItem(item) {
  if (item.kind === 'bookmark') {
    const key = item.id.slice('bookmark::'.length);
    const idx = key.lastIndexOf('::');
    setBookmark(key.substring(0, idx), parseInt(key.substring(idx + 2)), false);
    if (typeof refreshBookmarkDecorations === 'function') refreshBookmarkDecorations();
  } else if (item.kind === 'line') {
    const key = item.id.slice('line::'.length);
    const idx = key.lastIndexOf('::');
    setLineMemo(key.substring(0, idx), parseInt(key.substring(idx + 2)), '');
    refreshLineMemoDecorations();
  } else {
    const arr = getRangeMemos().filter(m => m.id !== item._rangeId);
    saveRangeMemos(arr);
    refreshRangeMemoDecorations();
  }
}

function _saveMemoItemText(item, newText) {
  if (item.kind === 'line') {
    const key = item.id.slice('line::'.length);
    const idx = key.lastIndexOf('::');
    setLineMemo(key.substring(0, idx), parseInt(key.substring(idx + 2)), newText);
    refreshLineMemoDecorations();
  } else {
    const arr = getRangeMemos();
    const m = arr.find(m => m.id === item._rangeId);
    if (m) { m.memo = newText; saveRangeMemos(arr); refreshRangeMemoDecorations(); }
  }
}

function toggleMemoList() {
  const panel = id('memo-list-panel');
  if (!panel) return;
  _memoListOpen = !_memoListOpen;
  if (_memoListOpen) { renderMemoList(); panel.classList.add('visible'); }
  else { panel.classList.remove('visible'); }
  id('btn-memo-list')?.classList.toggle('active', _memoListOpen);
}

function closeMemoList() {
  _memoListOpen = false;
  id('memo-list-panel')?.classList.remove('visible');
  id('btn-memo-list')?.classList.remove('active');
}

function renderMemoList() {
  const panel = id('memo-list-panel');
  if (!panel) return;
  const allItems = getAllMemosOrdered();

  // 初回のみパネル骨格を構築
  if (!id('memo-list-hdr')) {
    // ヘッダ
    const hdr = document.createElement('div');
    hdr.id = 'memo-list-hdr';
    hdr.innerHTML =
      `<span>マーク一覧</span>` +
      `<button id="memo-list-add-group" title="グループを追加"><i class="codicon codicon-add"></i></button>` +
      `<button id="memo-list-close" title="閉じる"><i class="codicon codicon-close"></i></button>`;
    panel.appendChild(hdr);
    id('memo-list-close').onclick = closeMemoList;
    id('memo-list-add-group').onclick = async () => {
      const name = await showInputModal('グループを追加', 'グループ名');
      if (!name) return;
      const groups = getMemoGroups();
      groups.push({ id: Math.random().toString(36).slice(2), name, itemIds: [], collapsed: false });
      saveMemoGroups(groups);
      _renderMemoListBody(getAllMemosOrdered());
    };

    // フィルタ欄
    const filterBar = document.createElement('div');
    filterBar.id = 'memo-list-filter-bar';
    filterBar.innerHTML =
      `<input id="memo-list-filter-input" type="text" placeholder="絞り込み (メモ / ファイル名)" spellcheck="false" autocomplete="off">` +
      `<button id="memo-list-filter-clear" title="クリア">✕</button>`;
    panel.appendChild(filterBar);
    const inp = id('memo-list-filter-input');
    inp.value = _memoListFilter;
    inp.oninput = () => { _memoListFilter = inp.value; _renderMemoListBody(getAllMemosOrdered()); };
    id('memo-list-filter-clear').onclick = () => { _memoListFilter = ''; inp.value = ''; _renderMemoListBody(getAllMemosOrdered()); };

    // タイプフィルタバー
    const typeBar = document.createElement('div');
    typeBar.id = 'memo-list-type-bar';
    const bmSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 16 16"><path d="M5 2h6a1 1 0 0 1 1 1v10l-4-2.5L4 13V3a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
    const typeButtons = [
      { kind: 'bookmark', label: bmSvg,  title: 'ブックマーク' },
      { kind: 'line',     label: '✎',   title: 'ラインメモ' },
      { kind: 'range',    label: '▤',   title: '範囲メモ' },
    ];
    typeButtons.forEach(({ kind, label, title }) => {
      const btn = document.createElement('button');
      btn.className = 'memo-type-btn';
      btn.dataset.kind = kind;
      btn.title = title;
      btn.innerHTML = label;
      btn.classList.toggle('active', _memoListTypeFilter.has(kind));
      btn.onclick = () => {
        if (_memoListTypeFilter.has(kind)) _memoListTypeFilter.delete(kind);
        else _memoListTypeFilter.add(kind);
        btn.classList.toggle('active', _memoListTypeFilter.has(kind));
        _renderMemoListBody(getAllMemosOrdered());
      };
      typeBar.appendChild(btn);
    });
    panel.appendChild(typeBar);

    // リスト本体
    const body = document.createElement('div');
    body.id = 'memo-list-body';
    panel.appendChild(body);

    // リサイザー
    const resizer = document.createElement('div');
    resizer.id = 'memo-list-resizer';
    panel.appendChild(resizer);

    // プレビューペイン
    const preview = document.createElement('div');
    preview.id = 'memo-list-preview';
    preview.innerHTML = '<div id="memo-list-preview-empty">メモを選択してください</div>';
    panel.appendChild(preview);

    resizer.addEventListener('mousedown', e => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = id('memo-list-preview').offsetHeight;
      const onMove = ev => {
        const delta = startY - ev.clientY;
        const newH = Math.max(80, Math.min(startH + delta, panel.offsetHeight - 120));
        id('memo-list-preview').style.height = newH + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // 幅リサイザー（左端）
    const widthResizer = document.createElement('div');
    widthResizer.id = 'memo-list-width-resizer';
    panel.appendChild(widthResizer);

    const savedW = parseInt(localStorage.getItem('grepnavi-memo-list-width'));
    if (savedW >= 200) panel.style.width = savedW + 'px';

    widthResizer.addEventListener('mousedown', e => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = panel.offsetWidth;
      document.body.style.cursor = 'ew-resize';
      const onMove = ev => {
        const newW = Math.max(200, Math.min(startW + (startX - ev.clientX), 700));
        panel.style.width = newW + 'px';
      };
      const onUp = () => {
        document.body.style.cursor = '';
        localStorage.setItem('grepnavi-memo-list-width', panel.offsetWidth);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  _renderMemoListBody(allItems);
}

function _showMemoPreview(item) {
  _memoListSelectedId = item.id;
  const preview = id('memo-list-preview');
  if (!preview) return;

  // 選択行のハイライト更新
  document.querySelectorAll('.memo-list-item').forEach(r => {
    r.classList.toggle('memo-list-selected', r.dataset.id === item.id);
  });

  const fileName = item.file.replace(/\\/g, '/').split('/').pop();
  const lineLabel = item.kind === 'range' ? `L${item.line}–${item.endLine}` : `L${item.line}`;
  const icon = item.kind === 'bookmark'
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 16 16" style="vertical-align:middle"><path d="M5 2h6a1 1 0 0 1 1 1v10l-4-2.5L4 13V3a1 1 0 0 1 1-1z" fill="none" stroke="#888" stroke-width="1.5" stroke-linejoin="round"/></svg>`
    : item.kind === 'range' ? '▤' : '✎';

  if (item.kind === 'bookmark') {
    preview.innerHTML =
      `<div id="memo-preview-hdr">` +
        `<span class="memo-preview-icon">${icon}</span>` +
        `<span class="memo-preview-loc" title="${esc(item.file)}">${esc(fileName)}<span style="color:#666">:${lineLabel}</span></span>` +
        `<button id="memo-preview-jump" title="この行へジャンプ"><i class="codicon codicon-go-to-file"></i></button>` +
      `</div>` +
      `<textarea id="memo-preview-ta" spellcheck="false" placeholder="メモ（任意）"></textarea>` +
      `<div id="memo-preview-actions">` +
        `<button id="memo-preview-save">保存 <kbd>Ctrl+Enter</kbd></button>` +
        `<button id="memo-preview-del" class="sec">削除</button>` +
      `</div>`;
    const ta = id('memo-preview-ta');
    ta.value = item.memo;
    id('memo-preview-jump').onclick = () => openPeek(item.file, item.line);
    const saveBm = () => {
      const key = item.id.slice('bookmark::'.length);
      const idx = key.lastIndexOf('::');
      setBookmark(key.substring(0, idx), parseInt(key.substring(idx + 2)), true, ta.value.trim());
      _renderMemoListBody(getAllMemosOrdered());
    };
    id('memo-preview-save').onclick = saveBm;
    ta.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); saveBm(); }
    });
    id('memo-preview-del').onclick = () => {
      _deleteMemoItem(item);
      _memoListSelectedId = null;
      id('memo-list-preview').innerHTML = '<div id="memo-list-preview-empty">メモを選択してください</div>';
    };
    return;
  }

  preview.innerHTML =
    `<div id="memo-preview-hdr">` +
      `<span class="memo-preview-icon">${icon}</span>` +
      `<span class="memo-preview-loc" title="${esc(item.file)}">${esc(fileName)}<span style="color:#666">:${lineLabel}</span></span>` +
      `<button id="memo-preview-jump" title="この行へジャンプ"><i class="codicon codicon-go-to-file"></i></button>` +
    `</div>` +
    `<textarea id="memo-preview-ta" spellcheck="false">${esc(item.memo)}</textarea>` +
    `<div id="memo-preview-actions">` +
      `<button id="memo-preview-save">保存 <kbd>Ctrl+Enter</kbd></button>` +
      `<button id="memo-preview-del" class="sec">削除</button>` +
    `</div>`;

  const ta = id('memo-preview-ta');
  ta.value = item.memo; // esc済み文字列ではなく生テキストを再セット

  id('memo-preview-jump').onclick = () => openPeek(item.file, item.line);

  const save = () => {
    const newText = ta.value.trim();
    if (!newText) { _deleteMemoItem(item); return; }
    if (newText !== item.memo) _saveMemoItemText(item, newText);
  };
  id('memo-preview-save').onclick = save;
  ta.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); save(); }
  });

  id('memo-preview-del').onclick = () => {
    _deleteMemoItem(item);
    _memoListSelectedId = null;
    id('memo-list-preview').innerHTML = '<div id="memo-list-preview-empty">メモを選択してください</div>';
  };
}

function _makeMemoRow(item) {
  const fileName = item.file.replace(/\\/g, '/').split('/').pop();
  const lineLabel = item.kind === 'range' ? `L${item.line}–${item.endLine}` : `L${item.line}`;
  const memoPreview = item.memo.split('\n')[0].substring(0, 60);
  const icon = item.kind === 'bookmark'
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 16 16" style="vertical-align:middle"><path d="M5 2h6a1 1 0 0 1 1 1v10l-4-2.5L4 13V3a1 1 0 0 1 1-1z" fill="none" stroke="#888" stroke-width="1.5" stroke-linejoin="round"/></svg>`
    : item.kind === 'range' ? '▤' : '✎';
  const row = document.createElement('div');
  const isBm = item.kind === 'bookmark';
  row.className = 'memo-list-item' + (_memoListSelectedId === item.id ? ' memo-list-selected' : '');
  row.draggable = true;
  row.dataset.id = item.id;
  row.dataset.file = item.file;
  row.dataset.line = item.line;
  const textContent = isBm ? esc((item.memo || '').substring(0, 60)) : esc(memoPreview);
  row.innerHTML =
    `<span class="memo-list-drag" title="ドラッグして並べ替え">⠿</span>` +
    `<span class="memo-list-icon">${icon}</span>` +
    `<span class="memo-list-loc" title="${esc(item.file)}">${esc(fileName)}<span class="memo-list-lineno">:${lineLabel}</span></span>` +
    `<span class="memo-list-text" ${isBm ? 'style="color:#666"' : ''}>${textContent}</span>` +
    `<button class="memo-list-del" title="削除"><i class="codicon codicon-trash"></i></button>`;
  row.addEventListener('click', e => {
    if (e.target.closest('.memo-list-drag') || e.target.closest('.memo-list-del')) return;
    _showMemoPreview(item);
  });
  row.addEventListener('dblclick', e => {
    if (e.target.closest('.memo-list-drag') || e.target.closest('.memo-list-del')) return;
    openPeek(item.file, item.line).then(() => monacoEditor?.focus());
  });
  row.querySelector('.memo-list-del').addEventListener('click', e => {
    e.stopPropagation();
    _deleteMemoItem(item);
    if (_memoListSelectedId === item.id) {
      _memoListSelectedId = null;
      const pv = id('memo-list-preview');
      if (pv) pv.innerHTML = '<div id="memo-list-preview-empty">メモを選択してください</div>';
    }
  });
  return row;
}

function _renderMemoListBody(allItems) {
  const body = id('memo-list-body');
  if (!body) return;
  const q = _memoListFilter.toLowerCase();
  const tf = _memoListTypeFilter;

  const filtered = allItems.filter(it => {
    if (tf.size > 0 && !tf.has(it.kind)) return false;
    if (!q) return true;
    return it.memo.toLowerCase().includes(q) ||
           it.file.replace(/\\/g, '/').split('/').pop().toLowerCase().includes(q);
  });

  body.innerHTML = '';

  const groups = getMemoGroups();
  const groupedIds = new Set(groups.flatMap(g => g.itemIds));
  const isFiltering = q || tf.size > 0;
  const filteredIds = new Set(filtered.map(it => it.id));

  if (isFiltering && !filtered.length) {
    body.innerHTML = '<div style="color:#666;font-size:11px;padding:12px 8px">一致するメモがありません</div>';
    _initMemoListKeyNav(body, []);
    // グループヘッダはDnDターゲットとして維持
    _initMemoListDnd(body, allItems, groups);
    return;
  }

  // グループセクションを描画（フィルタ中も全グループ表示）
  groups.forEach(group => {
    const groupItems = group.itemIds
      .map(iid => allItems.find(it => it.id === iid))
      .filter(Boolean);
    const visibleItems = isFiltering ? groupItems.filter(it => filteredIds.has(it.id)) : groupItems;

    const sec = document.createElement('div');
    sec.className = 'memo-group-section';
    sec.dataset.groupId = group.id;

    const ghdr = document.createElement('div');
    ghdr.className = 'memo-group-hdr';
    const countLabel = isFiltering ? `${visibleItems.length}/${groupItems.length}` : `${groupItems.length}`;
    ghdr.innerHTML =
      `<span class="memo-group-toggle codicon ${group.collapsed ? 'codicon-chevron-right' : 'codicon-chevron-down'}"></span>` +
      `<span class="memo-group-name">${esc(group.name)}</span>` +
      `<span class="memo-group-count">${countLabel}</span>` +
      `<button class="memo-group-rename" title="名前を変更"><i class="codicon codicon-edit"></i></button>` +
      `<button class="memo-group-del" title="グループを削除"><i class="codicon codicon-trash"></i></button>`;
    sec.appendChild(ghdr);

    const glist = document.createElement('div');
    glist.className = 'memo-group-list';
    glist.dataset.groupId = group.id;
    if (group.collapsed) glist.style.display = 'none';
    visibleItems.forEach(item => glist.appendChild(_makeMemoRow(item)));
    sec.appendChild(glist);

    // 折りたたみ
    ghdr.querySelector('.memo-group-toggle').addEventListener('click', () => {
      const grps = getMemoGroups();
      const g = grps.find(g => g.id === group.id);
      if (g) { g.collapsed = !g.collapsed; saveMemoGroups(grps); }
      _renderMemoListBody(getAllMemosOrdered());
    });
    ghdr.querySelector('.memo-group-name').addEventListener('click', () => {
      const grps = getMemoGroups();
      const g = grps.find(g => g.id === group.id);
      if (g) { g.collapsed = !g.collapsed; saveMemoGroups(grps); }
      _renderMemoListBody(getAllMemosOrdered());
    });

    // リネーム
    ghdr.querySelector('.memo-group-rename').addEventListener('click', async e => {
      e.stopPropagation();
      const newName = await showInputModal('グループ名を変更', 'グループ名', group.name);
      if (!newName) return;
      const grps = getMemoGroups();
      const g = grps.find(g => g.id === group.id);
      if (g) { g.name = newName; saveMemoGroups(grps); }
      _renderMemoListBody(getAllMemosOrdered());
    });

    // グループ削除（メモはそのまま未分類へ）
    ghdr.querySelector('.memo-group-del').addEventListener('click', e => {
      e.stopPropagation();
      if (!confirm(`グループ「${group.name}」を削除しますか？\nメモは未分類に移動します。`)) return;
      const grps = getMemoGroups().filter(g => g.id !== group.id);
      saveMemoGroups(grps);
      _renderMemoListBody(getAllMemosOrdered());
    });

    body.appendChild(sec);
  });

  // 未分類
  const ungrouped = allItems.filter(it => !groupedIds.has(it.id));
  const visibleUngrouped = isFiltering ? ungrouped.filter(it => filteredIds.has(it.id)) : ungrouped;
  if (ungrouped.length || !groups.length) {
    if (groups.length) {
      const uhdr = document.createElement('div');
      uhdr.className = 'memo-group-hdr memo-group-ungrouped-hdr';
      const uCount = isFiltering ? `${visibleUngrouped.length}/${ungrouped.length}` : `${ungrouped.length}`;
      uhdr.innerHTML = `<span class="memo-group-name" style="color:#666">未分類</span><span class="memo-group-count">${uCount}</span>`;
      body.appendChild(uhdr);
    }
    if (!allItems.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:#666;font-size:11px;padding:12px 8px';
      empty.textContent = 'メモがありません';
      body.appendChild(empty);
    } else {
      visibleUngrouped.forEach(item => body.appendChild(_makeMemoRow(item)));
    }
  }

  _initMemoListDnd(body, allItems, groups);
  _initMemoListKeyNav(body, filtered);
}

function _initMemoListKeyNav(body, items) {
  body.tabIndex = 0;
  if (_memoListNavAbort) _memoListNavAbort.abort();
  _memoListNavAbort = new AbortController();
  const sig = { signal: _memoListNavAbort.signal };

  body.addEventListener('mouseenter', () => {
    if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return;
    body.focus({ preventScroll: true });
  }, sig);

  let _jumpTimer = null;
  body.addEventListener('keydown', e => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const rows = [...body.querySelectorAll('.memo-list-item')];
    if (!rows.length) return;
    const selIdx = rows.findIndex(r => r.dataset.id === _memoListSelectedId);
    let nextIdx;
    if (e.key === 'ArrowUp') {
      nextIdx = selIdx <= 0 ? rows.length - 1 : selIdx - 1;
    } else {
      nextIdx = selIdx < 0 || selIdx >= rows.length - 1 ? 0 : selIdx + 1;
    }
    const nextRow = rows[nextIdx];
    // rows と items は対応しないのでIDで引く
    const nextItem = items.find(it => it.id === nextRow.dataset.id);
    if (!nextItem) return;

    rows.forEach(r => r.classList.remove('memo-list-selected'));
    nextRow.classList.add('memo-list-selected');
    nextRow.scrollIntoView({ block: 'nearest' });
    _memoListSelectedId = nextItem.id;
    _showMemoPreview(nextItem);

    clearTimeout(_jumpTimer);
    _jumpTimer = setTimeout(() => openPeek(nextItem.file, nextItem.line), 200);
  }, sig);
}

function _updateGroupCounts(body) {
  const isFiltering = !!(_memoListFilter || _memoListTypeFilter.size > 0);
  const grps = getMemoGroups();
  body.querySelectorAll('.memo-group-section').forEach(sec => {
    const gid = sec.dataset.groupId;
    const grp = grps.find(g => g.id === gid);
    const glist = sec.querySelector('.memo-group-list');
    const visCount = glist ? glist.querySelectorAll(':scope > .memo-list-item').length : 0;
    const totalCount = grp ? grp.itemIds.length : visCount;
    const countEl = sec.querySelector('.memo-group-hdr .memo-group-count');
    if (countEl) countEl.textContent = isFiltering ? `${visCount}/${totalCount}` : `${totalCount}`;
  });
  const uhdr = body.querySelector('.memo-group-ungrouped-hdr');
  if (uhdr) {
    const countEl = uhdr.querySelector('.memo-group-count');
    if (countEl) {
      let visCount = 0;
      body.childNodes.forEach(n => { if (n.classList?.contains('memo-list-item')) visCount++; });
      if (isFiltering) {
        const allGroupedIds = new Set(grps.flatMap(g => g.itemIds));
        const totalUngrp = getAllMemosOrdered().filter(it => !allGroupedIds.has(it.id)).length;
        countEl.textContent = `${visCount}/${totalUngrp}`;
      } else {
        countEl.textContent = `${visCount}`;
      }
    }
  }
}

function _initMemoListDnd(body, allItems, groups) {
  let dragId = null;

  let _prevIndicator = null;
  const clearIndicators = () => {
    if (_prevIndicator) {
      _prevIndicator.classList.remove('dnd-before', 'dnd-after', 'memo-group-dragover');
      _prevIndicator = null;
    }
  };
  const clearAll = () => {
    clearIndicators();
    body.querySelectorAll('.memo-list-dragging').forEach(r => r.classList.remove('memo-list-dragging'));
  };

  body.addEventListener('dragstart', e => {
    const row = e.target.closest('.memo-list-item');
    if (!row) return;
    dragId = row.dataset.id;
    setTimeout(() => row.classList.add('memo-list-dragging'), 0);
    e.dataTransfer.effectAllowed = 'move';
  });

  body.addEventListener('dragend', () => { clearAll(); _dndTarget = null; });

  let _dndTarget = null; // { id, after }

  body.addEventListener('dragover', e => {
    e.preventDefault();
    const ghdr = e.target.closest('.memo-group-hdr');
    if (ghdr) {
      if (_prevIndicator !== ghdr) { clearIndicators(); ghdr.classList.add('memo-group-dragover'); _prevIndicator = ghdr; }
      _dndTarget = null;
      return;
    }
    const row = e.target.closest('.memo-list-item');
    if (!row) { clearIndicators(); return; }  // keep _dndTarget when over empty space
    if (row.dataset.id === dragId) { clearIndicators(); _dndTarget = null; return; }
    const rect = row.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    const cls = after ? 'dnd-after' : 'dnd-before';
    const other = after ? 'dnd-before' : 'dnd-after';
    if (_prevIndicator !== row || !row.classList.contains(cls)) {
      clearIndicators();
      row.classList.add(cls);
      row.classList.remove(other);
      _prevIndicator = row;
    }
    _dndTarget = { id: row.dataset.id, after };
  });

  body.addEventListener('drop', e => {
    e.preventDefault();
    if (!dragId) return;

    // グループヘッダにドロップ → そのグループ末尾に追加
    const ghdr = e.target.closest('.memo-group-hdr');
    if (ghdr) {
      const gid = ghdr.closest('.memo-group-section')?.dataset.groupId;
      if (gid) {
        const grps = getMemoGroups();
        grps.forEach(g => { g.itemIds = g.itemIds.filter(i => i !== dragId); });
        const target = grps.find(g => g.id === gid);
        if (target) target.itemIds.push(dragId);
        saveMemoGroups(grps);
        const dragRowEl = body.querySelector(`.memo-list-item[data-id="${dragId}"]`);
        const tgtGlist = body.querySelector(`.memo-group-list[data-group-id="${gid}"]`);
        if (dragRowEl && tgtGlist) { tgtGlist.appendChild(dragRowEl); _updateGroupCounts(body); }
        else _renderMemoListBody(getAllMemosOrdered());
      }
      return;
    }

    // dragover で確定した位置を使う
    if (!_dndTarget) return;
    const { id: tgtId, after: insertAfter } = _dndTarget;
    const targetRow = body.querySelector(`.memo-list-item[data-id="${tgtId}"]`);
    if (!targetRow) return;

    const grps = getMemoGroups();
    const srcGroup = grps.find(g => g.itemIds.includes(dragId));
    const tgtGroup = grps.find(g => g.itemIds.includes(tgtId));

    const insertIntoArray = (ids, fromId, toId, after) => {
      const fi = ids.indexOf(fromId);
      if (fi >= 0) ids.splice(fi, 1);
      let ti = ids.indexOf(toId);
      if (ti < 0) return;
      ids.splice(after ? ti + 1 : ti, 0, fromId);
    };

    const isFiltering = !!(_memoListFilter || _memoListTypeFilter.size > 0);
    const crossGroup = (srcGroup?.id !== tgtGroup?.id);

    if (srcGroup && tgtGroup && !crossGroup) {
      // 同グループ内並び替え
      insertIntoArray(srcGroup.itemIds, dragId, tgtId, insertAfter);
      saveMemoGroups(grps);
    } else if (!srcGroup && !tgtGroup) {
      // 未分類内並び替え
      const order = getMemoListOrder() || allItems.map(i => i.id);
      const newOrder = order.filter(i => i !== dragId);
      const ti = newOrder.indexOf(tgtId);
      if (ti >= 0) newOrder.splice(insertAfter ? ti + 1 : ti, 0, dragId);
      else newOrder.push(dragId);
      saveMemoListOrder(newOrder);
    } else if (srcGroup && !tgtGroup) {
      // グループ → 未分類（位置も更新）
      srcGroup.itemIds = srcGroup.itemIds.filter(i => i !== dragId);
      saveMemoGroups(grps);
      const order = getMemoListOrder() || allItems.map(i => i.id);
      const newOrder = order.filter(i => i !== dragId);
      const ti = newOrder.indexOf(tgtId);
      if (ti >= 0) newOrder.splice(insertAfter ? ti + 1 : ti, 0, dragId);
      else newOrder.push(dragId);
      saveMemoListOrder(newOrder);
    } else {
      // 異なるグループ間 or 未分類→グループ（フィルタ中は末尾、非フィルタは位置指定）
      grps.forEach(g => { g.itemIds = g.itemIds.filter(i => i !== dragId); });
      if (tgtGroup) {
        if (isFiltering) {
          tgtGroup.itemIds.push(dragId);
        } else {
          const ti = tgtGroup.itemIds.indexOf(tgtId);
          tgtGroup.itemIds.splice(insertAfter ? ti + 1 : ti, 0, dragId);
        }
      }
      saveMemoGroups(grps);
    }
    // optimistic DOM update (avoid full re-render)
    const dragRowEl = body.querySelector(`.memo-list-item[data-id="${dragId}"]`);
    if (dragRowEl && targetRow) {
      if (isFiltering && crossGroup && tgtGroup) {
        const tgtGlist = body.querySelector(`.memo-group-list[data-group-id="${tgtGroup.id}"]`);
        if (tgtGlist) { tgtGlist.appendChild(dragRowEl); }
        else { _renderMemoListBody(getAllMemosOrdered()); return; }
      } else {
        if (insertAfter) targetRow.after(dragRowEl);
        else targetRow.before(dragRowEl);
      }
      _updateGroupCounts(body);
    } else {
      _renderMemoListBody(getAllMemosOrdered());
    }
  });
}
