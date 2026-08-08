// ===== シンボル検索パネル =====
// grep 検索（本文の全文検索）とは別の、名前で引くライブサーチ。
// 打鍵ごとに /api/symbol-search を叩き、種別チップで関数だけ・構造体だけ等に絞る。
// バックエンドは ctags 索引（Alt+T のシンボルクイックオープンと同じ）。

const SYM_KINDS = [
  { kind: '',            label: 'すべて' },
  { kind: 'func',        label: '関数' },
  { kind: 'struct',      label: 'struct' },
  { kind: 'define',      label: 'マクロ' },
  { kind: 'typedef',     label: 'typedef' },
  { kind: 'enum',        label: 'enum' },
  { kind: 'var',         label: '変数' },
];

let _symKind = '';
let _symSeq = 0;        // 古い応答が新しい入力の結果を上書きしないための連番
let _symTimer = null;   // 打鍵デバウンス
let _symShown = false;  // 初回表示でチップを組み立てたか

function symbolsPanelShow() {
  if (!_symShown) {
    _symShown = true;
    const wrap = id('symbols-kinds');
    wrap.innerHTML = SYM_KINDS.map(k =>
      `<button class="sym-kind${k.kind === _symKind ? ' sel' : ''}" data-kind="${k.kind}">${k.label}</button>`
    ).join('');
    wrap.addEventListener('click', e => {
      const btn = e.target.closest('.sym-kind');
      if (!btn) return;
      _symKind = btn.dataset.kind;
      wrap.querySelectorAll('.sym-kind').forEach(b => b.classList.toggle('sel', b === btn));
      _symbolsFetch();
    });
    id('symbols-input').addEventListener('input', () => {
      clearTimeout(_symTimer);
      _symTimer = setTimeout(_symbolsFetch, 150);
    });
    id('symbols-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') { clearTimeout(_symTimer); _symbolsFetch(); }
    });
  }
  setTimeout(() => { id('symbols-input')?.focus(); id('symbols-input')?.select(); }, 0);
  _symbolsFetch();
}

// fzf と同じ規約: スペース区切りトークンを順序付き AND（.* 連結）にする。
// "recipe save" → recipe.*save で recipe_save に当たる。
function _symbolsPattern(query) {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return '';
  return tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
}

async function _symbolsFetch() {
  const q = id('symbols-input').value;
  const pattern = _symbolsPattern(q);
  const list = id('symbols-list');
  const status = id('symbols-status');
  if (!pattern && !_symKind) {
    list.innerHTML = '';
    status.textContent = '名前の一部を入力（例: recipe save → recipe_save）';
    return;
  }
  const seq = ++_symSeq;
  const params = new URLSearchParams({ pattern: pattern || '.', limit: '100' });
  if (_symKind) params.set('kind', _symKind);
  let d;
  try {
    const r = await fetch('/api/symbol-search?' + params);
    d = await r.json();
  } catch (_) {
    return;
  }
  if (seq !== _symSeq) return; // 打鍵が先に進んでいる
  if (d.hint) {
    list.innerHTML = '';
    status.textContent = 'ctags 索引がありません（右下の歯車 → ctags 生成）';
    return;
  }
  const symbols = d.symbols || [];
  list.innerHTML = '';
  for (const s of symbols) {
    const row = document.createElement('div');
    row.className = 'sym-row';
    const name = document.createElement('span');
    name.className = 'sym-name';
    name.textContent = s.name || s.text;
    const kind = document.createElement('span');
    kind.className = 'sym-kind-badge';
    kind.style.background = kindColor(s.kind);
    kind.textContent = kindLabel(s.kind);
    const loc = document.createElement('span');
    loc.className = 'sym-loc';
    loc.textContent = shortPath(s.file) + ':' + s.line;
    row.append(name, kind, loc);
    row.title = s.file + ':' + s.line + '\n' + (s.text || '');
    row.onclick = async () => {
      // 索引の行番号は編集でずれるので、飛ぶ1件だけ決定時に補正する（Alt+T と同じ規約）
      openPeek(s.file, await healedSymbolLine(s));
    };
    list.appendChild(row);
  }
  status.textContent = symbols.length
    ? `${symbols.length} 件${d.truncated ? '（上限で打ち切り）' : ''}`
    : '一致するシンボルがありません';
}
