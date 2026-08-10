// ===== State Machine Addon =====
// 状態変数（s->early_data_state など）の代入箇所を集めて遷移図と一覧を出す。
// サーバ側 /api/state-machine が解析し、ここは描画とジャンプだけを担当する。
//
// 「追えなかった箇所を隠さない」方針: 遷移元が読めなかった代入は ? ノードから
// の破線、定数でない代入は式のまま、一度も代入されない状態は孤立ノードとして
// そのまま見せる。図に実線で描かれた辺だけがコードに根拠のある遷移。

(function() {

let _smVar = '';
let _smData = null;     // 直近のレスポンス
let _smAbort = null;
let _cy = null;
let _smSelKey = '';     // 選択中の遷移（file:line）
let _smHideSelf = localStorage.getItem('sm-hide-self') === '1';
// 図に描く範囲を1つの状態の隣接だけに絞る（'' = 全体）。48 状態の
// ハンドシェイクは1つのノードに33本集まるので、全体図は配置をどう変えても潰れる
let _smFocus = '';
// これを超えたら全体図は読めない。一覧から状態を選ばせる
const SM_GRAPH_READABLE = 20;

function _loadScript(url) {
  return new Promise((resolve, reject) => {
    const savedDefine = window.define;
    window.define = undefined;
    const s = document.createElement('script');
    s.src = url;
    s.onload  = () => { window.define = savedDefine; resolve(); };
    s.onerror = () => { window.define = savedDefine; reject(new Error('load failed: ' + url)); };
    document.head.appendChild(s);
  });
}
function _loadCytoscape() {
  if (typeof cytoscape !== 'undefined') return Promise.resolve();
  return _loadScript('/js/vendor/cytoscape.min.js');
}

function _short(file) {
  return (typeof shortPath === 'function') ? shortPath(file) : (file || '').split(/[\\/]/).pop();
}
function _esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
// 状態名は接頭辞が共通で長いので、図では共通部分を落として読む
function _stripPrefix(names) {
  if (names.length < 2) return s => s;
  let p = names[0];
  for (const n of names) {
    while (p && !n.startsWith(p)) p = p.slice(0, -1);
  }
  const cut = p.lastIndexOf('_');
  if (cut < 3) return s => s;
  const prefix = p.slice(0, cut + 1);
  return s => (s.startsWith(prefix) && s.length > prefix.length) ? s.slice(prefix.length) : s;
}

document.addEventListener('DOMContentLoaded', () => {
  document.body.insertAdjacentHTML('beforeend', `
    <div id="sm-panel">
      <div id="sm-resizer"></div>
      <div id="sm-header">
        <span id="sm-title">状態遷移</span>
        <input id="sm-input" type="text" spellcheck="false" autocomplete="off"
               placeholder="状態変数名（例: early_data_state）">
        <button id="sm-go">解析</button>
        <input id="sm-scope" type="text" spellcheck="false" autocomplete="off"
               placeholder="パスで絞る（例: ssl）"
               title="state のような汎用名は無関係な同名変数が混ざる。対象を絞ると1つの状態機械になる">
        <button id="sm-toggle-self" title="自己ループ（リトライ）を隠す">自己ループ</button>
        <span id="sm-status"></span>
        <button id="sm-close" title="閉じる (Esc)">×</button>
      </div>
      <div id="sm-body">
        <div id="sm-graph"></div>
        <div id="sm-side">
          <div id="sm-states"></div>
          <div id="sm-list"></div>
        </div>
      </div>
    </div>
  `);

  const addonBar = document.getElementById('addon-buttons');
  if (addonBar) {
    const btn = document.createElement('button');
    btn.id = 'btn-state-machine';
    btn.className = 'sec';
    btn.textContent = 'sm';
    btn.title = 'sm — 状態遷移ビュー（状態変数の代入から遷移図を作る）';
    addonBar.appendChild(btn);
    btn.onclick = () => openStateMachine();
  }

  // 幅はドラッグで変えられ、次回も同じ幅で開く。図はサイズ変更に追従させる
  const panel = document.getElementById('sm-panel');
  const savedW = parseInt(localStorage.getItem('sm-width') || '', 10);
  if (savedW > 200 && savedW < window.innerWidth) panel.style.width = savedW + 'px';
  document.getElementById('sm-resizer').addEventListener('mousedown', e => {
    e.preventDefault();
    const startX = e.clientX, startW = panel.offsetWidth;
    const onMove = ev => {
      const w = Math.max(320, Math.min(window.innerWidth - 120, startW + startX - ev.clientX));
      panel.style.width = w + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      localStorage.setItem('sm-width', String(panel.offsetWidth));
      _cy?.resize();
      _cy?.fit(undefined, 20);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  document.getElementById('sm-close').onclick = closeStateMachine;
  document.getElementById('sm-go').onclick = smAnalyze;
  for (const id of ['sm-input', 'sm-scope']) {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') smAnalyze();
      if (e.key === 'Escape') closeStateMachine();
    });
  }
  const selfBtn = document.getElementById('sm-toggle-self');
  const syncSelfBtn = () => {
    selfBtn.classList.toggle('on', _smHideSelf);
    selfBtn.textContent = _smHideSelf ? '自己ループ非表示' : '自己ループ';
  };
  syncSelfBtn();
  selfBtn.onclick = () => {
    _smHideSelf = !_smHideSelf;
    localStorage.setItem('sm-hide-self', _smHideSelf ? '1' : '0');
    syncSelfBtn();
    if (_smData) smRender();
  };
});

// 単語の上で開くと、その語を初期値にする（エディタの右クリックからの導線）
window.openStateMachine = function(word) {
  const panel = document.getElementById('sm-panel');
  if (!panel) return;
  panel.classList.add('open');
  // 閉じている間のサイズで組まれた図をドックの実寸に合わせ直す
  setTimeout(() => { _cy?.resize(); _cy?.fit(undefined, 20); }, 220);
  const input = document.getElementById('sm-input');
  if (word) input.value = word;
  input.focus();
  input.select();
  if (word && word !== _smVar) smAnalyze();
};
function closeStateMachine() {
  document.getElementById('sm-panel')?.classList.remove('open');
}

function _smStatus(text, isErr) {
  const el = document.getElementById('sm-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('sm-err', !!isErr);
}

async function smAnalyze() {
  const name = document.getElementById('sm-input').value.trim();
  if (!name) return;
  if (!/^[A-Za-z_]\w*$/.test(name)) {
    _smStatus('変数名だけを入力してください（s->st ではなく st）', true);
    return;
  }
  _smVar = name;
  _smAbort?.abort();
  _smAbort = new AbortController();
  _smStatus('解析中...');
  document.getElementById('sm-list').innerHTML = '';
  document.getElementById('sm-states').innerHTML = '';
  try {
    const glob = document.getElementById('glob')?.value.trim() || '';
    const scope = document.getElementById('sm-scope').value.trim();
    const url = '/api/state-machine?var=' + encodeURIComponent(name) +
                (glob ? '&glob=' + encodeURIComponent(glob) : '') +
                (scope ? '&dir=' + encodeURIComponent(scope) : '');
    const r = await fetch(url, { signal: _smAbort.signal });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      _smStatus(d.error || '解析に失敗しました', true);
      return;
    }
    const d = await r.json();
    // Go の空スライスは null で届く。以降は配列であることを前提に組み立てる
    d.transitions = d.transitions || [];
    d.states = d.states || [];
    _smData = d;
    smRender();
  } catch (e) {
    if (e.name !== 'AbortError') _smStatus('解析に失敗しました', true);
  }
}

// 遷移を「遷移元 → 遷移先」の辺に展開する。From が複数ある代入は
// フォールスルーや || で複数の状態から来られる意味なので、辺も複数になる。
function smEdges() {
  const edges = [];
  for (const tr of _smData.transitions) {
    const to = tr.to || null;
    const froms = (tr.from && tr.from.length) ? tr.from : [null];
    for (const from of froms) {
      if (_smHideSelf && from && to && from === to) continue;
      // 選んだ状態に触れない辺は描かない。周りだけ見えれば「ここから
      // どこへ行けるか / ここへは誰から来るか」は読める
      if (_smFocus && from !== _smFocus && to !== _smFocus) continue;
      const ftEntry = from && (tr.fell_through || []).find(f => f.name === from);
      edges.push({ from, to, tr, ft: !!ftEntry, ftLine: ftEntry ? ftEntry.set_line : 0 });
    }
  }
  return edges;
}

function smRender() {
  const d = _smData;
  const total = d.transitions.length;
  const known = d.transitions.filter(t => t.from && t.from.length).length;
  const familyLabel = { enum: 'enum 定義', prefix: '#define 群', observed: '遷移に現れた名前のみ' }[d.family] || d.family;
  if (!total) {
    _smStatus(`${d.var} への代入が見つかりませんでした（${d.files} ファイルを走査）`, true);
  } else if (!smLooksLikeStateMachine(d)) {
    // 状態でない変数に「状態 1」などと出すと解析できたように見える
    _smStatus(`${total} 代入 · ${d.files} ファイル · 状態変数ではなさそう`, true);
  } else {
    _smStatus(`${total} 代入 / 遷移元 ${known} 特定 · 状態 ${d.states.length}（${familyLabel}）` +
              ` · ${d.files} ファイル` + (d.truncated ? ' · 上限で打ち切り' : ''));
  }

  // 状態でない変数に「状態一覧」を出しても、拾えた定数が1個並ぶだけで紛らわしい
  document.getElementById('sm-states').innerHTML = '';
  if (smLooksLikeStateMachine(d)) smRenderStates();
  smRenderList();
  smRenderGraph();
}

// 状態機械らしさの判定。定数への代入が半分未満、または遷移元が1つも
// 特定できない変数は「状態」ではなく普通のデータ（サイズ・カウンタ等）。
// 図を描いても意味の無い扇形になるだけなので、代入箇所の一覧として使う。
function smLooksLikeStateMachine(d) {
  if (!d.transitions.length) return false;
  const constTargets = d.transitions.filter(t => t.to).length;
  const withSource = d.transitions.filter(t => t.from && t.from.length).length;
  return constTargets * 2 >= d.transitions.length && withSource > 0;
}

// 同名の別変数が混ざっていないかを見る。state のような汎用名は無関係な
// 状態機械が何本も同じ名前を使っているので、1枚の図にすると意味を成さない。
// 判定は「見つけた状態集合に属さない定数への代入がどれだけあるか」。
function smForeignTargets(d) {
  if (d.family === 'observed') return [];
  const known = new Set(d.states.map(s => s.name));
  const seen = new Map();
  for (const t of d.transitions) {
    if (t.to && !known.has(t.to)) seen.set(t.to, (seen.get(t.to) || 0) + 1);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
}

function smIsMixed(d) {
  const consts = d.transitions.filter(t => t.to).length;
  if (consts < 4) return false;
  return smForeignTargets(d).length * 2 > new Set(d.transitions.filter(t => t.to).map(t => t.to)).size;
}

function smRenderStates() {
  const d = _smData;
  const el = document.getElementById('sm-states');
  const dead = d.states.filter(s => !s.assigned && !s.observed);
  const rows = d.states.map(s => {
    const cls = (!s.assigned && !s.observed) ? 'sm-dead' : (!s.assigned ? 'sm-noassign' : '');
    const note = (!s.assigned && !s.observed) ? '代入なし・参照なし'
               : (!s.assigned ? '代入されない（遷移元・比較のみ）' : '');
    return `<div class="sm-state-row ${cls}" data-name="${_esc(s.name)}">
      <span class="sm-state-name">${_esc(s.name)}</span>
      <span class="sm-state-val">${_esc(s.value || '')}</span>
      <span class="sm-state-note">${_esc(note)}</span>
    </div>`;
  }).join('');
  el.innerHTML = `<div class="sm-sec-title">状態 ${d.states.length}` +
    (dead.length ? ` · <span class="sm-dead-count">未使用候補 ${dead.length}</span>` : '') +
    `</div>${rows}`;
  el.querySelectorAll('.sm-state-row').forEach(row => {
    // 状態名が並んでいる一覧はここが最初に目に入るので、遷移一覧の
    // 見出しと同じ操作にする。押す場所で結果が変わると覚えられない
    row.onclick = () => smSetFocus(row.dataset.name);
    row.classList.toggle('focused', row.dataset.name === _smFocus);
  });
}

function smRenderList() {
  const el = document.getElementById('sm-list');
  const trs = _smData.transitions;

  // 遷移元でまとめる。平坦に並べると同じ状態からの行き先が離れ、
  // 「この状態からどこへ行けるか」を数えるのに全行を読む必要がある。
  // 束ねると 132 行が 40 グループになり、各グループが1つの問いの答えになる
  const groups = new Map();
  trs.forEach((tr, i) => {
    const ftMap = {};
    for (const f of (tr.fell_through || [])) ftMap[f.name] = f.set_line || 0;
    const froms = (tr.from && tr.from.length) ? tr.from : ['?'];
    for (const from of froms) {
      if (!groups.has(from)) groups.set(from, []);
      groups.get(from).push({ tr, i, ft: from in ftMap, ftLine: ftMap[from] || 0 });
    }
  });

  // 並びは enum の宣言順。件数順にすると解析のたびに順序が変わり、
  // 上から順に確認している最中に見失う
  const order = new Map();
  (_smData.states || []).forEach((st, i) => order.set(st.name, i));
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === '?') return 1;
    if (b === '?') return -1;
    const oa = order.has(a) ? order.get(a) : 1e9;
    const ob = order.has(b) ? order.get(b) : 1e9;
    return oa !== ob ? oa - ob : a.localeCompare(b);
  });

  const html = keys.map(from => {
    const items = groups.get(from);
    const head = from === '?'
      ? '<span class="sm-unknown">遷移元不明</span>'
      : _esc(from);
    const rows = items.map(({ tr, i, ft, ftLine }) => {
      const to = tr.to || ('式: ' + (tr.to_expr || ''));
      const key = tr.file + ':' + tr.line;
      const via = tr.via ? `<span class="sm-via">via ${_esc(tr.via)}</span>` : '';
      const ifdef = (tr.ifdef && tr.ifdef.length) ? '<span class="sm-ifdef">#if</span>' : '';
      // この case のラベルでは届かない（上の case から落ちてくる）ことを示す
      const fall = ft
        ? `<span class="sm-ft" title="上の case から fall through してこの代入に到達">↴${ftLine ? ` ${ftLine}行で代入` : ''}</span>`
        : '';
      return `<div class="sm-row ${key === _smSelKey ? 'sel' : ''} ${tr.to ? '' : 'sm-row-expr'}" data-idx="${i}">
        <span class="sm-arrow">→</span>
        <span class="sm-to">${_esc(to)}</span>
        ${fall}${via}${ifdef}
        <span class="sm-loc">${_esc(tr.func || '')} ${_esc(_short(tr.file))}:${tr.line}</span>
      </div>`;
    }).join('');
    const focusable = from !== '?';
    return `<div class="sm-grp ${from === _smFocus ? 'focused' : ''}">
      <div class="sm-grp-hdr" ${focusable ? `data-from="${_esc(from)}"` : ''}
           title="${focusable ? 'クリックでこの状態の周りだけ図に描く' : ''}">
        <span class="sm-grp-name">${head}</span>
        <span class="sm-grp-n">${items.length}</span>
      </div>${rows}
    </div>`;
  }).join('');

  el.innerHTML = `<div class="sm-sec-title">遷移 ${trs.length}・遷移元 ${keys.length} 種（行をクリックでジャンプ）</div>` +
    (html || '<div class="sm-empty">代入が見つかりませんでした</div>');

  el.querySelectorAll('.sm-row').forEach(row => {
    row.onclick = () => smJump(trs[+row.dataset.idx]);
  });
  el.querySelectorAll('.sm-grp-hdr[data-from]').forEach(hdr => {
    hdr.onclick = () => {
      smSetFocus(hdr.dataset.from);
    };
  });
}

function smJump(tr) {
  if (!tr) return;
  _smSelKey = tr.file + ':' + tr.line;
  document.querySelectorAll('#sm-list .sm-row').forEach(r => {
    r.classList.toggle('sel', (_smData.transitions[+r.dataset.idx].file + ':' +
                               _smData.transitions[+r.dataset.idx].line) === _smSelKey);
  });
  if (typeof openPeek === 'function') openPeek(tr.file, tr.line);
}

// smSetFocus は図に描く範囲を1つの状態の周りへ切り替える。
// 同じ状態をもう一度選んだら全体へ戻す（トグル）。
function smSetFocus(name) {
  _smFocus = (_smFocus === name) ? '' : name;
  smRenderStates();
  smRenderList();
  smRenderGraph();
  if (_smFocus) smFocusState(_smFocus);
}

function smFocusState(name) {
  if (!_cy) return;
  const n = _cy.getElementById(name);
  if (n && n.length) {
    _cy.animate({ center: { eles: n }, zoom: Math.max(_cy.zoom(), 1) }, { duration: 200 });
    n.flashClass('sm-flash', 700);
  }
}

async function smRenderGraph() {
  const container = document.getElementById('sm-graph');
  if (!smLooksLikeStateMachine(_smData)) {
    if (_cy) { _cy.destroy(); _cy = null; }
    const exprs = _smData.transitions.filter(t => !t.to).length;
    container.innerHTML = `<div class="sm-notsm">
      <b>${_esc(_smData.var)}</b> は状態変数ではなさそうです<br>
      代入 ${_smData.transitions.length} 件のうち ${exprs} 件が定数でない値で、
      遷移元も特定できませんでした。<br>
      遷移図の代わりに、下の一覧を<b>「どこで書き換えているか」</b>として使えます。
    </div>`;
    return;
  }
  if (smIsMixed(_smData)) {
    if (_cy) { _cy.destroy(); _cy = null; }
    const foreign = smForeignTargets(_smData);
    container.innerHTML = `<div class="sm-notsm">
      <b>${_esc(_smData.var)}</b> は複数の無関係な変数で使われています<br>
      ${_smData.files} ファイルにまたがり、見つけた状態集合
      （${_esc(_smData.family === 'enum' ? 'enum' : '#define')} の
      ${_smData.states.length} 個）に含まれない定数が
      ${foreign.length} 種類あります:
      <span class="sm-foreign">${foreign.slice(0, 8).map(_esc).join(', ')}${foreign.length > 8 ? ' …' : ''}</span><br>
      上の<b>「パスで絞る」</b>に対象を入れると、1つの状態機械として見られます。
    </div>`;
    return;
  }
  try {
    await _loadCytoscape();
  } catch (e) {
    container.innerHTML = '<div class="sm-empty">グラフの読み込みに失敗しました</div>';
    return;
  }
  const d = _smData;
  const label = _stripPrefix(d.states.map(s => s.name));
  const edges = smEdges();

  // フォーカス中は辺に出てくる状態だけ。全状態を置くと、辺の無いノードが
  // 散らばって「周りだけ見る」意味が消える
  const touched = new Set();
  if (_smFocus) {
    touched.add(_smFocus);
    for (const e of edges) { if (e.from) touched.add(e.from); if (e.to) touched.add(e.to); }
  }
  const nodes = d.states
    .filter(s => !_smFocus || touched.has(s.name))
    .map(s => ({
      data: { id: s.name, label: label(s.name) + (s.value ? ` (${s.value})` : ''),
              dead: (!s.assigned && !s.observed) ? 1 : 0,
              focus: s.name === _smFocus ? 1 : 0 }
    }));
  const known = new Set(d.states.map(s => s.name));
  // 状態集合に無い名前（式の遷移先など）もノードにする
  for (const e of edges) {
    for (const n of [e.from, e.to]) {
      if (n && !known.has(n)) { known.add(n); nodes.push({ data: { id: n, label: label(n) } }); }
    }
  }
  let unknownUsed = false;
  const cyEdges = [];
  edges.forEach((e, i) => {
    const to = e.to || ('expr:' + (e.tr.to_expr || '?'));
    if (!known.has(to)) { known.add(to); nodes.push({ data: { id: to, label: e.tr.to_expr || '?', expr: 1 } }); }
    let from = e.from;
    if (!from) { from = '__unknown__'; unknownUsed = true; }
    cyEdges.push({ data: { id: 'e' + i, source: from, target: to, idx: e.tr._idx,
                           label: e.tr.via ? 'via ' + e.tr.via
                                  : (e.ft ? (e.ftLine ? `L${e.ftLine} で代入 → fall through` : 'fall through') : ''),
                           unknown: e.from ? 0 : 1, self: (e.from === e.to) ? 1 : 0,
                           ft: e.ft ? 1 : 0 } });
  });
  if (unknownUsed) nodes.push({ data: { id: '__unknown__', label: '遷移元不明', unknown: 1 } });

  // idx をたどれるよう遷移に索引を振っておく
  d.transitions.forEach((t, i) => { t._idx = i; });
  cyEdges.forEach((ce, i) => { ce.data.idx = edges[i].tr._idx; });

  // 前回が「状態変数ではない」だった場合、説明文の DOM が残っている。
  // 消さずに cytoscape を作ると、その上に重ねて描かれて枠からはみ出す
  if (_cy) { _cy.destroy(); _cy = null; }
  container.innerHTML = '';
  // 全体図が読める大きさを超えたら、そう言う。黙って毛玉を出すと
  // 「解析が失敗した」ようにしか見えない
  if (_smFocus || d.states.length > SM_GRAPH_READABLE) {
    const bar = document.createElement('div');
    bar.className = 'sm-focusbar';
    bar.innerHTML = _smFocus
      ? `<b>${_esc(_smFocus)}</b> の周りだけ表示中（${nodes.length} 状態）<button id="sm-focus-clear">全体を見る</button>`
      : `${d.states.length} 状態は1枚の図では読めません。<b>状態名をクリック</b>すると、その周りだけ描きます（状態一覧・遷移一覧のどちらでも）`;
    container.appendChild(bar);
    const clear = bar.querySelector('#sm-focus-clear');
    if (clear) clear.onclick = () => smSetFocus(_smFocus); // 同じ名前を渡すと解除
  }
  const graphBox = document.createElement('div');
  graphBox.className = 'sm-graph-box';
  container.appendChild(graphBox);
  _cy = cytoscape({
    container: graphBox,
    elements: { nodes, edges: cyEdges },
    style: [
      { selector: 'node', style: {
          'background-color': '#2d4a6a', 'border-color': '#4a90d9', 'border-width': 1.5,
          'label': 'data(label)', 'color': '#dcdcdc', 'font-size': 11,
          'text-valign': 'center', 'text-halign': 'center', 'shape': 'round-rectangle',
          'width': 'label', 'height': 22, 'padding': '8px', 'text-wrap': 'none' } },
      { selector: 'node[dead = 1]', style: {
          'background-color': '#2a2a2a', 'border-color': '#555', 'border-style': 'dashed', 'color': '#888' } },
      { selector: 'node[expr = 1]', style: {
          'background-color': '#3a3020', 'border-color': '#d7a35c', 'color': '#d7a35c' } },
      { selector: 'node[unknown = 1]', style: {
          'background-color': '#332b22', 'border-color': '#d7a35c', 'border-style': 'dashed', 'color': '#d7a35c' } },
      { selector: 'edge', style: {
          'width': 1.5, 'line-color': '#7aa7cc', 'target-arrow-color': '#7aa7cc',
          'target-arrow-shape': 'triangle', 'curve-style': 'bezier', 'arrow-scale': 0.9,
          'label': 'data(label)', 'font-size': 9, 'color': '#8a8a8a',
          'text-background-color': '#1e1e1e', 'text-background-opacity': 0.85,
          'text-background-padding': 2 } },
      { selector: 'edge[unknown = 1]', style: {
          'line-style': 'dashed', 'line-color': '#d7a35c', 'target-arrow-color': '#d7a35c' } },
      { selector: 'edge[self = 1]', style: { 'line-color': '#5a7a8a', 'target-arrow-color': '#5a7a8a' } },
      // fall through で届く辺は点線。代入はこの case ではなく上の case の
      // 続きにあり、コードを見ただけでは辿りにくい経路であることを示す
      { selector: 'edge[ft = 1]', style: { 'line-style': 'dotted', 'line-color': '#9aa7b5' } },
      // 後勝ちなので、基本の node より後・一時的な強調(.sm-flash)より前に置く
      { selector: 'node[focus = 1]', style: {
          'background-color': '#0b3a5c', 'border-color': '#9cdcfe', 'border-width': 2.5 } },
      { selector: '.sm-flash', style: { 'border-color': '#ffd479', 'border-width': 3 } },
      { selector: '.sm-hl', style: { 'line-color': '#ffd479', 'target-arrow-color': '#ffd479', 'width': 2.5 } },
    ],
    layout: {
      name: 'breadthfirst', directed: true, spacingFactor: 0.85, padding: 16,
      avoidOverlap: true, nodeDimensionsIncludeLabels: true,
    },
    wheelSensitivity: 0.2,
  });
  // 横に広い図を全部収めようとすると文字が読めない大きさまで縮む。
  // 一定より小さくはせず、あとはパン・ホイールで見てもらう
  _cy.ready(() => {
    if (_cy.zoom() < 0.55) {
      _cy.zoom(0.55);
      _cy.center();
    }
  });

  _cy.on('tap', 'edge', evt => {
    const idx = evt.target.data('idx');
    _cy.edges().removeClass('sm-hl');
    evt.target.addClass('sm-hl');
    smJump(_smData.transitions[idx]);
  });
  _cy.on('tap', 'node', evt => {
    const id = evt.target.id();
    const row = document.querySelector(`#sm-states .sm-state-row[data-name="${CSS.escape(id)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    row?.classList.add('sm-state-flash');
    setTimeout(() => row?.classList.remove('sm-state-flash'), 700);
  });
}

})();
