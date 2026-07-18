// ===== GNU Global UI =====
// このファイルと index.html の参照・addon.js の gtagsEnabled() 呼び出しを削除するだけで取り外し可能。

(function() {

let _installed  = false;
let _indexed    = false;
let _binSource  = ''; // "bin" / "scoop" / "msys" / "path" / ""
let _transport  = ''; // "direct" / "file" / "bash"
let _preloadedSymbols = 0;

// ===== 定義ジャンプエンジンの優先順 =====
// localStorage:
//   defEngineOrder   = "gtags,ctags,rg"  全エンジンの表示・優先順
//   defEngineEnabled = "gtags,ctags,rg"  有効なエンジン（order の部分集合）
// 旧 'defEngine'（単一選択）からは初回アクセス時に移行する。
const ALL_ENGINES = ['gtags', 'ctags', 'rg'];

function _migrateLegacyEngine() {
  if (localStorage.getItem('defEngineOrder')) return;
  const legacy = localStorage.getItem('defEngine');
  if (legacy === 'ctags') {
    // 旧 ctags 主エンジン = gtags は使わず ctags→rg
    localStorage.setItem('defEngineOrder', 'ctags,gtags,rg');
    localStorage.setItem('defEngineEnabled', 'ctags,rg');
  } else if (legacy === 'rg') {
    localStorage.setItem('defEngineOrder', 'rg,gtags,ctags');
    localStorage.setItem('defEngineEnabled', 'rg');
  }
  // legacy 'gtags' / 未設定 → 既定 (gtags,ctags,rg 全有効) のままでよい
}

function _sanitizeEngineList(raw, fallback) {
  const list = (raw || '').split(',').map(s => s.trim()).filter(s => ALL_ENGINES.includes(s));
  return list.length ? [...new Set(list)] : fallback;
}

// 全エンジンの優先順（無効なものも含む・UI表示用）
window.getDefEngineOrder = function() {
  _migrateLegacyEngine();
  const order = _sanitizeEngineList(localStorage.getItem('defEngineOrder'), [...ALL_ENGINES]);
  ALL_ENGINES.forEach(e => { if (!order.includes(e)) order.push(e); });
  return order;
};
// 有効なエンジンだけを優先順で（API の engines= に渡す形）
window.getDefEngines = function() {
  const enabled = new Set(_sanitizeEngineList(localStorage.getItem('defEngineEnabled'), [...ALL_ENGINES]));
  return window.getDefEngineOrder().filter(e => enabled.has(e));
};
// 後方互換: 先頭の有効エンジン
window.getDefEngine = function() {
  return window.getDefEngines()[0] || 'rg';
};
window.gtagsEnabled = function() {
  return window.getDefEngines().includes('gtags') && _installed && _indexed;
};
// defEngine の設定に関わらず gtags が使える状態かどうかを返す（callers 等で使用）
window.gtagsAvailable = function() {
  return _installed && _indexed;
};

let _stale = false;

// ===== 進捗オーバーレイ =====
let _progCount = 0;
let _progUpToDate = false;
let _progElapsedTimer = null;
let _progStartTime = 0;

function _consoleOpen(title) {
  const el = document.getElementById('gtags-console');
  if (!el) return;
  document.getElementById('gtags-console-title').textContent = title;
  document.getElementById('gtags-console-body').innerHTML = '';
  document.getElementById('gtags-console-close').disabled = true;
  document.getElementById('gtags-prog-count').textContent = '準備中...';
  document.getElementById('gtags-prog-file').textContent = '';
  document.getElementById('gtags-console-elapsed').style.display = '';
  document.getElementById('gtags-console-elapsed').textContent = '0s';
  document.getElementById('gtags-prog-bar').classList.add('running');
  const abortBtn = document.getElementById('gtags-console-abort');
  if (abortBtn) { abortBtn.style.display = ''; abortBtn.onclick = () => { if (_opCancel) _opCancel(); }; }
  _progCount = 0;
  _progUpToDate = false;
  _progStartTime = Date.now();
  clearInterval(_progElapsedTimer);
  _progElapsedTimer = setInterval(() => {
    const secs = Math.floor((Date.now() - _progStartTime) / 1000);
    const el = document.getElementById('gtags-console-elapsed');
    if (el) el.textContent = secs + 's';
  }, 1000);
  el.classList.add('open');
}

// "[5249] extracting tags of arch/..."   初回ビルド
// " [1/1] extracting tags of c.c"        差分更新 (global -u -v)
function _parseProgressLine(text) {
  const m = text.match(/^\s*\[(\d+)(?:\/\d+)?\]\s+extracting tags of\s+(.+)$/);
  if (m) return { count: parseInt(m[1]), file: m[2].split(/[/\\]/).pop() };
  return null;
}

function _consoleAppend(text, cls) {
  // 進捗行はパースして UI に反映（ログには流さない）
  if (!cls) {
    const prog = _parseProgressLine(text.trim());
    if (prog) {
      _progCount = prog.count;
      document.getElementById('gtags-prog-count').textContent = prog.count.toLocaleString() + ' ファイル処理済み';
      document.getElementById('gtags-prog-file').textContent = prog.file;
      return;
    }
    // ハートビート行はプログレス表示に反映（ログには流さない）
    if (text.trim() === '... global 実行中') {
      document.getElementById('gtags-prog-count').textContent = 'global 実行中...';
      return;
    }
    // 変化なし検知
    if (text.includes('up to date')) {
      _progUpToDate = true;
    }
    // 開始/完了行などはログへ
    const body = document.getElementById('gtags-console-body');
    if (body) {
      body.style.display = '';
      const line = document.createElement('div');
      line.textContent = text;
      body.appendChild(line);
      body.scrollTop = body.scrollHeight;
    }
    return;
  }
  // エラー/完了メッセージはログへ
  const body = document.getElementById('gtags-console-body');
  if (body) {
    body.style.display = '';
    const line = document.createElement('div');
    line.className = cls;
    line.textContent = text;
    body.appendChild(line);
    body.scrollTop = body.scrollHeight;
  }
}

function _consoleDone(ok) {
  clearInterval(_progElapsedTimer);
  _progElapsedTimer = null;
  const bar = document.getElementById('gtags-prog-bar');
  bar.classList.remove('running');
  bar.classList.add(ok ? 'done' : 'error');
  document.getElementById('gtags-console-abort')?.style && (document.getElementById('gtags-console-abort').style.display = 'none');
  const secs = Math.floor((Date.now() - _progStartTime) / 1000);
  if (ok) {
    const countEl = document.getElementById('gtags-prog-count');
    countEl.textContent = _progUpToDate ? '最新状態 ✓' : '完了 ✓';
    countEl.style.color = _progUpToDate ? '#888' : '#4ec9b0';
    countEl.style.fontWeight = 'bold';
    const detail = (_progCount > 0 ? _progCount.toLocaleString() + ' ファイル / ' : '') + secs + 's';
    document.getElementById('gtags-prog-file').textContent = '(' + detail + ')';
  } else {
    const countEl = document.getElementById('gtags-prog-count');
    countEl.textContent = 'エラー / 中断';
    countEl.style.color = '#f88';
    countEl.style.fontWeight = 'bold';
    document.getElementById('gtags-prog-file').textContent = '';
  }
  document.getElementById('gtags-console-close').disabled = false;
}

// ===== SSEストリーム実行 =====
async function runIndexOpStream(op, label) {
  if (_opRunning) return;
  _opRunning = true;
  _opLabel   = label;
  _opSecs    = 0;
  clearInterval(_opTimer);
  _opTimer = setInterval(() => { _opSecs++; _syncOpBtn(); }, 1000);
  renderPopover();
  _consoleOpen(label);

  return new Promise(resolve => {
    let _settled = false;
    function settle(ok, msg) {
      if (_settled) return;
      _settled = true;
      es.close();
      clearInterval(_opTimer); _opTimer = null; _opRunning = false;
      _opCancel = null;
      _opLabel = ok ? '' : (msg === '中断しました' ? '' : 'エラー'); _opLastMsg = '';
      if (msg) _consoleAppend(msg, 'con-err');
      _consoleDone(ok);
      if (ok) fetchStatus().then(renderPopover); else renderPopover();
      resolve(ok);
    }

    // スピナー
    const spinFrames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    let spinIdx = 0;
    const spinEl = document.createElement('div');
    spinEl.className = 'con-spin';
    spinEl.textContent = spinFrames[0] + ' 実行中...';
    const consoleBody = document.getElementById('gtags-console-body');
    if (consoleBody) consoleBody.appendChild(spinEl);
    const spinTimer = setInterval(() => {
      spinIdx = (spinIdx + 1) % spinFrames.length;
      spinEl.textContent = spinFrames[spinIdx] + ' 実行中...';
    }, 80);

    const es = new EventSource('/api/gtags/stream?op=' + op);
    _opCancel = () => { clearInterval(spinTimer); spinEl.remove(); settle(false, '中断しました'); };
    es.onmessage = e => {
      _consoleAppend(e.data);
      _opLastMsg = e.data.trim();
      _syncOpBtn();
    };
    es.addEventListener('gtags-done', () => { clearInterval(spinTimer); spinEl.remove(); settle(true, null); });
    es.addEventListener('gtags-error', e => { clearInterval(spinTimer); spinEl.remove(); settle(false, e.data || 'エラーが発生しました'); });
    es.onerror = () => { clearInterval(spinTimer); spinEl.remove(); settle(false, '接続エラー'); };
  });
}

// 進行中のインデックス操作の状態（ポップオーバーをまたいで保持）
let _opRunning = false;
let _opLabel   = '';
let _opSecs    = 0;
let _opTimer   = null;
let _opLastMsg = '';
let _opCancel  = null;

async function fetchStatus() {
  try {
    const [r1, r2] = await Promise.all([
      fetch('/api/gtags/status'),
      fetch('/api/ctags/status'),
    ]);
    if (r1.ok) {
      const d = await r1.json();
      _installed = !!d.installed;
      _indexed   = !!d.indexed;
      _stale     = !!d.stale;
      _binSource = d.bin_source || '';
      _transport = d.transport || '';
      _preloadedSymbols = d.preloaded_symbols || 0;
    }
    if (r2.ok) {
      const d = await r2.json();
      // ctags モジュールの状態を直接更新
      if (typeof window._ctagsSetStatus === 'function') window._ctagsSetStatus(d);
    }
    renderGear();
  } catch {}
  finally {
    // 起動オーバーレイの「定義エンジン」ステップを完了させる（取得失敗でも進める）。
    if (window.bootDone) window.bootDone('defengine');
  }
}

function renderGear() {
  const label = document.getElementById('gtags-engine-label');
  if (!label) return;
  label.style.display = '';
  const engines = window.getDefEngines();
  const eng = engines[0] || 'rg';
  const srcLabel = { bin: 'bin/', scoop: 'Scoop', msys: 'MSYS2', path: 'PATH' }[_binSource] || '';
  const gnuLabel = 'GNU Global' + (srcLabel ? ' (' + srcLabel + ')' : '');
  if (eng === 'gtags' && _installed && _indexed) {
    label.textContent = _stale ? gnuLabel + ' ⚠' : gnuLabel;
    label.style.color = _stale ? '#c8a84b' : '#999';
  } else if (eng === 'ctags') {
    label.textContent = 'ctags';
    label.style.color = '#999';
  } else {
    label.textContent = 'ripgrep';
    label.style.color = '#999';
  }
  const chainNames = { gtags: 'GNU Global', ctags: 'ctags', rg: 'ripgrep' };
  label.title = '定義ジャンプエンジン設定\n試行順: ' + engines.map(e => chainNames[e]).join(' → ');
}

function renderPopover() {
  const pop = document.getElementById('gtags-popover');
  if (!pop) return;

  const eng = window.getDefEngine();
  const ctagsIndexed   = typeof window._ctagsIndexed   === 'function' ? window._ctagsIndexed()   : false;
  const ctagsInstalled = typeof window._ctagsInstalled === 'function' ? window._ctagsInstalled() : false;

  const gtagsBadge = _indexed ? '<span style="color:#4ec9b0;font-size:10px"> ✓</span>' : '<span class="gtags-pop-hint">（未生成）</span>';
  const ctagsBadge = ctagsIndexed ? '<span style="color:#4ec9b0;font-size:10px"> ✓</span>' : '<span class="gtags-pop-hint">（未生成）</span>';

  let html = `<div class="gtags-pop-title">定義ジャンプエンジン <span class="gtags-pop-hint">上から順に試行</span></div>`;

  // エンジン優先順リスト（チェック=使用する、▲▼=順序変更）
  const engineLabels = {
    gtags: `GNU Global${gtagsBadge}`,
    ctags: `ctags${ctagsBadge}`,
    rg:    'ripgrep',
  };
  const order   = window.getDefEngineOrder();
  const enabled = new Set(window.getDefEngines());
  order.forEach((name, i) => {
    html += `<div class="gtags-pop-row engine-row" data-eng="${name}">
      <span class="engine-grip" title="ドラッグで順序変更">⠿</span>
      <input type="checkbox" data-eng-toggle="${name}" ${enabled.has(name) ? 'checked' : ''} title="このエンジンを使う">
      <span class="engine-prio">${i + 1}.</span>
      <span style="flex:1">${engineLabels[name]}</span>
    </div>`;
  });

  // gtags の実行状態（経路 + プリロード）。EDR 環境で速い経路に乗れているかを
  // ログを見ずに確認できるようにする。
  if (_installed && _indexed) {
    const tLabel = { direct: '直接起動', file: 'ファイル経由', bash: 'bash 経由' }[_transport] || _transport || '不明';
    let statusLine = `実行経路: ${tLabel}`;
    if (_preloadedSymbols > 0) statusLine += ` ／ プリロード: ${_preloadedSymbols.toLocaleString()} シンボル`;
    html += `<div class="gtags-pop-status">${statusLine}</div>`;
  }

  // インデックス操作: ctags と GNU Global は独立して表示する（両方インストール済みなら両方出す）。
  const showCtagsSection = eng === 'ctags' || ctagsInstalled;
  const showGtagsSection = _installed;

  if (showCtagsSection) {
    html += `<div class="gtags-pop-divider"></div>`;
    html += `<div class="gtags-pop-section">ctags インデックス</div>`;
    if (ctagsIndexed) {
      html += `<button class="gtags-pop-btn" id="ctags-pop-rebuild-main" style="width:100%">再生成</button>`;
    } else {
      html += `<button class="gtags-pop-btn primary" id="ctags-pop-build-main" style="width:100%">生成</button>`;
    }
  }

  if (showGtagsSection) {
    html += `<div class="gtags-pop-divider"></div>`;
    html += `<div class="gtags-pop-section">GNU Global インデックス</div>`;
    if (_opRunning) {
      html += `<div style="display:flex;gap:4px;align-items:center">`;
      html += `<button class="gtags-pop-btn" id="gtags-op-btn" disabled style="flex:1"><span class="gtags-spinner"></span>${_opLabel} ${_opSecs}s</button>`;
      html += `<button class="gtags-pop-btn" id="gtags-op-cancel" style="flex-shrink:0">中断</button>`;
      html += `</div>`;
      html += `<div id="gtags-op-msg" class="gtags-op-msg">${_opLastMsg ? _opLastMsg : ''}</div>`;
    } else if (_opLabel === 'エラー') {
      html += `<div style="color:#f88;font-size:11px;padding:4px 0">エラーが発生しました</div>`;
      if (_indexed) {
        html += `<div style="display:flex;gap:4px">`;
        html += `<button class="gtags-pop-btn" id="gtags-pop-update" style="flex:1">更新</button>`;
        html += `<button class="gtags-pop-btn" id="gtags-pop-rebuild" style="flex:1">再生成</button>`;
        html += `</div>`;
      } else {
        html += `<button class="gtags-pop-btn primary" id="gtags-pop-build">生成</button>`;
      }
    } else if (_indexed) {
      html += `<div style="display:flex;gap:4px">`;
      html += `<button class="gtags-pop-btn" id="gtags-pop-update" style="flex:1">更新</button>`;
      html += `<button class="gtags-pop-btn" id="gtags-pop-rebuild" style="flex:1">再生成</button>`;
      html += `</div>`;
    } else {
      html += `<button class="gtags-pop-btn primary" id="gtags-pop-build">生成</button>`;
    }
  }

  pop.innerHTML = html;

  // エンジンの有効/無効トグル
  pop.querySelectorAll('input[data-eng-toggle]').forEach(cb => {
    cb.onchange = () => {
      const name = cb.dataset.engToggle;
      const cur = new Set(window.getDefEngines());
      if (cb.checked) cur.add(name); else cur.delete(name);
      if (cur.size === 0) { cb.checked = true; return; } // 全部OFFは不可
      const orderNow = window.getDefEngineOrder();
      localStorage.setItem('defEngineEnabled', orderNow.filter(e => cur.has(e)).join(','));
      renderGear();
      renderPopover();
    };
  });
  // ドラッグ&ドロップで優先順を並べ替え。
  // ドラッグ中は innerHTML を再構築せず DOM 移動だけで並べ替え、
  // pointerup で DOM の並びを localStorage に確定 → 再描画する。
  const engineRows = () => [...pop.querySelectorAll('.engine-row')];
  pop.querySelectorAll('.engine-row .engine-grip').forEach(grip => {
    grip.onpointerdown = ev => {
      ev.preventDefault();
      ev.stopPropagation();
      const row = grip.closest('.engine-row');
      row.classList.add('dragging');
      grip.setPointerCapture(ev.pointerId);
      const renumber = () => engineRows().forEach((r, i) => {
        r.querySelector('.engine-prio').textContent = (i + 1) + '.';
      });
      grip.onpointermove = mv => {
        const over = engineRows().find(r => {
          const rc = r.getBoundingClientRect();
          return mv.clientY >= rc.top && mv.clientY <= rc.bottom;
        });
        if (!over || over === row) return;
        const list = engineRows();
        if (list.indexOf(over) < list.indexOf(row)) over.before(row); else over.after(row);
        renumber();
      };
      grip.onpointerup = () => {
        grip.onpointermove = null;
        grip.onpointerup = null;
        row.classList.remove('dragging');
        const newOrder = engineRows().map(r => r.dataset.eng);
        const cur = new Set(window.getDefEngines());
        localStorage.setItem('defEngineOrder', newOrder.join(','));
        localStorage.setItem('defEngineEnabled', newOrder.filter(en => cur.has(en)).join(','));
        renderGear();
        renderPopover();
      };
    };
  });

  const cancelBtn = document.getElementById('gtags-op-cancel');
  if (cancelBtn) cancelBtn.onclick = () => { if (_opCancel) _opCancel(); };

  function _syncOpBtn() {
    const btn = document.getElementById('gtags-op-btn');
    if (!btn) return;
    btn.innerHTML = `<span class="gtags-spinner"></span>${_opLabel} ${_opSecs}s`;
    btn.disabled = true;
    const msgEl = document.getElementById('gtags-op-msg');
    if (msgEl && _opLastMsg) msgEl.textContent = _opLastMsg;
  }

  async function runIndexOp(btn, url, label) {
    if (_opRunning) return false;
    _opRunning = true;
    _opLabel   = label;
    _opSecs    = 0;
    clearInterval(_opTimer);
    _opTimer = setInterval(() => { _opSecs++; _syncOpBtn(); }, 1000);
    renderPopover(); // ボタンをop-btn状態に更新
    try {
      const r = await fetch(url, { method: 'POST' });
      clearInterval(_opTimer);
      _opTimer = null;
      _opRunning = false;
      if (r.ok) { await fetchStatus(); renderPopover(); return true; }
      _opLabel = 'エラー';
      renderPopover();
      return false;
    } catch {
      clearInterval(_opTimer);
      _opTimer = null;
      _opRunning = false;
      _opLabel = 'エラー';
      renderPopover();
      return false;
    }
  }

  // 生成ボタン
  const buildBtn = document.getElementById('gtags-pop-build');
  if (buildBtn) {
    buildBtn.onclick = () => runIndexOpStream('index', 'gtags 生成中');
  }

  // 更新ボタン
  const updateBtn = document.getElementById('gtags-pop-update');
  if (updateBtn) {
    updateBtn.onclick = () => runIndexOpStream('update', 'gtags 更新中');
  }

  // 完全再生成ボタン
  const rebuildBtn = document.getElementById('gtags-pop-rebuild');
  if (rebuildBtn) {
    rebuildBtn.onclick = () => runIndexOpStream('rebuild', 'gtags 再生成中');
  }

  // ctags 生成/再生成ボタン（ポップオーバー内）
  const ctagsBuildMain = document.getElementById('ctags-pop-build-main');
  if (ctagsBuildMain) ctagsBuildMain.onclick = () => { pop.style.display = 'none'; window._ctagsRunIndex && window._ctagsRunIndex(); };
  const ctagsRebuildMain = document.getElementById('ctags-pop-rebuild-main');
  if (ctagsRebuildMain) ctagsRebuildMain.onclick = () => { pop.style.display = 'none'; window._ctagsRunIndex && window._ctagsRunIndex(); };

}

window._gtagsRenderPopover = renderPopover;

document.addEventListener('DOMContentLoaded', () => {
  fetchStatus();

  const label = document.getElementById('gtags-engine-label');
  const pop   = document.getElementById('gtags-popover');
  if (!label || !pop) return;

  label.onclick = e => {
    e.stopPropagation();
    const open = pop.style.display !== 'none';
    pop.style.display = open ? 'none' : 'block';
    if (!open) {
      // 現在の status で即描画してから最新を取りに行く。これが無いと、status 取得前に
      // 開いたとき中身が空のまま（GNU Global 行が出ず「開ききらない」症状）になる。
      renderPopover();
      fetchStatus().then(renderPopover);
    }
  };

  // ポップオーバー外クリックで閉じる
  document.addEventListener('click', e => {
    if (!pop.contains(e.target) && e.target !== label) {
      pop.style.display = 'none';
    }
  });

  // 最小化ボタン
  const minimizeBtn = document.getElementById('gtags-console-minimize');
  if (minimizeBtn) {
    minimizeBtn.onclick = () => {
      const el = document.getElementById('gtags-console');
      const isMin = el.classList.toggle('minimized');
      minimizeBtn.title = isMin ? '展開' : '最小化';
      minimizeBtn.textContent = isMin ? '□' : '─';
    };
  }

  // コンソール閉じるボタン
  const consoleClose = document.getElementById('gtags-console-close');
  if (consoleClose) {
    consoleClose.onclick = () => {
      document.getElementById('gtags-console').classList.remove('open');
    };
  }
});

})();
