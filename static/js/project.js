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
  id('dir').value = '';
  updateRootChip();
  st('ルート変更: ' + data.root);
  return true;
}

function showRootDialog() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center';
  const box = document.createElement('div');
  box.style.cssText = 'background:#252526;border:1px solid #555;border-radius:6px;padding:20px;width:480px;display:flex;flex-direction:column;gap:10px';
  box.innerHTML = `
    <div style="font-size:13px;color:#ccc;font-weight:600">プロジェクトルートを設定</div>
    <div style="font-size:11px;color:#888">検索対象のルートディレクトリの絶対パスを入力してください</div>
    <div style="display:flex;gap:6px">
      <input id="root-inp" type="text" value="${esc(projectRoot)}" placeholder="例: C:\\Users\\you\\project" style="flex:1;min-width:0;box-sizing:border-box;background:#3c3c3c;border:1px solid #555;color:#ccc;padding:6px 8px;border-radius:3px;font-size:12px;font-family:Consolas,monospace">
      <button id="root-browse" class="sec" title="フォルダを選択"><span class="codicon codicon-folder"></span></button>
    </div>
    <div style="display:flex;gap:6px;justify-content:flex-end">
      <button id="root-cancel" class="sec">キャンセル</button>
      <button id="root-ok">設定</button>
    </div>`;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  const inp = box.querySelector('#root-inp');
  inp.focus(); inp.select();
  box.querySelector('#root-browse').onclick = async () => {
    const res = await fetch('/api/pick-dir').then(r => r.json()).catch(() => null);
    if(res?.path) inp.value = res.path;
  };

  const close = () => document.body.removeChild(overlay);
  box.querySelector('#root-cancel').onclick = close;
  box.querySelector('#root-ok').onclick = async () => {
    const val = inp.value.trim();
    if(!val) return;
    const ok = await setRoot(val);
    if(ok) close();
  };
  inp.onkeydown = async e => {
    if(e.key === 'Enter') { box.querySelector('#root-ok').click(); }
    if(e.key === 'Escape') close();
  };
  overlay.onclick = e => { if(e.target === overlay) close(); };
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
const LS_PROJECT_PATH    = 'grepnavi_project_path';
const LS_PROJECT_HISTORY = 'grepnavi_project_history';
const LS_DIR_HISTORY     = 'grepnavi_dir_history';
const LS_GLOB_HISTORY    = 'grepnavi_glob_history';
const HISTORY_MAX = 8;

function getProjectPath() {
  return localStorage.getItem(LS_PROJECT_PATH) || '';
}
function setProjectPath(p) {
  localStorage.setItem(LS_PROJECT_PATH, p);
  addProjectHistory(p);
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
  const name = p ? p.replace(/\\/g, '/').split('/').pop() : '無題';
  el.textContent = name;
  el.title = p || '';
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
  const r = await fetch('/api/graph/saveas', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({path, line_memos: lineMemos})
  });
  const d = await r.json();
  if(d.error) { st('保存エラー: ' + d.error); return; }
  setProjectPath(path);
  st('保存しました: ' + path);
}

async function openProject(path) {
  const r = await fetch('/api/graph/openfile', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({path})
  });
  const d = await r.json();
  if(d.error) { st('読み込みエラー: ' + d.error); return; }
  selNode = null; showDetail(null);
  tabs.forEach(t => t.model.dispose());
  tabs = []; activeTabIdx = -1;
  renderTabs();
  fzfFiles = null;
  projectRoot = '';
  applyGraphResponse(d.graph);
  setProjectPath(path);
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

async function showFileBrowser(mode) {
  _fbMode = mode;
  id('fb-title').textContent = mode === 'save' ? '名前を付けて保存' : 'プロジェクトを開く';
  id('fb-ok').textContent    = mode === 'save' ? '保存' : '開く';
  id('fb-overlay').classList.add('open');

  // 初期ディレクトリ: 前回パス → プロジェクトルート → ホーム
  const cur = getProjectPath();
  const startDir = cur
    ? cur.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
    : '';
  await fbNavigate(startDir);

  // 保存モードは前回ファイル名を引き継ぐ
  if(mode === 'save') {
    const name = cur ? cur.replace(/\\/g, '/').split('/').pop() : 'project.json';
    id('fb-filename').value = name;
  } else {
    id('fb-filename').value = '';
  }
}

async function fbNavigate(dir) {
  const params = new URLSearchParams({ ext: '.json' });
  if(dir) params.set('path', dir);
  const res = await fetch('/api/browse?' + params).catch(() => null);
  if(!res || !res.ok) { st('ディレクトリを開けませんでした'); return; }
  const data = await res.json();

  _fbCurrentPath = data.path;
  id('fb-path-input').value = data.path;
  id('fb-up').disabled = !data.parent;
  addDirHistory(data.path);

  const list = id('fb-list');
  list.innerHTML = '';

  // 最近使ったファイル（開くモード時のみ表示）
  const hist = getProjectHistory();
  if(hist.length) {
    const label = document.createElement('div');
    label.className = 'fb-section-label';
    label.textContent = '最近使ったファイル';
    list.appendChild(label);
    hist.slice(0, 8).forEach(p => {
      const name = p.replace(/\\/g, '/').split('/').pop();
      const dir  = p.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      const row  = document.createElement('div');
      row.className = 'fb-item fb-file fb-recent';
      row.innerHTML = `<i class="codicon codicon-history"></i><span title="${esc(p)}">${esc(name)}</span><span class="fb-recent-dir">${esc(dir)}</span>`;
      if(_fbMode === 'open') {
        row.ondblclick = async () => { closeFb(); await openProject(p); };
        row.onclick = () => {
          list.querySelectorAll('.fb-item').forEach(r => r.classList.remove('selected'));
          row.classList.add('selected');
          id('fb-filename').value = name;
          fbNavigate(dir);
        };
      } else {
        row.onclick = () => {
          list.querySelectorAll('.fb-item').forEach(r => r.classList.remove('selected'));
          row.classList.add('selected');
          id('fb-filename').value = name;
          fbNavigate(dir);
        };
      }
      list.appendChild(row);
    });
    const sep = document.createElement('div');
    sep.className = 'fb-section-sep';
    list.appendChild(sep);
  }

  // 最近使ったフォルダ
  const dirHist = getDirHistory().filter(d => d !== data.path);
  if(dirHist.length) {
    const label = document.createElement('div');
    label.className = 'fb-section-label';
    label.textContent = '最近使ったフォルダ';
    list.appendChild(label);
    dirHist.slice(0, 5).forEach(dir => {
      const name = dir.replace(/\\/g, '/').split('/').pop() || dir;
      const row  = document.createElement('div');
      row.className = 'fb-item fb-dir fb-recent';
      row.innerHTML = `<i class="codicon codicon-folder"></i><span title="${esc(dir)}">${esc(name)}</span><span class="fb-recent-dir">${esc(dir)}</span>`;
      row.ondblclick = () => fbNavigate(dir);
      row.onclick    = () => fbSelectDir(row);
      list.appendChild(row);
    });
    const sep2 = document.createElement('div');
    sep2.className = 'fb-section-sep';
    list.appendChild(sep2);
  }

  (data.dirs || []).forEach(name => {
    const row = document.createElement('div');
    row.className = 'fb-item fb-dir';
    row.innerHTML = `<i class="codicon codicon-folder"></i><span>${esc(name)}</span>`;
    row.ondblclick = () => fbNavigate(data.path + '/' + name);
    row.onclick    = () => fbSelectDir(row);
    list.appendChild(row);
  });

  (data.files || []).forEach(name => {
    const row = document.createElement('div');
    row.className = 'fb-item fb-file';
    row.innerHTML = `<i class="codicon codicon-json"></i><span>${esc(name)}</span>`;
    row.onclick = () => {
      list.querySelectorAll('.fb-item').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      id('fb-filename').value = name;
    };
    row.ondblclick = () => { id('fb-filename').value = name; fbOk(); };
    list.appendChild(row);
  });
}

function fbSelectDir(row) {
  id('fb-list').querySelectorAll('.fb-item').forEach(r => r.classList.remove('selected'));
  row.classList.add('selected');
}

async function fbOk() {
  const filename = id('fb-filename').value.trim();
  if(!filename) return;
  let fullPath = _fbCurrentPath.replace(/\\/g, '/');
  if(!fullPath.endsWith('/')) fullPath += '/';
  fullPath += filename.endsWith('.json') ? filename : filename + '.json';

  closeFb();
  if(_fbMode === 'save') await saveProject(fullPath);
  else                   await openProject(fullPath);
}

function closeFb() {
  id('fb-overlay').classList.remove('open');
}

addEventListener('DOMContentLoaded', () => {
  id('fb-close').onclick   = closeFb;
  id('fb-cancel').onclick  = closeFb;
  id('fb-ok').onclick      = fbOk;
  id('fb-overlay').addEventListener('click', e => { if(e.target === id('fb-overlay')) closeFb(); });
  id('fb-up').onclick      = () => {
    const parent = id('fb-path-input').value.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    if(parent) fbNavigate(parent);
  };
  id('fb-path-go').onclick = () => fbNavigate(id('fb-path-input').value.trim());
  id('fb-path-input').onkeydown = e => { if(e.key === 'Enter') fbNavigate(id('fb-path-input').value.trim()); };
  id('fb-filename').onkeydown   = e => { if(e.key === 'Enter') fbOk(); };
});
