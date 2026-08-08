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
      _symbolsRefresh();
    });
    id('symbols-input').addEventListener('input', () => {
      clearTimeout(_symTimer);
      _symTimer = setTimeout(_symbolsRefresh, 150);
    });
    id('symbols-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') { clearTimeout(_symTimer); _symbolsRefresh(); }
    });
  }
  setTimeout(() => { id('symbols-input')?.focus(); id('symbols-input')?.select(); }, 0);
  _symbolsRefresh();
}

// 索引の有無を先に見る。無いのに入力を促すと「打ってから怒られる」体験になる。
// 生成はパネル内のボタンで完結させる（別の場所の歯車を探させない）。
function _symbolsRefresh() {
  if (typeof window._ctagsIndexed === 'function' && !window._ctagsIndexed()) {
    _symbolsRenderNoIndex();
    return;
  }
  _symbolsFetch();
}

let _symWaitTimer = null;
function _symbolsRenderNoIndex() {
  const list = id('symbols-list');
  const status = id('symbols-status');
  list.innerHTML = '';
  status.textContent = '';
  const box = document.createElement('div');
  box.className = 'sym-noindex';
  const msg = document.createElement('div');
  const installed = typeof window._ctagsInstalled !== 'function' || window._ctagsInstalled();
  msg.textContent = installed
    ? 'シンボル検索には ctags 索引が必要です。'
    : 'ctags が見つかりません。Universal Ctags のインストールが必要です（入手方法は README の「必要なもの」参照）。';
  box.appendChild(msg);
  if (!installed) {
    // インストールは grepnavi の外で行われる。サーバは status のたびに PATH を
    // 引き直すので、リロードしなくてもここから復帰できる
    const recheck = document.createElement('button');
    recheck.id = 'symbols-recheck-btn';
    recheck.textContent = 'インストールしたら再確認';
    recheck.onclick = async () => {
      try {
        const d = await (await fetch('/api/ctags/status')).json();
        window._ctagsSetStatus?.(d);
      } catch (_) {}
      _symbolsRefresh();
      if (typeof window._ctagsInstalled === 'function' && !window._ctagsInstalled()) {
        st('ctags がまだ見つかりません（インストール直後は grepnavi の再起動が要る場合があります）');
      }
    };
    box.appendChild(recheck);
  }
  if (installed) {
    const btn = document.createElement('button');
    btn.id = 'symbols-build-btn';
    btn.textContent = '索引を生成';
    btn.onclick = () => {
      window._ctagsRunIndex?.();
      btn.disabled = true;
      btn.textContent = '生成中…';
      // 生成の進捗表示は ctags.js のコンソールに任せ、完了したら自動で一覧に切り替える
      clearInterval(_symWaitTimer);
      let waited = 0;
      _symWaitTimer = setInterval(() => {
        waited += 1000;
        if (window._ctagsIndexed?.()) {
          clearInterval(_symWaitTimer);
          _symbolsRefresh();
        } else if (waited > 300000) {
          clearInterval(_symWaitTimer);
          btn.disabled = false;
          btn.textContent = '索引を生成';
        }
      }, 1000);
    };
    box.appendChild(btn);
  }
  list.appendChild(box);
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
  // 入力が空なら種別が選ばれていても一覧しない。上限100件のツリーでは
  // アルファベット順の先頭が同名マクロで埋まるだけで、閲覧として機能しない。
  if (!pattern) {
    _symSeq++; // 直前の打鍵で飛んだ応答が、消した後に着地して一覧を復活させないように
    list.innerHTML = '';
    status.textContent = '名前の一部を入力（例: recipe save → recipe_save）';
    return;
  }
  const seq = ++_symSeq;
  const params = new URLSearchParams({ pattern, limit: '100' });
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
    _symbolsRenderNoIndex();
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
