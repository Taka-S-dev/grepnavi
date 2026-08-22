// ===== Call Tree Addon =====
// 関数のコールツリー（callers / callees）を専用パネルで表示する。

(function() {

// ----- state -----
let _ctMode = 'callers'; // 'callers' | 'callees'
let _ctShowMacros = localStorage.getItem('ct-show-macros') === '1';
let _ctRootFunc = '';
let _ctTree = null; // ルートノード（現在のモード）
let _ctTrees = { callers: null, callees: null }; // タブごとにツリー状態を保持
let _ctAbort = null; // 進行中の検索キャンセル用
let _ctSelKey = '';  // 最後にジャンプした行（再描画をまたいで保持）

// ノード形状:
// { func, file, line, callLine, children: null|[], expanded: bool, loading: bool }

// ----- init -----
document.addEventListener('DOMContentLoaded', () => {
  // HTML injection - 右端からスライドインするサイドバー
  document.body.insertAdjacentHTML('beforeend', `
    <div id="ct-sidebar" class="side-panel">
      <div id="ct-resizer"></div>
      <div id="ct-header">
        <span>Call Tree</span>
        <button id="ct-close">×</button>
      </div>
      <div id="ct-search-row">
        <input id="ct-input" type="text" placeholder="関数名を入力..." spellcheck="false" autocomplete="off">
        <button id="ct-go">検索</button>
      </div>
      <div id="ct-tabs">
        <button class="ct-tab active" data-mode="callers">Callers</button>
        <button class="ct-tab" data-mode="callees">Callees</button>
        <span id="ct-tabs-spacer"></span>
        <button id="ct-toggle-macros" title="マクロ（#define）の呼び出しを表示/非表示">マクロ</button>
        <span id="ct-count"></span>
        <span id="ct-engine-label"></span>
      </div>
      <div id="ct-body"></div>
    </div>
  `);

  // ボタンを #addon-buttons に追加
  const addonBar = document.getElementById('addon-buttons');
  if (addonBar) {
    const btn = document.createElement('button');
    btn.id = 'btn-call-tree';
    btn.className = 'sec';
    btn.textContent = 'ct';
    btn.dataset.menuLabel = 'コールツリー';
    btn.dataset.menuHint = 'Ctrl+Shift+T';
    btn.title = 'ct — Call Tree (関数の callers / callees をツリー表示)  Ctrl+Shift+T';
    addonBar.appendChild(btn);
    // もう一度押したら閉じる（開くだけのボタンは、閉じ方を探させる）
    btn.onclick = () => {
      const p = document.getElementById('ct-sidebar');
      if (p.classList.contains('open')) closeCallTree();
      else openCallTree();
    };
  }

  // リサイズハンドル
  const resizer = document.getElementById('ct-resizer');
  const sidebar = document.getElementById('ct-sidebar');
  resizer.addEventListener('mousedown', e => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebar.offsetWidth;
    const onMove = e => {
      const w = Math.max(200, Math.min(800, startW + startX - e.clientX));
      sidebar.style.width = w + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // events
  document.getElementById('ct-close').onclick = closeCallTree;
  document.getElementById('ct-go').onclick = ctSearch;
  document.getElementById('ct-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') ctSearch();
    if (e.key === 'Escape') {
      const input = document.getElementById('ct-input');
      if (input.value.trim() || _ctRootFunc) {
        // 入力あり or 結果表示中 → クリア
        input.value = '';
        _ctRootFunc = '';
        _ctTree = null;
        _ctTrees.callers = null;
        _ctTrees.callees = null;
        ctRender();
      } else {
        closeCallTree();
      }
    }
  });
  document.querySelectorAll('.ct-tab').forEach(tab => {
    tab.onclick = () => {
      _ctMode = tab.dataset.mode;
      document.querySelectorAll('.ct-tab').forEach(t => t.classList.toggle('active', t === tab));
      updateCtEngineLabel(_ctMode);
      if (_ctRootFunc) {
        // 同じルート関数のツリーが保持済みなら再検索せず表示を切り替えるだけ
        const cached = _ctTrees[_ctMode];
        if (cached && cached.func === _ctRootFunc) {
          _ctTree = cached;
          ctRender();
        } else {
          ctSearch();
        }
      }
    };
  });

  const macroBtn = document.getElementById('ct-toggle-macros');
  const syncMacroBtn = () => {
    macroBtn.classList.toggle('on', _ctShowMacros);
    macroBtn.textContent = _ctShowMacros ? 'マクロ表示中' : 'マクロ';
  };
  syncMacroBtn();
  updateCtEngineLabel(_ctMode);
  macroBtn.onclick = () => {
    _ctShowMacros = !_ctShowMacros;
    localStorage.setItem('ct-show-macros', _ctShowMacros ? '1' : '0');
    syncMacroBtn();
    ctRender();
  };

  // キーボードショートカット
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'T') {
      e.preventDefault();
      openCallTree();
    }
    // コールツリーがアクティブな状態で Esc → 入力欄にフォーカスして結果クリア
    if (e.key === 'Escape' && document.getElementById('ct-sidebar').classList.contains('open')) {
      const input = document.getElementById('ct-input');
      // 入力欄以外にフォーカスがある場合は入力欄にフォーカスするだけ
      if (document.activeElement !== input) {
        e.preventDefault();
        input.focus();
        input.select();
        return;
      }
    }
  });
});

// 応答の実測をラベルへ。予測（gtagsAvailable）だけだと、rg へ降格した・
// 索引呼び出しに何秒かかった、が現地で見えず「遅い」以上の報告ができない。
// EDR 入りの社用機やネットワークドライブは手元で再現できないので、
// 1クリックがそのまま計測になるようにしておく。
// 生の内訳（index=..ms resolve=..ms）を読ませるのではなく、比較と判定は
// こちらでやって日本語の一文にする。数字はその下に残す（報告用）。
function ctTimingVerdict(eng, totalMs, t) {
  const ms = (k) => parseInt((t.match(new RegExp(k + '=([0-9]+)')) || [])[1] || '0', 10);
  const index = ms('index'), resolve = ms('resolve'), scan = ms('scan'), files = ms('files');
  if (totalMs < 1500) return 'この検索は遅くありません';
  if (eng !== 'gtags') {
    return 'この語は索引で答えられず、rg でツリー全体を走査しました (' + scan + 'ms)。' +
      '毎回こうなるなら、索引が無い・古い・プロジェクトルート直下に無い、のどれかです';
  }
  if (index > 1000 && index >= resolve * 2) {
    return '時間の大半は global の呼び出しです (' + index + 'ms)。プロセス起動が遅い環境' +
      '（ウイルス対策/EDR がプロセスを検査している）の典型です。2回目も遅いままか見てください';
  }
  if (resolve > 1000) {
    return '時間の大半はファイル読みです (' + resolve + 'ms / ' + files + ' ファイル)。' +
      '遅いディスクかネットワークドライブ上のプロジェクトが典型です';
  }
  return 'サーバ側はどの段階も速いのに合計が遅い場合、通信か描画側です';
}

function ctShowTiming(res, totalMs) {
  const label = document.getElementById('ct-engine-label');
  if (!label || !res) return;
  const eng = res.headers.get('X-Engine');
  if (!eng) return;
  const name = eng === 'gtags' ? 'GNU Global' : 'ripgrep';
  const sec = (totalMs / 1000).toFixed(totalMs >= 9500 ? 0 : 1);
  label.textContent = `${name} · ${sec}s`;
  const t = res.headers.get('X-Timing') || '';
  label.title = ctTimingVerdict(eng, totalMs, t) +
    String.fromCharCode(10) + String.fromCharCode(10) + t +
    String.fromCharCode(10) + 'build: ' + (res.headers.get('X-Build') || '?');
}

function updateCtEngineLabel(mode) {
  const label = document.getElementById('ct-engine-label');
  if (!label) return;
  const useGtags = mode === 'callers' && typeof gtagsAvailable === 'function' && gtagsAvailable();
  label.textContent = useGtags ? 'GNU Global' : 'ripgrep';
  // 種別は callees でしか付かないので、callers ではトグル自体を出さない
  const macroBtn = document.getElementById('ct-toggle-macros');
  if (macroBtn) macroBtn.style.display = mode === 'callees' ? '' : 'none';
}

// 表示件数と打ち切りをタブ行に出す。件数が見えないと
// 「マクロを隠して何件減ったか」も「上限で切られたか」も画面から読み取れない。
function ctUpdateCount() {
  const el = document.getElementById('ct-count');
  if (!el) return;
  if (!_ctTree || !_ctTree.children) { el.textContent = ''; el.title = ''; return; }
  const total = _ctTree.children.length;
  const shown = ctVisibleChildren(_ctTree).length;
  el.textContent = (shown < total ? `${shown} / ${total}` : `${total}`) + (_ctTree.truncated ? '+ ⚠' : '');
  el.title = [
    shown < total ? `${total - shown} 件のマクロを非表示` : `${total} 件`,
    _ctTree.truncated ? '検索上限に達したため、これで全部とは限りません' : '',
  ].filter(Boolean).join('\n');
  el.classList.toggle('truncated', !!_ctTree.truncated);
}

// ----- open / close -----
function openCallTree(funcName) {
  const panel = document.getElementById('ct-sidebar');
  panel.classList.add('open');
  window.closeOtherSidePanels?.(panel);
  if (funcName) {
    document.getElementById('ct-input').value = funcName;
    _ctRootFunc = funcName;
    ctSearch();
  } else {
    document.getElementById('ct-input').focus();
  }
}

function closeCallTree() {
  document.getElementById('ct-sidebar').classList.remove('open');
}

// ホバーパネルなど外部から呼び出せるよう公開
window.openCallTree = openCallTree;

// ----- search -----
async function ctSearch() {
  const input = document.getElementById('ct-input');
  const word = input.value.trim();
  if (!word) return;
  // ルート関数が変わったときは両タブのキャッシュをリセット
  if (word !== _ctRootFunc) {
    _ctTrees.callers = null;
    _ctTrees.callees = null;
    _ctSelKey = '';
  }
  _ctRootFunc = word;

  // 前回の検索を中断
  if (_ctAbort) _ctAbort.abort();
  _ctAbort = new AbortController();
  const signal = _ctAbort.signal;

  const body = document.getElementById('ct-body');
  body.innerHTML = '<div class="ct-empty">検索中...</div>';
  // 前回の件数が残ると新しい検索結果の件数と誤読される
  _ctTree = null;
  ctUpdateCount();

  // 定義探しだけ検索ディレクトリを見る（同名定義が複数あるとき、
  // いま見ている範囲のものを優先したいため）
  const dir = (document.getElementById('dir') || {}).value || '';

  // callers は defEngine に関わらず gtags が使えるなら使う（ripgrep より速い）
  const useGtags = typeof gtagsAvailable === 'function' && gtagsAvailable();
  updateCtEngineLabel(_ctMode);

  try {
    if (_ctMode === 'callers') {
      // 検索パネルの絞り込みは渡さない。呼び出し元は「これで全部か」を
      // 見る一覧なので、別のパネルの設定で黙って件数が減るほうが危ない
      const params = new URLSearchParams({ word });
      if (!useGtags) params.set('gtags', '0');
      const t0 = performance.now();
      const res = await fetch('/api/callers?' + params, { signal });
      ctShowTiming(res, performance.now() - t0);
      if (!res.ok) { body.innerHTML = '<div class="ct-empty">エラー</div>'; return; }
      const hits = await res.json();

      if (!hits.length) {
        body.innerHTML = `<div class="ct-empty">${escHtml(word)} を呼び出す関数が見つかりません</div>`;
        return;
      }
      _ctTree = {
        func: word, file: '', line: 0,
        children: hits.map(h => ({ func: h.func, file: h.file, line: h.line, callLine: h.call_line, indirect: h.indirect, text: h.text || '', children: null, expanded: false })),
        truncated: res.headers.get('X-Truncated') === 'true',
        expanded: true,
      };
      _ctTrees.callers = _ctTree;
    } else {
      // callees: ripgrep固定（updateCtEngineLabel は ctSearch 冒頭で呼び済み）
      // まず定義を探して file:line を取得
      const hoverParams = new URLSearchParams({ word });
      if (dir) hoverParams.set('dir', dir);
      const hRes = await fetch('/api/hover?' + hoverParams, { signal });
      let defFile = '', defLine = 0;
      if (hRes.ok) {
        const hHits = await hRes.json();
        const funcHit = hHits.find(h => h.kind === 'func' && !h.decl) || hHits.find(h => h.kind === 'func');
        if (funcHit) { defFile = funcHit.file; defLine = funcHit.line; }
      }
      if (!defFile) {
        body.innerHTML = `<div class="ct-empty">${escHtml(word)} の定義が見つかりません</div>`;
        return;
      }
      const calleeParams = new URLSearchParams({ file: defFile, line: defLine });
      const cRes = await fetch('/api/callees?' + calleeParams, { signal });
      if (!cRes.ok) { body.innerHTML = '<div class="ct-empty">エラー</div>'; return; }
      const callees = await cRes.json();

      if (!callees.length) {
        body.innerHTML = `<div class="ct-empty">${escHtml(word)} が呼び出す関数が見つかりません</div>`;
        return;
      }
      _ctTree = {
        func: word, file: defFile, line: defLine,
        children: callees.map(c => ctCalleeNode(c, defFile)).filter(n => n.func !== word),
        expanded: true,
      };
      _ctTrees.callees = _ctTree;
    }
  } catch(e) {
    if (e.name === 'AbortError') return; // 新しい検索に切り替わった
    body.innerHTML = '<div class="ct-empty">エラー</div>';
    return;
  }

  ctRender();
}

// ----- render -----
// 直前に描いた行のファイル名。同じなら行番号だけにして、
// ファイル名が出ている＝ここでファイルが変わる、という意味を持たせる。
let _ctPrevFile = '';

function ctRender() {
  const body = document.getElementById('ct-body');
  body.innerHTML = '';
  _ctPrevFile = '';
  ctUpdateCount();
  if (!_ctTree) return;

  // ガイド線ハイライト用オーバーレイ
  const guideHL = document.createElement('div');
  guideHL.id = 'ct-guide-highlight';
  body.appendChild(guideHL);
  body.addEventListener('mouseover', e => {
    const node = e.target.closest('.ct-node');
    if (!node) { guideHL.style.display = 'none'; return; }
    const depth = parseInt(node.dataset.depth || '0');
    if (depth === 0) { guideHL.style.display = 'none'; return; }

    // 同じ深さの兄弟グループの範囲だけハイライト（親で打ち止め）
    const allNodes = Array.from(body.querySelectorAll('.ct-node'));
    const idx = allNodes.indexOf(node);
    let topNode = node, bottomIdx = idx;
    for (let i = idx - 1; i >= 0; i--) {
      const d = parseInt(allNodes[i].dataset.depth || '0');
      if (d < depth) break;
      if (d === depth) topNode = allNodes[i];
    }
    for (let i = idx + 1; i < allNodes.length; i++) {
      const d = parseInt(allNodes[i].dataset.depth || '0');
      if (d < depth) break;
      bottomIdx = i;
    }
    const bottomNode = allNodes[bottomIdx];
    const bodyRect = body.getBoundingClientRect();
    const topPx    = topNode.getBoundingClientRect().top    - bodyRect.top + body.scrollTop;
    const botPx    = bottomNode.getBoundingClientRect().bottom - bodyRect.top + body.scrollTop;

    guideHL.style.left   = ((depth - 1) * 16 + 15 + 8) + 'px';
    guideHL.style.top    = topPx + 'px';
    guideHL.style.height = (botPx - topPx) + 'px';
    guideHL.style.display = 'block';
  });
  body.addEventListener('mouseleave', () => { guideHL.style.display = 'none'; });

  // root label
  const rootEl = document.createElement('div');
  rootEl.className = 'ct-node';
  rootEl.innerHTML = `<span style="color:#888;font-size:11px;">▼</span> <span class="ct-func">${escHtml(_ctTree.func)}</span>`;
  rootEl.querySelector('.ct-func').onclick = () => ctJumpToFunc(_ctTree);
  body.appendChild(rootEl);

  renderChildren(body, _ctTree, 1, new Set([_ctTree.func]));
}

// callees ではマクロが実処理と同じ重みで並び、本命の関数が埋もれる。
// 既定では隠し、必要なときだけ出せるようにする（callers 側は種別を持たないので対象外）。
function ctVisibleChildren(node) {
  if (!node.children) return [];
  if (_ctShowMacros || _ctMode !== 'callees') return node.children;
  return node.children.filter(c => c.kind !== 'define');
}

function renderChildren(container, node, depth, ancestors) {
  const children = ctVisibleChildren(node);
  if (children.length === 0) return;
  const shown = children.slice(0, 100);
  for (const child of shown) {
    const isCycle = ancestors.has(child.func);
    container.appendChild(makeNodeEl(child, depth, isCycle));
    if (!isCycle && child.expanded && child.children) {
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(child.func);
      renderChildren(container, child, depth + 1, nextAncestors);
    }
  }
  if (children.length > 100) {
    const more = document.createElement('div');
    more.className = 'ct-more';
    more.textContent = `... 他 ${children.length - 100} 件`;
    container.appendChild(more);
  }
  // ルート以外は件数ラベルに出ないので、打ち切りをその場に出す
  if (node.truncated && depth > 1) {
    const warn = document.createElement('div');
    warn.className = 'ct-more truncated';
    warn.textContent = '⚠ 検索上限で打ち切り';
    warn.style.paddingLeft = (depth * 16 + 22) + 'px';
    container.appendChild(warn);
  }
}

function makeNodeEl(node, depth, isCycle = false) {
  const el = document.createElement('div');
  el.className = 'ct-node';
  el.dataset.depth = depth;

  // indent
  const indent = document.createElement('span');
  indent.className = 'ct-indent';
  indent.style.width = (depth * 16) + 'px';

  // 構造体メンバ = 関数ポインタ経由の呼び出し。実体はテキストからは決まらないので展開しない。
  const isIndirect = node.indirect || node.kind === 'member';

  // expander
  const exp = document.createElement('span');
  exp.className = 'ct-expander';
  if (isCycle) {
    exp.textContent = '↻';
    exp.style.color = '#c08040';
  } else if (isIndirect) {
    exp.textContent = '·';
    exp.title = '関数ポインタ経由: 実体はテキスト解析では特定できない';
    exp.style.opacity = '0.4';
  } else {
    exp.textContent = node.expanded ? '▼' : '▶';
    if (node.loading) { exp.textContent = '…'; exp.classList.add('loading'); }
    exp.onclick = () => ctToggle(node, el);
  }

  // func name
  const fn = document.createElement('span');
  fn.className = _ctMode === 'callers' ? 'ct-func' : 'ct-callee-name';
  // func が空 = ファイルスコープの登録行（メソッドテーブル・ops 構造体）。
  // 関数ポインタで登録される関数は、これが「誰が呼ぶのか」への答えになる。
  // 場所をそのまま名前にする（basename:行）。
  fn.textContent = node.func ||
    ((node.file || '').replace(/\\/g, '/').split('/').pop() + ':' + (node.callLine || node.line));
  if (!node.func) fn.title = '関数の外での登録（テーブル初期化子など）。クリックでその行へ';
  if (isIndirect) {
    fn.style.opacity = '0.6';
    const badge = document.createElement('span');
    badge.textContent = '(ptr)';
    badge.title = '関数ポインタ経由の呼び出し';
    badge.style.cssText = 'font-size:10px;opacity:0.5;margin-left:4px;font-family:monospace';
    fn.appendChild(badge);
  } else if (node.kind === 'define') {
    // マクロは処理の本筋でないことが多いので、関数より弱く見せる
    fn.style.opacity = '0.55';
    const badge = document.createElement('span');
    badge.textContent = '(macro)';
    badge.style.cssText = 'font-size:10px;opacity:0.5;margin-left:4px;font-family:monospace';
    fn.appendChild(badge);
  }
  if (isCycle) fn.style.opacity = '0.5';
  else fn.onclick = () => { ctSelect(node, el); ctJumpToFunc(node); };

  // エディタ側を調べて戻ったとき、どのノードから来たかが残るようにする
  el.dataset.key = ctNodeKey(node);
  if (el.dataset.key === _ctSelKey) el.classList.add('sel');

  // location
  const loc = document.createElement('span');
  loc.className = 'ct-loc';
  const isCallees = _ctMode === 'callees';
  const locFile = isCallees ? (node.callFile || node.file) : node.file;
  const jumpLine = isCallees
    ? (node.callFile ? node.callLine : node.line)
    : (node.callLine || node.line);
  if (locFile) {
    const sameFile = locFile === _ctPrevFile;
    loc.textContent = sameFile ? `:${jumpLine}` : `${shortFilePath(locFile)}:${jumpLine}`;
    loc.classList.toggle('samefile', sameFile);
    _ctPrevFile = locFile;
    loc.onclick = () => { ctSelect(node, el); ctJumpToLine(locFile, jumpLine); };
  }

  // 呼び出し行のソースを行全体のツールチップに出す。
  // 「その free_percpu はエラーパスか本流か」「なぜ ptr 扱いか」が
  // ジャンプせずに判断できる（API は既に text を返している）。
  const tip = [];
  if (locFile) tip.push(node.kind ? `${locFile}:${jumpLine}  [${node.kind}]` : `${locFile}:${jumpLine}`);
  if (node.text) tip.push(node.text.trim());
  if (tip.length) el.title = tip.join('\n');

  el.appendChild(indent);
  el.appendChild(exp);
  el.appendChild(fn);
  if (locFile) el.appendChild(loc);
  return el;
}

// ----- selection -----
// 同じ関数が複数箇所から呼ばれるので、名前だけでは行を一意にできない
function ctNodeKey(node) {
  return `${node.func}|${node.callFile || node.file}:${node.callLine || node.line}`;
}

function ctSelect(node, el) {
  _ctSelKey = ctNodeKey(node);
  const body = document.getElementById('ct-body');
  body.querySelectorAll('.ct-node.sel').forEach(n => n.classList.remove('sel'));
  el.classList.add('sel');
}

// ----- expand/collapse -----
async function ctToggle(node, el) {
  if (node.expanded) {
    node.expanded = false;
    ctRender();
    return;
  }
  if (node.children !== null) {
    node.expanded = true;
    ctRender();
    return;
  }

  // load children
  node.loading = true;
  ctRender();

  // 定義探しだけ検索ディレクトリを見る（呼び出し元の一覧は絞らない）
  const dir = (document.getElementById('dir') || {}).value || '';

  if (_ctMode === 'callers') {
    const params = new URLSearchParams({ word: node.func });
    if (typeof gtagsAvailable === 'function' && !gtagsAvailable()) params.set('gtags', '0');
    const t0 = performance.now();
    const res = await fetch('/api/callers?' + params).catch(() => null);
    ctShowTiming(res, performance.now() - t0);
    if (res && res.ok) {
      const hits = await res.json();
      node.truncated = res.headers.get('X-Truncated') === 'true';
      node.children = hits.map(h => ({ func: h.func, file: h.file, line: h.line, callLine: h.call_line, indirect: h.indirect, text: h.text || '', children: null, expanded: false, _callerCached: true }));
    } else {
      node.children = [];
    }
  } else {
    // callees: まず定義を取得
    if (!node.file) {
      const hoverParams = new URLSearchParams({ word: node.func });
      if (dir) hoverParams.set('dir', dir);
      const hRes = await fetch('/api/hover?' + hoverParams).catch(() => null);
      if (hRes && hRes.ok) {
        const hHits = await hRes.json();
        const funcHit = hHits.find(h => h.kind === 'func' && !h.decl) || hHits.find(h => h.kind === 'func');
        const anyHit = funcHit || hHits[0];
        // 表示用（定義場所）はどの種別でもセット
        if (anyHit) { node.file = anyHit.file; node.line = anyHit.line; }
        // ジャンプ用: decl:false（実装）が見つかった場合だけ _defFile/_defLine にキャッシュ
        // decl しか見つからない場合はキャッシュしない（ctJumpToFunc で hover API を再呼び出し）
        const defHit = hHits.find(h => h.kind === 'func' && !h.decl);
        if (defHit) { node._defFile = defHit.file; node._defLine = defHit.line; }
        // callees API は関数本体が必要なので func のみ使用
        node._funcFile = funcHit ? funcHit.file : '';
        node._funcLine = funcHit ? funcHit.line : 0;
      }
    }
    if (node._funcFile && node._funcLine) {
      const params = new URLSearchParams({ file: node._funcFile, line: node._funcLine });
      const res = await fetch('/api/callees?' + params).catch(() => null);
      if (res && res.ok) {
        const callees = await res.json();
        node.children = callees.map(c => ctCalleeNode(c, node._funcFile)).filter(n => n.func !== node.func);
      } else {
        node.children = [];
      }
    } else {
      node.children = [];
    }
  }

  node.loading = false;
  node.expanded = true;
  ctRender();
}

// /api/callees は {name, call_line, kind, text} を返す。
// 呼び出し位置は callFile/callLine に持たせ、node.file は空のままにする:
// ctToggle は node.file の有無で「定義をまだ解決していない」を判断するため。
function ctCalleeNode(c, callerFile) {
  const name = typeof c === 'string' ? c : c.name;
  const callLine = typeof c === 'string' ? 0 : (c.call_line || 0);
  return {
    func: name,
    file: '', line: 0,
    callFile: callerFile || '', callLine,
    kind: typeof c === 'string' ? '' : (c.kind || ''),
    text: typeof c === 'string' ? '' : (c.text || ''),
    children: null, expanded: false,
  };
}

// ----- jump -----
function ctJumpToLine(file, line) {
  if (typeof openPeek === 'function') openPeek(file, line);
}

async function ctJumpToFunc(node) {
  // _defFile/_defLine: ctToggle で decl:false と確認済みの実装場所
  if (node._defFile && node._defLine) {
    ctJumpToLine(node._defFile, node._defLine);
    return;
  }
  // callers の子ノードは findContainingFunc が返した実装行をキャッシュ済みなのでそのまま使う
  // （callers では node.file/line は実装行が入る）
  if (node.file && node.line && node._callerCached) {
    ctJumpToLine(node.file, node.line);
    return;
  }
  // hover API で定義（decl:false 優先）を検索
  const dir = (document.getElementById('dir') || {}).value || '';
  const params = new URLSearchParams({ word: node.func });
  if (dir) params.set('dir', dir);
  const res = await fetch('/api/hover?' + params).catch(() => null);
  if (res && res.ok) {
    const hits = await res.json();
    const h = hits.find(h => h.kind === 'func' && !h.decl) || hits.find(h => h.kind === 'func') || hits[0];
    if (h) {
      node._defFile = h.file;
      node._defLine = h.line;
      ctJumpToLine(h.file, h.line);
      return;
    }
  }
  if (typeof st === 'function') st(`定義が見つかりません: ${node.func}`);
}

// ----- utils -----
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function shortFilePath(p) {
  if (!p) return '';
  return p.replace(/\\/g, '/').split('/').pop();
}

// openPeek は core（editor.js）のグローバル関数を利用する

})();
