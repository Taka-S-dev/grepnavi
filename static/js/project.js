// ===== 新しいウィンドウ =====
async function openNewWindow() {
  st('新しいウィンドウを起動中...');
  const res = await fetch('/api/new-window', {method: 'POST'}).catch(() => null);
  if(!res || !res.ok) { st('起動に失敗しました'); return; }
  const {url} = await res.json();

  // サーバーが起動するまで待ってから開く
  for(let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 300));
    try {
      const ok = await fetch(url, {mode: 'no-cors'});
      break;
    } catch(_) {}
  }
  window.open(url, '_blank');
  st('新しいウィンドウを開きました');
}

// ===== タイトル更新 =====
// file を渡すと "filename – ProjectName"、省略時は "ProjectName"
function updateTitle(file) {
  const rootName = projectRoot
    ? projectRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop() || projectRoot
    : '';
  if (pageMode === PAGE_MODES.SEARCH) {
    updateSearchTitle();
    return;
  }
  if (file) {
    const fileName = file.replace(/\\/g, '/').split('/').pop();
    document.title = rootName ? fileName + ' \u2013 ' + rootName : fileName;
  } else {
    document.title = rootName || 'コードビューア';
  }
}

// search モードのタブタイトルを `"query" (N) – ProjectName` 形式に設定。
function updateSearchTitle(query, count) {
  if (pageMode !== PAGE_MODES.SEARCH) return;
  const rootName = projectRoot
    ? projectRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop() || projectRoot
    : '';
  if (!query) {
    document.title = rootName || 'コードビューア';
    return;
  }
  const q = query.length > 40 ? query.slice(0, 39) + '…' : query;
  const countStr = count != null ? ' (' + count + ')' : '';
  document.title = '"' + q + '"' + countStr + (rootName ? ' – ' + rootName : '');
}

// ===== 汎用確認ダイアログ =====
function showConfirm(msg) {
  return new Promise(resolve => {
    id('confirm-modal-msg').textContent = msg;
    id('confirm-modal').classList.add('open');
    const ok     = id('confirm-modal-ok');
    const cancel = id('confirm-modal-cancel');
    function close(result) {
      id('confirm-modal').classList.remove('open');
      ok.onclick = null; cancel.onclick = null;
      resolve(result);
    }
    ok.onclick     = () => close(true);
    cancel.onclick = () => close(false);
  });
}

// ===== ルートチップ =====
function updateRootChip() {
  const chip = id('root-chip');
  const chipText = id('root-chip-text');
  if(!chip || !chipText) return;
  const dirVal = (id('dir')?.value || '').trim();
  const rootName = projectRoot
    ? projectRoot.replace(/\\/g,'/').split('/').filter(Boolean).pop() || projectRoot
    : '未設定';
  if(dirVal) {
    chipText.innerHTML = rootName + '<span class="chip-subdir"> ▸ ' + dirVal.replace(/</g,'&lt;') + '</span>';
    chip.classList.add('has-subdir');
    chip.title = 'ルート: ' + (projectRoot || '未設定') + '\n検索範囲: ' + dirVal + '\n(クリックでルートを変更)';
  } else {
    chipText.textContent = rootName;
    chip.classList.remove('has-subdir');
    chip.title = 'ルート: ' + (projectRoot || '未設定') + '\n(クリックで変更)';
  }
  updateTitle();
  // ルートが変わったら ignore マーカーも更新（新ルートに .gitignore 等があるか）。
  if (typeof updateIgnoreMarker === 'function') updateIgnoreMarker();
}

// ===== ディレクトリ取得 =====
async function fetchDirs() {
  if(dirList) return dirList;
  try {
    const r = await fetch('/api/dirs');
    dirList = await r.json();
  } catch(e) { dirList = []; }
  return dirList;
}

// ディレクトリ候補のマッチ文字列ハイライト
function highlightMatch(text, query) {
  if(!query) return esc(text);
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = text.toLowerCase();
  const hl = new Set();
  tokens.forEach(tok => {
    let idx = 0;
    while((idx = lower.indexOf(tok, idx)) >= 0) {
      for(let i = idx; i < idx + tok.length; i++) hl.add(i);
      idx += tok.length || 1;
    }
  });
  if(!hl.size) return esc(text);
  let result = '', open = false;
  for(let i = 0; i < text.length; i++) {
    if(hl.has(i) && !open)  { result += '<span class="dir-hl">'; open = true; }
    if(!hl.has(i) && open)  { result += '</span>'; open = false; }
    result += esc(text[i]);
  }
  if(open) result += '</span>';
  return result;
}

// ===== ルート設定 =====
async function setRoot(newRoot) {
  const r = await fetch('/api/root', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({root: newRoot})
  });
  if(!r.ok) {
    const e = await r.json().catch(()=>({}));
    st('エラー: ' + (e.error || r.statusText));
    return false;
  }
  const data = await r.json();
  projectRoot = data.root;
  const parts = data.root.replace(/\\/g,'/').split('/');
  id('root-label').textContent = parts[parts.length-1] || data.root;
  id('root-label').title = data.root + ' (クリックで変更)';
  dirList = null;
  fzfFiles = null;
  if(typeof explorerInvalidate === 'function') explorerInvalidate();
  id('dir').value = '';
  updateRootChip();

  // クライアント側をリセット
  localStorage.removeItem(LS_PROJECT_PATH);
  selNode = null; showDetail(null);
  tabs.forEach(t => { try { t.model?.dispose(); } catch(_) {} });
  tabs = []; activeTabIdx = -1;
  renderTabs();
  id('results').innerHTML = '';

  // .grepnavi からプロジェクトファイルを自動ロード
  try {
    const gnRes = await fetch('/api/grepnavi');
    const gn = await gnRes.json();
    if(gn.graph) {
      await openProject(gn.graph);
      // openProject が projectRoot を書き換えるので data.root に戻す
      projectRoot = data.root;
      const _parts = data.root.replace(/\\/g,'/').split('/');
      id('root-label').textContent = _parts[_parts.length-1] || data.root;
      id('root-label').title = data.root + ' (クリックで変更)';
      updateRootChip();
      // サーバー側の root も戻す
      await fetch('/api/root', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({root: data.root})}).catch(()=>{});
      return true;
    }
  } catch(_) {}

  // .grepnavi なし → サーバーをファイル保存なしでリセット
  window._serverGraphFile = null;
  const cleared = await fetch('/api/graph/clear', { method: 'POST' }).then(r => r.json()).catch(() => null);
  if(cleared) applyGraphResponse(cleared);
  else applyGraphResponse({ nodes: {}, edges: [], root_dir: data.root });
  markClean();
  updateProjectUI();
  st('ルート変更: ' + data.root);
  return true;
}

function showRootDialog() {
  showFileBrowser('dir', async path => {
    await setRoot(path);
  });
}

// ===== ディレクトリピッカー =====
function initDirPicker() {
  const inp = id('dir');
  const drop = id('dir-drop');

  let activeIdx = -1;
  let itemsContainer = null;

  function getItems() { return itemsContainer ? itemsContainer.querySelectorAll('.dir-item') : []; }
  function setActive(idx) {
    const items = getItems();
    [...items].forEach((el, i) => el.classList.toggle('active', i === idx));
    activeIdx = idx;
    if(items[idx]) items[idx].scrollIntoView({block:'nearest'});
  }

  // inp.value で直接フィルタリング（別途フィルター欄なし）
  function renderItems() {
    const q = inp.value.toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean);
    const filtered = (dirList||[]).filter(d => {
      if(d === '.') return false;
      if(!tokens.length) return true;
      return tokens.every(t => d.toLowerCase().includes(t));
    }).slice(0, 200);

    itemsContainer.innerHTML = '';
    if(!filtered.length) {
      itemsContainer.insertAdjacentHTML('beforeend', '<div class="dir-item" style="color:#555">一致なし</div>');
    } else {
      filtered.forEach(d => {
        const el = document.createElement('div');
        el.className = 'dir-item';
        el.innerHTML = highlightMatch(d, inp.value);
        el.onmousedown = e => {
          e.preventDefault();
          inp.value = d;
          clearBtn.style.display = '';
          updateRootChip();
          closeDrop();
        };
        itemsContainer.appendChild(el);
      });
    }
    activeIdx = -1;
  }

  function openDrop() {
    const rect = id('dir-wrap').getBoundingClientRect();
    drop.style.left  = rect.left + 'px';
    drop.style.top   = rect.bottom + 2 + 'px';
    drop.style.width = Math.max(320, rect.width) + 'px';
    if(!itemsContainer) {
      itemsContainer = document.createElement('div');
      drop.appendChild(itemsContainer);
    }
    drop.classList.add('open');
    renderItems();
  }

  let suppressOpen = false;
  let opening = false;
  function closeDrop() { drop.classList.remove('open'); activeIdx = -1; }
  function closeDropAndBlur() {
    suppressOpen = true;
    closeDrop();
    inp.blur();
    setTimeout(() => { suppressOpen = false; }, 200);
  }

  function handleDropKey(e) {
    if(!drop.classList.contains('open')) return;
    const items = getItems();
    if(e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(activeIdx+1, items.length-1)); }
    else if(e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(activeIdx-1, 0)); }
    else if(e.key === 'Enter') {
      e.preventDefault();
      if(activeIdx >= 0 && items[activeIdx]) {
        inp.value = items[activeIdx].textContent.trim();
        clearBtn.style.display = '';
        updateRootChip();
        closeDrop();
      } else { closeDrop(); }
    }
    else if(e.key === 'Escape') { closeDropAndBlur(); }
  }

  const clearBtn = id('dir-clear');
  clearBtn.onclick = e => { e.stopPropagation(); inp.value = ''; clearBtn.style.display = 'none'; updateRootChip(); inp.focus(); };

  inp.addEventListener('input', () => {
    clearBtn.style.display = inp.value ? '' : 'none';
    updateRootChip();
    if(drop.classList.contains('open')) renderItems(); // 入力と同時にリストを絞り込む
  });
  inp.addEventListener('change', () => { clearBtn.style.display = inp.value ? '' : 'none'; updateRootChip(); });
  inp.addEventListener('keydown', handleDropKey);

  async function tryOpen() {
    if(suppressOpen || opening || drop.classList.contains('open')) return;
    opening = true;
    await fetchDirs();
    opening = false;
    if(!dirList || dirList.length === 0) { showRootDialog(); return; }
    if(!drop.classList.contains('open')) openDrop();
  }
  inp.addEventListener('focus', tryOpen);
  inp.addEventListener('click', () => { if(!drop.classList.contains('open')) tryOpen(); });

  document.addEventListener('mousedown', e => {
    if(!id('dir-wrap').contains(e.target) && !drop.contains(e.target)) closeDrop();
  }, true);
  document.addEventListener('keydown', e => {
    if(e.key === 'Escape' && drop.classList.contains('open')) {
      e.stopPropagation();
      closeDropAndBlur();
    }
  }, true);
}

// ===== カラムリサイザー =====
function initColResizer() {
  const resizer = id('col-resizer');
  const left = id('pane-left');
  let startX, startW;
  resizer.addEventListener('mousedown', e => {
    startX = e.clientX;
    startW = left.offsetWidth;
    resizer.classList.add('active');
    const onMove = e => {
      const w = Math.max(200, Math.min(900, startW + e.clientX - startX));
      left.style.width = w + 'px';
    };
    const onUp = () => {
      resizer.classList.remove('active');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      localStorage.setItem('grepnavi-col-w', left.offsetWidth);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  const saved = localStorage.getItem('grepnavi-col-w');
  if(saved) left.style.width = saved + 'px';
}

// ===== プロジェクト保存/開く =====
let _dirty = false;
function markDirty() { _dirty = true;  updateProjectUI(); }
function markClean() { _dirty = false; updateProjectUI(); }

// グラフ・ツリーを変更する API 呼び出しで自動的に dirty にする
const _SKIP_DIRTY_ENDPOINTS = new Set(['/api/graph/clear', '/api/graph/openfile', '/api/graph/import', '/api/graph/saveas', '/api/graph/export', '/api/graph/memos']);
(function() {
  const _orig = window.fetch;
  window.fetch = function(url, opts) {
    const method = ((opts && opts.method) || 'GET').toUpperCase();
    if(method !== 'GET' && typeof url === 'string' &&
       (url.startsWith('/api/graph') || url.startsWith('/api/trees')) &&
       !_SKIP_DIRTY_ENDPOINTS.has(url)) {
      markDirty();
    }
    return _orig.apply(this, arguments);
  };
})();

const LS_PROJECT_PATH    = 'grepnavi_project_path';
const LS_PROJECT_HISTORY = 'grepnavi_project_history';
const LS_DIR_HISTORY     = 'grepnavi_dir_history';      // ルート選択専用
const LS_SAVE_DIR_HISTORY= 'grepnavi_save_dir_history'; // open/save フォルダ専用
const LS_GLOB_HISTORY    = 'grepnavi_glob_history';
const HISTORY_MAX = 8;

function getProjectPath() {
  return localStorage.getItem(LS_PROJECT_PATH) || '';
}
function setProjectPath(p) {
  localStorage.setItem(LS_PROJECT_PATH, p);
  if (p) {
    fetch('/api/root').then(r => r.json()).then(({ root }) => {
      if (root) localStorage.setItem('grepnavi_project_root', root.replace(/\\/g, '/'));
    }).catch(() => {});
  }
  addProjectHistory(p);
  updateProjectUI();
}

async function writeGrepnavi(p) {
  if(!projectRoot || !p) return;
  await fetch('/api/grepnavi', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({graph: p})
  }).catch(() => {});
}
function getProjectHistory() {
  try { return JSON.parse(localStorage.getItem(LS_PROJECT_HISTORY) || '[]'); } catch { return []; }
}
function addProjectHistory(p) {
  if(!p) return;
  let hist = getProjectHistory().filter(h => h !== p);
  hist.unshift(p);
  if(hist.length > HISTORY_MAX) hist = hist.slice(0, HISTORY_MAX);
  localStorage.setItem(LS_PROJECT_HISTORY, JSON.stringify(hist));
}
function getDirHistory() {
  try { return JSON.parse(localStorage.getItem(LS_DIR_HISTORY) || '[]'); } catch { return []; }
}
function addDirHistory(dir) {
  if(!dir) return;
  let hist = getDirHistory().filter(h => h !== dir);
  hist.unshift(dir);
  if(hist.length > HISTORY_MAX) hist = hist.slice(0, HISTORY_MAX);
  localStorage.setItem(LS_DIR_HISTORY, JSON.stringify(hist));
}
function getSaveDirHistory() {
  try { return JSON.parse(localStorage.getItem(LS_SAVE_DIR_HISTORY) || '[]'); } catch { return []; }
}
function addSaveDirHistory(dir) {
  if(!dir) return;
  let hist = getSaveDirHistory().filter(h => h !== dir);
  hist.unshift(dir);
  if(hist.length > HISTORY_MAX) hist = hist.slice(0, HISTORY_MAX);
  localStorage.setItem(LS_SAVE_DIR_HISTORY, JSON.stringify(hist));
}
function getGlobHistory() {
  try { return JSON.parse(localStorage.getItem(LS_GLOB_HISTORY) || '[]'); } catch { return []; }
}
function addGlobHistory(glob) {
  if(!glob) return;
  let hist = getGlobHistory().filter(h => h !== glob);
  hist.unshift(glob);
  if(hist.length > HISTORY_MAX) hist = hist.slice(0, HISTORY_MAX);
  localStorage.setItem(LS_GLOB_HISTORY, JSON.stringify(hist));
}

function initGlobPicker() {
  const inp = id('glob');
  const drop = id('glob-drop');
  if(!inp || !drop) return;
  let activeIdx = -1;

  function getItems() { return drop.querySelectorAll('.dir-item'); }
  function setActive(idx) {
    const items = getItems();
    [...items].forEach((el, i) => el.classList.toggle('active', i === idx));
    activeIdx = idx;
    if(items[idx]) items[idx].scrollIntoView({block:'nearest'});
  }

  function renderDrop(filter = true) {
    const q = filter ? inp.value.toLowerCase() : '';
    const hist = getGlobHistory().filter(h => !q || h.toLowerCase().includes(q));
    drop.innerHTML = '';
    if(!hist.length) { drop.classList.remove('open'); return; }
    hist.forEach(h => {
      const el = document.createElement('div');
      el.className = 'dir-item';
      el.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:4px';
      const txt = document.createElement('span');
      txt.textContent = h;
      txt.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis';
      const del = document.createElement('span');
      del.textContent = '✕';
      del.style.cssText = 'color:#555;font-size:10px;padding:0 2px;flex-shrink:0;cursor:pointer';
      del.onmouseenter = () => del.style.color = '#f88';
      del.onmouseleave = () => del.style.color = '#555';
      del.onmousedown = e => {
        e.preventDefault(); e.stopPropagation();
        const newHist = getGlobHistory().filter(x => x !== h);
        localStorage.setItem(LS_GLOB_HISTORY, JSON.stringify(newHist));
        renderDrop(filter);
      };
      el.onmousedown = e => { e.preventDefault(); inp.value = h; drop.classList.remove('open'); };
      el.appendChild(txt);
      el.appendChild(del);
      drop.appendChild(el);
    });
    drop.classList.add('open');
    activeIdx = -1;
  }

  inp.addEventListener('focus', () => renderDrop(true));
  inp.addEventListener('input', () => renderDrop(true));
  inp.addEventListener('blur', () => setTimeout(() => drop.classList.remove('open'), 150));
  inp.addEventListener('keydown', e => {
    if(e.key === 'ArrowDown' && !drop.classList.contains('open')) { e.preventDefault(); renderDrop(false); return; }
    if(!drop.classList.contains('open')) return;
    const items = getItems();
    if(e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(activeIdx+1, items.length-1)); }
    else if(e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(activeIdx-1, 0)); }
    else if(e.key === 'Enter') {
      if(activeIdx >= 0 && items[activeIdx]) { e.preventDefault(); inp.value = items[activeIdx].querySelector('span').textContent; drop.classList.remove('open'); }
    }
    else if(e.key === 'Escape') { drop.classList.remove('open'); }
  });
}
function updateProjectUI() {
  const p = getProjectPath();
  const el = id('project-name');
  if(!el) return;
  const serverFile = window._serverGraphFile
    ? window._serverGraphFile.replace(/\\/g, '/').split('/').pop()
    : 'graph.json';
  const base = p ? p.replace(/\\/g, '/').split('/').pop() : `無題 (${serverFile})`;
  const name = _dirty ? '* ' + base : base;
  el.textContent = name;
  el.title = p || window._serverGraphFile || '';
  const saveItem = id('pmenu-save');
  if(saveItem) saveItem.style.color = p ? '' : '#666';
}

function showProjectModal(mode) {
  _projectModalMode = mode;
  id('project-modal-title').textContent = mode === 'save' ? '名前を付けて保存' : 'プロジェクトを開く';
  id('project-modal-input').value = getProjectPath();
  renderProjectHistory();
  id('project-modal').classList.add('open');
  setTimeout(() => { id('project-modal-input').focus(); id('project-modal-input').select(); }, 50);
}

function renderProjectHistory() {
  const hist = getProjectHistory();
  const el = id('project-history');
  el.innerHTML = '';
  if(!hist.length) return;
  hist.forEach(p => {
    const name = p.replace(/\\/g, '/').split('/').pop();
    const div = document.createElement('div');
    div.className = 'phist-item';
    div.innerHTML = `<span class="phist-name">${esc(name)}</span><span class="phist-path">${esc(p)}</span>`;
    div.onclick = async () => {
      closeProjectModal();
      if(_projectModalMode === 'save') await saveProject(p);
      else await openProject(p);
    };
    el.appendChild(div);
  });
}

function closeProjectModal() {
  id('project-modal').classList.remove('open');
}

async function onProjectModalOk() {
  const p = id('project-modal-input').value.trim();
  if(!p) return;
  closeProjectModal();
  if(_projectModalMode === 'save') await saveProject(p);
  else await openProject(p);
}

async function saveProject(path) {
  const lineMemos = getLineMemos();
  const rangeMemos = getRangeMemos();
  let d;
  try {
    const r = await fetch('/api/graph/saveas', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({path, line_memos: lineMemos, range_memos: rangeMemos})
    });
    d = await r.json();
  } catch(e) {
    st('保存エラー: ' + e.message);
    return;
  }
  if(!d || d.error) { st('保存エラー: ' + (d?.error || '不明なエラー')); return; }
  _dirty = false;
  setProjectPath(path);
  await writeGrepnavi(path);
  addSaveDirHistory(path.replace(/\\/g, '/').split('/').slice(0, -1).join('/'));
  st('保存しました: ' + path);
}

async function openProject(path) {
  let d;
  try {
    const r = await fetch('/api/graph/openfile', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({path})
    });
    d = await r.json();
  } catch(e) {
    st('読み込みエラー: ' + e.message);
    return false;
  }
  if(!d || d.error) { st('読み込みエラー: ' + (d?.error || '不明なエラー')); return false; }
  if(!d.graph)      { st('読み込みエラー: レスポンスにグラフデータがありません'); return false; }
  selNode = null; showDetail(null);
  tabs.forEach(t => { try { t.model?.dispose(); } catch(_) {} });
  tabs = []; activeTabIdx = -1;
  renderTabs();
  fzfFiles = null;
  projectRoot = '';
  const resultsEl = id('results'); if (resultsEl) resultsEl.innerHTML = '';
  const paneSearch = id('pane-search'); if (paneSearch) paneSearch.style.display = '';
  // applyGraphResponse より前にlocalStorageを上書きして古いデータが描画されないようにする
  _cancelMemoSave();
  localStorage.setItem('grepnavi-line-memos',  JSON.stringify(d.graph.line_memos  || {}));
  localStorage.setItem('grepnavi-range-memos', JSON.stringify(d.graph.range_memos || []));
  localStorage.setItem('grepnavi-bookmarks',   JSON.stringify(d.graph.bookmarks   || {}));
  applyGraphResponse(d.graph);
  refreshLineMemoDecorations();
  refreshRangeMemoDecorations();
  refreshBookmarkDecorations();
  renderMemoList();
  _dirty = false;
  // サーバーがrootを切り替えた場合はUIに反映
  if (d.root) {
    projectRoot = d.root;
    const parts = d.root.replace(/\\/g, '/').split('/');
    id('root-label').textContent = parts[parts.length - 1] || d.root;
    id('root-label').title = d.root + ' (クリックで変更)';
    dirList = null; fzfFiles = null;
    if (typeof explorerInvalidate === 'function') explorerInvalidate();
    updateRootChip();
    localStorage.setItem('grepnavi_project_root', d.root.replace(/\\/g, '/'));
    if (typeof loadPinnedHighlights === 'function') loadPinnedHighlights();
  }
  setProjectPath(path);
  addSaveDirHistory(path.replace(/\\/g, '/').split('/').slice(0, -1).join('/'));
  st('読み込みました: ' + path);
  // ルートとノードのズレを検知したら気づけるように知らせる（黙って壊れないように）。
  if (d.root_warning) {
    const rw = d.root_warning;
    if (rw.root_missing) {
      st('⚠ ルートが見つかりません: ' + (rw.configured_root || '(未設定)'));
      if (typeof showAlert === 'function') {
        showAlert('このグラフのルート「' + (rw.configured_root || '(未設定)') +
          '」が見つかりません。ノードのファイルを開けません。\n左上のルートチップから正しいルートを選び直してください。');
      }
    } else if (rw.missing_files > 0) {
      st('⚠ ノードのファイルが ' + rw.missing_files + '/' + rw.sampled_files +
        ' 件見つかりません。ルートが正しいか確認してください');
    }
  }
  return true;
}

// ===== ファイルブラウザ =====


function openProjectFilePicker()   { showFileBrowser('open'); }
function saveAsProjectFilePicker() { showFileBrowser('save'); }

// ===== 設定モーダル =====

const LS_SETTINGS = 'grepnavi-app-settings';
const VSCODE_CMD  = 'code --goto {file}:{line}';

function getSettings() {
  try { return JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}'); } catch(_) { return {}; }
}
function saveSettings(s) {
  localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
}
function getEditorCmd() {
  const s = getSettings();
  const active = s.activeEditor || 'vscode';
  if(active === 'vscode') return VSCODE_CMD;
  const idx = parseInt(active.replace('custom', ''));
  return s.customEditors?.[idx]?.cmd || VSCODE_CMD;
}

// モーダル内の編集バッファ（OK 前の一時データ）
let _editingCustoms = [];

function _syncDropdownLabels() {
  const sel = id('settings-active-editor');
  sel.querySelectorAll('option').forEach((opt, i) => {
    if(i === 0) return;
    const name = _editingCustoms[i-1]?.name?.trim();
    opt.textContent = name || `カスタム ${i}`;
  });
}

function _showCustomFields(idx) {
  // idx: null = VS Code, 0/1/2 = custom slot
  const fields   = id('settings-custom-fields');
  const vsinfo   = id('settings-vscode-info');
  if(idx === null) {
    vsinfo.style.display  = '';
    fields.style.display  = 'none';
  } else {
    vsinfo.style.display  = 'none';
    fields.style.display  = 'flex';
    id('settings-custom-name').value = _editingCustoms[idx]?.name || '';
    id('settings-custom-cmd').value  = _editingCustoms[idx]?.cmd  || '';
  }
}

function _saveCurrentFieldsToBuffer(prevValue) {
  if(prevValue === 'vscode') return;
  const idx = parseInt(prevValue.replace('custom', ''));
  _editingCustoms[idx] = {
    name: id('settings-custom-name').value.trim(),
    cmd:  id('settings-custom-cmd').value.trim(),
  };
}

function showSettingsModal() {
  const s = getSettings();
  _editingCustoms = [0,1,2].map(i => ({ ...(s.customEditors?.[i] || {name:'',cmd:''}) }));
  const sel = id('settings-active-editor');
  sel.value = s.activeEditor || 'vscode';
  _syncDropdownLabels();
  const active = sel.value;
  _showCustomFields(active === 'vscode' ? null : parseInt(active.replace('custom', '')));
  id('settings-modal').classList.add('open');
}

function hideSettingsModal() {
  id('settings-modal').classList.remove('open');
}

(function initSettingsModal() {
  document.addEventListener('DOMContentLoaded', () => {
    const sel = id('settings-active-editor');
    let prevValue = 'vscode';

    sel.addEventListener('change', () => {
      _saveCurrentFieldsToBuffer(prevValue);
      prevValue = sel.value;
      _showCustomFields(sel.value === 'vscode' ? null : parseInt(sel.value.replace('custom', '')));
    });

    // 名前欄が変わったらドロップダウンのラベルをリアルタイム更新
    id('settings-custom-name').addEventListener('input', e => {
      const idx = parseInt(sel.value.replace('custom', ''));
      if(isNaN(idx)) return;
      if(!_editingCustoms[idx]) _editingCustoms[idx] = {name:'',cmd:''};
      _editingCustoms[idx].name = e.target.value;
      _syncDropdownLabels();
    });

    id('settings-modal-ok').onclick = () => {
      _saveCurrentFieldsToBuffer(sel.value);
      saveSettings({ activeEditor: sel.value, customEditors: _editingCustoms });
      hideSettingsModal();
    };
    id('settings-modal-cancel').onclick = hideSettingsModal;
    id('settings-modal').addEventListener('mousedown', e => {
      if(e.target === id('settings-modal')) hideSettingsModal();
    });
  });
})();

async function saveProjectFileCurrent() {
  const p = getProjectPath();
  if(!p) { showFileBrowser('save'); return; }
  await saveProject(p);
}

// ファイルブラウザは filebrowser.js 参照
