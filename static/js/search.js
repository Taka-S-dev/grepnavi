// ===== Virtual scroll constants =====
const VIRT_GH = 28;  // group header row height px
const VIRT_RH = 22;  // result row height px
const VIRT_OVER = 8; // overdraw rows outside viewport

// ===== 純粋関数 (Pure functions) =====

// 検索パラメータを構築して返す（DOM・副作用なし）
function buildSearchParams(q, dir, glob, isRegex, isCaseSensitive, isWord) {
  const params = new URLSearchParams({
    q,
    regex: isRegex ? '1' : '0',
    case:  isCaseSensitive ? '1' : '0',
    word:  isWord ? '1' : '0',
  });
  if(dir)  params.set('dir', dir);
  if(glob) params.set('glob', glob);
  return params;
}

// F3 ジャンプ先インデックスを計算（DOM・副作用なし）
function nextResultIndex(cur, delta, total) {
  if(total === 0) return -1;
  if(cur === -1) return delta > 0 ? 0 : total - 1;
  return (cur + delta + total) % total;
}

// 検索完了時のタイトル・overText を生成（DOM・副作用なし）
function buildSearchSummary(count, fcount, q, limit) {
  return {
    title:    `${fcount} ファイル · ${count} 件  "${q}"`,
    overText: count > limit ? `先頭${limit}件のみ表示` : '',
  };
}

// タブ配列へのupsert（DOM・副作用なし）
// 既存タブがあれば上書き、なければ追加。maxTabs を超えた場合は古い未ピンタブを削除。
function upsertSearchTab(tabs, query, data, maxTabs) {
  const next = [...tabs];
  const existing = next.findIndex(t => t.query === query);
  if(existing >= 0) {
    next[existing] = { ...next[existing], ...data };
    return { tabs: next, activeIdx: existing };
  }
  next.push({ query, ...data, pinned: false });
  let activeIdx = next.length - 1;
  if(next.length > maxTabs) {
    const unpinnedIdx = next.findIndex(t => !t.pinned);
    if(unpinnedIdx >= 0) {
      next.splice(unpinnedIdx, 1);
      activeIdx = next.length - 1;
    }
  }
  return { tabs: next, activeIdx };
}

// ===== SEARCH =====
function doSearch() {
  const q = id('q').value.trim(); if(!q) return;
  const dir = id('dir').value.trim();
  const glob = id('glob').value.trim();
  if(glob) addGlobHistory(glob);
  const isRegex = id('btn-re').classList.contains('on');
  const isCaseSensitive = id('btn-cs').classList.contains('on');
  const isWord = id('btn-wb').classList.contains('on');
  localStorage.setItem('grepnavi-settings', JSON.stringify({dir, glob, regex: isRegex, cs: isCaseSensitive, word: isWord}));

  const params = buildSearchParams(q, dir, glob, isRegex, isCaseSensitive, isWord);

  stopSearch();
  allMatches=[]; pending=[]; fileGroupMap={};
  _virtItems=[]; _visibleItems=[]; _collapsedGroups=new Set(); _selectedKey=''; _virtHeaderMap=new Map(); _virtNeedRebuild=false;
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
    const fcount = _virtItems.filter(it => it.type === 'header').length;
    const { title, overText } = buildSearchSummary(d.count, fcount, q, LIMIT);
    id('sh-title').textContent = title;
    id('sh-over').textContent = overText;
    st(`${d.count} 件ヒット  F3: 次へ  Shift+F3: 前へ`);
    saveSearchTab(q, d.count, title, overText);
  });
  sse.onerror = () => { stopSearch(); flushBatch(q); st('完了'); };
}

function stopSearch() {
  if(sse){sse.close();sse=null;}
  if(batchTimer){clearInterval(batchTimer);batchTimer=null;}
  if(spinnerTimer){clearInterval(spinnerTimer);spinnerTimer=null;}
  id('btn-stop').style.display='none';
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

// ===== フィルター =====
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
  const active = raw.trim().length > 0;
  id('filter-input').classList.toggle('active', active);
  id('filter-clear').style.display = active ? '' : 'none';
  buildVisibleItems();
  renderVirtual();
}

function initFilter() {
  const inp = id('filter-input');
  const btn = id('filter-clear');
  btn.style.display = 'none';
  inp.addEventListener('input', applyFilter);
  inp.addEventListener('keydown', e => {
    if(e.key === 'Escape') { inp.value=''; applyFilter(); inp.blur(); }
    if(e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const rows = _visibleItems.filter(it => it.type === 'row');
      if(!rows.length) return;
      const curIdx = rows.findIndex(r => (_selectedKey === r.match.file + ':' + r.match.line));
      const nextIdx = e.key === 'ArrowDown'
        ? (curIdx + 1) % rows.length
        : (curIdx - 1 + rows.length) % rows.length;
      const nextRow = rows[nextIdx];
      if(nextRow) {
        previewMatch(nextRow.match);
        scrollToVirtItem(nextRow);
      }
    }
  });
  btn.onclick = () => { inp.value=''; applyFilter(); inp.focus(); };

  const scopeBtn = id('filter-scope');
  if(scopeBtn) {
    scopeBtn.onclick = () => {
      const fileOnly = scopeBtn.classList.toggle('on');
      scopeBtn.innerHTML = fileOnly
        ? '<i class="codicon codicon-file"></i>'
        : '<i class="codicon codicon-file"></i>';
      scopeBtn.title = fileOnly
        ? '絞り込み対象: ファイル名のみ (クリックで全体に戻す)'
        : '絞り込み対象: 全体 (クリックでファイル名のみに切り替え)';
      scopeBtn.style.background = fileOnly ? '#094771' : '';
      applyFilter();
    };
  }
}

function flushBatch(q) {
  if(!pending.length) return;
  const batch = pending.splice(0);
  for(const m of batch) {
    if(allMatches.length > LIMIT) break;
    const file = m.file;
    let header = _virtHeaderMap.get(file);
    if(!header) {
      header = {type: 'header', file, count: 0};
      _virtHeaderMap.set(file, header);
      _virtItems.push(header);
    }
    header.count++;
    _virtItems.push({type: 'row', match: m, file});
  }
  _virtNeedRebuild = true;
  scheduleRender();
  id('sh-title').textContent = `検索中... ${allMatches.length}件 "${q}"`;
}

function scheduleRender() {
  if(_virtRenderTimer) return;
  _virtRenderTimer = requestAnimationFrame(() => {
    _virtRenderTimer = null;
    if(_virtNeedRebuild) { buildVisibleItems(); _virtNeedRebuild = false; }
    renderVirtual();
  });
}

function buildVisibleItems() {
  const filterStr = id('filter-input').value.trim();
  const filter = parseFilter(filterStr);
  const fileOnly = id('filter-scope')?.classList.contains('on');

  _visibleItems = [];
  let i = 0;
  while(i < _virtItems.length) {
    const item = _virtItems[i];
    if(item.type !== 'header') { i++; continue; }

    const collapsed = _collapsedGroups.has(item.file);

    // Collect rows for this group
    const groupRows = [];
    let j = i + 1;
    while(j < _virtItems.length && _virtItems[j].type === 'row' && _virtItems[j].file === item.file) {
      groupRows.push(_virtItems[j]);
      j++;
    }

    // Apply filter to rows
    let visibleRows = groupRows;
    if(filter) {
      visibleRows = groupRows.filter(r => matchFilter(
        (item.file + (fileOnly ? '' : ' ' + (r.match.text || ''))).toLowerCase(),
        filter
      ));
    }

    // Skip group entirely if filter active and no rows pass
    if(filter && visibleRows.length === 0) { i = j; continue; }

    _visibleItems.push({...item, _visibleCount: visibleRows.length});
    if(!collapsed) {
      for(const r of visibleRows) _visibleItems.push(r);
    }
    i = j;
  }
}

function renderVirtual() {
  const el = id('results');
  if(!el) return;
  const scrollTop = el.scrollTop;
  const viewH = el.clientHeight || 500;

  // Compute cumulative offsets
  let totalH = 0;
  const offsets = new Array(_visibleItems.length);
  for(let i = 0; i < _visibleItems.length; i++) {
    offsets[i] = totalH;
    totalH += _visibleItems[i].type === 'header' ? VIRT_GH : VIRT_RH;
  }

  // Find visible range
  const overPx = VIRT_OVER * VIRT_RH;
  let startIdx = 0;
  for(let i = 0; i < offsets.length; i++) {
    if(offsets[i] >= scrollTop - overPx) { startIdx = Math.max(0, i - 1); break; }
    startIdx = i;
  }
  let endIdx = _visibleItems.length;
  for(let i = startIdx; i < offsets.length; i++) {
    if(offsets[i] > scrollTop + viewH + overPx) { endIdx = i; break; }
  }

  const frag = document.createDocumentFragment();

  const topSpacer = document.createElement('div');
  topSpacer.style.height = (offsets[startIdx] || 0) + 'px';
  frag.appendChild(topSpacer);

  for(let i = startIdx; i < endIdx; i++) {
    frag.appendChild(makeVirtRow(_visibleItems[i]));
  }

  const lastRenderedEnd = endIdx > 0
    ? (offsets[endIdx - 1] || 0) + (_visibleItems[endIdx - 1]?.type === 'header' ? VIRT_GH : VIRT_RH)
    : 0;
  const botH = totalH - lastRenderedEnd;
  const botSpacer = document.createElement('div');
  botSpacer.style.height = Math.max(0, botH) + 'px';
  frag.appendChild(botSpacer);

  el.innerHTML = '';
  el.appendChild(frag);
  el.scrollTop = scrollTop;
}

function makeVirtRow(item) {
  if(item.type === 'header') {
    const div = document.createElement('div');
    div.className = 'rg-file-hdr';
    div.style.height = VIRT_GH + 'px';
    const collapsed = _collapsedGroups.has(item.file);
    const toggle = document.createElement('span');
    toggle.className = 'rg-toggle';
    toggle.textContent = collapsed ? '▶' : '▼';
    const iconEl = document.createElement('span');
    iconEl.innerHTML = fileIcon(item.file);
    const fname = document.createElement('span');
    fname.className = 'rg-fname';
    fname.textContent = shortPath(item.file);
    fname.title = item.file;
    const fcount = document.createElement('span');
    fcount.className = 'rg-fcount';
    fcount.textContent = item._visibleCount + '件';
    div.append(toggle, iconEl, fname, fcount);
    div.onclick = () => {
      if(_collapsedGroups.has(item.file)) _collapsedGroups.delete(item.file);
      else _collapsedGroups.add(item.file);
      buildVisibleItems();
      renderVirtual();
    };
    return div;
  } else {
    const div = makeRI(item.match, true);
    div.style.height = VIRT_RH + 'px';
    div.style.overflow = 'hidden';
    if(_selectedKey === item.match.file + ':' + item.match.line) div.classList.add('sel');
    div.onclick = () => {
      previewMatch(item.match);
    };
    return div;
  }
}

// Scroll the #results container so that a virtual item is in view
function scrollToVirtItem(targetItem) {
  const el = id('results');
  if(!el) return;
  let offset = 0;
  for(const item of _visibleItems) {
    if(item === targetItem) break;
    offset += item.type === 'header' ? VIRT_GH : VIRT_RH;
  }
  const itemH = targetItem.type === 'header' ? VIRT_GH : VIRT_RH;
  const viewH = el.clientHeight;
  if(offset < el.scrollTop) {
    el.scrollTop = offset;
  } else if(offset + itemH > el.scrollTop + viewH) {
    el.scrollTop = offset + itemH - viewH;
  }
  renderVirtual();
}

function makeRI(m, compact=false) {
  const ifd = (m.ifdef_stack||[]).map(f=>'#'+f.directive+' '+f.condition).join(' > ');
  const kind = m.kind || null;
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
  div.querySelector('.ri-open').onclick = e => { e.stopPropagation(); if(e.ctrlKey || e.metaKey) openFile(m.file, m.line); };
  div.onclick = () => previewMatch(m);
  return div;
}

function previewMatch(m) {
  _selectedKey = m.file + ':' + m.line;
  // Re-render to update .sel on visible rows
  renderVirtual();
  showDetail({id:'__preview__', match:m, memo:'', label:labelFrom(m), children:[], expanded:true});
  const bd = id('btn-del');
  if(bd) bd.style.display='none';
  if(m.file) openPeek(m.file, m.line);
}

// ===== F3 検索結果ナビゲーション =====
function jumpResult(delta) {
  const rows = _visibleItems.filter(it => it.type === 'row');
  if(!rows.length) return;
  const cur = rows.findIndex(r => _selectedKey === r.match.file + ':' + r.match.line);
  const next = nextResultIndex(cur, delta, rows.length);
  if(next < 0) return;
  const nextRow = rows[next];
  previewMatch(nextRow.match);
  scrollToVirtItem(nextRow);
}

// ===== 検索履歴タブ =====
function saveSearchTab(query, count, title, overText) {
  const filterValue = id('filter-input').value;
  const data = { count, title, overText, filterValue, allMatches: [...allMatches] };
  const result = upsertSearchTab(searchTabs, query, data, MAX_SEARCH_TABS);
  searchTabs = result.tabs;
  activeSearchTab = result.activeIdx;
  renderSearchTabs();
  const wrap = id('search-stack-wrap');
  if(wrap) wrap.style.display = '';
}

function pinSearchTab(idx) {
  if(idx < 0 || idx >= searchTabs.length) return;
  searchTabs[idx].pinned = !searchTabs[idx].pinned;
  _savePinnedTabs();
  renderSearchTabs();
}

function _savePinnedTabs() {
  const pinned = searchTabs.filter(t => t.pinned).map(t => ({
    query: t.query, count: t.count, title: t.title,
    overText: t.overText, filterValue: t.filterValue,
    allMatches: t.allMatches, pinned: true,
  }));
  try { localStorage.setItem(LS_PINNED_TABS, JSON.stringify(pinned)); } catch {}
}

function _loadPinnedTabs() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_PINNED_TABS) || '[]');
    saved.forEach(t => {
      if(!searchTabs.find(s => s.query === t.query)) searchTabs.push(t);
    });
  } catch {}
}

function switchSearchTab(idx) {
  if(idx < 0 || idx >= searchTabs.length) return;
  stopSearch();
  activeSearchTab = idx;
  const tab = searchTabs[idx];

  allMatches = [...tab.allMatches];
  pending = [...tab.allMatches];
  fileGroupMap = {};
  _virtItems = []; _visibleItems = []; _collapsedGroups = new Set(); _selectedKey = ''; _virtHeaderMap = new Map(); _virtNeedRebuild = false;
  id('results').innerHTML = '';

  flushBatch(tab.query);
  id('sh-title').textContent = tab.title;
  id('sh-over').textContent = tab.overText || '';
  st(`${tab.count} 件ヒット  F3: 次へ  Shift+F3: 前へ`);

  const filterVal = tab.filterValue || '';
  id('filter-input').value = filterVal;
  filterTokens = [];
  if(filterVal) {
    applyFilter();
  } else {
    id('filter-input').classList.remove('active');
    id('filter-clear').style.display = 'none';
  }

  renderSearchTabs();
}

function closeSearchTab(idx) {
  if(searchTabs[idx]?.pinned) _savePinnedTabs();
  searchTabs.splice(idx, 1);
  _savePinnedTabs();
  if(!searchTabs.length) {
    activeSearchTab = -1;
    id('results').innerHTML = '';
    id('sh-title').textContent = '検索結果';
    id('sh-over').textContent = '';
    allMatches = []; pending = []; fileGroupMap = {};
    _virtItems = []; _visibleItems = []; _collapsedGroups = new Set(); _selectedKey = ''; _virtHeaderMap = new Map(); _virtNeedRebuild = false;
    renderSearchTabs();
    return;
  }
  const next = Math.min(idx, searchTabs.length - 1);
  switchSearchTab(next);
}

function renderSearchTabs() {
  const btn = id('btn-search-hist');
  const bar = id('search-tab-bar');
  if(!btn || !bar) return;

  if(searchTabs.length === 0) {
    btn.style.display = 'none';
    bar.classList.remove('open');
    return;
  }

  btn.style.display = '';
  btn.textContent = `履歴 ${searchTabs.length} ▾`;

  // ピン留め済みを上、それ以外を新しい順に並べる
  const pinnedIdxs   = searchTabs.map((t,i)=>({t,i})).filter(x=>x.t.pinned);
  const unpinnedIdxs = searchTabs.map((t,i)=>({t,i})).filter(x=>!x.t.pinned).reverse();

  bar.innerHTML = '';
  const makeItem = ({t: tab, i}) => {
    const el = document.createElement('div');
    el.className = 'stab' + (i === activeSearchTab ? ' active' : '') + (tab.pinned ? ' pinned' : '');

    const lbl = document.createElement('span');
    lbl.className = 'stab-lbl';
    lbl.textContent = tab.query;
    lbl.title = tab.title;

    const cnt = document.createElement('span');
    cnt.className = 'stab-cnt';
    cnt.textContent = tab.count + '件';

    const dot = document.createElement('span');
    dot.className = 'stab-dot';
    dot.title = tab.pinned ? 'ピン留め解除' : 'ピン留め';
    dot.onclick = e => { e.stopPropagation(); pinSearchTab(i); };

    const cls = document.createElement('span');
    cls.className = 'stab-close';
    cls.textContent = '×';
    cls.onclick = e => { e.stopPropagation(); closeSearchTab(i); };

    el.append(dot, lbl, cnt, cls);
    el.onclick = () => { switchSearchTab(i); bar.classList.remove('open'); };
    bar.appendChild(el);
  };

  pinnedIdxs.forEach(makeItem);
  if(pinnedIdxs.length && unpinnedIdxs.length) {
    const sep = document.createElement('div');
    sep.className = 'stab-sep';
    bar.appendChild(sep);
  }
  unpinnedIdxs.forEach(makeItem);
}

// ===== 検索スタック =====

function addToSearchStack() {
  if(activeSearchTab < 0 || !searchTabs[activeSearchTab]) return;
  const tab = searchTabs[activeSearchTab];
  if(searchStack.find(s => s.query === tab.query)) {
    st('既にスタックに追加済みです');
    return;
  }
  searchStack.push({ query: tab.query, count: tab.count, title: tab.title,
    overText: tab.overText, filterValue: tab.filterValue, allMatches: [...tab.allMatches] });
  _saveSearchStack();
  renderSearchStack();
  st('スタックに追加: ' + tab.query);
}

function removeFromSearchStack(idx) {
  searchStack.splice(idx, 1);
  _saveSearchStack();
  renderSearchStack();
}

function switchSearchStack(idx) {
  if(idx < 0 || idx >= searchStack.length) return;
  _currentStackIdx = idx;
  const entry = searchStack[idx];
  allMatches = [...entry.allMatches];
  pending = [...entry.allMatches];
  fileGroupMap = {};
  _virtItems = []; _visibleItems = []; _collapsedGroups = new Set(); _selectedKey = ''; _virtHeaderMap = new Map(); _virtNeedRebuild = false;
  id('results').innerHTML = '';
  flushBatch(entry.query);
  id('sh-title').textContent = entry.title;
  id('sh-over').textContent = entry.overText || '';
  st(`${entry.count} 件ヒット`);
  const filterVal = entry.filterValue || '';
  id('filter-input').value = filterVal;
  filterTokens = [];
  if(filterVal) applyFilter();
  else { id('filter-input').classList.remove('active'); id('filter-clear').style.display = 'none'; }
  id('search-stack-bar').classList.remove('open');
}

function renderSearchStack() {
  const btn = id('btn-search-stack');
  const bar = id('search-stack-bar');
  if(!btn || !bar) return;
  btn.textContent = searchStack.length ? `スタック ${searchStack.length} ▾` : 'スタック ▾';
  if(searchStack.length === 0) {
    bar.classList.remove('open');
    return;
  }
  bar.innerHTML = '';
  searchStack.forEach((entry, i) => {
    const el = document.createElement('div');
    el.className = 'stab sstack' + (i === _currentStackIdx ? ' active' : '');
    el.draggable = true;

    el.addEventListener('dragstart', e => {
      _stackDragIdx = i;
      el.classList.add('sstack-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      _stackDragIdx = null;
      bar.querySelectorAll('.sstack-drag-over').forEach(n => n.classList.remove('sstack-drag-over'));
      bar.querySelectorAll('.sstack-dragging').forEach(n => n.classList.remove('sstack-dragging'));
    });
    el.addEventListener('dragover', e => {
      if(_stackDragIdx === null || _stackDragIdx === i) return;
      e.preventDefault();
      bar.querySelectorAll('.sstack-drag-over').forEach(n => n.classList.remove('sstack-drag-over'));
      el.classList.add('sstack-drag-over');
    });
    el.addEventListener('drop', e => {
      e.preventDefault();
      if(_stackDragIdx === null || _stackDragIdx === i) return;
      const moved = searchStack.splice(_stackDragIdx, 1)[0];
      searchStack.splice(i, 0, moved);
      _saveSearchStack();
      renderSearchStack();
    });

    const handle = document.createElement('span');
    handle.className = 'sstack-handle';
    handle.textContent = '⠿';
    handle.title = 'ドラッグで並び替え';

    const body = document.createElement('span');
    body.className = 'sstack-body';

    const lbl = document.createElement('span');
    lbl.className = 'stab-lbl';
    lbl.textContent = entry.query;
    lbl.title = entry.title;

    const labelEl = document.createElement('span');
    labelEl.className = 'sstack-label' + (entry.label ? ' has-label' : '');
    labelEl.textContent = entry.label || '+ ラベル';
    labelEl.title = 'クリックで編集';
    labelEl.onclick = e => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.className = 'sstack-label-input';
      input.value = entry.label || '';
      input.placeholder = 'ラベルを入力…';
      labelEl.replaceWith(input);
      input.focus();
      input.select();
      const commit = () => {
        const val = input.value.trim();
        searchStack[i].label = val;
        _saveSearchStack();
        renderSearchStack();
      };
      input.onblur = commit;
      input.onkeydown = e2 => {
        if(e2.key === 'Enter') { e2.preventDefault(); input.blur(); }
        if(e2.key === 'Escape') { input.onblur = null; renderSearchStack(); }
      };
    };

    const cnt = document.createElement('span');
    cnt.className = 'stab-cnt';
    cnt.textContent = entry.count + '件';

    const cls = document.createElement('span');
    cls.className = 'stab-close';
    cls.textContent = '×';
    cls.onclick = e => { e.stopPropagation(); removeFromSearchStack(i); };

    body.append(lbl, labelEl);
    el.append(handle, body, cnt, cls);
    el.onclick = () => switchSearchStack(i);
    bar.appendChild(el);
  });
}

function _saveSearchStack() {
  try { localStorage.setItem(LS_SEARCH_STACK, JSON.stringify(searchStack)); } catch {}
}

function _loadSearchStack() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_SEARCH_STACK) || '[]');
    searchStack = saved;
  } catch {}
}

// ===== 検索バー初期化 =====
function initSearchBar() {
  _loadPinnedTabs();
  renderSearchTabs();
  _loadSearchStack();
  renderSearchStack();
  if(searchStack.length) { const w = id('search-stack-wrap'); if(w) w.style.display = ''; }

  // Virtual scroll: re-render on scroll
  const resultsEl = id('results');
  if(resultsEl) resultsEl.addEventListener('scroll', () => renderVirtual(), {passive: true});

  id('btn-cs').onclick = () => id('btn-cs').classList.toggle('on');
  id('btn-wb').onclick = () => id('btn-wb').classList.toggle('on');
  id('btn-re').onclick = () => id('btn-re').classList.toggle('on');

  // スタック
  id('btn-stack-add').onclick = e => { e.stopPropagation(); addToSearchStack(); };
  id('btn-search-stack').onclick = e => {
    e.stopPropagation();
    if(!searchStack.length) return;
    renderSearchStack();
    id('search-tab-bar')?.classList.remove('open');
    id('search-stack-bar').classList.toggle('open');
  };
  document.addEventListener('click', () => id('search-stack-bar')?.classList.remove('open'));

  // 検索履歴ドロップダウン
  const toggleSearchHist = () => {
    if(!searchTabs.length) return;
    renderSearchTabs();
    id('search-stack-bar')?.classList.remove('open');
    id('search-tab-bar').classList.toggle('open');
  };
  id('btn-search-hist').onclick = e => { e.stopPropagation(); toggleSearchHist(); };
  document.addEventListener('click', () => id('search-tab-bar')?.classList.remove('open'));
  document.addEventListener('keydown', e => {
    if(e.altKey && e.key.toLowerCase() === 'h') { e.preventDefault(); toggleSearchHist(); }
  });
  document.addEventListener('keydown', e => {
    if(e.altKey && e.key.toLowerCase() === 'c') { e.preventDefault(); id('btn-cs').click(); }
    if(e.altKey && e.key.toLowerCase() === 'w') { e.preventDefault(); id('btn-wb').click(); }
    if(e.altKey && e.key.toLowerCase() === 'r') { e.preventDefault(); id('btn-re').click(); }
    if(e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); id('q').focus(); id('q').select(); }
    if(e.ctrlKey && !e.shiftKey && e.key === 'Enter' && document.activeElement === id('q')) { e.preventDefault(); addToSearchStack(); }
    if(e.altKey && e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if(!searchStack.length) return;
      renderSearchStack();
      id('search-tab-bar')?.classList.remove('open');
      id('search-stack-bar').classList.toggle('open');
    }
  });
  id('btn-toggle-sub').onclick = () => {
    const sub = id('bar-sub');
    const open = sub.classList.toggle('open');
    id('btn-toggle-sub').classList.toggle('open', open);
  };
}

if (typeof module !== 'undefined') module.exports = { buildSearchParams, nextResultIndex, buildSearchSummary, upsertSearchTab };
