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
    const fcount = Object.keys(fileGroupMap).length;
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
  const groups = parseFilter(raw);
  const active = raw.trim().length > 0;
  id('filter-input').classList.toggle('active', active);
  id('filter-clear').style.display = active ? '' : 'none';

  const fileOnly = id('filter-scope')?.classList.contains('on');

  document.querySelectorAll('.rg-file-group').forEach(group => {
    let groupHasVisible = false;
    group.querySelectorAll('.ri').forEach(row => {
      const file = (row.title || '').toLowerCase();
      const text = fileOnly ? '' : (row.querySelector('.ri-text')||{}).textContent?.toLowerCase() || '';
      const haystack = file + ' ' + text;
      const match = matchFilter(haystack, groups);
      row.classList.toggle('fz-hidden', !match);
      if(match) groupHasVisible = true;
    });
    group.classList.toggle('fz-hidden', !groupHasVisible);
  });
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
      const rows = [...document.querySelectorAll('.ri:not(.fz-hidden)')];
      if(!rows.length) return;
      const sel = document.querySelector('.ri.sel');
      const idx = sel ? rows.indexOf(sel) : -1;
      const next = e.key === 'ArrowDown' ? rows[idx+1]||rows[0] : rows[idx-1]||rows[rows.length-1];
      if(next) next.click();
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

function getOrCreateFileGroup(file) {
  if(fileGroupMap[file]) return fileGroupMap[file];
  const group = document.createElement('div');
  group.className = 'rg-file-group';
  const hdr = document.createElement('div');
  hdr.className = 'rg-file-hdr';
  const toggle = document.createElement('span');
  toggle.className = 'rg-toggle'; toggle.textContent = '▼';
  const iconEl = document.createElement('span');
  iconEl.innerHTML = fileIcon(file);
  const fname = document.createElement('span');
  fname.className = 'rg-fname'; fname.textContent = shortPath(file); fname.title = file;
  const fcount = document.createElement('span');
  fcount.className = 'rg-fcount'; fcount.textContent = '0件';
  hdr.append(toggle, iconEl, fname, fcount);
  const items = document.createElement('div');
  items.className = 'rg-file-items';
  hdr.onclick = () => {
    const collapsed = items.style.display === 'none';
    items.style.display = collapsed ? '' : 'none';
    toggle.textContent = collapsed ? '▼' : '▶';
  };
  group.append(hdr, items);
  id('results').appendChild(group);
  fileGroupMap[file] = {items, fcount, count: 0};
  return fileGroupMap[file];
}

function flushBatch(q) {
  if(!pending.length) return;
  const batch = pending.splice(0);
  const rendered = id('results').querySelectorAll('.ri').length;
  let added = 0;
  for(const m of batch) {
    if(rendered+added >= LIMIT) break;
    const fg = getOrCreateFileGroup(m.file);
    fg.items.appendChild(makeRI(m, true));
    fg.count++;
    fg.fcount.textContent = fg.count + '件';
    added++;
  }
  id('sh-title').textContent = `検索中... ${allMatches.length}件 "${q}"`;
}

function defKind(text, snippet, matchLine) {
  const t = (text||'').trim();
  if (/^#\s*define\s+\w/.test(t)) return 'define';
  if (/^(struct|union)\s+\w+\s*(\{|$)/.test(t)) return 'struct';
  if (/^enum\s+\w+\s*\{/.test(t)) return 'enum';
  if (/\btypedef\b/.test(t)) return 'typedef';
  const parenIdx = t.indexOf('(');
  if (!/^(if|else|while|for|switch|return|case|do)\b/.test(t) &&
      !t.startsWith('{') &&
      !t.startsWith('!') &&
      !t.startsWith('/*') &&
      !t.startsWith('//') &&
      !t.startsWith('*') &&
      !/;\s*$/.test(t) &&
      !/[&|]\s*$/.test(t) &&
      parenIdx > 0 && !/=/.test(t.slice(0, parenIdx)) &&
      !/[->.:]/.test(t.slice(0, parenIdx)) &&
      /\w+\s*\(/.test(t)) {
    if (/\{\s*$/.test(t)) return 'func';
    if(Array.isArray(snippet)) {
      // Track open parens to avoid breaking inside string arguments
      let openParens = (t.match(/\(/g)||[]).length - (t.match(/\)/g)||[]).length;
      const after = snippet.filter(s => s.line > matchLine).slice(0, 10);
      for(const s of after) {
        const st = (s.text||'').trim();
        if(!st) continue;
        openParens += (st.match(/\(/g)||[]).length - (st.match(/\)/g)||[]).length;
        if (/^\{/.test(st) || /\{\s*$/.test(st)) return 'func';
        // If parens balanced and line ends with semicolon, it's a call not a definition
        if(openParens <= 0 && /;\s*$/.test(st)) break;
        // Only break on unexpected characters when not inside an argument list
        if(openParens <= 0 && st && !/^[a-zA-Z0-9_\s,*(){}]/.test(st)) break;
      }
    }
  }
  return null;
}

function makeRI(m, compact=false) {
  const ifd = (m.ifdef_stack||[]).map(f=>'#'+f.directive+' '+f.condition).join(' > ');
  const kind = defKind(m.text, m.snippet, m.line);
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
  div.onclick = () => previewMatch(m, div);
  return div;
}

function previewMatch(m, el) {
  document.querySelectorAll('.ri').forEach(r=>r.classList.remove('sel'));
  el.classList.add('sel');
  showDetail({id:'__preview__', match:m, memo:'', label:labelFrom(m), children:[], expanded:true});
  const bd = id('btn-del');
  if(bd) bd.style.display='none';
  if(m.file) openPeek(m.file, m.line);
}

// ===== F3 検索結果ナビゲーション =====
function getVisibleResultRows() {
  return [...document.querySelectorAll('#results .ri:not(.fz-hidden)')];
}

function jumpResult(delta) {
  const rows = getVisibleResultRows();
  if(!rows.length) return;
  const cur = rows.findIndex(r => r.classList.contains('sel'));
  const next = nextResultIndex(cur, delta, rows.length);
  if(next < 0) return;
  rows[next].click();
  rows[next].scrollIntoView({block:'nearest'});
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
  const entry = searchStack[idx];
  allMatches = [...entry.allMatches];
  pending = [...entry.allMatches];
  fileGroupMap = {};
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
    el.className = 'stab sstack';
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

  id('btn-cs').onclick = () => id('btn-cs').classList.toggle('on');
  id('btn-wb').onclick = () => id('btn-wb').classList.toggle('on');
  id('btn-re').onclick = () => id('btn-re').classList.toggle('on');

  // スタック
  id('btn-stack-add').onclick = e => { e.stopPropagation(); addToSearchStack(); };
  id('btn-search-stack').onclick = e => {
    e.stopPropagation();
    if(!searchStack.length) return;
    renderSearchStack();
    id('search-stack-bar').classList.toggle('open');
  };
  document.addEventListener('click', () => id('search-stack-bar')?.classList.remove('open'));

  // 検索履歴ドロップダウン
  const toggleSearchHist = () => {
    if(!searchTabs.length) return;
    renderSearchTabs();
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
  });
  id('btn-toggle-sub').onclick = () => {
    const sub = id('bar-sub');
    const open = sub.classList.toggle('open');
    id('btn-toggle-sub').classList.toggle('open', open);
  };
}
