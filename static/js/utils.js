// ===== CONSTANTS =====
const SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
const LIMIT = 1000, BATCH_MS = 80, DRAG_STEP = 30;
const NODE_COLORS = ['#4a9edd','#3dbfa0','#d4875a','#d4c45a','#b87ac8'];
const KIND_LABEL = {define:'macro', struct:'struct', enum:'enum', typedef:'typedef', func:'fn'};
const KIND_COLOR = {define:'#a06000', struct:'#4a5bbf', enum:'#4a5bbf', typedef:'#1e7d82', func:'#1e6e40'};

// Material Icon Theme (MIT License, PKief/vscode-material-icon-theme)
const MIT_ICON_BASE = 'https://cdn.jsdelivr.net/gh/PKief/vscode-material-icon-theme@main/icons/';
const EXT_TO_ICON = {
  c:'c',h:'h',cpp:'cpp',cc:'cpp',cxx:'cpp',hpp:'hpp',
  go:'go',
  js:'javascript',mjs:'javascript',cjs:'javascript',
  ts:'typescript',tsx:'react_ts',jsx:'react',
  html:'html',htm:'html',
  css:'css',scss:'scss',sass:'sass',less:'less',
  json:'json',jsonc:'json',
  py:'python',
  rs:'rust',
  md:'markdown',
  sh:'shell',bash:'shell',zsh:'shell',
  bat:'windows_cmd',cmd:'windows_cmd',
  yaml:'yaml',yml:'yaml',
  xml:'xml',
  sql:'database',
  rb:'ruby',
  java:'java',
  cs:'csharp',
  php:'php',
  vue:'vue',
  svelte:'svelte',
  kt:'kotlin',kts:'kotlin',
  swift:'swift',
  r:'r',
  lua:'lua',
  cmake:'cmake',
  makefile:'makefile',mk:'makefile',
  toml:'toml',
  lock:'lock',
  env:'dotenv',
};
const _iconCache = {};

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
  return parts.length<=2 ? p : parts.slice(-2).join('/');
}

function labelFrom(m) {
  if(!m) return '';
  return shortPath(m.file||'') + (m.line?':'+m.line:'');
}

function extractSym(text) {
  const m = text.match(/\b([a-zA-Z_][a-zA-Z0-9_]{2,})\b/);
  return m ? m[1] + '(' : '';
}

// ===== STATUS =====
function st(msg){ id('st').textContent=msg; }
function stGraph(){
  const nc=Object.keys(graph.nodes).length, ec=(graph.edges||[]).length;
  st(`${nc}ノード / ${ec}エッジ | 保存済`);
}

// ===== FILE ICONS =====
function fileIcon(filename) {
  const base = filename.split(/[\\/]/).pop() || filename;
  const ext = (base.split('.').pop()||'').toLowerCase();
  const name = EXT_TO_ICON[ext] || EXT_TO_ICON[base.toLowerCase()];
  const url = name ? MIT_ICON_BASE + name + '.svg' : null;
  if(!url) {
    const label = ext.slice(0,4) || '?';
    return `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0;vertical-align:middle"><rect width="16" height="16" rx="2" fill="#607d8b"/><text x="8" y="11.5" font-size="${label.length>2?4.5:6}" font-family="Consolas,monospace" font-weight="bold" fill="#fff" text-anchor="middle">${label}</text></svg>`;
  }
  if(_iconCache[url]) return _iconCache[url];
  const html = `<img src="${url}" width="16" height="16" style="flex-shrink:0;vertical-align:middle" onerror="this.replaceWith(fileIconFallback('${ext}'))">`;
  _iconCache[url] = html;
  return html;
}

function fileIconFallback(ext) {
  const label = ext.slice(0,4)||'?';
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('width','16');svg.setAttribute('height','16');svg.setAttribute('viewBox','0 0 16 16');
  svg.style.cssText='flex-shrink:0;vertical-align:middle';
  svg.innerHTML=`<rect width="16" height="16" rx="2" fill="#607d8b"/><text x="8" y="11.5" font-size="${label.length>2?4.5:6}" font-family="Consolas,monospace" font-weight="bold" fill="#fff" text-anchor="middle">${label}</text>`;
  return svg;
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
  tt.innerHTML = `<span class="mt-label">💬 ${esc(node.label || shortPath(node.match?.file||'')+(node.match?.line?':'+node.match.line:''))}</span>${esc(node.memo)}`;
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
