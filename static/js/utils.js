// ===== CONSTANTS =====
const SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
const LIMIT = 1000, BATCH_MS = 80, DRAG_STEP = 30;
const NODE_COLOR_PRESETS = {
  vivid: ['#4a9edd','#3dbfa0','#d4875a','#d4c45a','#b87ac8'],
  muted: ['#5a7a9a','#4a8a72','#8a6040','#7a7040','#7a5a8a'],
  dark:  ['#2a3d52','#243d30','#3d2a1a','#3a3a1a','#2d2038'],
};
const NODE_COLOR_PRESET_ORDER = ['vivid','muted','dark'];
let _nodeColorPreset = localStorage.getItem('grepnavi-node-color-preset') || 'vivid';
let NODE_COLORS = [...NODE_COLOR_PRESETS[_nodeColorPreset]];

function cycleNodeColorPreset() {
  const idx = NODE_COLOR_PRESET_ORDER.indexOf(_nodeColorPreset);
  _nodeColorPreset = NODE_COLOR_PRESET_ORDER[(idx + 1) % NODE_COLOR_PRESET_ORDER.length];
  localStorage.setItem('grepnavi-node-color-preset', _nodeColorPreset);
  NODE_COLORS.splice(0, NODE_COLORS.length, ...NODE_COLOR_PRESETS[_nodeColorPreset]);
}

function nodeColorPresetLabel() {
  return {vivid:'色:鮮', muted:'色:淡', dark:'色:暗'}[_nodeColorPreset] || '色';
}
const KIND_LABEL = {define:'macro', struct:'struct', enum:'enum', union:'union', typedef:'typedef', typedef_close:'typedef', func:'fn', enum_member:'enum', var:'var', member:'member'};
const KIND_COLOR = {define:'#a06000', struct:'#4a5bbf', enum:'#4a5bbf', union:'#4a5bbf', typedef:'#1e7d82', typedef_close:'#1e7d82', func:'#1e6e40', enum_member:'#4a5bbf', var:'#6b5b95', member:'#6b5b95'};
// サーバが新しい kind を返してもバッジが "undefined" にならないためのフォールバック
const kindLabel = k => KIND_LABEL[k] || k;
const kindColor = k => KIND_COLOR[k] || '#555';


// ===== DOM / ESCAPE =====
const id = s => document.getElementById(s);
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const trunc = (s,n) => s&&s.length>n ? s.slice(0,n)+'…' : s||'';
const pad = n => String(n).padStart(4,' ');

// ===== TEXT =====
function wrapText(text, maxChars, maxLines = 3) {
  return wrapTextNL(text.replace(/\n/g, ' '), maxChars, maxLines);
}

function wrapTextNL(text, maxChars, maxLines = 6) {
  const lines = [];
  for(const para of text.split('\n')) {
    if(lines.length >= maxLines) break;
    if(!para.trim()) { lines.push(''); continue; }
    const words = para.split(/\s+/);
    let cur = '';
    for(const w of words) {
      if(lines.length >= maxLines) break;
      const next = cur ? cur + ' ' + w : w;
      if(next.length > maxChars) {
        if(cur) lines.push(cur);
        cur = w.slice(0, maxChars);
      } else {
        cur = next;
      }
    }
    if(cur && lines.length < maxLines) lines.push(cur);
  }
  return lines.length ? lines : [text.slice(0, maxChars)];
}

function shortPath(p) {
  if(!p) return '';
  const parts = p.replace(/\\/g,'/').split('/');
  if(parts.length <= 4) return parts.join('/');
  return '\u2026/' + parts.slice(-3).join('/');
}

function labelFrom(m) {
  if(!m) return '';
  return shortPath(m.file||'') + (m.line?':'+m.line:'');
}

// ===== 別ルートの検出 =====
// グラフは root を切り替えても残るので、linux の調査に openssl のノードが
// 混ざることがある。複数プロジェクトを見比べる使い方は塞がないが、
// どちらのツリーのものかは常に分かるようにする。
//
// 現在の root の外なら「そのファイルがどのツリーに属するか」を表す短い名前を返す。
// root 配下なら空文字。
function foreignRootName(file, root) {
  if(!file || !root) return '';
  const norm = p => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const f = norm(file), r = norm(root);
  if((f + '/').toLowerCase().startsWith((r + '/').toLowerCase())) return '';

  // root と共通する部分の次のセグメントが、そのファイル側のツリー名。
  //   root = .../work/C/linux, file = .../work/C/openssl-1.1.1q/ssl/x.c → openssl-1.1.1q
  const fp = f.split('/'), rp = r.split('/');
  let i = 0;
  while(i < fp.length && i < rp.length && fp[i].toLowerCase() === rp[i].toLowerCase()) i++;
  // 共通部分が無い（別ドライブ等）ならファイル側の先頭を出す
  return fp[i] || fp[0] || '';
}

if (typeof module !== "undefined") module.exports = { shortPath, labelFrom, foreignRootName };

function extractSym(text) {
  const m = text.match(/\b([a-zA-Z_][a-zA-Z0-9_]{2,})\b/);
  return m ? m[1] + '(' : '';
}

// ===== CSS 変数経由のアニメ時間取得 =====
// CSS animation の duration と JS の cleanup setTimeout を同じ値で動かすためのヘルパ。
// "700ms" / "0.7s" どちらの単位でも ms に正規化。
function cssDurationMs(varName) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (v.endsWith('ms')) return parseFloat(v);
  if (v.endsWith('s'))  return parseFloat(v) * 1000;
  return parseFloat(v) || 0;
}

// ===== STATUS =====
function st(msg){ id('st').textContent=msg; }
function stGraph(){
  const nc=Object.keys(graph.nodes).length, ec=(graph.edges||[]).length;
  st(`${nc}ノード / ${ec}エッジ`);
}

// ===== FILE ICONS =====
const MIT_ICON_BASE = '/js/vendor/icons/';
const EXT_TO_ICON = {
  c:'c',h:'h',cpp:'cpp',cc:'cpp',cxx:'cpp',hpp:'hpp',
  go:'go',rs:'rust',py:'python',rb:'ruby',
  js:'javascript',mjs:'javascript',cjs:'javascript',
  ts:'typescript',tsx:'react_ts',jsx:'react',
  html:'html',htm:'html',
  css:'css',scss:'scss',sass:'sass',less:'less',
  json:'json',jsonc:'json',
  yaml:'yaml',yml:'yaml',
  xml:'xml',toml:'toml',ini:'tune',cfg:'tune',conf:'tune',
  env:'tune',lock:'lock',
  sql:'database',
  java:'java',kt:'kotlin',kts:'kotlin',gradle:'gradle',scala:'scala',
  cs:'csharp',
  sh:'shell',bash:'shell',zsh:'shell',fish:'shell',
  bat:'windows_cmd',cmd:'windows_cmd',ps1:'powershell',
  php:'php',lua:'lua',r:'r',dart:'dart',swift:'swift',
  ex:'elixir',exs:'elixir',
  tf:'terraform',tfvars:'terraform',
  vue:'vue',svelte:'svelte',
  md:'markdown',rst:'readme',
  cmake:'cmake',makefile:'makefile',mk:'makefile',
  gitignore:'git',gitattributes:'git',gitmodules:'git',
  editorconfig:'editorconfig',
  npmignore:'npm',dockerignore:'docker',
  eslintignore:'eslint',eslintrc:'eslint',
  prettierrc:'prettier',prettierignore:'prettier',
  babelrc:'babel',
  readme:'readme',license:'license',copying:'license',
  changelog:'changelog',contributing:'contributing',
  authors:'authors',dockerfile:'docker',
};
const _iconCache = {};

function fileIcon(filename) {
  const base = filename.split(/[\\/]/).pop() || filename;
  const ext = (base.split('.').pop() || '').toLowerCase();
  const name = EXT_TO_ICON[ext] || EXT_TO_ICON[base.toLowerCase()];
  if (!name) return `<i class="codicon codicon-file" style="flex-shrink:0;vertical-align:middle;font-size:16px;color:#888;margin-right:3px;width:16px;text-align:center;display:inline-block"></i>`;
  if (_iconCache[name]) return _iconCache[name];
  const html = `<img src="${MIT_ICON_BASE}${name}.svg" width="16" height="16" style="flex-shrink:0;vertical-align:middle;margin-right:3px" onerror="this.replaceWith(fileIconFallback())">`;
  _iconCache[name] = html;
  return html;
}

function fileIconFallback() {
  const el = document.createElement('i');
  el.className = 'codicon codicon-file';
  el.style.cssText = 'flex-shrink:0;vertical-align:middle;font-size:16px;color:#888;margin-right:3px;width:16px;text-align:center;display:inline-block';
  return el;
}

// ===== LANGUAGE DETECTION =====
function detectLang(file) {
  const ext = (file||'').split('.').pop().toLowerCase();
  const map = {
    c:'c', h:'c', cpp:'cpp', cc:'cpp', cxx:'cpp', hpp:'cpp',
    go:'go', py:'python',
    js:'javascript', mjs:'javascript', cjs:'javascript',
    ts:'typescript', tsx:'typescript', jsx:'javascript',
    rs:'rust', java:'java',
    sh:'shell', bash:'shell', zsh:'shell',
    rb:'ruby', cs:'csharp', php:'php',
    kt:'kotlin', kts:'kotlin', swift:'swift', lua:'lua',
    sql:'sql', html:'html', htm:'html',
    css:'css', scss:'scss', sass:'scss', less:'less',
    json:'json', yaml:'yaml', yml:'yaml', xml:'xml',
    md:'markdown',
  };
  return map[ext] || null;
}

// ===== MEMO TOOLTIP =====
function showMemoTip(e, node) {
  if(!node.memo) return;
  const tt = id('memo-tooltip');
  tt.innerHTML = `<span class="mt-label"><i class="codicon codicon-comment"></i> ${esc(node.label || shortPath(node.match?.file||'')+(node.match?.line?':'+node.match.line:''))}</span>${esc(node.memo)}`;
  tt.style.display = 'block';
  moveMemoTip(e);
}

function moveMemoTip(e) {
  const tt = id('memo-tooltip');
  if(tt.style.display === 'none') return;
  const x = e.clientX + 18, y = e.clientY - 10;
  tt.style.left = Math.min(x, window.innerWidth  - tt.offsetWidth  - 8) + 'px';
  tt.style.top  = Math.max(4, Math.min(y, window.innerHeight - tt.offsetHeight - 8)) + 'px';
}

function hideMemoTip() { id('memo-tooltip').style.display = 'none'; }

// ===== ENCODING BUTTON =====
const ENC_LABELS = { '': 'UTF-8', 'sjis': 'SJIS', 'euc-jp': 'EUC-JP', 'utf-16le': 'UTF-16' };
const ENC_CYCLE  = ['', 'sjis', 'euc-jp', 'utf-16le'];
function updateEncBtn(enc) {
  const btn = id('enc-btn');
  if(!btn) return;
  btn.dataset.enc = enc || '';
  btn.textContent = ENC_LABELS[enc] || 'UTF-8';
  btn.classList.toggle('active', !!enc);
}
function getSearchEnc() {
  return id('enc-btn')?.dataset.enc || '';
}
// setSearchEnc は検索エンコーディングを変更して保存し、クエリがあれば再検索する。
function setSearchEnc(enc) {
  updateEncBtn(enc);
  const saved = JSON.parse(localStorage.getItem('grepnavi-settings') || '{}');
  saved.enc = enc;
  localStorage.setItem('grepnavi-settings', JSON.stringify(saved));
  if(id('q')?.value.trim() && typeof doSearch === 'function') doSearch();
}
// cycleSearchEncFromBadge は SJIS バッジ等から呼ばれ、非 UTF-8 系のみを循環する。
// 最初の遷移は SJIS（日本語コードベースで最も多い）にジャンプする。
function cycleSearchEncFromBadge() {
  const cur = getSearchEnc();
  const nonUtf8 = ['sjis', 'euc-jp', 'utf-16le'];
  const idx = nonUtf8.indexOf(cur);
  const next = idx < 0 ? 'sjis' : nonUtf8[(idx + 1) % nonUtf8.length];
  setSearchEnc(next);
}

// ===== 汎用テキスト入力モーダル =====
// showInputModal(title, placeholder, defaultVal, opts) → Promise<string|null>
// opts.code:      ソース行を編集する用途。等幅で枠を広げ、行頭の字下げも編集対象
//                 なので trim しない（既定の trim はグループ名などの短い入力向け）。
// opts.multiline: 1行入力を textarea に差し替える。Ctrl+Enter で確定、Enter は改行。
let _inputModalResolve = null;
let _inputModalCode = false;
let _inputModalMultiline = false;

// 今どちらの入力欄を使っているか。表示の切り替えは CSS 側 (.input-modal-multiline)。
function _inputModalField() {
  return id(_inputModalMultiline ? 'input-modal-ta' : 'input-modal-input');
}

function showInputModal(title, placeholder, defaultVal = '', opts = {}) {
  return new Promise(resolve => {
    _inputModalResolve = resolve;
    _inputModalCode = !!opts.code;
    _inputModalMultiline = !!opts.multiline;
    id('input-modal-title').textContent = title;
    const box = id('input-modal-box');
    box.classList.toggle('input-modal-code', _inputModalCode);
    box.classList.toggle('input-modal-multiline', _inputModalMultiline);
    // 1行入力の等幅化は textarea 側には要らない (元から等幅)。
    id('input-modal-input').classList.toggle('input-modal-input-code', _inputModalCode && !_inputModalMultiline);
    const el = _inputModalField();
    el.placeholder = placeholder || '';
    el.value = defaultVal;
    id('input-modal').classList.add('open');
    setTimeout(() => {
      el.focus();
      // 1行入力は「丸ごと打ち直す」のが普通なので全選択する。複数行は既存の
      // 内容に手を入れる用途なので、全選択したまま Tab や文字入力を受けると
      // 中身が消える。末尾にキャレットを置く。
      if (_inputModalMultiline) el.setSelectionRange(el.value.length, el.value.length);
      else el.select();
    }, 30);
  });
}

// 空白だけの入力は取り消し扱い。中身があるときだけ、code 用途では原文のまま返す。
function _inputModalValue() {
  const v = _inputModalField().value;
  if (!v.trim()) return null;
  return _inputModalCode ? v : v.trim();
}
// textarea 内の Tab をフォーカス移動ではなく字下げ操作にする。
// 複数行を選択しているときは行ごとに字下げ・字上げする。選択を潰して
// タブ1文字に置き換えてしまうと、編集中の内容が消える。
// outdent は行頭からタブ1つ (無ければスペース最大4つ) を外す。
function _taIndent(ta, outdent) {
  const v = ta.value, start = ta.selectionStart, end = ta.selectionEnd;
  // 行頭で終わる選択は、その行を含める意図ではない (エディタ共通の作法)。
  const selEnd = end > start && v[end - 1] === '\n' ? end - 1 : end;
  const spansLines = v.slice(start, selEnd).includes('\n');
  // 選択を1つのタブで置き換えてよいのは、その選択が1行に収まっているときだけ。
  // 行頭で終わる選択 (selEnd !== end) は行単位の操作として扱う。
  if (!spansLines && !outdent && selEnd === end) { // 単純な字下げ挿入
    ta.value = v.slice(0, start) + '\t' + v.slice(end);
    ta.selectionStart = ta.selectionEnd = start + 1;
    return;
  }
  const from = v.lastIndexOf('\n', start - 1) + 1;  // 先頭行の行頭
  let to = v.indexOf('\n', selEnd);                 // 末尾行の行末
  if (to < 0) to = v.length;
  let headDelta = 0, totalDelta = 0;
  const orig = v.slice(from, to);
  const body = orig.split('\n').map((line, i) => {
    if (outdent) {
      const m = line.match(/^(\t| {1,4})/);
      if (!m) return line;
      if (i === 0) headDelta = -m[1].length;
      totalDelta -= m[1].length;
      return line.slice(m[1].length);
    }
    if (i === 0) headDelta = 1;
    totalDelta += 1;
    return '\t' + line;
  }).join('\n');
  // 外す段が無かったときに value を代入し直すと、textarea の undo 履歴が消える。
  if (body === orig) return;
  ta.value = v.slice(0, from) + body + v.slice(to);
  ta.selectionStart = Math.max(from, start + headDelta);
  ta.selectionEnd = Math.max(ta.selectionStart, end + totalDelta);
}

function _inputModalClose(val) {
  id('input-modal').classList.remove('open');
  if (_inputModalResolve) { _inputModalResolve(val); _inputModalResolve = null; }
}
document.addEventListener('DOMContentLoaded', () => {
  id('input-modal-ok').onclick = () => _inputModalClose(_inputModalValue());
  id('input-modal-cancel').onclick = () => _inputModalClose(null);
  // stopPropagation は、背後のフローティング定義などが同じ Escape で
  // 一緒に閉じないようにするため（モーダルが最前面なので、ここで止めてよい）。
  id('input-modal-input').onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); _inputModalClose(_inputModalValue()); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); _inputModalClose(null); }
  };
  id('input-modal-ta').onkeydown = e => {
    // Enter は改行なので、確定は Ctrl+Enter に寄せる (挿入ダイアログと同じ)。
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); _inputModalClose(_inputModalValue()); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); _inputModalClose(null); return; }
    if (e.key === 'Tab') { e.preventDefault(); _taIndent(e.target, e.shiftKey); }
  };
  id('input-modal').addEventListener('click', e => {
    // 複数行のときは背景クリックで閉じない。書きかけの数行を、外した
    // クリック1つで失うのは代償が大きすぎる (Esc とキャンセルは残る)。
    if (e.target === id('input-modal') && !_inputModalMultiline) _inputModalClose(null);
  });
});

// ===== 汎用 確認/通知 モーダル =====
// showConfirm(message, {okText, cancelText, danger}) → Promise<boolean>
// showAlert(message, {okText})                        → Promise<void>
//
// native confirm()/alert() 置換用。dark theme で UI 一貫性を保つ。
// Esc / 背景クリック = キャンセル相当、Enter = OK 相当。
let _gnDialogResolve = null;
function _gnDialogClose(value) {
  id('gn-dialog').classList.remove('open');
  if (_gnDialogResolve) { _gnDialogResolve(value); _gnDialogResolve = null; }
}
function showConfirm(message, opts = {}) {
  const { okText = 'OK', cancelText = 'キャンセル', danger = false } = opts;
  return new Promise(resolve => {
    _gnDialogResolve = resolve;
    id('gn-dialog-body').textContent = message;
    const ok = id('gn-dialog-ok');
    ok.textContent = okText;
    ok.classList.toggle('danger', danger);
    const cancel = id('gn-dialog-cancel');
    cancel.textContent = cancelText;
    cancel.style.display = '';
    id('gn-dialog').classList.add('open');
    setTimeout(() => ok.focus(), 30);
  });
}
function showAlert(message, opts = {}) {
  const { okText = 'OK' } = opts;
  return new Promise(resolve => {
    // alert は値を返さないため resolve は引数無視
    _gnDialogResolve = () => resolve();
    id('gn-dialog-body').textContent = message;
    const ok = id('gn-dialog-ok');
    ok.textContent = okText;
    ok.classList.remove('danger');
    id('gn-dialog-cancel').style.display = 'none';
    id('gn-dialog').classList.add('open');
    setTimeout(() => ok.focus(), 30);
  });
}
document.addEventListener('DOMContentLoaded', () => {
  id('gn-dialog-ok').onclick = () => _gnDialogClose(true);
  id('gn-dialog-cancel').onclick = () => _gnDialogClose(false);
  id('gn-dialog').addEventListener('click', e => {
    if (e.target === id('gn-dialog')) _gnDialogClose(false);
  });
  document.addEventListener('keydown', e => {
    const dlg = id('gn-dialog');
    if (!dlg.classList.contains('open')) return;
    if (e.key === 'Escape') { e.preventDefault(); _gnDialogClose(false); }
    // Enter は ok/cancel ボタンに focus が当たっていれば native click が拾うので
    // global handler では拾わない (二重発火防止)
  });
});
