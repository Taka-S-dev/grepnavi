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
// 外から / 外へ の束ね方。'other' = 相手のまとまりごと（どのモジュールと
// 関係があるか）、'entry' = こちら側のファイルごと（公開面がどこか）
let _rmGroupBy = 'other';
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
        <button id="rm-here" title="いま開いているファイルのまとまりを開く">このファイル</button>
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
    btn.dataset.menuLabel = '参照マップ';
    btn.title = 'map — 参照マップ (どこがどこを参照しているか)';
    addonBar.appendChild(btn);
    btn.onclick = () => {
      const p = document.getElementById('rm-sidebar');
      if (p.classList.contains('open')) closeRefMap();
      else openRefMap();
    };
  }

  document.getElementById('rm-close').onclick = () => closeRefMap();
  // 読んでいる場所から「このモジュールは誰に使われているか」へ 1 クリックで行く。
  // 調査中はこの問いが一番多く、名前を打つより速い
  document.getElementById('rm-here').onclick = () => {
    const dir = rmCurrentFileDir();
    if (dir === null) { st('開いているファイルがルートの中にありません'); return; }
    rmLoad(dir);
  };
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

// rmCurrentFileDir はエディタで開いているファイルの、ルート相対のディレクトリ。
// ルート直下なら ''（全体図）。開いていない・ルートの外なら null
function rmCurrentFileDir() {
  const file = (typeof tabs !== 'undefined' && tabs[activeTabIdx] && tabs[activeTabIdx].file) || '';
  if (!file || !_rmRoot) return null;
  const rel = rmRel(file);
  if (rel === file) return null; // ルートの外（rmRel は切れなかったら元のまま返す）
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

// 実装を持つ全ディレクトリ。全体図の絞り込みで、地図に出ていないまとまりにも
// 当てるために 1 回だけ取る（表は読み込み済みなので安い）
let _rmDirs = null;
async function rmAllDirs() {
  if (_rmDirs) return _rmDirs;
  try {
    const r = await fetch('/api/structure/dirs');
    if (!r.ok) return [];
    _rmDirs = (await r.json()).dirs || [];
  } catch (_) { return []; }
  return _rmDirs;
}

function openRefMap(focus) {
  const panel = document.getElementById('rm-sidebar');
  panel.classList.add('open');
  window.closeOtherSidePanels?.(panel);
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
  _rmOpened = new Set();
  if (!opts || !opts.fromHistory) rmHistPush(_rmFocus);
  rmUpdateNavButtons();
  _rmTab = 'in';
  _rmFilter = '';
  if (_rmAbort) _rmAbort.abort();
  _rmAbort = new AbortController();
  document.getElementById('rm-bar').textContent = '';
  const body = document.getElementById('rm-body');
  rmMsg(body, '読み込み中…', true);
  rmRenderCrumbs();
  try {
    const url = _rmFocus
      ? '/api/structure?' + new URLSearchParams(_rmFileLevel ? { focus: _rmFocus, files: '1' } : { focus: _rmFocus })
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
    // 図を開いたまま別のまとまりへ移ったら、図もそのまとまりに描き直す。
    // 前の図が残ると、戻して開き直す 2 クリックが毎回要る。全体図（まとまり無し）へ
    // 戻ったときは描くものが無いので閉じる
    if (document.getElementById('rm-graph')) {
      if (_rmFocus && d.map && d.map.internal) { _rmGraphPin = null; rmOpenGraph(d.map); }
      else rmCloseGraph();
    }
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

    // 地図に出ていないまとまり。全体図は被参照順の 40 件に絞られるので、小さな
    // まとまりは行が無く、名前で探しても 0 件になっていた。絞り込み中だけ、
    // ツリー全体から一致するディレクトリを別の節で出す
    if (filtering) {
      const shown = new Set(rows.map(([name]) => name));
      const secD = rmSection(body, 'まとまり — 地図に出ていないもの');
      secD.dataset.pending = '1';
      rmAllDirs().then(dirs => {
        if (document.getElementById('rm-filter')?.value !== _rmFilter) return; // 入力が進んだ
        const hit = dirs.filter(d => !shown.has(d.path) && hitName(d.path));
        secD.dataset.pending = '';
        if (!hit.length) { secD.remove(); return; }
        hit.slice(0, 40).forEach(d => {
          const row = document.createElement('div');
          row.className = 'rm-row rm-clickable';
          const nm = document.createElement('span');
          nm.className = 'rm-name rm-mod';
          rmHighlight(nm, d.path, must);
          nm.appendChild(document.createTextNode('/'));
          row.appendChild(nm);
          const meta = document.createElement('span');
          meta.className = 'rm-meta';
          meta.textContent = `実装 ${d.files} ファイル`;
          row.appendChild(meta);
          row.onclick = () => rmLoad(d.path);
          secD.appendChild(row);
        });
        if (hit.length > 40) {
          const more = document.createElement('div');
          more.className = 'rm-msg';
          more.textContent = `ほか ${hit.length - 40} 件（絞り込みを足して減らす）`;
          secD.appendChild(more);
        }
      });
    }

    // 全体図では普段チップを出さない。方向感を掴む画面に見本を並べると壁になる。
    // ただし絞り込み中は出す — 絞り込みはシンボル名にも当たるので、チップを
    // 伏せたままだと「パスのどこにも無い語で行が残る」状態になり、理由が見えない
    const edges = filtering ? m.edges.filter(hitEdge) : m.edges;
    const secE = rmSection(body, filtering
      ? `太い参照（一致 ${edges.length} · 上位15まで）`
      : '太い参照（上位15）');
    rmEdgeRows(secE, edges.slice(0, 15), e => `${e.count}`, { noChips: !filtering, hl: must });
  };
  const filter = document.getElementById('rm-filter');
  filter.oninput = e => { _rmFilter = e.target.value; render(); };
  // Enter で先頭の候補を開く。候補が 1 つに絞れたら、クリックに持ち替えずに済む
  filter.onkeydown = e => {
    if (e.key !== 'Enter') return;
    const first = body.querySelector('.rm-row.rm-clickable');
    if (first) { e.preventDefault(); first.click(); }
  };
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
    // 内部を図で見る。線を太い順に読むより、層か絡まりかは形のほうが速い
    if (m.internal.length) {
      const g = document.createElement('button');
      g.className = 'rm-tab rm-graph-btn' + (document.getElementById('rm-graph') ? ' active' : '');
      g.textContent = '図';
      g.title = '内部の参照を図で見る（開いていればもう一度で閉じる）: 使う側が左、使われる側が右。戻る矢印（赤）が相互参照。絞り込みは図にも効く';
      g.onclick = () => { if (document.getElementById('rm-graph')) rmCloseGraph(); else rmOpenGraph(m); };
      tabsEl.appendChild(g);
    }
    // 束ね方の切り替えは 外から / 外へ だけ。内部 は相手が無い（両側とも中）
    if (active[0] !== 'mid') {
      const sw = document.createElement('span');
      sw.className = 'rm-groupby';
      for (const [key, label, title] of [
        // ラベルは「呼び出し元 / 呼び出し先」。数えているのは関数の呼び出しだけでなく
        // グローバル変数の読み書きも含むが、コールツリーと同じ語にして読み替えを
        // 不要にする。差は説明文で補う
        ['other', active[0] === 'in' ? '呼び出し元ごと' : '呼び出し先ごと', active[0] === 'in'
          ? '使っている外のまとまりごとに束ねる: 誰に使われているか（関数の呼び出しのほか、グローバル変数の読み書きも含む）'
          : '使っている先の、外のまとまりごとに束ねる: 何に頼っているか（関数の呼び出しのほか、グローバル変数の読み書きも含む）'],
        ['entry', active[0] === 'in' ? '呼び出し先ごと' : 'まとめない', active[0] === 'in'
          ? '使われているこの中のファイルごとに束ねる: 外への窓口がどこか'
          : '束ねず、使っている先を 1 行ずつ'],
      ]) {
        const b = document.createElement('button');
        b.className = 'rm-tab' + (key === _rmGroupBy ? ' active' : '');
        b.textContent = label;
        b.title = title;
        b.onclick = () => { _rmGroupBy = key; render(); };
        sw.appendChild(b);
      }
      tabsEl.appendChild(sw);
    }
    secEl.textContent = '';
    // 絞り込み中は畳まない。一致した行が畳まれた中に隠れると、何件と言われても
    // 見えないままになる
    if (active[0] !== 'mid' && _rmGroupBy === 'other' && active[4].length) {
      rmGroupedByOther(secEl, active[0], active[4], { hl: must, forceOpen: !!filtering });
    } else if (active[0] === 'out' && active[4].length) {
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
  document.getElementById('rm-filter').oninput = e => { _rmFilter = e.target.value; render(); rmGraphRefresh(); };
  render();
}



// ===== 内部を図で見る =====
// ノードは「内部」タブと同じ単位（ファイルかサブディレクトリ）、矢印は内部の参照。
// 左から右へ層に並べる: 誰にも使われないものが左、使われるだけの土台が右。
// 参照は左→右に流れ、右→左へ戻る矢印（相互参照）だけ赤くする。力学配置は
// 50 本で線が絡んで構造が読めなくなるので使わない。
// 外との出入りはノードの端に数字で出す。外のまとまりまで描くと一気に増える。
//
// 図はツリーの区画（エディタの上）に出し、エディタは隠さない。初見のモジュールは
// 図で当たりを付けてはコードを読み、また図に戻る、を繰り返して把握するので、
// 図とコードが同時に見えていないと往復のたびに開き直すことになる。
// 開いているファイルのノードには印を付け、いま図のどこを読んでいるかを示す。
let _rmGraphSpread = 1; // 間隔の倍率（＋/− と Ctrl+ホイール）
let _rmGraphData = null;
// 参照の無いファイルも並べるために、まとまりの直下の一覧を 1 回取ってから描く。
// 図は「このフォルダに何があるか」の俯瞰にも使うので、線の無いファイルが
// 無いように見えてはいけない（engines/ は 7 ファイル中 3 つがエラー表で参照 0）
const _rmGraphKids = {};
// 図と一覧の単位。false = モジュールの 1 段下（サブディレクトリは 1 つの箱）、
// true = ファイル単位（サブディレクトリの中まで 1 ファイルずつ）。サブディレクトリを
// またぐ呼び出しの階層を 1 枚で見たいときに使う
let _rmFileLevel = false;
const RM_GRAPH_MAX_NODES = 250; // これを超えると線が読めず、描くのも重い

function rmOpenGraph(m) {
  if (_rmFileLevel) {
    const n = (m.all_files || []).length;
    if (n > RM_GRAPH_MAX_NODES) {
      // 多すぎるときは描かずに戻す。数百ノードは線が読めないうえ、配置の計算も重い
      st(`ファイル単位は ${n} ファイルあり、図にするには多すぎます（上限 ${RM_GRAPH_MAX_NODES}）。サブディレクトリに降りてから切り替えてください`);
      _rmFileLevel = false;
      rmLoad(_rmFocus, { fromHistory: true });
      return;
    }
    _rmGraphKids[m.module + '|files'] = m.all_files || [];
    rmDrawGraph(m);
    return;
  }
  if (_rmGraphKids[m.module]) { rmDrawGraph(m); return; }
  fetch('/api/structure/children?' + new URLSearchParams({ path: m.module }))
    .then(r => r.ok ? r.json() : { children: [] })
    .then(d => { _rmGraphKids[m.module] = (d.children || []).map(c => c.path); })
    .catch(() => { _rmGraphKids[m.module] = []; })
    .then(() => { if (_rmGraphData === m || _rmFocus === m.module) rmDrawGraph(m); });
}

function rmDrawGraph(m) {
  const keep = document.getElementById('rm-graph-body');
  const scroll = keep ? [keep.scrollLeft, keep.scrollTop] : null;
  rmCloseGraph();
  _rmGraphData = m;
  const edges = m.internal.filter(e => e.from !== e.to);
  const { cols, col, back } = layerGraph(edges);
  const isBack = new Set(back.map(([a, b]) => a + '\u0000' + b));
  // 外からの件数（入口の太さ）。内部の線が無いが外から使われるファイルも並べる
  const inCount = new Map();
  for (const e of m.incoming) inCount.set(e.to, (inCount.get(e.to) || 0) + e.count);
  for (const n of inCount.keys()) if (!col.has(n)) { col.set(n, cols.length); (cols[cols.length] || (cols[cols.length] = [])).push(n); }
  // 参照が 1 本も無いファイル・サブフォルダは最後の列（行）に薄く並べる
  const idle = new Set();
  for (const p of _rmGraphKids[m.module + (_rmFileLevel ? '|files' : '')] || []) {
    if (col.has(p)) continue;
    idle.add(p);
    col.set(p, cols.length);
    (cols[cols.length] || (cols[cols.length] = [])).push(p);
  }
  const names = [...col.keys()];
  // 役割: 数字から機械的に付ける。入口 = 外から使われる、中核 = 内部の 3 つ以上
  // から使われる、末端 = 内部を使うだけで使われない。初見のモジュールでは
  // 「このファイルが何をするか」を名前から当てるより、これと提供している関数名のほうが早い
  const usersOf = new Map(), usesOf = new Map();
  for (const e of edges) {
    usersOf.set(e.to, (usersOf.get(e.to) || 0) + 1);
    usesOf.set(e.from, (usesOf.get(e.from) || 0) + 1);
  }
  const roleOf = n => {
    const r = [];
    if (inCount.get(n)) r.push('入口');
    if ((usersOf.get(n) || 0) >= 3) r.push('中核');
    if (!usersOf.get(n) && usesOf.get(n)) r.push('末端');
    return r;
  };
  // 提供している関数: 外から一番太い参照の見本から 3 つ。見本は名前順なので
  // 「代表」ではなく「外から使われているものの例」
  const offers = n => {
    const best = m.incoming.filter(e => e.to === n).sort((a, b) => b.count - a.count)[0];
    return best ? (best.symbols || []).filter(s => s.length >= 3).slice(0, 3) : [];
  };

  // 列の中の並び: 隣の列の相手の位置の平均に寄せて、交差を減らす（1 往復）
  const pos = new Map();
  cols.forEach(c => c.forEach((n, i) => pos.set(n, i)));
  const neighbors = n => edges.filter(e => e.from === n || e.to === n).map(e => e.from === n ? e.to : e.from);
  for (let pass = 0; pass < 2; pass++) {
    cols.forEach(c => {
      c.sort((a, b) => {
        const bary = n => { const ns = neighbors(n); return ns.length ? ns.reduce((s, x) => s + pos.get(x), 0) / ns.length : pos.get(n); };
        return bary(a) - bary(b) || a.localeCompare(b);
      });
      c.forEach((n, i) => pos.set(n, i));
    });
  }

  // 向きは形で決める: 層の数が 1 層あたりのノード数より多い（鎖が長い）
  // モジュールは、左から右だと横に伸び切って縦が空くので、上から下へ流す
  const W = 200, H = 40, PAD = 24;
  const widest = Math.max(...cols.map(c => c.length));
  const vertical = cols.length > widest;
  const GX = (vertical ? 24 : 64) * _rmGraphSpread, GY = (vertical ? 44 : 10) * _rmGraphSpread;
  const x = n => vertical ? PAD + pos.get(n) * (W + GX) : PAD + col.get(n) * (W + GX);
  const y = n => vertical ? PAD + 20 + col.get(n) * (H + GY) : PAD + 20 + pos.get(n) * (H + GY);
  const width = vertical ? PAD * 2 + widest * (W + GX) + 80 : PAD * 2 + cols.length * W + (cols.length - 1) * GX;
  const height = vertical ? PAD * 2 + 20 + cols.length * (H + GY) : PAD * 2 + 20 + widest * (H + GY);

  const maxCount = Math.max(1, ...edges.map(e => e.count));
  // 線の出口と入口をノードの辺に散らす。同じノードから出る線が全部ノードの中央から
  // 出ると 1 本に重なって、どの線をクリックしたか分からない（siphash/ から真下の
  // evp/ へ行く線と、ずっと下の mem_clr.c へ行く線が同じ x を通っていた）。
  // 相手の位置の順に並べるので、線が交差して出ることもない
  const fwd = edges.filter(e => !isBack.has(e.from + '\u0000' + e.to));
  const portOf = (name, list, keyOf) => {
    const sorted = list.slice().sort((a, b) => keyOf(a) - keyOf(b));
    const m = new Map();
    sorted.forEach((e, i) => m.set(e, (i + 1) / (sorted.length + 1)));
    return m;
  };
  const outPort = new Map(), inPort = new Map();
  for (const n of names) {
    const outs = fwd.filter(e => e.from === n), ins = fwd.filter(e => e.to === n);
    const key = vertical ? (e => x(e.to) - x(e.from)) : (e => y(e.to) - y(e.from));
    const keyIn = vertical ? (e => x(e.from) - x(e.to)) : (e => y(e.from) - y(e.to));
    for (const [e, t] of portOf(n, outs, key)) outPort.set(e, t);
    for (const [e, t] of portOf(n, ins, keyIn)) inPort.set(e, t);
  }
  const overlay = document.createElement('div');
  overlay.id = 'rm-graph';
  overlay.innerHTML = `<div id="rm-graph-head"><span class="rm-name rm-mod">${rmEsc(m.module)}/</span>
    <span class="rm-hint">内部の参照 ${edges.length} 本 · 使う側 → 使われる側（${vertical ? '上から下' : '左から右'}）· <span class="rm-graph-back">赤</span> は戻る参照 · 入口 / 中核 / 末端 は参照の数から · 乗せると繋がりだけ残る · クリックで固定 · ダブルクリックで開く</span>
    <span id="rm-graph-pin"></span>
    <span id="rm-graph-spacer"></span>
    <button id="rm-graph-files" class="rm-graph-zoom${_rmFileLevel ? ' on' : ''}" title="サブディレクトリを 1 つの箱にまとめず、中のファイルまで 1 つずつ描く（右の一覧も同じ単位になる）">ファイル単位</button>
    <label id="rm-graph-min" title="参照の数がこれより少ない線を隠す。太い線（主な依存）だけ残して骨格を見る">細い線を隠す: 参照 ≥ <input type="range" min="1" max="${Math.max(2, maxCount)}" value="1"><span>1</span></label>
    <button class="rm-graph-zoom" data-d="-1" title="間隔を詰める (Ctrl+ホイール)">−</button><span id="rm-graph-spread">${_rmGraphSpread.toFixed(1)}×</span><button class="rm-graph-zoom" data-d="1" title="間隔を広げる (Ctrl+ホイール)">＋</button>
    <button id="rm-graph-close" title="図を閉じてツリーに戻る (Esc)">×</button></div>
    <div id="rm-graph-body"></div>`;
  const pane = document.getElementById('pane-tree');
  pane.appendChild(overlay);
  overlay.querySelector('#rm-graph-close').onclick = rmCloseGraph;
  overlay.querySelectorAll('.rm-graph-zoom[data-d]').forEach(b => { b.onclick = () => rmGraphSpread(+b.dataset.d); });
  // 単位の切り替え。取り直して、図も右の一覧も同じ単位にする（履歴には積まない）
  overlay.querySelector('#rm-graph-files').onclick = () => {
    _rmFileLevel = !_rmFileLevel;
    _rmGraphPin = null;
    rmLoad(_rmFocus, { fromHistory: true });
  };
  overlay.querySelector('#rm-graph-body').addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    rmGraphSpread(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  // サブディレクトリの色（現れた順に割り当てる）
  const _subColors = new Map();
  const SUB_PALETTE = ['#4fc1ff', '#89d185', '#d7ba7d', '#c586c0', '#ce9178', '#f48771', '#3cc8c8', '#ffb8d0'];
  const subDirColor = d => {
    if (!_subColors.has(d)) _subColors.set(d, SUB_PALETTE[_subColors.size % SUB_PALETTE.length]);
    return _subColors.get(d);
  };
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.innerHTML = `<defs>
    <marker id="rm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#8ab4f8"/></marker>
    <marker id="rm-arrow-ext" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#e8c45a"/></marker>
    <marker id="rm-arrow-back" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#e5484d"/></marker>
  </defs>`;
  for (const e of edges) {
    const backEdge = isBack.has(e.from + '\u0000' + e.to);
    const path = document.createElementNS(svgNS, 'path');
    let d;
    // 何層またぐか。1 層先なら素直に結び、遠いほど横（縦）へ膨らませて、
    // 途中のノードの上を通らないようにする
    const span = Math.abs(col.get(e.to) - col.get(e.from));
    const bulge = span > 1 ? Math.min(span - 1, 4) * 18 : 0;
    const po = outPort.get(e) ?? 0.5, pi = inPort.get(e) ?? 0.5;
    if (vertical) {
      const x1 = x(e.from) + W * (0.15 + 0.7 * po), y1 = y(e.from) + H;
      const x2 = x(e.to) + W * (0.15 + 0.7 * pi), y2 = y(e.to);
      if (backEdge) {
        // 下→上: 右側を回って戻す
        const bx = Math.max(x(e.from), x(e.to)) + W + 50;
        d = `M${x(e.from) + W},${y1 - H / 2} C${bx},${y1 - H / 2} ${bx},${y2 + H / 2} ${x(e.to) + W},${y2 + H / 2}`;
      } else {
        const my = (y1 + y2) / 2;
        const side = x2 >= x1 ? 1 : -1; // 相手の側へ膨らむ
        d = `M${x1},${y1} C${x1 + side * bulge},${my} ${x2 - side * bulge},${my} ${x2},${y2}`;
      }
    } else {
      const x1 = x(e.from) + W, y1 = y(e.from) + H * (0.2 + 0.6 * po);
      const x2 = x(e.to), y2 = y(e.to) + H * (0.2 + 0.6 * pi);
      if (backEdge) {
        // 右→左: 2 つのノードのうち下のほうの、さらに下をくぐらせて戻す
        const dip = Math.max(y1, y2) + H * 1.6;
        d = `M${x1 - W},${y1 + H / 2} C${x1 - W - 40},${dip} ${x2 + W + 40},${dip} ${x2 + W},${y2 + H / 2}`;
      } else {
        const mx = (x1 + x2) / 2;
        const side = y2 >= y1 ? 1 : -1;
        d = `M${x1},${y1} C${mx},${y1 + side * bulge} ${mx},${y2 - side * bulge} ${x2},${y2}`;
      }
    }
    path.setAttribute('d', d);
    path.setAttribute('class', 'rm-graph-edge' + (backEdge ? ' rm-graph-edge-back' : ''));
    path.dataset.from = e.from; path.dataset.to = e.to; path.dataset.count = e.count;
    path.dataset.hay = rmEdgeHaystack(e);
    path.setAttribute('stroke-width', (1 + 5 * Math.sqrt(e.count / maxCount)).toFixed(1));
    path.setAttribute('marker-end', backEdge ? 'url(#rm-arrow-back)' : 'url(#rm-arrow)');
    const title = document.createElementNS(svgNS, 'title');
    title.textContent = `${e.from} → ${e.to}: ${e.count}\n` + (e.symbols || []).join(', ') + (e.syms_capped ? ' …' : '');
    path.appendChild(title);
    // 矢印をクリック: 内部タブをその組で絞り込む（チップで関数へ飛べる）
    // 図は閉じない: 矢印を次々にクリックして把握していく使い方を止めないため。
    // 選んだ矢印に印を付け、側のパネルの「内部」をその組に絞り込む
    path.onclick = () => {
      svg.querySelectorAll('.rm-graph-edge-sel').forEach(p => p.classList.remove('rm-graph-edge-sel'));
      path.classList.add('rm-graph-edge-sel');
      svg.appendChild(path); // 手前に出す（他の線の下に隠れない。帯はノードの下のまま）
      // 側のパネルだけをこの組に絞る。この絞り込みは図には効かせない —
      // 線を選ぶたびに図全体が薄くなり、固定を外しても戻らないように見える
      _rmTab = 'mid'; _rmFilter = _rmFilterByArrow = rmLeaf(e.from) + ' ' + rmLeaf(e.to); rmRerender();
    };
    svg.appendChild(path);
    // 当たり判定だけの太い透明な帯。見た目の線は 1〜6px で狙いにくい
    const hit = document.createElementNS(svgNS, 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('class', 'rm-graph-hit');
    hit.appendChild(title.cloneNode(true));
    hit.onclick = () => path.onclick();
    hit.onmouseenter = () => path.classList.add('rm-graph-edge-hover');
    hit.onmouseleave = () => path.classList.remove('rm-graph-edge-hover');
    svg.appendChild(hit);
  }
  for (const n of names) {
    const g = document.createElementNS(svgNS, 'g');
    g.setAttribute('class', 'rm-graph-node' + (rmIsFile(n) ? ' rm-graph-file' : ' rm-graph-dir') + (idle.has(n) ? ' rm-graph-idle' : ''));
    g.setAttribute('transform', `translate(${x(n)},${y(n)})`);
    const inN = inCount.get(n) || 0;
    const roles = idle.has(n) ? ['参照なし'] : roleOf(n), sym = offers(n);
    // ファイル単位では、どのサブディレクトリのファイルかを名前（statem/statem.c）と
    // 左の色の帯で示す。帯の色はサブディレクトリごと（直下のファイルは帯なし）
    const sub = n.startsWith(m.module + '/') ? n.slice(m.module.length + 1) : n;
    const subDir = sub.includes('/') ? sub.slice(0, sub.lastIndexOf('/')) : '';
    const nodeLabel = x => {
      if (!_rmFileLevel) return rmLeaf(x);
      return sub.length > 26 ? '…' + sub.slice(-25) : sub;
    };
    const dirBar = () => (_rmFileLevel && subDir)
      ? `<rect class="rm-graph-dirbar" width="5" height="${H}" rx="2" style="fill:${subDirColor(subDir)}"/>` : '';
    g.dataset.name = n;
    // 外からの参照は図の中に線を持たない（外のまとまりまで描くと一気に増える）ので、
    // 固定したときだけ、まとまりの外から来る点線の矢印と相手を添える。これが無いと
    // 内部の線の束が「外から入ってきている」ように読める
    // 相手はまとまりごとに合計して多い順（apps/ の 46 ファイルが 1 件ずつ並ばないように）
    const byOther = new Map();
    for (const e of m.incoming) if (e.to === n) { const k = e.other || e.from; byOther.set(k, (byOther.get(k) || 0) + e.count); }
    const outsiders = [...byOther.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k.split('/').pop() + (rmIsFile(k) ? '' : '/'));
    const ext = inN ? (vertical
      ? `<g class="rm-graph-ext"><path d="M-34,${H / 2} L-4,${H / 2}" marker-end="url(#rm-arrow-ext)"/><text x="-38" y="${H / 2 + 4}" text-anchor="end">外から ${inN}（${rmEsc([...new Set(outsiders)].slice(0, 3).join(' '))}）</text></g>`
      : `<g class="rm-graph-ext"><path d="M${W / 2},-30 L${W / 2},-4" marker-end="url(#rm-arrow-ext)"/><text x="${W / 2 + 6}" y="-18">外から ${inN}（${rmEsc([...new Set(outsiders)].slice(0, 3).join(' '))}）</text></g>`) : '';
    g.innerHTML = `<rect width="${W}" height="${H}" rx="4"/>
      ${dirBar(n)}<text x="${_rmFileLevel ? 12 : 8}" y="15" class="rm-graph-label">${rmEsc(nodeLabel(n))}${rmIsFile(n) ? '' : '/'}</text>
      <text x="${W - 6}" y="15" text-anchor="end" class="rm-graph-role">${rmEsc(roles.join('・'))}${inN ? ` ${inN}` : ''}</text>
      <text x="8" y="31" class="rm-graph-sym">${rmEsc(sym.join(', '))}</text>${ext}`;
    const t = document.createElementNS(svgNS, 'title');
    t.textContent = n + (inN ? `\n外から ${inN}` : '') + (roles.length ? `\n${roles.join('・')}` : '')
      + (sym.length ? `\n外から使われる例: ${sym.join(', ')}` : '') + (rmIsFile(n) ? '\nクリックで開く' : '\nクリックで降りる');
    g.appendChild(t);
    g.onmouseenter = () => { if (!_rmGraphPin) rmGraphFocus(svg, n); };
    g.onmouseleave = () => { if (!_rmGraphPin) rmGraphFocus(svg, null); };
    // 線が多いと、乗せている間だけでは追い切れない。クリックで固定し、もう一度で
    // 外す。ファイルを開くのはダブルクリックに分ける: 固定のたびに下のエディタが
    // 切り替わると、固定したことより開いたことに目が行って、固定に気付けない
    g.onclick = () => {
      _rmGraphPin = _rmGraphPin === n ? null : n;
      rmGraphFocus(svg, _rmGraphPin);
      rmGraphPinLabel(_rmGraphPin);
      // 固定したファイルに「外から」を絞る: 図は内部しか描かないので、外から
      // 入ってくる参照はここで見る。外すときは絞り込みも戻す
      if (_rmGraphPin) {
        // 外から使われていないファイルなら、内部の面を開く（0 件の面を見せない）
        _rmTab = m.incoming.some(e => e.to === n) ? 'in' : 'mid';
        _rmFilter = _rmFilterByArrow = rmLeaf(n);
      } else if (_rmFilter === _rmFilterByArrow) { _rmFilter = _rmFilterByArrow = ''; }
      rmRerender();
      rmGraphPinLabel(_rmGraphPin, _rmGraphPin && {
        inner: edges.filter(e => e.from === n || e.to === n).length,
        outside: inCount.get(n) || 0,
      });
    };
    g.ondblclick = () => {
      if (rmIsFile(n)) { if (typeof openPeek === 'function' && _rmRoot) openPeek(_rmRoot.replace(/\\/g, '/') + '/' + n, 1); }
      else { rmCloseGraph(); rmLoad(n); }
    };
    svg.appendChild(g);
  }
  // 細い線を隠す
  const minIn = overlay.querySelector('#rm-graph-min input');
  minIn.oninput = () => {
    const min = +minIn.value;
    overlay.querySelector('#rm-graph-min span').textContent = String(min);
    svg.querySelectorAll('.rm-graph-edge').forEach(p => p.classList.toggle('rm-graph-edge-thin', +p.dataset.count < min));
  };
  if (_rmGraphMin > 1) { minIn.value = String(Math.min(_rmGraphMin, +minIn.max)); minIn.oninput(); }
  minIn.onchange = () => { _rmGraphMin = +minIn.value; };
  // 背景のクリックでは固定を外さない: 細い線を狙って外れたクリックで
  // 見ていた状態が消えるのは、外したいときより圧倒的に多い。外すのは
  // 固定したノードの再クリック・ヘッダの「外す」・Esc の 3 つ
  overlay.querySelector('#rm-graph-pin').onclick = () => { _rmGraphPin = null; rmGraphFocus(svg, null); rmGraphPinLabel(null); };
  overlay.querySelector('#rm-graph-body').appendChild(svg);
  if (_rmGraphPin && names.includes(_rmGraphPin)) rmGraphFocus(svg, _rmGraphPin); else _rmGraphPin = null;
  rmGraphPinLabel(_rmGraphPin);
  if (scroll) { const b = overlay.querySelector('#rm-graph-body'); b.scrollLeft = scroll[0]; b.scrollTop = scroll[1]; }
  // ツリーの区画を図に明け渡す（閉じたら戻す）
  _rmGraphHidden = ['tree', 'graph-view', 'tree-toolbar', 'drop-root', 'indent-guide']
    .map(i => document.getElementById(i)).filter(Boolean)
    .map(el => [el, el.style.display]);
  for (const [el] of _rmGraphHidden) el.style.display = 'none';
  document.addEventListener('keydown', _rmGraphKey);
  document.addEventListener('grepnavi:active-file-changed', _rmGraphMarkCurrent);
  _rmGraphMarkCurrent();
  document.querySelectorAll('.rm-graph-btn').forEach(b => b.classList.add('active'));
}

let _rmGraphPin = null; // 固定して見ているノード
let _rmFilterByArrow = ''; // 線のクリックで入れた絞り込み（図には効かせない）
function rmGraphPinLabel(name, counts) {
  const el = document.getElementById('rm-graph-pin');
  if (!el) return;
  el.textContent = '';
  if (!name) return;
  // 図の線は内部だけなので、外からの数を並べて「線 = 内部」と読めるようにする
  const detail = counts ? `（内部の線 ${counts.inner} · 外から ${counts.outside}）` : '';
  el.appendChild(document.createTextNode(`固定: ${rmLeaf(name)}${detail} `));
  const off = document.createElement('button');
  off.className = 'rm-graph-zoom';
  off.textContent = '外す';
  off.title = '固定を外す (Esc)';
  el.appendChild(off);
}
let _rmGraphMin = 1;    // これより細い線は隠す

// 1 つのノードに絡む線と相手だけを残し、他を薄くする。線が多いとき、
// 「このファイルはどこと繋がっているか」はこれで読む
// 固定したノード（name）と、側のパネルの絞り込みの両方で線を選ぶ。
// 絞り込みはパネルと同じ当たり判定（パス + シンボルの見本）なので、
// パネルで残った行と図で残る線が一致する
function rmGraphFocus(svg, name) {
  const { must, not } = _rmFilter === _rmFilterByArrow ? { must: [], not: [] } : rmFilterTerms();
  const filtering = must.length || not.length;
  const hitHay = hay => must.every(t => hay.includes(t)) && !not.some(t => hay.includes(t));
  svg.classList.toggle('rm-graph-focus', !!name || !!filtering);
  const near = new Set();
  svg.querySelectorAll('.rm-graph-edge').forEach(p => {
    const touches = !name || p.dataset.from === name || p.dataset.to === name;
    const matches = !filtering || hitHay(p.dataset.hay || '');
    const on = (!!name || !!filtering) && touches && matches;
    p.classList.toggle('rm-graph-edge-on', on);
    if (on) { near.add(p.dataset.from); near.add(p.dataset.to); }
  });
  svg.querySelectorAll('.rm-graph-node').forEach(g => {
    g.classList.toggle('rm-graph-node-on', (!!name || !!filtering) && (g.dataset.name === name || near.has(g.dataset.name)));
    g.classList.toggle('rm-graph-node-pin', !!name && g.dataset.name === name);
  });
}

// 絞り込みが変わったら、開いている図にも当て直す
function rmGraphRefresh() {
  const svg = document.querySelector('#rm-graph svg');
  if (svg) rmGraphFocus(svg, _rmGraphPin);
}

// 間隔を 1 段広げる/詰める（0.5×〜3×）。描き直すが、スクロール位置は保つ
function rmGraphSpread(dir) {
  const next = Math.min(3, Math.max(0.5, Math.round((_rmGraphSpread + dir * 0.25) * 4) / 4));
  if (next === _rmGraphSpread || !_rmGraphData) return;
  _rmGraphSpread = next;
  const hidden = _rmGraphHidden; // 閉じて開き直す間、ツリーを一瞬出さない
  _rmGraphHidden = [];
  rmDrawGraph(_rmGraphData);
  _rmGraphHidden = hidden;
}

let _rmGraphHidden = [];
function rmCloseGraph() {
  const g = document.getElementById('rm-graph');
  if (!g) return;
  g.remove();
  document.querySelectorAll('.rm-graph-btn').forEach(b => b.classList.remove('active'));
  for (const [el, disp] of _rmGraphHidden) el.style.display = disp;
  _rmGraphHidden = [];
  document.removeEventListener('keydown', _rmGraphKey);
  document.removeEventListener('grepnavi:active-file-changed', _rmGraphMarkCurrent);
}
function _rmGraphKey(e) {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  // 固定中の Esc は固定を外すだけ。図ごと閉じるのは次の Esc
  const svg = document.querySelector('#rm-graph svg');
  if (_rmGraphPin && svg) { _rmGraphPin = null; rmGraphFocus(svg, null); rmGraphPinLabel(null); return; }
  rmCloseGraph();
}
// 開いているファイルのノードに印を付ける。図を見ながらコードを読むとき、
// いま図のどこにいるかを見失わないため
function _rmGraphMarkCurrent() {
  const g = document.getElementById('rm-graph');
  if (!g) return;
  const file = (typeof tabs !== 'undefined' && tabs[activeTabIdx] && tabs[activeTabIdx].file) || '';
  const rel = file ? rmRel(file) : '';
  g.querySelectorAll('.rm-graph-node').forEach(n => {
    const name = n.dataset.name || '';
    n.classList.toggle('rm-graph-cur', !!rel && (rel === name || rel.startsWith(name + '/')));
  });
}
function rmIsFile(name) { return /\.[A-Za-z0-9]+$/.test(name.split('/').pop()); }
function rmLeaf(name) { return name.split('/').pop(); }

// ===== 行き先ごとに畳む =====
// 外からの参照は「同じ入口に、外の別々のところが来る」形になりやすい
// （openssl の crypto/bio では 30 行のうち大半が bio_lib.c 行き）。同じ行き先を
// 何度も読ませるのは、太さの比較にも公開面の把握にも効かない。行き先で束ねて
// 「どの入口が何本受けているか」を先に見せ、中身は開いたまま畳めるようにする。
//
// 畳んで得がないとき（束が全部1行）は束ねない。見出しだけ増えて行数が倍になる。
let _rmClosed = new Set();

function rmGroupKey(to) { return _rmFocus + '|' + _rmTab + '|' + _rmGroupBy + '|' + to; }

// 相手のまとまりごとに束ねる（外から / 外へ）。見出しが相手のモジュールで、
// 中の行はこちら側の入口（外から）か、相手の中の実装（外へ）。
// 行の名前が見出しと同じ（相手が 1 段で割れない）ときは繰り返さない。
// 束は閉じて始める: この見せ方の目的は「どのモジュールと、どれだけ」を
// 一覧することで、apps/ の 158 行を先頭で開くと見出しの並びが読めない
let _rmOpened = new Set();

function rmGroupedByOther(sec, face, edges, opts) {
  const hl = (opts && opts.hl) || [];
  const forceOpen = !!(opts && opts.forceOpen);
  const groups = new Map();
  for (const e of edges) {
    const k = e.other || (face === 'in' ? e.from : e.to);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const order = [...groups.entries()]
    .map(([other, rows]) => [other, rows, rows.reduce((n, e) => n + e.count, 0)])
    .sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0]));
  for (const [other, rows, total] of order) {
    const key = rmGroupKey(other);
    // 相手がそれ以上割れない（行が 1 本で名前が見出しと同じ）ときは開閉を
    // 付けず、シンボルの見本を見出しの下にそのまま出す。開いても同じ名前が
    // もう一度出るだけの束にしない
    const side = e => (face === 'in' ? e.from : e.to);
    const leaf = rows.length === 1 && side(rows[0]) === other;
    // 絞り込み中は開いて始める（一致した行が畳まれて見えないのを防ぐ）が、
    // 自分で畳んだものはそのまま畳んでおく
    const open = leaf || (forceOpen ? !_rmClosed.has(key) : _rmOpened.has(key));
    const head = document.createElement('div');
    head.className = 'rm-group' + (open ? ' open' : '');
    const caret = document.createElement('span');
    caret.className = 'rm-group-caret';
    caret.textContent = leaf ? '' : open ? '▾' : '▸';
    head.appendChild(caret);
    head.appendChild(rmName(other, hl));
    const phrase = document.createElement('span');
    phrase.className = 'rm-group-phrase';
    // 外から: 「ssl/ が使っている N か所」。外へ: 「ssl/ を使っている N か所」
    // （主語は今いるまとまり）。向きは助詞だけで変わるので、タブ名と合わせて読む
    phrase.textContent = (face === 'in' ? ' が使っている ' : ' を使っている ') + `${rows.length} か所（参照 ${total}）`;
    phrase.title = '参照 = 参照の組数（シンボル × 参照元ファイル）';
    head.appendChild(phrase);
    if (!leaf) {
      head.onclick = (ev) => {
        if (ev.target.closest('.rm-name')) return;
        if (open) { _rmOpened.delete(key); _rmClosed.add(key); }
        else { _rmOpened.add(key); _rmClosed.delete(key); }
        rmRerender();
      };
    }
    sec.appendChild(head);
    if (!open) continue;
    const inner = document.createElement('div');
    inner.className = 'rm-group-body';
    sec.appendChild(inner);
    for (const e of rows) {
      const sameAsHead = side(e) === other;
      rmEdgeRows(inner, [e], x => `${x.count}`, {
        hl,
        hideFrom: face === 'out' || sameAsHead,
        // 外へ で相手がファイルそのもの（crypto/mem.c）なら、行き先も見出しと同じ
        hideTo: face === 'out' && sameAsHead,
        chipsOnly: leaf,
      });
    }
  }
}

function rmGroupedRows(sec, edges, opts) {
  const hl = (opts && opts.hl) || [];
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
    // 絞り込み中も開いて始めるだけで、自分で畳んだものは畳んだまま
    const open = !_rmClosed.has(key);
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
  const hideFrom = opts && opts.hideFrom; // 参照元が見出し（外へ タブ・外のまとまりごと）のときの逆版
  const chipsOnly = opts && opts.chipsOnly; // 名前も件数も見出しにある: 見本だけ出す
  const hl = (opts && opts.hl) || [];
  for (const e of edges) {
    if (chipsOnly) {
      rmChips(sec, e, hl);
      continue;
    }
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
    if (!noChips) rmChips(sec, e, hl);
  }
}

function rmChips(sec, e, hl, before) {
  if (!e.symbols || !e.symbols.length) return;
  const chips = document.createElement('div');
  chips.className = 'rm-chips';
  // `a` のような短い名前は見本として情報が無いので、他があれば落とす。
  // ただし絞り込みに一致した名前は必ず残す — 一致したから出ている行なのに
  // その名前が見えないと、なぜ出ているのか分からない
  const matched = x => hl.length && hl.some(t => x.toLowerCase().includes(t));
  const named = e.symbols.filter(x => x.length >= 3 || matched(x));
  const syms = named.length ? named : e.symbols;
  // 行き先がまとまり（statem/）に畳まれているときは、中のどのファイルかを
  // 見出しにしてファイルごとに並べる。行き先がファイルならその名前と同じなので出さない
  const fileOf = s => { const i = e.symbols.indexOf(s); return (e.symbol_files && i >= 0 && e.symbol_files[i]) || ''; };
  const byFile = e.symbol_files && !rmIsFile(e.to);
  if (byFile) {
    const groups = new Map();
    for (const s of syms) { const f = fileOf(s); if (!groups.has(f)) groups.set(f, []); groups.get(f).push(s); }
    for (const [f, list] of groups) {
      if (f) {
        const lab = document.createElement('span');
        lab.className = 'rm-chip-file';
        lab.textContent = rmLeaf(f) + ':';
        lab.title = f + ' を開く';
        lab.onclick = () => { if (typeof openPeek === 'function' && _rmRoot) openPeek(_rmRoot.replace(/\\/g, '/') + '/' + f, 1); };
        chips.appendChild(lab);
      }
      for (const s of list) rmSymChip(chips, e, s, hl);
    }
  } else {
    for (const s of syms) rmSymChip(chips, e, s, hl);
  }
  if (e.syms_capped) rmMoreChip(chips, e, syms, hl);
  if (before) sec.insertBefore(chips, before); else sec.appendChild(chips);
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
    more.innerHTML = '<span class="gn-spinner"></span>読込中';
    const params = { from: e.from, to: e.to };
    if (_rmFocus) params.focus = _rmFocus;
    if (_rmFocus && _rmFileLevel) params.files = '1';
    try {
      const r = await fetch('/api/structure/edge-symbols?' + new URLSearchParams(params));
      const d = await r.json();
      if (!r.ok || !Array.isArray(d.symbols)) throw new Error(d.error || r.statusText);
      // 全量で描き直す（ファイルごとの並びを保つため、足すのではなく作り直す）
      e.symbols = d.symbols;
      e.symbol_files = Array.isArray(d.files) ? d.files : undefined;
      e.syms_capped = false;
      const parent = chips.parentNode, next = chips.nextSibling;
      chips.remove();
      rmChips(parent, e, hl, next);
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
  box.innerHTML = '<span class="gn-spinner"></span>検索中…';
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
// 渡さない）。強調は肯定条件だけ — `-` の除外語は行に存在しないのが正常
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
    `<div id="rm-picker-list" class="rm-picker-msg"><span class="gn-spinner"></span>読み込み中…</div>`;
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
    parts.push(`static 定義・.c 内の #define への他ファイル参照 ${omitted.static_refs} 件は除外（名前が一致しただけで、C の規則上ありえない）`);
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

// busy を付けると回る印を添える（待っている間の表示に使う）
function rmMsg(body, text, busy) {
  body.textContent = '';
  const div = document.createElement('div');
  div.className = 'rm-msg';
  if (busy) {
    const s = document.createElement('span');
    s.className = 'gn-spinner';
    div.appendChild(s);
  }
  div.appendChild(document.createTextNode(text));
  body.appendChild(div);
}

})();
