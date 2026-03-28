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
  if (file) {
    const fileName = file.replace(/\\/g, '/').split('/').pop();
    document.title = rootName ? fileName + ' \u2013 ' + rootName : fileName;
  } else {
    document.title = rootName || 'コードビューア';
  }
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
    chipText.textContent = rootName + ' / ' + dirVal;
    chip.classList.add('has-subdir');
    chip.title = projectRoot + ' / ' + dirVal + '\n(クリックで設定)';
  } else {
    chipText.textContent = rootName;
    chip.classList.remove('has-subdir');
    chip.title = (projectRoot || '未設定') + '\n(クリックで設定)';
  }
  updateTitle();
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
  // 未保存の変更がある場合は確認
  if(_dirty) {
    const ok = await showConfirm('未保存の変更があります。保存せずにルートを切り替えますか？');
    if(!ok) return false;
  }

  // 現在のルートとプロジェクトファイルの対応を保存しておく
  const prevRoot = projectRoot;
  const prevPath = getProjectPath();
  if(prevRoot && prevPath) setRootProjectEntry(prevRoot, prevPath);

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

  // 新しいルートに対応するプロジェクトファイルを自動で切り替える
  const savedPath = getRootProjectMap()[data.root];
  if(savedPath) {
    await openProject(savedPath);
  } else {
    localStorage.removeItem(LS_PROJECT_PATH);
    markClean();
    updateProjectUI();
    st('ルート変更: ' + data.root);
  }
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
      const w = Math.max(200, Math.min(600, startW + e.clientX - startX));
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
(function() {
  const _orig = window.fetch;
  window.fetch = function(url, opts) {
    const method = ((opts && opts.method) || 'GET').toUpperCase();
    if(method !== 'GET' && typeof url === 'string' &&
       (url.startsWith('/api/graph') || url.startsWith('/api/trees'))) {
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
const LS_ROOT_PROJECT_MAP= 'grepnavi_root_project_map'; // ルート→プロジェクトファイルの対応
const HISTORY_MAX = 8;

function getRootProjectMap() {
  try { return JSON.parse(localStorage.getItem(LS_ROOT_PROJECT_MAP) || '{}'); } catch { return {}; }
}
function setRootProjectEntry(root, path) {
  if(!root) return;
  const map = getRootProjectMap();
  if(path) map[root] = path; else delete map[root];
  localStorage.setItem(LS_ROOT_PROJECT_MAP, JSON.stringify(map));
}

function getProjectPath() {
  return localStorage.getItem(LS_PROJECT_PATH) || '';
}
function setProjectPath(p) {
  localStorage.setItem(LS_PROJECT_PATH, p);
  addProjectHistory(p);
  if(projectRoot && p) setRootProjectEntry(projectRoot, p);
  updateProjectUI();
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
  let d;
  try {
    const r = await fetch('/api/graph/saveas', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({path, line_memos: lineMemos})
    });
    d = await r.json();
  } catch(e) {
    st('保存エラー: ' + e.message);
    return;
  }
  if(!d || d.error) { st('保存エラー: ' + (d?.error || '不明なエラー')); return; }
  _dirty = false;
  setProjectPath(path);
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
    return;
  }
  if(!d || d.error) { st('読み込みエラー: ' + (d?.error || '不明なエラー')); return; }
  if(!d.graph)      { st('読み込みエラー: レスポンスにグラフデータがありません'); return; }
  selNode = null; showDetail(null);
  tabs.forEach(t => { try { t.model?.dispose(); } catch(_) {} });
  tabs = []; activeTabIdx = -1;
  renderTabs();
  fzfFiles = null;
  projectRoot = '';
  applyGraphResponse(d.graph);
  _dirty = false;
  setProjectPath(path);
  addSaveDirHistory(path.replace(/\\/g, '/').split('/').slice(0, -1).join('/'));
  st('読み込みました: ' + path);
}

// ===== ファイルブラウザ =====


function openProjectFilePicker()   { showFileBrowser('open'); }
function saveAsProjectFilePicker() { showFileBrowser('save'); }

async function saveProjectFileCurrent() {
  const p = getProjectPath();
  if(!p) { showFileBrowser('save'); return; }
  await saveProject(p);
}

// ファイルブラウザは filebrowser.js 参照
