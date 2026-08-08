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
let _symLast = null;    // 直近の結果。表示形式の切り替えで再フェッチしないため
// 表示形式: フラット（一致の良い順）⇄ ファイル単位。既定はフラット。
// シンボル検索の主キーは関連度なので、束ねるのは明示的に選んだときだけ。
let _symGrouped = localStorage.getItem('grepnavi-sym-group') === '1';

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
    // 場所の絞り込みバー（grep 結果の絞り込みと同じ位置づけ）。
    // 見た目はクライアントのフィルタだが、実際はサーバ側で絞る。
    // 取得済み100件から削る方式だと、目当てが上限の外に落ちて見えなくなる。
    for (const [inputId, clearId] of [['symbols-filter', 'symbols-filter-clear'],
                                      ['symbols-glob', 'symbols-glob-clear']]) {
      const inp = id(inputId);
      inp.addEventListener('input', () => {
        id(clearId).style.display = inp.value ? '' : 'none';
        clearTimeout(_symTimer);
        _symTimer = setTimeout(_symbolsRefresh, 150);
      });
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { clearTimeout(_symTimer); _symbolsRefresh(); }
      });
      id(clearId).onclick = () => {
        inp.value = '';
        id(clearId).style.display = 'none';
        _symbolsRefresh();
      };
    }
    const gbtn = id('symbols-group-btn');
    gbtn.classList.toggle('on', _symGrouped);
    gbtn.onclick = () => {
      _symGrouped = !_symGrouped;
      localStorage.setItem('grepnavi-sym-group', _symGrouped ? '1' : '0');
      gbtn.classList.toggle('on', _symGrouped);
      if (_symLast) _symbolsRender(_symLast.symbols, _symLast.truncated);
    };
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

// 入力を「名前のトークン」と「パス条件」に分ける。パス条件は grep 検索の
// 絞り込みバーと同じ語彙 (path:xxx / file:xxx / -path:xxx / -file:xxx)。
// 名前側は fzf と同じ規約: スペース区切りを順序付き AND（.* 連結）にする。
// "recipe save" → recipe.*save で recipe_save に当たる。
function _symbolsParse(query) {
  const nameTokens = [];
  const pathTerms = [];
  for (const tok of query.trim().split(/\s+/).filter(Boolean)) {
    const m = tok.match(/^(-?)(?:path|file):(.*)$/i);
    if (m) {
      if (m[2]) pathTerms.push(m[1] + m[2]);
      continue;
    }
    nameTokens.push(tok);
  }
  return {
    pattern: nameTokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'),
    path: pathTerms.join(' '),
  };
}

// 絞り込みバーの中身をパス条件へ。素のトークンは「含む」、"-" 始まりは「除外」。
// path: / file: の接頭辞も受ける（メイン入力と語彙を揃えるため。無くてもよい）。
function _symbolsFilterTerms() {
  const out = [];
  for (const tok of (id('symbols-filter')?.value || '').trim().split(/\s+/).filter(Boolean)) {
    const m = tok.match(/^(-?)(?:path:|file:)?(.*)$/i);
    if (m && m[2]) out.push(m[1] + m[2]);
  }
  return out;
}

// 含めるファイル欄（grep の glob 欄と同じカンマ区切り: *.c,*.h）を
// 「いずれかに一致」の1条件へまとめる。"*" の無い ".c" / "c" も拡張子として受ける。
function _symbolsGlobTerm() {
  const alts = [];
  for (let tok of (id('symbols-glob')?.value || '').split(/[,\s]+/).filter(Boolean)) {
    if (!/[*?]/.test(tok) && !tok.startsWith('.')) tok = '.' + tok;
    alts.push(tok);
  }
  return alts.join('|');
}

async function _symbolsFetch() {
  const q = id('symbols-input').value;
  const parsed = _symbolsParse(q);
  const pattern = parsed.pattern;
  const path = [parsed.path, ..._symbolsFilterTerms(), _symbolsGlobTerm()]
    .filter(Boolean).join(' ');
  const list = id('symbols-list');
  const status = id('symbols-status');
  // 名前もパス条件も無ければ一覧しない。上限100件のツリーでは
  // アルファベット順の先頭が同名マクロで埋まるだけで、閲覧として機能しない。
  // パス条件だけは許す（例: path:drivers/led + 種別チップ）——場所で範囲が
  // 絞られていれば、その中の一覧は閲覧として意味を持つ。
  if (!pattern && !path) {
    _symSeq++; // 直前の打鍵で飛んだ応答が、消した後に着地して一覧を復活させないように
    _symbolsRenderHint('名前の一部を入力', 'スペース区切りで AND（recipe save → recipe_save）');
    status.textContent = '';
    return;
  }
  const seq = ++_symSeq;
  const params = new URLSearchParams({ pattern: pattern || '.', limit: '100' });
  if (path) params.set('path', path);
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
    _symbolsRenderNoIndex();
    return;
  }
  _symLast = { symbols: d.symbols || [], truncated: !!d.truncated };
  _symbolsRender(_symLast.symbols, _symLast.truncated);
}

function _symSplitPath(file) {
  const p = (file || '').replace(/\\/g, '/');
  const i = p.lastIndexOf('/');
  return { dir: shortPath(i >= 0 ? p.slice(0, i) : ''), base: i >= 0 ? p.slice(i + 1) : p };
}

// 案内をリスト領域の中央に出す（最下段のステータス行は読まれない場所なので使わない）
function _symbolsRenderHint(main, sub) {
  const list = id('symbols-list');
  list.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'sym-noindex';
  const m = document.createElement('div');
  m.textContent = main;
  box.appendChild(m);
  if (sub) {
    const d = document.createElement('div');
    d.className = 'sym-hint-sub';
    d.textContent = sub;
    box.appendChild(d);
  }
  list.appendChild(box);
}

function _symMakeRow(s, withLoc) {
  const row = document.createElement('div');
  row.className = 'sym-row';
  const name = document.createElement('span');
  name.className = 'sym-name';
  name.textContent = s.name || s.text;
  row.append(name);
  // 種別チップで絞っている間は全行同じバッジになる。同じ情報の反復は
  // ノイズでしかないので、「すべて」表示のときだけ種別を行に出す
  if (!_symKind) {
    const kind = document.createElement('span');
    kind.className = 'sym-kind-badge';
    kind.style.background = kindColor(s.kind);
    kind.textContent = kindLabel(s.kind);
    row.append(kind);
  }
  const loc = document.createElement('span');
  loc.className = 'sym-loc';
  if (withLoc) {
    const { dir, base } = _symSplitPath(s.file);
    const d = document.createElement('span');
    d.className = 'sym-dir';
    d.textContent = dir ? dir + '/' : '';
    const f = document.createElement('span');
    f.className = 'sym-file';
    f.textContent = base + ':' + s.line;
    loc.append(d, f);
  } else {
    const f = document.createElement('span');
    f.className = 'sym-file';
    f.textContent = ':' + s.line;
    loc.appendChild(f);
  }
  row.appendChild(loc);
  row.title = s.file + ':' + s.line + '\n' + (s.text || '');
  row.onclick = async () => {
    // 索引の行番号は編集でずれるので、飛ぶ1件だけ決定時に補正する（Alt+T と同じ規約）
    openPeek(s.file, await healedSymbolLine(s));
  };
  return row;
}

function _symbolsRender(symbols, truncated) {
  const list = id('symbols-list');
  const status = id('symbols-status');
  list.innerHTML = '';
  if (!_symGrouped) {
    for (const s of symbols) list.appendChild(_symMakeRow(s, true));
  } else {
    // ファイル単位。グループの並びは出現順（= 良い一致を含むファイルが先）に保ち、
    // フラット表示のランキングを壊さずに束ねる。
    const groups = new Map();
    for (const s of symbols) {
      if (!groups.has(s.file)) groups.set(s.file, []);
      groups.get(s.file).push(s);
    }
    for (const [file, items] of groups) {
      const hdr = document.createElement('div');
      hdr.className = 'sym-group-hdr';
      const { dir, base } = _symSplitPath(file);
      const d = document.createElement('span');
      d.className = 'sym-dir';
      d.textContent = dir ? dir + '/' : '';
      const f = document.createElement('span');
      f.className = 'sym-file';
      f.textContent = base;
      const n = document.createElement('span');
      n.className = 'sym-group-count';
      n.textContent = String(items.length);
      hdr.append(d, f, n);
      hdr.title = file;
      list.appendChild(hdr);
      for (const s of items) list.appendChild(_symMakeRow(s, false));
    }
  }
  if (!symbols.length) {
    _symbolsRenderHint('一致するシンボルがありません');
    status.textContent = '0 件';
    return;
  }
  // 打ち切りは行き止まりにしない。絞り込み手段（場所・種別）まで案内する
  status.textContent = `${symbols.length} 件` +
    (truncated ? '（上限で打ち切り — 場所や種別で絞ると残りが見えます）' : '');
}
