// ===== 参照マップ Addon =====
// gtags の索引から「どのモジュールがどのモジュールの実装を参照しているか」を
// 表示する。ジャンプマップ（訪問の足跡）と違い、開いたことのないツリーでも
// 全域が最初から見える。全体図は入口で、主役は1モジュールのフォーカス表示。

(function() {

let _rmRoot = '';      // サーバーの root（絶対パスの組み立てに使う）
let _rmFocus = '';     // '' = 全体図
let _rmData = null;   // 直近の応答（タブ切り替えの再描画で再取得しない）
let _rmTab = 'in';    // フォーカスビューの面（in / mid / out）
let _rmFilter = '';   // フォーカスビューの絞り込み（面をまたいで効く）
let _rmAbort = null;

document.addEventListener('DOMContentLoaded', () => {
  document.body.insertAdjacentHTML('beforeend', `
    <div id="rm-sidebar" class="side-panel">
      <div id="rm-resizer"></div>
      <div id="rm-header">
        <button id="rm-back" title="前に戻る (Alt+←)" disabled>&#8592;</button>
        <button id="rm-fwd" title="次へ進む (Alt+→)" disabled>&#8594;</button>
        <span id="rm-crumbs"></span>
        <span id="rm-spacer"></span>
        <button id="rm-close" title="閉じる">×</button>
      </div>
      <div id="rm-bar"></div>
      <div id="rm-body"></div>
      <div id="rm-footer"></div>
    </div>
  `);

  const addonBar = document.getElementById('addon-buttons');
  if (addonBar) {
    const btn = document.createElement('button');
    btn.id = 'btn-ref-map';
    btn.className = 'sec';
    btn.textContent = 'map';
    btn.title = 'map — 参照マップ (どこがどこを参照しているか)';
    addonBar.appendChild(btn);
    btn.onclick = () => openRefMap();
  }

  document.getElementById('rm-close').onclick = () => closeRefMap();
  document.getElementById('rm-back').onclick = () => rmHistGo(-1);
  document.getElementById('rm-fwd').onclick = () => rmHistGo(1);

  // Alt+←/→ はエディタの履歴に常時割り当てられている (app.js)。ここで
  // document に足すと、パネルを開いている間ずっとエディタ側が動かなくなる。
  // サイドバー内で押されたときだけ拾い、そこで伝播を止める。tabindex=-1 に
  // しているので、行やパンくずをクリックした時点でフォーカスはこの中にある。
  const rmPane = document.getElementById('rm-sidebar');
  rmPane.tabIndex = -1;
  rmPane.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    if (!rmHistGo(e.key === 'ArrowLeft' ? -1 : 1)) {
      st(e.key === 'ArrowLeft' ? 'これより前の履歴はありません' : 'これより先の履歴はありません');
    }
  });

  const resizer = document.getElementById('rm-resizer');
  const sidebar = document.getElementById('rm-sidebar');
  sidebar.style.width = (parseInt(localStorage.getItem('rm-width')) || 380) + 'px';
  resizer.addEventListener('mousedown', e => {
    e.preventDefault();
    const startX = e.clientX, startW = sidebar.offsetWidth;
    const move = ev => {
      const w = Math.min(Math.max(startW + (startX - ev.clientX), 260), window.innerWidth - 200);
      sidebar.style.width = w + 'px';
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      localStorage.setItem('rm-width', sidebar.offsetWidth);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
});

function openRefMap(focus) {
  document.getElementById('rm-sidebar').classList.add('open');
  rmLoad(focus !== undefined ? focus : _rmFocus);
}
window.openRefMap = openRefMap;

function closeRefMap() {
  document.getElementById('rm-sidebar').classList.remove('open');
}

// ===== 移動の履歴 =====

// パンくずは祖先しか辿れない。`▾` の兄弟移動やファイルツリーからの直行が入って、

// 「さっき見ていた場所」がパンくずの上に無いことが普通になったので、来た道を

// 別に持つ。エディタ側の履歴 (editor.js の navHistory) と同じ規約で、履歴を

// 辿っている間は積まない。

let _rmHist = [];

let _rmHistIdx = -1;



function rmHistPush(focus) {

  if (_rmHistIdx >= 0 && _rmHist[_rmHistIdx] === focus) return;

  _rmHist = _rmHist.slice(0, _rmHistIdx + 1);

  _rmHist.push(focus);

  _rmHistIdx = _rmHist.length - 1;

}



function rmHistGo(delta) {

  const i = _rmHistIdx + delta;

  if (i < 0 || i >= _rmHist.length) return false;

  _rmHistIdx = i;

  rmLoad(_rmHist[i], { fromHistory: true });

  return true;

}



function rmUpdateNavButtons() {

  const b = document.getElementById('rm-back');

  const f = document.getElementById('rm-fwd');

  if (b) b.disabled = _rmHistIdx <= 0;

  if (f) f.disabled = _rmHistIdx >= _rmHist.length - 1;

}

async function rmLoad(focus, opts) {
  _rmFocus = focus || '';
  _rmClosed = new Set(); // 畳み状態は今いる場所のもの。移ったら持ち越さない
  if (!opts || !opts.fromHistory) rmHistPush(_rmFocus);
  rmUpdateNavButtons();
  _rmTab = 'in';
  _rmFilter = '';
  if (_rmAbort) _rmAbort.abort();
  _rmAbort = new AbortController();
  document.getElementById('rm-bar').textContent = '';
  const body = document.getElementById('rm-body');
  rmMsg(body, '読み込み中…');
  rmRenderCrumbs();
  try {
    const url = _rmFocus
      ? '/api/structure?' + new URLSearchParams({ focus: _rmFocus })
      : '/api/structure'; // depth なし = 自動畳み（大きな塊は中の重い部分を取り出す）
    const r = await fetch(url, { signal: _rmAbort.signal });
    const d = await r.json();
    if (r.status === 409) {
      // 表がまだ無い。開いた瞬間に数十秒使わず、作るかどうかを選ばせる
      rmRenderNotBuilt(d.status || {});
      document.getElementById('rm-footer').textContent = '';
      return;
    }
    if (!r.ok) {
      // gtags なし等。偽の空マップを出さず理由をそのまま見せる
      rmMsg(body, d.error || r.statusText);
      document.getElementById('rm-footer').textContent = '';
      return;
    }
    if (_rmRoot && d.root && d.root !== _rmRoot) {
      // ルートを切り替えた。前の木のパスを履歴に残すと、戻った先が今の木に
      // 無いことになる
      _rmHist = [_rmFocus];
      _rmHistIdx = 0;
      rmUpdateNavButtons();
    }
    _rmRoot = d.root || '';
    _rmData = d;
    rmRerender();
  } catch (e) {
    if (e.name !== 'AbortError') rmMsg(body, '取得に失敗: ' + e.message);
  }
}

// 索引から表を作る前の画面。gtags 索引の生成と同じ流儀で、
// 何が要るのか・どれくらいかかるのかを出してから選ばせる。
function rmRenderNotBuilt(st) {
  const body = document.getElementById('rm-body');
  document.getElementById('rm-bar').textContent = '';
  body.textContent = '';

  if (!st.indexed) {
    rmMsg(body, '参照マップには GNU Global の索引が必要です。'
      + 'ツールバーのエンジン表示から索引を生成してください。');
    return;
  }
  const box = document.createElement('div');
  box.className = 'rm-build';
  const head = document.createElement('div');
  head.className = 'rm-build-head';
  head.textContent = st.stale ? '索引が更新されています' : '参照マップはまだ作られていません';
  box.appendChild(head);

  const desc = document.createElement('div');
  desc.className = 'rm-hint';
  desc.textContent = `索引 ${st.index_mb} MB を1回読んで、参照の表を作ります`
    + `（見込み 約 ${rmFmtSecs(st.estimate_seconds)}）。`
    + '結果は .grepnavi-refmap に保存され、次回からは即座に開きます。';
  box.appendChild(desc);

  const btn = document.createElement('button');
  btn.className = 'rm-build-btn';
  btn.textContent = st.stale ? '作り直す' : '参照マップを作る';
  box.appendChild(btn);

  const log = document.createElement('div');
  log.className = 'rm-build-log';
  box.appendChild(log);
  body.appendChild(box);

  btn.onclick = () => rmBuild(btn, log);
}

function rmFmtSecs(n) {
  n = n || 1;
  return n < 60 ? `${n} 秒` : `${Math.round(n / 60)} 分`;
}

// 生成の進捗を SSE で受ける（/api/gtags/stream と同じ形）。
function rmBuild(btn, log) {
  btn.disabled = true;
  const spin = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let i = 0, secs = 0;
  const line = document.createElement('div');
  line.className = 'rm-build-spin';
  log.appendChild(line);
  const tick = setInterval(() => {
    i = (i + 1) % spin.length;
    if (i === 0) secs++;
    line.textContent = `${spin[i]} 生成中... ${secs} 秒`;
  }, 100);

  const es = new EventSource('/api/structure/build');
  const stop = () => { clearInterval(tick); es.close(); };
  es.onmessage = e => {
    const d = document.createElement('div');
    d.textContent = e.data;
    log.insertBefore(d, line);
    log.scrollTop = log.scrollHeight;
  };
  es.addEventListener('refmap-done', () => {
    stop();
    rmLoad(_rmFocus); // 出来上がった地図をそのまま開く
  });
  es.addEventListener('refmap-error', e => {
    stop();
    line.textContent = 'エラー: ' + (e.data || '生成に失敗しました');
    btn.disabled = false;
  });
  es.onerror = () => {
    stop();
    line.textContent = '接続が切れました（生成は中断されています）';
    btn.disabled = false;
  };
}

function rmRerender() {
  if (!_rmData) return;
  if (_rmFocus) rmRenderFocus(_rmData.map);
  else rmRenderOverview(_rmData.map);
  rmRenderFooter(_rmData);
}

// ----- 全体図: まとまり一覧 + 太いエッジ -----
function rmRenderOverview(m) {
  const bar = document.getElementById('rm-bar');
  const body = document.getElementById('rm-body');
  bar.textContent = '';
  body.textContent = '';

  // エッジからまとまりごとの出入りを集計する
  const mods = new Map();
  const at = n => {
    if (!mods.has(n)) mods.set(n, { out: 0, in: 0 });
    return mods.get(n);
  };
  for (const e of m.edges) { at(e.from).out += e.count; at(e.to).in += e.count; }

  // 取り出された子を持つ親の行は「残り」。行名にそう書かないと、
  // crypto の行が crypto 配下ぜんぶの合計に見える（実際は分割で、合計に
  // すると子と同じ参照を二重に数えることになる）
  const residual = new Set();
  for (const n of mods.keys()) {
    for (const other of mods.keys()) {
      if (other !== n && other.startsWith(n + '/')) { residual.add(n); break; }
    }
  }

  // 絞り込みはスクロールしない帯（#rm-bar）に置く。一覧と一緒に流れて
  // 消えると、絞り込んだ状態であること自体が見えなくなる
  bar.appendChild(rmFilterInput());

  const render = () => {
    body.textContent = '';
    const { must, not } = rmFilterTerms();
    const hitName = n => {
      const low = n.toLowerCase();
      return must.every(t => low.includes(t)) && !not.some(t => low.includes(t));
    };
    const hitEdge = e => {
      const hay = rmEdgeHaystack(e);
      return must.every(t => hay.includes(t)) && !not.some(t => hay.includes(t));
    };
    const filtering = must.length || not.length;

    const hint = document.createElement('div');
    hint.className = 'rm-hint';
    hint.textContent = '数字は参照の組数（同じファイル→同じ関数は何行でも1）。大きなまとまりは中の重い部分を取り出して同格に並べています（親の行は残り）。クリックで 入口・内部・依存先 の詳細。';
    body.appendChild(hint);

    // 被参照の多い順 = 上にあるほど、みんなが頼っている場所。
    // 出入りの合計で並べると test / apps / include のような「利用者」が
    // 本体（crypto / ssl）より上に来て、地図として逆さまになる
    const rows = [...mods.entries()]
      .filter(([name]) => !filtering || hitName(name))
      .sort((a, b) => (b[1].in - a[1].in) || (b[1].out - a[1].out));
    const secM = rmSection(body, filtering
      ? `まとまり — 被参照の多い順（一致 ${rows.length}/${mods.size}）`
      : 'まとまり — 被参照の多い順');
    rows.forEach(([name, c]) => {
      const row = document.createElement('div');
      row.className = 'rm-row rm-clickable';
      const nm = document.createElement('span');
      nm.className = 'rm-name rm-mod';
      // 全体図の一覧も同じ表記に揃える（まとまりは末尾 /）
      rmHighlight(nm, name, must);
      nm.appendChild(document.createTextNode(residual.has(name) ? '/（他）' : '/'));
      if (residual.has(name)) {
        nm.title = name + ' 配下のうち、取り出した子まとまり以外の残り。\n'
          + name + ' 全体の出入りはクリックして詳細表示で（外から/外へ タブの件数）';
      }
      row.appendChild(nm);
      const meta = document.createElement('span');
      meta.className = 'rm-meta';
      meta.textContent = `被参照 ${c.in} · 参照 ${c.out}`;
      meta.title = '被参照 = 外からこのまとまり内の実装への参照\n参照 = このまとまりから外の実装への参照';
      row.appendChild(meta);
      row.onclick = () => rmLoad(name);
      secM.appendChild(row);
    });

    // 全体図では普段チップを出さない。方向感を掴む画面に見本を並べると壁になる。
    // ただし絞り込み中は出す — 絞り込みはシンボル名にも当たるので、チップを
    // 伏せたままだと「パスのどこにも無い語で行が残る」状態になり、理由が見えない
    const edges = filtering ? m.edges.filter(hitEdge) : m.edges;
    const secE = rmSection(body, filtering
      ? `太い参照（一致 ${edges.length} · 上位15まで）`
      : '太い参照（上位15）');
    rmEdgeRows(secE, edges.slice(0, 15), e => `${e.count}`, { noChips: !filtering, hl: must });
  };
  document.getElementById('rm-filter').oninput = e => { _rmFilter = e.target.value; render(); };
  render();
}

// 絞り込み入力（全体図とフォーカスで同じもの）。
function rmFilterInput() {
  const filter = document.createElement('input');
  filter.id = 'rm-filter';
  filter.type = 'text';
  filter.value = _rmFilter;
  filter.spellcheck = false;
  // 対象を名前に限るのは、シンボルは上位8件の見本しか手元に無いため。
  // 見本だけを検索して「0件」を出すと、実在する参照が無いように見える
  filter.placeholder = '絞り込み: まとまり/ファイル/シンボル名（スペース=AND、-で除外）';
  return filter;
}

// 絞り込みの当たり判定。パス（from / to）だけでなく、行に付いているシンボルの
// 見本も見る。「この関数が絡む行だけ」が地図の中でいちばん出る絞り方なのに、
// パスしか見ていないと chip に名前が出ているのに落ちる。
// 見本は上限 8 件で打ち切られることがあるので、判定できるのはその範囲まで
// （e.syms_capped の行は取りこぼしうる。件数を出して知らせる）。
function rmEdgeHaystack(e) {
  return (e.from + ' ' + e.to + ' ' + (e.symbols || []).join(' ')).toLowerCase();
}

function rmFilterTerms() {
  const terms = _rmFilter.toLowerCase().split(/\s+/).filter(Boolean);
  return {
    must: terms.filter(t => !t.startsWith('-')),
    not: terms.filter(t => t.startsWith('-') && t.length > 1).map(t => t.slice(1)),
  };
}

// 方向のアイコン。四角が「今見ているまとまり」で、矢印がその境界をどう
// またぐかを示す。向きは言葉より形のほうが速く読めるが、外から と 外へ は
// 矢印だけだと取り違えるので、ラベルと件数は残して補助に徹する。
// 色は currentColor（他のモノクロアイコンと同じく、選択中は明るくなる）。
//
// 内部は「構成要素どうし」なので、中に2つの縦棒を置いてその間を結ぶ。
// 循環矢印にはしない — それは自己参照の記号だが、自分自身への参照は
// 表に入れる前に落としてある（structmap.go の src == def と、フォーカスの
// inside(a) != b）。中の別々のものの間の線であることを形で示す。
function rmDirIcon(key) {
  const box = {
    in:  '<rect x="8.5" y="2.5" width="6" height="7"/><path d="M1 6h5"/><path d="M4.5 4.2 6.5 6 4.5 7.8"/>',
    mid: '<rect x="1.5" y="2.5" width="13" height="7"/><path d="M4.5 4.6v2.8"/><path d="M5.3 6h4"/>' +
         '<path d="M8.3 4.9 9.8 6 8.3 7.1"/><path d="M11.5 4.6v2.8"/>',
    out: '<rect x="1.5" y="2.5" width="6" height="7"/><path d="M10 6h5"/><path d="M13 4.2 15 6 13 7.8"/>',
  }[key];
  return `<svg class="rm-dir" width="16" height="12" viewBox="0 0 16 12" fill="none"` +
         ` stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${box}</svg>`;
}

// ----- フォーカス: 外から / 内部 / 外へ -----
function rmRenderFocus(m) {
  const bar = document.getElementById('rm-bar');
  const body = document.getElementById('rm-body');
  bar.textContent = '';
  body.textContent = '';
  // Call Tree の Callers/Callees と同じ、方向のタブ。件数を常にラベルに
  // 出すので、開いていない面も「あるのに見えない」にはならない。
  // アクティブな面は全行出す（既定で隠さない）
  // 3列目はタブのホバー説明。見出しが文になった（「X を使っている N か所」）ので
  // 帯の常時説明はやめた — 一覧の上でもう一度言い直す文は読まれず、
  // 「刺さる」のような比喩は読めなかった。語彙は見出しと同じ「使う」に揃える。
  const secs = [
    ['in', '外から', '外のどこが、この中の実装を使っているか', m.incoming],
    ['mid', '内部', 'この中どうしで、どこがどこを使っているか', m.internal],
    ['out', '外へ', 'この中のコードが使っている、外の実装（関数・グローバル変数）', m.outgoing],
  ];
  if (!m.incoming.length && !m.internal.length && !m.outgoing.length) {
    rmMsg(body, 'このまとまりをまたぐ参照は索引にありません');
    return;
  }
  // 事実・絞り込み・タブはスクロールしない帯（#rm-bar）に置く。
  // 一覧と一緒に流れて消えると、絞り込み中であることも今どの面かも見えなくなる
  bar.appendChild(rmFilterInput());
  const tabsEl = document.createElement('div');
  tabsEl.className = 'rm-tabs';
  bar.appendChild(tabsEl);
  const capEl = document.createElement('div');
  capEl.className = 'rm-hint';
  bar.appendChild(capEl);
  const secEl = document.createElement('div');
  secEl.className = 'rm-sec';
  body.appendChild(secEl);

  const render = () => {
    const { must, not } = rmFilterTerms();
    const hit = e => {
      const hay = rmEdgeHaystack(e);
      return must.every(t => hay.includes(t)) && !not.some(t => hay.includes(t));
    };
    const filtering = must.length || not.length;
    const view = secs.map(([key, short, title, edges]) =>
      [key, short, title, edges, filtering ? edges.filter(hit) : edges]);

    const active = view.find(x => x[0] === _rmTab) || view[0];
    tabsEl.textContent = '';
    for (const [key, short, title, edges, shown] of view) {
      const b = document.createElement('button');
      b.className = 'rm-tab' + (key === active[0] ? ' active' : '');
      const count = filtering ? `${shown.length}/${edges.length}` : `${edges.length}`;
      b.innerHTML = rmDirIcon(key) + `${short} ${count}`;
      b.title = title;
      b.disabled = !edges.length;
      b.onclick = () => { _rmTab = key; render(); };
      tabsEl.appendChild(b);
    }
    secEl.textContent = '';
    // 絞り込み中は畳まない。一致した行が畳まれた中に隠れると、何件と言われても
    // 見えないままになる
    if (active[0] === 'out' && active[4].length) {
      // 外へ は from が全行このまとまり自身。行ごとに自分の名前を繰り返さず、
      // 他の面と同じ文の形にする（「X を使っている」の逆で「X が使っている」）。
      const total = active[4].reduce((n, e) => n + e.count, 0);
      const head = document.createElement('div');
      head.className = 'rm-group';
      const nm = document.createElement('span');
      nm.className = 'rm-name rm-mod';
      nm.textContent = _rmFocus + '/';
      nm.style.cursor = 'default'; // 今いる場所なので押しても行き先が無い
      head.appendChild(nm);
      const phrase = document.createElement('span');
      phrase.className = 'rm-group-phrase';
      phrase.textContent = ` が使っている ${active[4].length} か所（参照 ${total}）`;
      phrase.title = '参照 = 参照の組数（シンボル × 参照元ファイル）';
      head.appendChild(phrase);
      secEl.appendChild(head);
      const inner = document.createElement('div');
      inner.className = 'rm-group-body';
      secEl.appendChild(inner);
      rmEdgeRows(inner, active[4], e => `${e.count}`, { hl: must, hideFrom: true });
    } else if (active[4].length) rmGroupedRows(secEl, active[4], { hl: must, forceOpen: !!filtering });
    // 見本が切れている行は、シンボル名での絞り込みが取りこぼしうる。
    // 黙って落とすと「無い」と読まれるので、絞り込み中だけ件数で断る。
    const capped = filtering ? active[3].filter(e => e.syms_capped && !hit(e)).length : 0;
    // 公開面の事実（入口がどれだけ絞られているか）は「外から」の面の要約
    // なので、そのタブでだけ出す。全タブに常時出すと、内部・外へ の一覧を
    // 見ながら「外から使われるのは…」を読むことになり、繋がらない。
    const parts = [];
    if (active[0] === 'in' && m.files > 0) {
      parts.push(`実装 ${m.files} ファイル中、外から使われるのは ${m.files_open}`);
    }
    if (capped) {
      parts.push(`※ シンボル見本が 8 件で切れている行が ${capped} 件あり、名前での絞り込みは取りこぼしがありえます（… で全量を開けます）`);
    }
    capEl.title = parts.length && active[0] === 'in'
      ? '外の入口になっているファイルの数。少ないほど公開面が狭く、1つの部品として扱いやすい。\n分母は索引で実装(.c系)に定義を持つファイル数（同名で集計外のものは含まない）' : '';
    capEl.textContent = parts.join('　');
    capEl.style.display = parts.length ? '' : 'none';
    if (!active[4].length) {
      const d = document.createElement('div');
      d.className = 'rm-msg';
      d.textContent = filtering ? 'この面に絞り込みへの一致はありません' : 'この面に参照はありません';
      secEl.appendChild(d);
    }
  };
  document.getElementById('rm-filter').oninput = e => { _rmFilter = e.target.value; render(); };
  render();
}



// ===== 行き先ごとに畳む =====
// 外からの参照は「同じ入口に、外の別々のところが来る」形になりやすい
// （openssl の crypto/bio では 30 行のうち大半が bio_lib.c 行き）。同じ行き先を
// 何度も読ませるのは、太さの比較にも公開面の把握にも効かない。行き先で束ねて
// 「どの入口が何本受けているか」を先に見せ、中身は開いたまま畳めるようにする。
//
// 畳んで得がないとき（束が全部1行）は束ねない。見出しだけ増えて行数が倍になる。
let _rmClosed = new Set();

function rmGroupKey(to) { return _rmFocus + '|' + _rmTab + '|' + to; }

function rmGroupedRows(sec, edges, opts) {
  const hl = (opts && opts.hl) || [];
  const forceOpen = !!(opts && opts.forceOpen);
  const groups = new Map();
  for (const e of edges) {
    if (!groups.has(e.to)) groups.set(e.to, []);
    groups.get(e.to).push(e);
  }
  if (groups.size === edges.length) {
    rmEdgeRows(sec, edges, e => `${e.count}`, { hl });
    return;
  }
  const order = [...groups.entries()]
    .map(([to, rows]) => [to, rows, rows.reduce((n, e) => n + e.count, 0)])
    .sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0]));

  for (const [to, rows, total] of order) {
    const key = rmGroupKey(to);
    const open = forceOpen || !_rmClosed.has(key);
    const head = document.createElement('div');
    head.className = 'rm-group' + (open ? ' open' : '');

    const caret = document.createElement('span');
    caret.className = 'rm-group-caret';
    caret.textContent = open ? '▾' : '▸';
    head.appendChild(caret);
    head.appendChild(rmName(to, hl));
    // 見出しは文で完結させる（「X を使っている 15 か所」）。この木は呼び出し
    // ツリーの習慣（親が呼ぶ側）と逆に、親が参照される側なので、矢印 →
    // 見出しの ← → 説明文と3回注釈を試してどれも逆に読まれた。注釈が要る
    // 見せ方をやめ、一方向にしか読めない語順にする。束は常に行き先で作る
    //（外へ タブは from が自分自身で束が全部1行になり、フラットへ落ちる）。
    const phrase = document.createElement('span');
    phrase.className = 'rm-group-phrase';
    phrase.textContent = ` を使っている ${rows.length} か所（参照 ${total}）`;
    phrase.title = '参照 = 参照の組数（シンボル × 参照元ファイル）';
    head.appendChild(phrase);
    // 見出しの余白を押すと開閉。名前は元どおり（まとまりなら降りる、
    // ファイルなら開く）なので、そちらのクリックは奪わない
    head.onclick = (ev) => {
      if (ev.target.closest('.rm-name')) return;
      if (_rmClosed.has(key)) _rmClosed.delete(key);
      else _rmClosed.add(key);
      rmRerender();
    };
    sec.appendChild(head);

    if (!open) continue;
    const inner = document.createElement('div');
    inner.className = 'rm-group-body';
    sec.appendChild(inner);
    rmEdgeRows(inner, rows, e => `${e.count}`, { hl, hideTo: true });
  }
}

function rmEdgeRows(sec, edges, countOf, opts) {
  const noChips = opts && opts.noChips;
  const hideTo = opts && opts.hideTo;     // 行き先は見出しに出ているので繰り返さない
  const hideFrom = opts && opts.hideFrom; // 参照元が見出し（外へ タブ）のときの逆版
  const hl = (opts && opts.hl) || [];
  for (const e of edges) {
    const row = document.createElement('div');
    row.className = 'rm-row';
    if (!hideFrom) row.appendChild(rmName(e.from, hl));
    if (!hideTo && !hideFrom) {
      const arrow = document.createElement('span');
      arrow.className = 'rm-arrow';
      arrow.textContent = '→';
      row.appendChild(arrow);
    }
    if (!hideTo) {
      row.appendChild(rmName(e.to, hl));
    }
    const cnt = document.createElement('span');
    cnt.className = 'rm-meta';
    cnt.textContent = countOf(e);
    cnt.title = '参照の組数（シンボル × 参照元ファイル）';
    row.appendChild(cnt);
    sec.appendChild(row);
    if (!noChips && e.symbols && e.symbols.length) {
      const chips = document.createElement('div');
      chips.className = 'rm-chips';
      // `a` のような短い名前は見本として情報が無いので、他があれば落とす。
      // ただし絞り込みに一致した名前は必ず残す — 一致したから出ている行なのに
      // その名前が見えないと、なぜ出ているのか分からない
      const matched = x => hl.length && hl.some(t => x.toLowerCase().includes(t));
      const named = e.symbols.filter(x => x.length >= 3 || matched(x));
      const syms = named.length ? named : e.symbols;
      for (const s of syms) rmSymChip(chips, e, s, hl);
      if (e.syms_capped) rmMoreChip(chips, e, syms, hl);
      sec.appendChild(chips);
    }
  }
}

function rmSymChip(chips, e, s, hl) {
  const chip = document.createElement('span');
  chip.className = 'rm-chip';
  // 絞り込みはシンボル名にも当たる。当たった箇所を光らせないと、
  // パスに一致が無い行が「なぜ出ているのか」分からないまま並ぶ
  rmHighlight(chip, s, hl);
  chip.title = s + '\nクリック: 定義へ（' + e.to + '）'
    + '\nAlt+クリック: 参照している行（' + e.from + ' 内）';
  chip.onclick = ev => {
    // 主動作は定義へ、Alt はそこから広げる探索 — エディタの
    // Ctrl+クリック（定義ジャンプ）/ Alt+クリック（ジャンプランチャー）と
    // 同じ割り当てにする。参照行の行番号は表に持っていない
    // （linux 対応でファイル対まで畳んだ）ので、押されたときに参照 API で解決する
    if (ev.altKey) rmToggleSites(chips, chip, s, e.from);
    else rmJumpToSymbol(s);
  };
  chips.appendChild(chip);
  return chip;
}

// 「…」= 残り全部を開く。応答には見本 8 件しか付かない（linux の全体図で全量を
// 送ると応答が 10MB 級になる）が、表は全数を持っているので、この1エッジ分だけ
// 引き直す。開いた行は e.symbols を全量へ差し替えるので、以後の絞り込みは
// この行に限り全シンボルへ当たる。
function rmMoreChip(chips, e, shown, hl) {
  const more = document.createElement('span');
  more.className = 'rm-chip rm-chip-more';
  // 残り件数は出さない: count は (シンボル, 参照元) の組数で、束ねた行では
  // 参照元をまたいで同じ名前が重なるため、別名シンボルの残数にならない
  more.textContent = '…';
  more.title = 'クリックで残りのシンボルを全部表示';
  more.onclick = async () => {
    more.onclick = null;
    more.textContent = '…読込中';
    const params = { from: e.from, to: e.to };
    if (_rmFocus) params.focus = _rmFocus;
    try {
      const r = await fetch('/api/structure/edge-symbols?' + new URLSearchParams(params));
      const d = await r.json();
      if (!r.ok || !Array.isArray(d.symbols)) throw new Error(d.error || r.statusText);
      const have = new Set(shown);
      more.remove();
      for (const s of d.symbols) {
        if (!have.has(s)) rmSymChip(chips, e, s, hl);
      }
      e.symbols = d.symbols;
      e.syms_capped = false;
    } catch (err) {
      st('シンボルの取得に失敗: ' + err.message);
      more.textContent = '…';
      more.onclick = null;
    }
  };
  chips.appendChild(more);
}

// 名前がファイル（拡張子つき）ならエディタで開き、モジュールならフォーカスする
function rmName(name, hl) {
  const el = document.createElement('span');
  el.className = 'rm-name';
  rmHighlight(el, name, hl);
  if (/\.[A-Za-z0-9]+$/.test(name.split('/').pop())) {
    el.classList.add('rm-file');
    el.title = name + ' を開く';
    el.onclick = () => {
      if (typeof openPeek === 'function' && _rmRoot) {
        openPeek(_rmRoot.replace(/\\/g, '/') + '/' + name, 1);
      }
    };
  } else {
    // まとまりには末尾 / を付ける。色だけで folder / file を分けると、行の
    // 左右で粒度が違うこと（左はまとまり = 複数ファイル、右はファイル1枚）が
    // 読み取れず、参照行が複数ファイルに散るのが不可解に見える
    el.classList.add('rm-mod');
    el.textContent = '';
    rmHighlight(el, name, hl);
    el.appendChild(document.createTextNode('/'));
    el.title = name + '/ を詳細表示（フォルダ）';
    el.onclick = () => rmLoad(name);
  }
  return el;
}

const RM_SITES_MAX = 50;

// 参照している行をチップの下に出す。検索パネルは別の作業のための場所なので、
// そこを書き換えずにこのパネルの中で完結させる。
async function rmToggleSites(chips, chip, sym, from) {
  const open = chip.nextElementSibling && chip.nextElementSibling.classList.contains('rm-sites');
  chips.querySelectorAll('.rm-sites').forEach(el => el.remove());
  chips.querySelectorAll('.rm-chip.on').forEach(el => el.classList.remove('on'));
  if (open) return;

  chip.classList.add('on');
  const box = document.createElement('div');
  box.className = 'rm-sites';
  box.textContent = '検索中…';
  chip.after(box);

  // 出すのはこのエッジぶんだけ = 参照している側（from）の中の行に限る。
  // from がファイルのときは、親ディレクトリで引くと兄弟ファイルの参照まで
  // 混ざるので、パスでそのファイルに絞る
  const isFile = /\.[A-Za-z0-9]+$/.test(from.split('/').pop());
  const dir = isFile ? from.split('/').slice(0, -1).join('/') : from;
  const params = { word: sym, dir, limit: String(RM_SITES_MAX) };
  if (isFile) params.filter = 'path:' + from;
  try {
    const r = await fetch('/api/references?' + new URLSearchParams(params));
    const refs = await r.json();
    box.textContent = '';
    if (!r.ok || !Array.isArray(refs) || !refs.length) {
      box.textContent = from + ' 内に参照行が見つかりません';
      return;
    }
    for (const ref of refs) {
      const row = document.createElement('div');
      row.className = 'rm-site';
      const where = document.createElement('span');
      where.className = 'rm-site-at';
      where.textContent = rmRel(ref.file) + ':' + ref.line + (ref.func ? ' ' + ref.func : '');
      row.appendChild(where);
      const text = document.createElement('span');
      text.className = 'rm-site-text';
      text.textContent = (ref.text || '').trim();
      row.appendChild(text);
      row.onclick = () => { if (typeof openPeek === 'function') openPeek(ref.file, ref.line); };
      box.appendChild(row);
    }
    if (refs.length >= RM_SITES_MAX) {
      const more = document.createElement('div');
      more.className = 'rm-site-more';
      more.textContent = `上限 ${RM_SITES_MAX} 件まで表示（これ以上は参照パネルで）`;
      box.appendChild(more);
    }
  } catch (err) {
    box.textContent = '取得に失敗: ' + err.message;
  }
}

// 絶対パスを root 相対にする（表示用）
function rmRel(file) {
  const f = (file || '').replace(/\\/g, '/');
  const r = (_rmRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return r && f.startsWith(r + '/') ? f.slice(r.length + 1) : f;
}

async function rmJumpToSymbol(sym) {
  try {
    const r = await fetch('/api/definition?' + new URLSearchParams({ word: sym, dir: '', glob: '' }));
    const hits = await r.json();
    if (Array.isArray(hits) && hits.length && typeof openPeek === 'function') {
      openPeek(hits[0].file, hits[0].line);
    }
  } catch (_) {}
}

// 絞り込みの一致箇所を強調する。DOM を組んで入れる（innerHTML に文字列を
// 流し込まない）。強調は肯定条件だけ — `-` の除外語は行に存在しないのが正常
function rmHighlight(el, text, terms) {
  if (!terms || !terms.length) {
    el.textContent = text;
    return;
  }
  const lower = text.toLowerCase();
  let i = 0;
  while (i < text.length) {
    let best = -1, len = 0;
    for (const t of terms) {
      const idx = lower.indexOf(t, i);
      if (idx >= 0 && (best < 0 || idx < best)) { best = idx; len = t.length; }
    }
    if (best < 0) {
      el.appendChild(document.createTextNode(text.slice(i)));
      break;
    }
    if (best > i) el.appendChild(document.createTextNode(text.slice(i, best)));
    const m = document.createElement('span');
    m.className = 'rm-hl';
    m.textContent = text.slice(best, best + len);
    el.appendChild(m);
    i = best + len;
  }
}

// ----- 枠 -----
function rmSection(body, title) {
  const h = document.createElement('div');
  h.className = 'rm-sec-title';
  h.textContent = title;
  body.appendChild(h);
  const sec = document.createElement('div');
  sec.className = 'rm-sec';
  body.appendChild(sec);
  return sec;
}

function rmRenderCrumbs() {
  const el = document.getElementById('rm-crumbs');
  el.innerHTML = '';
  const add = (label, focus, clickable) => {
    const s = document.createElement('span');
    s.textContent = label;
    if (clickable) {
      s.className = 'rm-crumb';
      s.onclick = () => rmLoad(focus);
    }
    el.appendChild(s);
    // どの段にも直下の一覧を出す。祖先の段では兄弟へ、末尾の段では今いる
    // まとまりの中へ移れる。地図の行は被参照順に絞られていて、そこに出ない
    // ディレクトリへはクリックだけでは辿り着けない。
    const caret = document.createElement('span');
    caret.className = 'rm-crumb-caret';
    caret.textContent = '▾';
    caret.title = (focus || 'ルート') + ' の直下へ移動';
    caret.onclick = (e) => { e.stopPropagation(); rmOpenChildPicker(caret, focus); };
    el.appendChild(caret);
  };
  add('参照マップ', '', _rmFocus !== '');
  if (_rmFocus) {
    const segs = _rmFocus.split('/');
    segs.forEach((seg, i) => {
      const sep = document.createElement('span');
      sep.textContent = ' › ';
      el.appendChild(sep);
      const path = segs.slice(0, i + 1).join('/');
      add(seg, path, path !== _rmFocus);
    });
  }
}

// ===== 直下のまとまりを選ぶポップアップ =====
// 地図の行と違って絞らずに全部出す（絞られていることが移動できない原因なので、
// ここで同じことをすると意味が無い）。件数が多い場合のために絞り込みを付ける。

let _rmPickerAbort = null;

function rmClosePicker() {
  document.getElementById('rm-picker')?.remove();
  document.removeEventListener('mousedown', _rmPickerOutside, true);
  document.removeEventListener('keydown', _rmPickerKey, true);
  if (_rmPickerAbort) { _rmPickerAbort.abort(); _rmPickerAbort = null; }
}

function _rmPickerOutside(e) {
  const p = document.getElementById('rm-picker');
  if (p && !p.contains(e.target)) rmClosePicker();
}

function _rmPickerKey(e) {
  if (e.key === 'Escape') { e.stopPropagation(); rmClosePicker(); }
}

async function rmOpenChildPicker(anchor, path) {
  rmClosePicker();
  const box = document.createElement('div');
  box.id = 'rm-picker';
  box.innerHTML =
    `<input id="rm-picker-filter" type="text" spellcheck="false" placeholder="絞り込み">` +
    `<div id="rm-picker-list" class="rm-picker-msg">読み込み中…</div>`;
  document.body.appendChild(box);
  const r = anchor.getBoundingClientRect();
  box.style.left = Math.min(r.left, window.innerWidth - box.offsetWidth - 8) + 'px';
  box.style.top = r.bottom + 2 + 'px';
  document.addEventListener('mousedown', _rmPickerOutside, true);
  document.addEventListener('keydown', _rmPickerKey, true);
  document.getElementById('rm-picker-filter').focus();

  _rmPickerAbort = new AbortController();
  let children = [];
  try {
    const res = await fetch('/api/structure/children?' + new URLSearchParams({ path: path || '' }),
                            { signal: _rmPickerAbort.signal });
    const d = await res.json();
    children = (d && d.children) || [];
  } catch (e) {
    if (e.name === 'AbortError') return;
    children = null;
  }
  const list = document.getElementById('rm-picker-list');
  if (!list) return;
  if (children === null) { list.textContent = '読み込みに失敗しました'; return; }
  if (!children.length) {
    // 実装定義を持たないディレクトリ（ヘッダだけの include/ 等）はここに出ない。
    list.textContent = 'この下に実装はありません';
    return;
  }
  const draw = (q) => {
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hit = children.filter((c) => terms.every((t) => c.path.toLowerCase().includes(t)));
    list.className = hit.length ? '' : 'rm-picker-msg';
    list.innerHTML = '';
    if (!hit.length) { list.textContent = '一致なし'; return; }
    for (const c of hit) {
      const row = document.createElement('div');
      row.className = 'rm-picker-row';
      row.innerHTML =
        `<span class="rm-picker-name">${rmEsc(c.name)}${c.is_file ? '' : '/'}</span>` +
        `<span class="rm-picker-num" title="外から刺さる参照 / 実装ファイル数">${c.incoming} · ${c.files}f</span>`;
      row.onclick = () => { rmClosePicker(); rmLoad(c.path); };
      list.appendChild(row);
    }
  };
  draw('');
  document.getElementById('rm-picker-filter').oninput = (e) => draw(e.target.value);
}

function rmEsc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function rmRenderFooter(d) {
  const el = document.getElementById('rm-footer');
  const parts = [];
  const omitted = d.map && d.map.omitted;
  if (omitted && omitted.same_name > 0) {
    // シンボル数だけでは地図のどれくらいが欠けているか分からないので、
    // それによって出ていない参照の数も添える
    parts.push(`同名のため集計外: ${omitted.same_name} シンボル / ${omitted.same_name_refs} 参照`);
  }
  // 落とした理由ごとに数を出す。黙って消すと「元から関係が無かった」と読めてしまう。
  if (omitted && omitted.static_refs > 0) {
    parts.push(`static 定義への他ファイル参照 ${omitted.static_refs} 件は除外（名前が一致しただけで、C の規則上ありえない）`);
  }
  if (omitted && omitted.header_refs > 0) {
    parts.push(`ヘッダに現れた名前 ${omitted.header_refs} 件は不算入（プロトタイプ宣言は実装の利用ではない）`);
  }
  if (d.stale) parts.push('⚠ 索引が古い（地図は前回の索引時点）');
  // 色の意味を常に出しておく。行の色は粒度（まとまり / ファイル）と、
  // クリックで何が起きるか（地図を降りる / エディタで開く）を兼ねていて、
  // 凡例が無いと「なんとなく色分けされている」に見える。
  el.innerHTML =
    `<span class="rm-legend">` +
      `<span class="rm-mod" title="まとまり（フォルダ）。クリックでその中の地図へ降ります">まとまり/</span>` +
      `<span class="rm-legend-sep">·</span>` +
      `<span class="rm-file" title="ファイル。クリックでエディタに開きます">file.c</span>` +
    `</span>`;
  if (parts.length) {
    const rest = document.createElement('span');
    rest.textContent = parts.join(' · ');
    el.appendChild(document.createTextNode(' · '));
    el.appendChild(rest);
  }
}

function rmMsg(body, text) {
  body.textContent = '';
  const div = document.createElement('div');
  div.className = 'rm-msg';
  div.textContent = text;
  body.appendChild(div);
}

})();
