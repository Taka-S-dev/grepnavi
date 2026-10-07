// ===== 画面 =====
// 画面は作業場全体の組: 検索（条件と結果）・見ているノードツリー・ファイルタブの
// 並びとアクティブなタブ・移動の履歴・開いている側パネル・参照マップの状態。
// Neovim のタブページにあたる。ファイルの中身（Monaco のモデル）、ノードツリーの
// 中身、メモ、ピン留めハイライト、検索の履歴（スタック）は画面をまたいで共有し、
// 画面ごとに持つのは「どれを見ているか」。state.js の tabs / activeTabIdx /
// navHistory は「いまの画面」の中身で、切り替えで差し替える。
//
// モデルの寿命はここだけが決める。タブを閉じるときに直接 dispose すると、別の
// 画面で同じファイルを開いていたときに、その画面のエディタが空になる。

const SCREENS_MAX = 9; // Alt+1〜9 で届く数まで

function _newScreen() {
  return { tabs: [], activeTabIdx: -1, nav: { history: [], index: -1 }, panel: null, refMap: null, search: null, tree: null };
}

// 検索は、検索タブ（searchTabs）のどれを見ているかと入力欄の文字で覚える。
// 結果そのものは検索タブが持っているので、画面はそれを指すだけ
function _searchState() {
  return {
    q: document.getElementById('q')?.value || '',
    dir: document.getElementById('dir')?.value || '',
    glob: document.getElementById('glob')?.value || '',
    tab: typeof activeSearchTab !== 'undefined' ? activeSearchTab : -1,
    // 検索タブに入っていない結果（止めた検索など）は画面が自分で持つ
    matches: (typeof activeSearchTab === 'undefined' || activeSearchTab < 0) && typeof allMatches !== 'undefined' && allMatches.length ? [...allMatches] : null,
    title: document.getElementById('sh-title')?.textContent || '',
    over: document.getElementById('sh-over')?.textContent || '',
  };
}

function _restoreSearch(s) {
  const q = document.getElementById('q'), dir = document.getElementById('dir'), glob = document.getElementById('glob');
  if (!s) {
    // 新しい画面: 結果は空にして始める（前の画面の結果を引き継がない）
    if (typeof stopSearch === 'function') stopSearch();
    if (typeof activeSearchTab !== 'undefined') activeSearchTab = -1;
    allMatches = []; pending = []; fileGroupMap = {};
    _virtItems = []; _visibleItems = []; _collapsedGroups = new Set(); _collapsedFolders = new Set(); _selectedKey = ''; _virtHeaderMap = new Map(); _virtNeedRebuild = false;
    const r = document.getElementById('results'); if (r) r.innerHTML = '';
    const t = document.getElementById('sh-title'); if (t) t.textContent = '検索結果';
    const o = document.getElementById('sh-over'); if (o) o.textContent = '';
    if (q) q.value = '';
    if (typeof renderSearchTabs === 'function') renderSearchTabs();
    return;
  }
  if (s.tab >= 0 && typeof searchTabs !== 'undefined' && searchTabs[s.tab] && typeof switchSearchTab === 'function') switchSearchTab(s.tab);
  else if (s.matches && typeof flushBatch === 'function') {
    if (typeof stopSearch === 'function') stopSearch();
    if (typeof activeSearchTab !== 'undefined') activeSearchTab = -1;
    allMatches = [...s.matches]; pending = [...s.matches]; fileGroupMap = {};
    _virtItems = []; _visibleItems = []; _collapsedGroups = new Set(); _collapsedFolders = new Set(); _selectedKey = ''; _virtHeaderMap = new Map(); _virtNeedRebuild = false;
    const r = document.getElementById('results'); if (r) r.innerHTML = '';
    flushBatch(s.q || '');
    const t = document.getElementById('sh-title'); if (t) t.textContent = s.title || '検索結果';
    const o = document.getElementById('sh-over'); if (o) o.textContent = s.over || '';
    if (typeof renderSearchTabs === 'function') renderSearchTabs();
  }
  else _restoreSearch(null);
  if (q) q.value = s.q || '';
  if (dir) dir.value = s.dir || '';
  if (glob) glob.value = s.glob || '';
}

function _treeId() {
  return (typeof graph !== 'undefined' && graph && (graph.active_tree_id || graph.id)) || null;
}
const _screens = [_newScreen()];
let _screenIdx = 0;

function currentScreenIndex() { return _screenIdx; }
function screenCount() { return _screens.length; }

// どの画面のどのタブからも使われていないモデルだけを捨てる。
// 呼ぶ側は、タブを一覧から外した「後」に呼ぶ（外す前だと自分が使用者に数えられる）
function releaseTabModel(model) {
  if (!model || model.isDisposed?.()) return;
  for (let i = 0; i < _screens.length; i++) {
    const list = i === _screenIdx ? tabs : _screens[i].tabs;
    if (list.some(t => t.model === model)) return;
  }
  model.dispose();
}

// 全画面のタブを捨てる（プロジェクトの切り替えなど、開いているものを全部閉じるとき）
function resetScreens() {
  for (let i = 0; i < _screens.length; i++) {
    const list = i === _screenIdx ? tabs : _screens[i].tabs;
    for (const t of list) { try { t.model?.dispose(); } catch (_) {} }
  }
  _screens.length = 1;
  _screens[0] = _newScreen();
  _screenIdx = 0;
  tabs = []; activeTabIdx = -1;
  navHistory.length = 0; navIndex = -1;
  renderScreenTabs();
}

function _openSidePanelId() {
  const p = document.querySelector('.side-panel.open');
  return p ? p.id : null;
}

// いまの画面の状態を保存する。エディタの位置はタブの viewState に入れる
function _saveCurrentScreen() {
  const s = _screens[_screenIdx];
  if (activeTabIdx >= 0 && activeTabIdx < tabs.length && typeof monacoEditor !== 'undefined' && monacoEditor) {
    try { tabs[activeTabIdx].viewState = monacoEditor.saveViewState(); } catch (_) {}
  }
  s.tabs = tabs; s.activeTabIdx = activeTabIdx;
  s.nav = { history: navHistory.slice(), index: navIndex };
  s.panel = _openSidePanelId();
  s.refMap = typeof window.refMapScreenState === 'function' ? window.refMapScreenState() : null;
  s.search = _searchState();
  s.tree = _treeId();
}

// 画面 i の中身を本体に入れる。側パネルと図は、この画面のものだけを出す
// （閉じても中身は残るので戻せる）
async function _installScreen(i) {
  _screenIdx = i;
  const s = _screens[i];
  tabs = s.tabs; activeTabIdx = -1;
  navHistory.length = 0; navHistory.push(...s.nav.history); navIndex = s.nav.index;
  _restoreSearch(s.search);
  // 新しい画面はいまのツリーを引き継ぐ（空のツリーを作りはしない）。別のツリーを
  // 見ていた画面なら、そのツリーに切り替える
  if (s.tree && s.tree !== _treeId() && typeof switchTree === 'function') await switchTree(s.tree);
  window.closeOtherSidePanels?.(null);
  if (typeof window.refMapRestore === 'function') await window.refMapRestore(s.refMap);
  if (s.panel) {
    const p = document.getElementById(s.panel);
    if (p && !p.classList.contains('open')) {
      if (s.panel === 'memo-list-panel' && typeof toggleMemoList === 'function') toggleMemoList();
      else p.classList.add('open');
    }
  }
  const peek = document.getElementById('peek');
  if (tabs.length) {
    peek.classList.add('visible');
    await switchTab(Math.min(Math.max(s.activeTabIdx, 0), tabs.length - 1));
  } else {
    peek.classList.remove('visible');
    if (typeof stopFilePolling === 'function') stopFilePolling();
    if (typeof hideFileErrorOverlay === 'function') hideFileErrorOverlay();
    renderTabs();
    if (typeof updateTitle === 'function') updateTitle();
    document.dispatchEvent(new CustomEvent('grepnavi:active-file-changed', { detail: '' }));
  }
  if (typeof monacoEditor !== 'undefined' && monacoEditor) monacoEditor.layout();
  renderScreenTabs();
}

async function switchScreen(i) {
  if (i < 0 || i >= _screens.length) return;
  if (i === _screenIdx) { renderScreenTabs(); return; }
  _saveCurrentScreen();
  await _installScreen(i);
}

async function newScreen() {
  if (_screens.length >= SCREENS_MAX) { if (typeof st === 'function') st(`画面は ${SCREENS_MAX} つまでです`); return; }
  _screens.push(_newScreen());
  await switchScreen(_screens.length - 1);
}

async function closeScreen(i) {
  if (i < 0 || i >= _screens.length) return;
  if (_screens.length === 1) {
    // 最後の 1 つは空にするだけ（画面が無い状態は作らない）
    if (i === _screenIdx) closePeek();
    return;
  }
  if (i !== _screenIdx) {
    const [s] = _screens.splice(i, 1);
    if (i < _screenIdx) _screenIdx--;
    s.tabs.forEach(t => releaseTabModel(t.model));
    renderScreenTabs();
    return;
  }
  // いまの画面を閉じる: タブを手放してから隣へ移る（保存はしない）
  const closed = tabs;
  tabs = []; activeTabIdx = -1;
  closed.forEach(t => releaseTabModel(t.model));
  _screens.splice(i, 1);
  await _installScreen(Math.min(i, _screens.length - 1));
}

// 画面タブ。番号だけで並ぶ（Alt+番号と同じ記号）。画面の正体は「どの線を追って
// いるか」で、見ているファイルは中で次々変わるので、名前にすると毎回変わって
// かえって見分けにくい。中身はホバーの吹き出しで
function renderScreenTabs() {
  const bar = document.getElementById('screen-tabs');
  if (!bar) return;
  bar.innerHTML = '';
  _screens.forEach((s, i) => {
    const b = document.createElement('div');
    b.className = 'screen-tab' + (i === _screenIdx ? ' active' : '');
    const list = i === _screenIdx ? tabs : s.tabs;
    const active = i === _screenIdx ? activeTabIdx : s.activeTabIdx;
    const search = i === _screenIdx ? _searchState() : s.search;
    const panel = i === _screenIdx ? _openSidePanelId() : s.panel;
    const lines = [`画面 ${i + 1}`];
    if (list[active]) lines.push(`ファイル: ${list[active].label}` + (list.length > 1 ? `（他 ${list.length - 1}）` : ''));
    if (search && search.q) lines.push(`検索: ${search.q}`);
    if (panel) lines.push(`パネル: ${panel.replace(/-?(sidebar|panel)$/, '')}`);
    if (lines.length === 1) lines.push('（空）');
    lines.push(`Alt+${i + 1} で切り替え・右クリックか中クリックで閉じる`);
    b.title = lines.join('\n');
    const num = document.createElement('span');
    num.className = 'screen-tab-num';
    num.textContent = String(i + 1);
    b.appendChild(num);
    b.onclick = () => switchScreen(i);
    // × は置かない: 切り替えようとして当たると画面ごと消える。閉じるのは右クリックの
    // メニューか中クリックで、どちらも押し間違えにくい
    b.onauxclick = e => { if (e.button === 1) { e.preventDefault(); closeScreen(i); } };
    b.oncontextmenu = e => { e.preventDefault(); _showScreenMenu(i, e.clientX, e.clientY); };
    bar.appendChild(b);
  });
  const add = document.createElement('div');
  add.className = 'screen-tab screen-tab-add';
  add.textContent = '+';
  add.title = `新しい画面（Alt+${_screens.length + 1} でも）。いま開いているものはそのまま残り、Alt+番号で戻れる`;
  add.onclick = () => newScreen();
  bar.appendChild(add);
}

function _showScreenMenu(i, x, y) {
  let menu = document.getElementById('screen-ctx-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'screen-ctx-menu';
    document.body.appendChild(menu);
    // 外をどこか押したら閉じる。click ではなく mousedown の捕捉段階で見る: エディタや
    // ツリーは click を自分で止めるので、document まで上がってこない
    const hide = () => menu.classList.remove('open');
    document.addEventListener('mousedown', e => { if (!menu.contains(e.target)) hide(); }, true);
    document.addEventListener('contextmenu', e => { if (!menu.contains(e.target)) hide(); }, true);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); }, true);
    window.addEventListener('blur', hide);
    document.addEventListener('wheel', hide, { capture: true, passive: true });
  }
  menu.innerHTML = '';
  const item = (label, fn, disabled) => {
    const d = document.createElement('div');
    d.className = 'tab-ctx-item' + (disabled ? ' disabled' : '');
    d.textContent = label;
    if (!disabled) d.onclick = () => { menu.classList.remove('open'); fn(); };
    menu.appendChild(d);
  };
  // 文言は VS Code のタブのメニューに寄せ、どれを閉じるかは番号で言う（1 を閉じる / その他を閉じる）
  item(`${i + 1} を閉じる`, () => closeScreen(i));
  item('その他を閉じる', () => { for (let k = _screens.length - 1; k >= 0; k--) if (k !== i) closeScreen(k); }, _screens.length <= 1);
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  menu.classList.add('open');
}

// ===== 画面ピッカー（Alt+S） =====
// Ctrl+P と同じ箱に画面を並べ、打って絞り、Enter で移る。Alt+番号が OS や他の
// ソフトに取られている環境でも、キーだけで画面を行き来できるようにする
function _screenLine(i) {
  const s = _screens[i];
  const list = i === _screenIdx ? tabs : s.tabs;
  const active = i === _screenIdx ? activeTabIdx : s.activeTabIdx;
  const search = i === _screenIdx ? _searchState() : s.search;
  const panel = i === _screenIdx ? _openSidePanelId() : s.panel;
  const parts = [];
  if (list[active]) parts.push(list[active].label + (list.length > 1 ? `（他 ${list.length - 1}）` : ''));
  if (search && search.q) parts.push('検索: ' + search.q);
  if (panel) parts.push(_panelName(panel));
  return parts.join(' · ') || '（空）';
}

const _PANEL_NAMES = { 'rm-sidebar': '参照マップ', 'ct-sidebar': '呼び出しツリー', 'jst-sidebar': 'ジャンプスタック', 'hll-sidebar': 'ハイライト一覧', 'jm-panel': 'ジャンプマップ', 'sm-panel': '状態遷移', 'memo-list-panel': 'マーク一覧' };
function _panelName(id) { return _PANEL_NAMES[id] || id.replace(/-?(sidebar|panel)$/, ''); }

let _spSel = 0;
function openScreenPicker() {
  let ov = document.getElementById('screen-picker');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'screen-picker';
    ov.innerHTML = '<div id="screen-picker-box"><div id="screen-picker-head"><input id="screen-picker-input" type="text" placeholder="画面を選ぶ（番号・ファイル名・検索語で絞り込み）" spellcheck="false" autocomplete="off"><span id="screen-picker-hint">↑↓ 選ぶ · Enter 移る · Esc 閉じる</span></div><div id="screen-picker-list"></div></div>';
    document.body.appendChild(ov);
    ov.onmousedown = e => { if (e.target === ov) closeScreenPicker(); };
    const input = ov.querySelector('#screen-picker-input');
    input.oninput = () => { _spSel = 0; _renderScreenPicker(); };
    input.onkeydown = e => {
      const n = ov.querySelectorAll('.fzf-item').length;
      if (e.key === 'ArrowDown') { e.preventDefault(); _spSel = Math.min(n - 1, _spSel + 1); _renderScreenPicker(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); _spSel = Math.max(0, _spSel - 1); _renderScreenPicker(); }
      else if (e.key === 'Enter') { e.preventDefault(); const el = ov.querySelectorAll('.fzf-item')[_spSel]; if (el) el.click(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeScreenPicker(); }
      e.stopPropagation();
    };
  }
  ov.classList.add('open');
  const input = ov.querySelector('#screen-picker-input');
  input.value = '';
  _spSel = _screenIdx;
  _renderScreenPicker();
  setTimeout(() => input.focus(), 20);
}

function closeScreenPicker() {
  const ov = document.getElementById('screen-picker');
  if (ov) ov.classList.remove('open');
  if (typeof monacoEditor !== 'undefined' && monacoEditor && tabs.length) monacoEditor.focus();
}

function _renderScreenPicker() {
  const ov = document.getElementById('screen-picker');
  const list = ov.querySelector('#screen-picker-list');
  const q = ov.querySelector('#screen-picker-input').value.trim().toLowerCase();
  list.innerHTML = '';
  const rows = [];
  _screens.forEach((s, i) => {
    const text = _screenLine(i);
    const hay = (String(i + 1) + ' ' + text).toLowerCase();
    if (q && !q.split(/\s+/).every(t => hay.includes(t))) return;
    rows.push({ label: String(i + 1), text, act: () => switchScreen(i), cur: i === _screenIdx });
  });
  if (!q && _screens.length < SCREENS_MAX) rows.push({ label: '+', text: '新しい画面', act: () => newScreen() });
  if (_spSel >= rows.length) _spSel = Math.max(0, rows.length - 1);
  rows.forEach((r, k) => {
    const d = document.createElement('div');
    d.className = 'fzf-item' + (k === _spSel ? ' fzf-sel' : '');
    const name = document.createElement('span');
    name.className = 'fzf-name' + (r.cur ? ' screen-picker-cur' : '');
    name.textContent = r.label;
    const dir = document.createElement('span');
    dir.className = 'fzf-dir';
    dir.textContent = r.text;
    d.append(name, dir);
    d.onmousemove = () => { if (_spSel !== k) { _spSel = k; _renderScreenPicker(); } };
    d.onclick = () => { closeScreenPicker(); r.act(); };
    list.appendChild(d);
  });
  if (!rows.length) {
    const e = document.createElement('div');
    e.className = 'fzf-empty';
    e.textContent = '一致する画面がありません';
    list.appendChild(e);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  renderScreenTabs();
  document.addEventListener('keydown', e => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 's' && e.key !== 'S') return;
    // 参照ピッカーの中の Alt+S（何が入るか）はそちらが先
    const fz = document.getElementById('fzf-overlay');
    if (fz && fz.classList.contains('open')) return;
    e.preventDefault();
    openScreenPicker();
  });
  // 吹き出しの中身（見ているファイル）を、開き直すたびに追従させる
  document.addEventListener('grepnavi:active-file-changed', renderScreenTabs);
  document.addEventListener('keydown', e => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (!/^[1-9]$/.test(e.key)) return;
    const i = +e.key - 1;
    e.preventDefault();
    // 次の番号を押したら新しい画面。マウスに持ち替えずに増やせるように
    if (i === _screens.length) { newScreen(); return; }
    if (i > _screens.length) { if (typeof st === 'function') st(`画面は ${_screens.length} つ。Alt+${_screens.length + 1} で増やせます`); return; }
    switchScreen(i);
  });
});
