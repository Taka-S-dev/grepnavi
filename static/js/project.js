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

// 確認ダイアログは utils.js の showConfirm (gn-dialog) を使う。かつてここに
// 独自実装があり、読み込み順の後勝ちで utils 版を上書きして danger 等の
// オプションを黙って無効化していた。

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
    if(!r.ok) throw new Error(r.statusText);
    dirList = await r.json();
  } catch(e) { dirList = null; } // 失敗はキャッシュしない（次のフォーカスで再試行できるように）
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
// .grepnavi が覚えているグラフのうち、最後に使ったものを返す。
// /api/grepnavi の応答は {root, graphs:[...]} で、graph という単数の
// フィールドは無い。そこを読んでいた箇所は常に undefined で、ルート
// ごとのグラフを開き直す経路が一度も動いていなかった。
function lastGraphOf(cfg) {
  const list = Array.isArray(cfg?.graphs) ? cfg.graphs : [];
  return list.length ? list[list.length - 1] : '';
}

// 開いたグラフを一覧の末尾へ寄せる。記録は「初めて登録した順」で、開いても
// 並びが変わらないため、寄せておかないと lastGraphOf が「最後に使ったもの」
// ではなく「最初に登録したうちの最後」を指してしまう。
// 失敗しても実害は無い (次に開いたときの候補が古いままになるだけ)。
async function bumpGrepnaviGraph(path) {
  if(!path) return;
  try {
    const cfg = await (await fetch('/api/grepnavi')).json();
    const list = Array.isArray(cfg?.graphs) ? cfg.graphs : [];
    const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
    const rest = list.filter(g => norm(g) !== norm(path));
    if(rest.length === list.length - 1 && list.length && norm(list[list.length - 1]) === norm(path)) return; // 既に末尾
    await fetch('/api/grepnavi/graphs', {
      method: 'PUT', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ grepnaviFile: cfg.root + '/.grepnavi', graphs: [...rest, path] }),
    });
  } catch(_) { /* ignore */ }
}

// ルートを切り替えると、グラフもそのルートのものへ入れ替わる
// （.grepnavi に記録があればそれを開き、無ければ空から始める）。
// 調査対象が変わったのに前のツリーのノードが残っていても使い道が無いため。
//
// 入れ替えで本当に失われるのは、保存先がまだ決まっていないグラフだけ。
// 名前を付けたものも作業ファイルもディスクに残るので、開き直せる。
async function setRoot(newRoot) {
  const nodeCount = Object.keys(graph?.nodes || {}).length;
  if(nodeCount > 0 && projectSaveState().kind === 'unsaved') {
    const ok = await showConfirm(
      `保存先が決まっていないグラフ（${nodeCount} ノード）は、ルートを切り替えると失われます。\n\n` +
      `続けますか？（キャンセルして Ctrl+S で保存してからでも切り替えられます）`,
      { danger: true });
    if(!ok) return false;
  }
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

  // どのルートへ移ったかを先に出す。この後 openProject が「読み込みました」や
  // ルート不一致の警告を出すので、順番を逆にするとその警告を消してしまう。
  st('ルート変更: ' + data.root);

  // .grepnavi からプロジェクトファイルを自動ロード
  try {
    const gnRes = await fetch('/api/grepnavi');
    const gn = await gnRes.json();
    const last = lastGraphOf(gn);
    if(last && await openProject(last)) {
      // openProject が projectRoot を書き換えるので data.root に戻す
      projectRoot = data.root;
      const _parts = data.root.replace(/\\/g,'/').split('/');
      id('root-label').textContent = _parts[_parts.length-1] || data.root;
      id('root-label').title = data.root + ' (クリックで変更)';
      updateRootChip();
      // サーバー側の root も戻す
      await fetch('/api/root', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({root: data.root})}).catch(()=>{});
      updateProjectUI();
      return true;
    }
  } catch(_) {}

  // .grepnavi なし → サーバーをファイル保存なしでリセット
  window._serverGraphFile = null;
  const cleared = await fetch('/api/graph/clear', { method: 'POST' }).then(r => r.json()).catch(() => null);
  if(cleared) applyGraphResponse(cleared);
  else applyGraphResponse({ nodes: {}, edges: [], root_dir: data.root });
  updateProjectUI();
  st('ルート変更: ' + data.root + '（新しいグラフ。Ctrl+S で保存すると次回も開けます）');
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

  function renderMessage(msg) {
    itemsContainer.innerHTML = '';
    itemsContainer.insertAdjacentHTML('beforeend', `<div class="dir-item" style="color:#555">${esc(msg)}</div>`);
    activeIdx = -1;
  }

  function renderLoading() {
    itemsContainer.innerHTML = '<div class="dir-item dir-item-loading"><span class="dir-spin"></span> 読み込み中...</div>';
    activeIdx = -1;
  }

  function openDrop(loadingMsg) {
    const rect = id('dir-wrap').getBoundingClientRect();
    drop.style.left  = rect.left + 'px';
    drop.style.top   = rect.bottom + 2 + 'px';
    drop.style.width = Math.max(320, rect.width) + 'px';
    if(!itemsContainer) {
      itemsContainer = document.createElement('div');
      drop.appendChild(itemsContainer);
    }
    drop.classList.add('open');
    if(loadingMsg) renderLoading(); else renderItems();
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
    if(dirList) { openDrop(); return; }
    // 初回は /api/dirs の取得待ちがある（大きいリポジトリでは数秒）。
    // 待っている間なにも出ないと「開かない」ように見えるので、先に開いて即時フィードバックする。
    openDrop(true);
    opening = true;
    try { await fetchDirs(); } finally { opening = false; }
    // 取得中にフォーカスが外れていたら、今さら開いたままにしない
    if(document.activeElement !== inp) { closeDrop(); return; }
    if(dirList === null) { renderMessage('ディレクトリ一覧の取得に失敗しました'); return; }
    if(dirList.length === 0) { closeDrop(); showRootDialog(); return; }
    renderItems();
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
// 未保存マーク (*) は置かない。サーバは変更のたびに「今開いているファイル」へ
// 自動保存し、名前を付けて保存するとその名前付きファイルが保存先になる
// (Store.SaveAs が filePath を差し替える)。名前付きでも自動保存される以上、
// 「保存すべき変更が溜まっている」状態は存在しない。
// 以前は API の URL から dirty を推測していたが、読み取り専用の POST まで
// 変更と数えてしまい、印が常時点灯したり一瞬で消えたりして機能していなかった。
// 危険なのは保存先そのものが無いとき (kind:'unsaved') だけなので、そこに絞って知らせる。
let _noticedUnnamed = false;
function noticeUnnamedOnce() {
  if(_noticedUnnamed) return;
  _noticedUnnamed = true;
  if(typeof st === 'function') st('保存先が未指定です。Ctrl+S で保存すると次回も開けます');
}

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
// グラフはサーバが変更のたびに作業ファイル（-graph、既定 graph.json）へ
// 自動保存し、起動時に読み直す。名前を付けて保存していない状態でもデータは失われない。
// 旧表示の「無題 (graph.json)」は「まだ何も保存されていない」と読めてしまい、
// 実際には前回の続きが読み込まれているのに、それが伝わらなかった。
// 保存状態は3つあり、旧 UI は下2つを同じ「無題 (graph.json)」で表示していた。
// 片方は自動保存済みで安全、もう片方は保存先が無く閉じると消える。
//   named    名前を付けて保存したファイルがある
//   working  サーバの作業ファイル（-graph、既定 graph.json）に自動保存される
//   unsaved  新規 JSON 直後・ルート切替直後。保存先が無く、書き込まれない
// ===== 前回の作業の復元 =====
// 起動時は必ず空のグラフから始める（名前を付けなければ一時的、というルールを一本にする）。
// 前回の内容は復元ファイルへ退避されているので、戻る手段だけメニューに出す。
let _recoverInfo = null;

async function refreshRecoverItem() {
  const item = id('pmenu-recover');
  if(!item) return;
  try {
    const r = await fetch('/api/root');
    const d = await r.json();
    _recoverInfo = d.recover || null;
  } catch(_) { _recoverInfo = null; }
  if(_recoverInfo) {
    item.textContent = `前回の作業を復元 (${_recoverInfo.nodes} ノード)`;
    item.title = _recoverInfo.path;
    item.style.display = '';
  } else {
    item.style.display = 'none';
  }
}

async function restorePreviousWork() {
  if(!_recoverInfo) return;
  if(Object.keys(graph.nodes || {}).length > 0) {
    const ok = await showConfirm(
      `現在のグラフを、前回の作業 (${_recoverInfo.nodes} ノード) で置き換えます。よろしいですか？`);
    if(!ok) return;
  }
  const r = await fetch('/api/graph/recover', {method: 'POST'}).catch(() => null);
  const d = r && r.ok ? await r.json() : null;
  if(!d || d.error) { st('復元できませんでした'); return; }
  selNode = null; showDetail(null);
  applyGraphResponse(d);
  updateProjectUI();
  await refreshRecoverItem();
  st(`前回の作業を復元しました (${Object.keys(d.nodes || {}).length} ノード)`);
}

// 現在のグラフに、いまのルートの外を指すノードが何件あるか。
function countForeignNodes(root) {
  const r = root !== undefined ? root : projectRoot;
  if(!r || !graph || !graph.nodes) return 0;
  return Object.values(graph.nodes)
    .filter(n => foreignRootName((n.match || {}).file || '', r)).length;
}

function saveStateOf(projectPath, serverPath) {
  if(projectPath) return {kind: 'named', path: projectPath};
  if(serverPath)  return {kind: 'working', path: serverPath};
  return {kind: 'unsaved', path: ''};
}

function projectSaveState() {
  return saveStateOf(getProjectPath(), window._serverGraphFile || '');
}

function updateProjectUI() {
  const st = projectSaveState();
  const el = id('project-name');
  if(!el) return;
  const base = st.path ? st.path.replace(/\\/g, '/').split('/').pop() : '';

  // 名前付きも作業ファイルも保存先が決まっている点は同じで、どちらも自動保存
  // される。区別が要るのは「保存先が無い」ときだけ。
  if(st.kind === 'unsaved') {
    el.textContent = '未保存';
    el.title = '保存先が決まっていません。閉じるとグラフは失われます (Ctrl+S)';
    noticeUnnamedOnce();
  } else {
    el.textContent = base;
    el.title = st.path + '\n変更するたび自動保存されます';
  }
  el.classList.toggle('project-unsaved', st.kind === 'unsaved');

  // 保存は名前が無くても動く（保存先を尋ねるダイアログが開く）。
  // 灰色にすると押せないように見えるだけで、実際の挙動と食い違っていた。
  const saveItem = id('pmenu-save');
  if(saveItem) {
    saveItem.style.color = '';
    saveItem.firstChild.nodeValue = st.kind === 'named' ? '保存 ' : '保存… ';
  }
  updateProjectStatus(st);
}

// メニュー先頭に「今どのファイルを編集していて、どう保存されるか」を出す。
// ボタンにはファイル名しか入らず、フルパスはホバーしないと見えなかった。
function updateProjectStatus(st) {
  const pathEl = id('pmenu-status-path');
  const detailEl = id('pmenu-status-detail');
  if(!pathEl || !detailEl) return;

  pathEl.textContent = st.path || '保存先が決まっていません';
  const nodes = (graph && graph.nodes) ? Object.values(graph.nodes) : [];
  const detail = [`${nodes.length} ノード`];
  // 別ツリーのノードが混ざっていることに気づけるようにする。
  // 見比べる使い方は正当なので止めないが、黙って混ざるのは事故。
  const foreign = countForeignNodes();
  if(foreign) detail.push(`ルート外 ${foreign} 件`);
  if(st.kind === 'unsaved') {
    detail.push('閉じると失われます — Ctrl+S で保存先を指定');
  } else {
    detail.push('変更するたび自動保存されます');
  }
  detailEl.textContent = detail.join(' · ');
  // 注意が要る状態だけ色を付ける。常時色付きだと警告として機能しない。
  const warn = st.kind === 'unsaved' || foreign > 0;
  detailEl.classList.toggle('pmenu-unsaved', warn);
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
  // 検索結果ペインの表示はタブの状態に従う（projects/explorer タブを開いたまま
  // プロジェクトを切り替えたとき、検索結果がパネル下にはみ出さないように）。
  const paneSearch = id('pane-search');
  if (paneSearch && id('tab-search')?.classList.contains('active')) paneSearch.style.display = '';
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
  bumpGrepnaviGraph(path); // 次に同じルートを開いたときの既定にする
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

if (typeof module !== "undefined") module.exports = { saveStateOf };
