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

async function rmLoad(focus) {
  _rmFocus = focus || '';
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
    const hitEdge = e => hitName(e.from + ' ' + e.to);
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

    // 全体図ではチップを出さない。方向感を掴む画面に見本を並べると壁になる
    const edges = filtering ? m.edges.filter(hitEdge) : m.edges;
    const secE = rmSection(body, filtering
      ? `太い参照（一致 ${edges.length} · 上位15まで）`
      : '太い参照（上位15）');
    rmEdgeRows(secE, edges.slice(0, 15), e => `${e.count}`, { noChips: true, hl: must });
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
  filter.placeholder = '絞り込み: まとまり/ファイル名（スペース=AND、-で除外）';
  return filter;
}

function rmFilterTerms() {
  const terms = _rmFilter.toLowerCase().split(/\s+/).filter(Boolean);
  return {
    must: terms.filter(t => !t.startsWith('-')),
    not: terms.filter(t => t.startsWith('-') && t.length > 1).map(t => t.slice(1)),
  };
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
  const secs = [
    ['in', '外から', '外からの参照 — 外のどこが、中のどこに刺さるか', m.incoming],
    ['mid', '内部', '内部の参照 — 構成要素の間', m.internal],
    ['out', '外へ', '外への参照 — 何に依存するか', m.outgoing],
  ];
  if (!m.incoming.length && !m.internal.length && !m.outgoing.length) {
    rmMsg(body, 'このまとまりをまたぐ参照は索引にありません');
    return;
  }
  // 事実・絞り込み・タブはスクロールしない帯（#rm-bar）に置く。
  // 一覧と一緒に流れて消えると、絞り込み中であることも今どの面かも見えなくなる
  // 公開面の事実。「モジュールかどうか」は判定できないが、外からの参照が
  // 中の少数に集中しているかどうかは事実として見せられる
  if (m.files > 0) {
    const facts = document.createElement('div');
    facts.className = 'rm-facts';
    facts.textContent = `外から触られる実装 ${m.files_open}/${m.files} ファイル · 公開シンボル ${m.syms_open}/${m.syms}`;
    facts.title = '比が小さいほど公開面が狭い = 1つの単位として扱いやすい。\n分母は索引にある実装(.c系)の定義（同名で集計外のものは含まない）';
    bar.appendChild(facts);
  }

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
      const hay = (e.from + ' ' + e.to).toLowerCase();
      return must.every(t => hay.includes(t)) && !not.some(t => hay.includes(t));
    };
    const filtering = must.length || not.length;
    const view = secs.map(([key, short, title, edges]) =>
      [key, short, title, edges, filtering ? edges.filter(hit) : edges]);

    const active = view.find(x => x[0] === _rmTab) || view[0];
    tabsEl.textContent = '';
    for (const [key, short, , edges, shown] of view) {
      const b = document.createElement('button');
      b.className = 'rm-tab' + (key === active[0] ? ' active' : '');
      b.textContent = filtering ? `${short} ${shown.length}/${edges.length}` : `${short} ${edges.length}`;
      b.disabled = !edges.length;
      b.onclick = () => { _rmTab = key; render(); };
      tabsEl.appendChild(b);
    }
    capEl.textContent = active[2];
    secEl.textContent = '';
    if (active[4].length) rmEdgeRows(secEl, active[4], e => `${e.count}`, { hl: must });
    else {
      const d = document.createElement('div');
      d.className = 'rm-msg';
      d.textContent = filtering ? 'この面に絞り込みへの一致はありません' : 'この面に参照はありません';
      secEl.appendChild(d);
    }
  };
  document.getElementById('rm-filter').oninput = e => { _rmFilter = e.target.value; render(); };
  render();
}



function rmEdgeRows(sec, edges, countOf, opts) {
  const noChips = opts && opts.noChips;
  const hl = (opts && opts.hl) || [];
  for (const e of edges) {
    const row = document.createElement('div');
    row.className = 'rm-row';
    row.appendChild(rmName(e.from, hl));
    const arrow = document.createElement('span');
    arrow.className = 'rm-arrow';
    arrow.textContent = '→';
    row.appendChild(arrow);
    row.appendChild(rmName(e.to, hl));
    const cnt = document.createElement('span');
    cnt.className = 'rm-meta';
    cnt.textContent = countOf(e);
    cnt.title = '参照の組数（シンボル × 参照元ファイル）';
    row.appendChild(cnt);
    sec.appendChild(row);
    if (!noChips && e.symbols && e.symbols.length) {
      const chips = document.createElement('div');
      chips.className = 'rm-chips';
      // `a` のような短い名前は見本として情報が無いので、他があれば後ろに回す
      const named = e.symbols.filter(x => x.length >= 3);
      const syms = named.length ? named : e.symbols;
      for (const s of syms) {
        const chip = document.createElement('span');
        chip.className = 'rm-chip';
        chip.textContent = s;
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
      }
      sec.appendChild(chips);
    }
  }
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
  el.textContent = parts.join(' · ');
}

function rmMsg(body, text) {
  body.textContent = '';
  const div = document.createElement('div');
  div.className = 'rm-msg';
  div.textContent = text;
  body.appendChild(div);
}

})();
