// ===== メモ一覧パネル =====
// 依存: utils.js (id, esc, showInputModal), editor.js (getLineMemos, setLineMemo,
//        getRangeMemos, saveRangeMemos, refreshLineMemoDecorations,
//        refreshRangeMemoDecorations, openPeek)

let _memoListOpen = false;
let _memoListFilter = '';
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
  if (item.kind === 'line') {
    const key = item.id.slice('line::'.length); // "file::line"
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
      `<span>メモ一覧</span>` +
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
  const icon = item.kind === 'range' ? '▤' : '✎';

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
  const icon = item.kind === 'range' ? '▤' : '✎';
  const row = document.createElement('div');
  row.className = 'memo-list-item' + (_memoListSelectedId === item.id ? ' memo-list-selected' : '');
  row.draggable = true;
  row.dataset.id = item.id;
  row.dataset.file = item.file;
  row.dataset.line = item.line;
  row.innerHTML =
    `<span class="memo-list-drag" title="ドラッグして並べ替え">⠿</span>` +
    `<span class="memo-list-icon">${icon}</span>` +
    `<span class="memo-list-loc" title="${esc(item.file)}">${esc(fileName)}<span class="memo-list-lineno">:${lineLabel}</span></span>` +
    `<span class="memo-list-text" title="${esc(item.memo)}">${esc(memoPreview)}</span>` +
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
  const filtered = q
    ? allItems.filter(it =>
        it.memo.toLowerCase().includes(q) ||
        it.file.replace(/\\/g, '/').split('/').pop().toLowerCase().includes(q))
    : allItems;

  body.innerHTML = '';

  const groups = getMemoGroups();
  // グループに属するitemIdのSet
  const groupedIds = new Set(groups.flatMap(g => g.itemIds));

  // フィルタ中はグループ構造を無視してフラット表示
  if (q) {
    if (!filtered.length) {
      body.innerHTML = '<div style="color:#666;font-size:11px;padding:12px 8px">一致するメモがありません</div>';
      _initMemoListKeyNav(body, []);
      return;
    }
    filtered.forEach(item => body.appendChild(_makeMemoRow(item)));
    _initMemoListDnd(body, allItems, groups);
    _initMemoListKeyNav(body, filtered);
    return;
  }

  // グループセクションを描画
  groups.forEach(group => {
    const groupItems = group.itemIds
      .map(iid => allItems.find(it => it.id === iid))
      .filter(Boolean);

    const sec = document.createElement('div');
    sec.className = 'memo-group-section';
    sec.dataset.groupId = group.id;

    const ghdr = document.createElement('div');
    ghdr.className = 'memo-group-hdr';
    ghdr.innerHTML =
      `<span class="memo-group-toggle codicon ${group.collapsed ? 'codicon-chevron-right' : 'codicon-chevron-down'}"></span>` +
      `<span class="memo-group-name">${esc(group.name)}</span>` +
      `<span class="memo-group-count">${groupItems.length}</span>` +
      `<button class="memo-group-rename" title="名前を変更"><i class="codicon codicon-edit"></i></button>` +
      `<button class="memo-group-del" title="グループを削除"><i class="codicon codicon-trash"></i></button>`;
    sec.appendChild(ghdr);

    const glist = document.createElement('div');
    glist.className = 'memo-group-list';
    glist.dataset.groupId = group.id;
    if (group.collapsed) glist.style.display = 'none';
    groupItems.forEach(item => glist.appendChild(_makeMemoRow(item)));
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
  if (ungrouped.length || !groups.length) {
    if (groups.length) {
      const uhdr = document.createElement('div');
      uhdr.className = 'memo-group-hdr memo-group-ungrouped-hdr';
      uhdr.innerHTML = `<span class="memo-group-name" style="color:#666">未分類</span><span class="memo-group-count">${ungrouped.length}</span>`;
      body.appendChild(uhdr);
    }
    if (!allItems.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:#666;font-size:11px;padding:12px 8px';
      empty.textContent = 'メモがありません';
      body.appendChild(empty);
    } else {
      ungrouped.forEach(item => body.appendChild(_makeMemoRow(item)));
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

function _initMemoListDnd(body, allItems, groups) {
  let dragId = null;
  body.addEventListener('dragstart', e => {
    const row = e.target.closest('.memo-list-item');
    if (!row) return;
    dragId = row.dataset.id;
    setTimeout(() => row.classList.add('memo-list-dragging'), 0);
    e.dataTransfer.effectAllowed = 'move';
  });
  body.addEventListener('dragend', () => {
    body.querySelectorAll('.memo-list-item, .memo-group-hdr').forEach(r =>
      r.classList.remove('memo-list-dragging', 'memo-list-dragover', 'memo-group-dragover'));
    dragId = null;
  });
  body.addEventListener('dragover', e => {
    e.preventDefault();
    body.querySelectorAll('.memo-list-item, .memo-group-hdr').forEach(r =>
      r.classList.remove('memo-list-dragover', 'memo-group-dragover'));
    // グループヘッダへのドロップ
    const ghdr = e.target.closest('.memo-group-hdr');
    if (ghdr) { ghdr.classList.add('memo-group-dragover'); return; }
    const row = e.target.closest('.memo-list-item');
    if (row && row.dataset.id !== dragId) row.classList.add('memo-list-dragover');
  });
  body.addEventListener('drop', e => {
    e.preventDefault();
    if (!dragId) return;

    // グループヘッダにドロップ → そのグループに追加
    const ghdr = e.target.closest('.memo-group-hdr');
    if (ghdr) {
      const gid = ghdr.closest('.memo-group-section')?.dataset.groupId;
      if (gid) {
        const grps = getMemoGroups();
        // 既存のグループから除去
        grps.forEach(g => { g.itemIds = g.itemIds.filter(i => i !== dragId); });
        const target = grps.find(g => g.id === gid);
        if (target && !target.itemIds.includes(dragId)) target.itemIds.push(dragId);
        saveMemoGroups(grps);
        _renderMemoListBody(getAllMemosOrdered());
        return;
      }
    }

    // メモ行にドロップ → 並び替え（同グループ内 or 未分類内）
    const targetRow = e.target.closest('.memo-list-item');
    if (!targetRow || targetRow.dataset.id === dragId) return;

    const grps = getMemoGroups();
    // dragId が属するグループを探す
    const srcGroup = grps.find(g => g.itemIds.includes(dragId));
    const tgtGroup = grps.find(g => g.itemIds.includes(targetRow.dataset.id));

    if (srcGroup && tgtGroup && srcGroup.id === tgtGroup.id) {
      // 同グループ内並び替え
      const ids = srcGroup.itemIds;
      const fi = ids.indexOf(dragId), ti = ids.indexOf(targetRow.dataset.id);
      ids.splice(fi, 1); ids.splice(ti, 0, dragId);
      saveMemoGroups(grps);
    } else if (!srcGroup && !tgtGroup) {
      // 未分類内並び替え
      const rows = [...body.querySelectorAll('.memo-list-item')];
      const ids = rows.map(r => r.dataset.id).filter(i => !grps.some(g => g.itemIds.includes(i)));
      const fi = ids.indexOf(dragId), ti = ids.indexOf(targetRow.dataset.id);
      if (fi >= 0 && ti >= 0) { ids.splice(fi, 1); ids.splice(ti, 0, dragId); }
      // 全体の order に反映（未分類部分だけ ids の順序で置き換え）
      const order = getMemoListOrder() || allItems.map(i => i.id);
      let ui = 0;
      const newOrder = order.map(i => {
        if (!grps.some(g => g.itemIds.includes(i))) return ids[ui++] || i;
        return i;
      });
      saveMemoListOrder(newOrder);
    } else if (srcGroup && !tgtGroup) {
      // グループから未分類へ
      srcGroup.itemIds = srcGroup.itemIds.filter(i => i !== dragId);
      saveMemoGroups(grps);
    } else if (!srcGroup && tgtGroup) {
      // 未分類からグループへ
      grps.forEach(g => { g.itemIds = g.itemIds.filter(i => i !== dragId); });
      tgtGroup.itemIds.push(dragId);
      saveMemoGroups(grps);
    }
    _renderMemoListBody(getAllMemosOrdered());
  });
}
