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

// ===== ダイアログをパネルとして扱う (移動・リサイズ・位置の記憶) =====
//
// コードを書くダイアログは、中央に固定されていると使い物にならない。
// 構造体のメンバー名を調べてから printf に書く、といった作業では、背面の
// エディタやピークウィンドウと場所を取り合うため。掴んで動かせて、幅を
// 広げられて、次に開いたとき同じ場所に出る必要がある。
//
// 位置を覚えるのは、毎回中央に戻るとピークとの位置取りをやり直すことになるため。

const _panelKey = (key) => 'grepnavi-panel-' + key;

function _panelGeom(box) {
  const r = box.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: box.offsetWidth, h: box.offsetHeight };
}

// インラインで付けた位置・大きさを外し、CSS 既定の中央配置へ戻す。
function _resetPanelStyles(box) {
  for (const p of ['position', 'margin', 'left', 'top', 'width', 'height']) box.style[p] = '';
}

// パネル扱いを解除する。1つの箱を使い回している汎用モーダルが、次の用途で
// 動かせたり位置を覚えたりしないようにする。
function clearPanelGeom(box) {
  if (!box) return;
  box._panelKey = null;
  _resetPanelStyles(box);
  // 重なり順はここでは触らない。閉じるときに _lowerModal が戻す。
  // ここで消すと、直前に前へ出したモーダル自身を引きずり下ろしてしまう。
  const handle = box.querySelector('.node-modal-title, #input-modal-title');
  if (handle) { handle.style.cursor = ''; handle.removeAttribute('title'); }
}

// 覚えた位置・大きさを戻す。ダイアログを開いた直後に呼ぶ
// (display:none のままでは寸法が測れないため)。
function restorePanel(box, key) {
  if (!box) return;
  // 先に必ず素へ戻す。同じ箱を用途ごとに使い回しているので、記憶が無い用途を
  // 開いたときに前の用途の位置・大きさが残っていると、そこに居座ってしまう。
  _resetPanelStyles(box);
  let g = null;
  try { g = JSON.parse(localStorage.getItem(_panelKey(key)) || 'null'); } catch { /* ignore */ }
  if (!g) return;
  // flex による中央寄せから絶対座標へ切り替える (left/top を効かせるため)。
  box.style.position = 'fixed';
  box.style.margin = '0';
  if (g.w) box.style.width = g.w + 'px';
  if (g.h) box.style.height = g.h + 'px';
  // 画面の解像度が変わっていても、全体が画面内に収まるようにする。
  // 下端をはみ出させると OK/キャンセルの行が画面外に出て押せなくなる。
  const w = box.offsetWidth || 420, h = box.offsetHeight || 260;
  box.style.left = Math.max(4, Math.min(g.x, window.innerWidth - Math.min(w, window.innerWidth - 8))) + 'px';
  box.style.top = Math.max(4, Math.min(g.y, Math.max(4, window.innerHeight - h - 4))) + 'px';
}

// handle を掴んで box を動かせるようにする。CSS の resize による大きさ変更も
// 一緒に記憶する。handle のダブルクリックで既定の位置・大きさへ戻す。
//
// 汎用入力モーダルは1つの箱を使い回すので、パネルとして振る舞ってよいのは
// コード編集のときだけ。リスナは一度しか張らない代わりに、box._panelKey が
// 入っている間だけ動く（外れている間は素の中央モーダルのまま）。
function makePanelDraggable(box, handle, key) {
  if (!box || !handle) return;
  box._panelKey = key;
  handle.style.cursor = 'move';
  handle.title = 'ドラッグで移動 / ダブルクリックで元の位置へ';
  if (box._panelBound) return;
  box._panelBound = true;

  const save = () => {
    if (!box._panelKey) return;
    try { localStorage.setItem(_panelKey(box._panelKey), JSON.stringify(_panelGeom(box))); } catch { /* ignore */ }
  };

  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !box._panelKey) return;
    e.preventDefault(); // ヘッダ文字列の選択を始めない
    const r = box.getBoundingClientRect();
    box.style.position = 'fixed';
    box.style.margin = '0';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    let moved = false;
    const onMove = (mv) => {
      moved = true;
      // 端まで持って行っても掴み直せるよう、ヘッダが画面内に残る範囲で止める。
      box.style.left = Math.max(60 - box.offsetWidth, Math.min(mv.clientX - dx, window.innerWidth - 60)) + 'px';
      box.style.top = Math.max(0, Math.min(mv.clientY - dy, window.innerHeight - 30)) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // 動かしていないなら覚えない (タイトルを一度クリックしただけで位置が
      // 固定されないように)。ここで位置を素へ戻してはいけない —— 復元した
      // 位置ごと消えてしまう。記憶しなければ次に開いたときは既定へ戻る。
      if (moved) save();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // リサイズハンドルは CSS 側 (resize:both) なので、終わりを mouseup で拾う。
  // ResizeObserver だと開いた瞬間の 0→既定サイズでも発火し、触っていない
  // 大きさを覚えてしまう。
  let lastW = 0, lastH = 0;
  box.addEventListener('mousedown', () => {
    lastW = box.offsetWidth; lastH = box.offsetHeight;
    // 触った窓を前へ。ピークは開くたびに重なり順を上げていくので、
    // これが無いとダイアログが下敷きのままになる。
    // 重なり順はオーバーレイ側に付ける — 箱は既にその重なり文脈の中にいて、
    // 箱の z-index を上げても外の窓は追い越せない。
    if (box._panelKey) window.raiseAbovePeeks?.(box.parentElement);
  });
  document.addEventListener('mouseup', () => {
    if (!box._panelKey || !box.offsetWidth) return; // 閉じている / パネル扱いでない
    if (box.offsetWidth !== lastW || box.offsetHeight !== lastH) { lastW = box.offsetWidth; lastH = box.offsetHeight; save(); }
  });

  handle.addEventListener('dblclick', () => {
    if (!box._panelKey) return;
    _resetPanelStyles(box); // パネル扱いは続けたいので、位置と大きさだけ戻す
    // 既定へ戻った寸法を「変更された」と誤検出して保存し直さないよう控えを更新する。
    lastW = box.offsetWidth; lastH = box.offsetHeight;
    try { localStorage.removeItem(_panelKey(box._panelKey)); } catch { /* ignore */ }
  });
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
    // 既に開いているときは奪わない。背面を触れるようにした結果、開いたまま
    // 別の書き換えを始められるようになり、そのたびに書きかけが黙って
    // 消えていた（前の Promise も宙に浮いたままになる）。
    if (_inputModalResolve) {
      if (typeof st === 'function') st('入力中のダイアログがあります。先に確定するかキャンセルしてください');
      _inputModalField()?.focus();
      resolve(null);
      return;
    }
    _inputModalResolve = resolve;
    _inputModalCode = !!opts.code;
    _inputModalMultiline = !!opts.multiline;
    id('input-modal-title').textContent = title;
    const box = id('input-modal-box');
    box.classList.toggle('input-modal-code', _inputModalCode);
    box.classList.toggle('input-modal-multiline', _inputModalMultiline);
    // 1行入力の等幅化は textarea 側には要らない (元から等幅)。
    id('input-modal-input').classList.toggle('input-modal-input-code', _inputModalCode && !_inputModalMultiline);
    // コードを書く用途のときだけ背面を素通しにする。グループ名などの短い入力は
    // その場で完結するので、従来どおり前面で受け止める。
    id('input-modal').classList.toggle('input-modal-passthrough', _inputModalCode);
    const el = _inputModalField();
    el.placeholder = placeholder || '';
    el.value = defaultVal;
    id('input-modal').classList.add('open');
    // パネル化したダイアログ (ピークより前) から呼ばれても隠れないよう前へ出す。
    _raiseModal(id('input-modal'));
    if (_inputModalCode) {
      // 1行編集と複数行編集では欲しい大きさが違うので、記憶も分ける。
      const panelKey = 'input-modal-code' + (_inputModalMultiline ? '-block' : '');
      restorePanel(box, panelKey);
      makePanelDraggable(box, id('input-modal-title'), panelKey);
    } else {
      // コード用途で動かした位置・大きさが、グループ名入力などに残らないようにする
      // (同じ箱を使い回しているため、インライン指定を消さないと引き継がれる)。
      clearPanelGeom(box);
    }
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
// textarea の一部を、undo 履歴を保ったまま置き換える。
//
// value への代入はブラウザの undo 履歴を丸ごと捨てるので、字下げした瞬間に
// それまで打った内容を Ctrl+Z で戻せなくなる。選択してから execCommand で
// 差し替えると1回の編集として履歴に積まれる。非推奨 API だが、textarea の
// 履歴を保てる実用的な手段が他に無い。使えない環境では代入に落とす。
function _taReplace(ta, from, to, text, selStart, selEnd) {
  ta.setSelectionRange(from, to);
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
  if (!ok) {
    const v = ta.value;
    ta.value = v.slice(0, from) + text + v.slice(to);
  }
  ta.setSelectionRange(selStart, selEnd);
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
    _taReplace(ta, start, end, '\t', start + 1, start + 1);
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
  if (body === orig) return; // 外す段が無い: 履歴も選択も動かさない
  const ns = Math.max(from, start + headDelta);
  _taReplace(ta, from, to, body, ns, Math.max(ns, end + totalDelta));
}

function _inputModalClose(val) {
  id('input-modal').classList.remove('open');
  _lowerModal(id('input-modal'));
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
// パネル化したダイアログはピークより前へ出る (z-index を大きく取る) ので、
// 答えを求めるモーダルはさらにその前へ出す必要がある。前に出さないと、
// パネルから開いた確認・入力が背後に隠れて操作できなくなる。
function _raiseModal(overlay) {
  if (overlay) window.raiseAbovePeeks?.(overlay);
}
function _lowerModal(overlay) {
  if (overlay) overlay.style.zIndex = '';
}

function _gnDialogClose(value) {
  id('gn-dialog').classList.remove('open');
  _lowerModal(id('gn-dialog'));
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
    _raiseModal(id('gn-dialog'));
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
    _raiseModal(id('gn-dialog'));
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
