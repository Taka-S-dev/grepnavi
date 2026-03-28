// ===== GNU Global UI =====
// このファイルと index.html の参照・addon.js の gtagsEnabled() 呼び出しを削除するだけで取り外し可能。

(function() {

let _installed  = false;
let _indexed    = false;
let _binSource  = ''; // "bin" / "scoop" / "msys" / "path" / ""

window.gtagsEnabled = function() {
  return _installed && _indexed && localStorage.getItem('gtagsEnabled') !== 'false';
};

let _stale = false;

// ===== 進捗オーバーレイ =====
let _progCount = 0;
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
  _progStartTime = Date.now();
  clearInterval(_progElapsedTimer);
  _progElapsedTimer = setInterval(() => {
    const secs = Math.floor((Date.now() - _progStartTime) / 1000);
    const el = document.getElementById('gtags-console-elapsed');
    if (el) el.textContent = secs + 's';
  }, 1000);
  el.classList.add('open');
}

// "[5249] extracting tags of arch/..." からカウントとファイル名を抽出
function _parseProgressLine(text) {
  const m = text.match(/^\[(\d+)\]\s+extracting tags of\s+(.+)$/);
  if (m) return { count: parseInt(m[1]), file: m[2].split('/').pop() };
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
    countEl.textContent = '完了 ✓';
    countEl.style.color = '#4ec9b0';
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
    const r = await fetch('/api/gtags/status');
    if (!r.ok) return;
    const d = await r.json();
    _installed  = !!d.installed;
    _indexed    = !!d.indexed;
    _stale      = !!d.stale;
    _binSource  = d.bin_source || '';
    renderGear();
  } catch {}
}

function renderGear() {
  const label = document.getElementById('gtags-engine-label');
  if (!label) return;
  if (!_installed) { label.style.display = 'none'; return; }
  const active = _indexed && localStorage.getItem('gtagsEnabled') !== 'false';
  label.style.display = '';
  const srcLabel = { bin: 'bin/', scoop: 'Scoop', msys: 'MSYS2', path: 'PATH' }[_binSource] || '';
  const gnuLabel = 'GNU Global' + (srcLabel ? ' (' + srcLabel + ')' : '');
  if (active && _stale) {
    label.textContent = gnuLabel + ' ⚠';
    label.style.color = '#c8a84b';
    label.title = '定義ジャンプエンジン設定（インデックスが古い可能性があります）';
  } else {
    label.textContent = active ? gnuLabel : 'ripgrep';
    label.style.color = '#999';
    label.title = '定義ジャンプエンジン設定';
  }
}

function renderPopover() {
  const pop = document.getElementById('gtags-popover');
  if (!pop) return;

  const enabled = localStorage.getItem('gtagsEnabled') !== 'false';
  const active  = _indexed && enabled;

  let html = `<div class="gtags-pop-title">定義ジャンプエンジン</div>`;

  // エンジン選択
  html += `<label class="gtags-pop-row">
    <input type="radio" name="gtags-engine" value="gtags" ${active ? 'checked' : ''} ${!_indexed ? 'disabled' : ''}>
    <span>GNU Global${!_indexed ? '<span class="gtags-pop-hint">（インデックスなし）</span>' : ''}</span>
  </label>`;
  html += `<label class="gtags-pop-row">
    <input type="radio" name="gtags-engine" value="ripgrep" ${!active ? 'checked' : ''}>
    <span>ripgrep</span>
  </label>`;

  // インデックス操作（GNU Global 選択時のみ表示）
  if (enabled) {
    html += `<div class="gtags-pop-divider"></div>`;
    html += `<div class="gtags-pop-section">インデックス</div>`;
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

  // ラジオ変更
  pop.querySelectorAll('input[name="gtags-engine"]').forEach(r => {
    r.onchange = () => {
      localStorage.setItem('gtagsEnabled', r.value === 'gtags' ? 'true' : 'false');
      renderGear();
      renderPopover();
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

}

document.addEventListener('DOMContentLoaded', () => {
  fetchStatus();

  const label = document.getElementById('gtags-engine-label');
  const pop   = document.getElementById('gtags-popover');
  if (!label || !pop) return;

  label.onclick = e => {
    e.stopPropagation();
    const open = pop.style.display !== 'none';
    pop.style.display = open ? 'none' : 'block';
    if (!open) renderPopover();
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
