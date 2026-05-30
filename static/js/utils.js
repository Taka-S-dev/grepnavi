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
const KIND_LABEL = {define:'macro', struct:'struct', enum:'enum', typedef:'typedef', func:'fn'};
const KIND_COLOR = {define:'#a06000', struct:'#4a5bbf', enum:'#4a5bbf', typedef:'#1e7d82', func:'#1e6e40'};


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
// showInputModal(title, placeholder, defaultVal) → Promise<string|null>
let _inputModalResolve = null;
function showInputModal(title, placeholder, defaultVal = '') {
  return new Promise(resolve => {
    _inputModalResolve = resolve;
    id('input-modal-title').textContent = title;
    const inp = id('input-modal-input');
    inp.placeholder = placeholder || '';
    inp.value = defaultVal;
    id('input-modal').classList.add('open');
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
  });
}
function _inputModalClose(val) {
  id('input-modal').classList.remove('open');
  if (_inputModalResolve) { _inputModalResolve(val); _inputModalResolve = null; }
}
document.addEventListener('DOMContentLoaded', () => {
  id('input-modal-ok').onclick = () => _inputModalClose(id('input-modal-input').value.trim() || null);
  id('input-modal-cancel').onclick = () => _inputModalClose(null);
  id('input-modal-input').onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); _inputModalClose(id('input-modal-input').value.trim() || null); }
    if (e.key === 'Escape') { e.preventDefault(); _inputModalClose(null); }
  };
  id('input-modal').addEventListener('click', e => {
    if (e.target === id('input-modal')) _inputModalClose(null);
  });
});
