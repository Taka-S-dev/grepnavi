// ===== ctags UI =====

(function() {

let _installed = false;
let _indexed   = false;
let _opRunning = false;
let _progStartTime = 0;
let _progElapsedTimer = null;

window._ctagsIndexed   = function() { return _indexed; };
window._ctagsInstalled = function() { return _installed; };
window._ctagsRunIndex  = function() { runIndex(); };
window._ctagsSetStatus = function(d) { _installed = !!d.installed; _indexed = !!d.indexed; };

async function fetchStatus() {
  try {
    const r = await fetch('/api/ctags/status');
    if (!r.ok) return;
    const d = await r.json();
    _installed = !!d.installed;
    _indexed   = !!d.indexed;
    if (_indexed) pollMacroReady();
    else renderLabel(false);
  } catch {}
}

function renderLabel(loading) {
  const label = document.getElementById('ctags-label');
  if (!label) return;
  if (loading) {
    label.style.display = '';
    label.textContent = 'マクロ読込中...';
    label.style.color = '#888';
  } else {
    label.style.display = 'none';
  }
}

async function pollMacroReady() {
  try {
    const r = await fetch('/api/ctags/macros');
    if (!r.ok) return;
    const d = await r.json();
    if (d.loading) {
      renderLabel(true);
      setTimeout(pollMacroReady, 2000);
    } else {
      renderLabel(false);
      // editor-c.js のキャッシュをクリアして再適用
      if (typeof window._ctagsSetStatus === 'function') {
        window._ctagsSetStatus({ installed: _installed, indexed: _indexed });
      }
    }
  } catch {}
}

function renderPopover() {
  const pop = document.getElementById('ctags-popover');
  if (!pop) return;

  let html = `<div class="gtags-pop-title">ctags インデックス</div>`;
  if (!_installed) {
    html += `<div style="color:#f88;font-size:11px;padding:4px 0">ctags がインストールされていません</div>`;
    html += `<div style="font-size:11px;color:#888;padding:2px 0">scoop install universal-ctags</div>`;
  } else if (_opRunning) {
    html += `<button class="gtags-pop-btn" disabled style="width:100%"><span class="gtags-spinner"></span>生成中...</button>`;
  } else if (_indexed) {
    html += `<button class="gtags-pop-btn" id="ctags-pop-rebuild" style="width:100%">再生成</button>`;
  } else {
    html += `<button class="gtags-pop-btn primary" id="ctags-pop-build" style="width:100%">生成</button>`;
  }

  pop.innerHTML = html;

  const buildBtn = document.getElementById('ctags-pop-build');
  if (buildBtn) buildBtn.onclick = () => runIndex();

  const rebuildBtn = document.getElementById('ctags-pop-rebuild');
  if (rebuildBtn) rebuildBtn.onclick = () => runIndex();
}

function consoleOpen() {
  const el = document.getElementById('ctags-console');
  if (!el) return;
  document.getElementById('ctags-console-title').textContent = 'ctags 生成中...';
  document.getElementById('ctags-console-body').innerHTML = '';
  document.getElementById('ctags-console-body').style.display = 'none';
  document.getElementById('ctags-console-close').disabled = true;
  document.getElementById('ctags-console-elapsed').style.display = '';
  document.getElementById('ctags-console-elapsed').textContent = '0s';
  document.getElementById('ctags-prog-bar').className = 'running';
  document.getElementById('ctags-prog-count').textContent = '準備中...';
  document.getElementById('ctags-prog-count').style.color = '';
  document.getElementById('ctags-prog-count').style.fontWeight = '';
  document.getElementById('ctags-prog-file').textContent = '';
  _progStartTime = Date.now();
  clearInterval(_progElapsedTimer);
  const _dotFrames = ['生成中.  ', '生成中.. ', '生成中...'];
  let _dotIdx = 0;
  _progElapsedTimer = setInterval(() => {
    const elapsed = document.getElementById('ctags-console-elapsed');
    if (elapsed) elapsed.textContent = Math.floor((Date.now() - _progStartTime) / 1000) + 's';
    const countEl = document.getElementById('ctags-prog-count');
    if (countEl && _opRunning) {
      _dotIdx = (_dotIdx + 1) % _dotFrames.length;
      countEl.textContent = _dotFrames[_dotIdx];
    }
  }, 400);
  el.classList.add('open');
}

function consoleAppend(text, cls) {
  if (!cls) {
    const trimmed = text.trim();
    // ハートビート行は無視
    if (trimmed === '... 生成中') return;
    // 開始・完了行はコンソールに表示
    const body = document.getElementById('ctags-console-body');
    body.style.display = '';
    const line = document.createElement('div');
    line.textContent = text;
    body.appendChild(line);
    body.scrollTop = body.scrollHeight;
    return;
  }
  const body = document.getElementById('ctags-console-body');
  body.style.display = '';
  const line = document.createElement('div');
  line.className = cls;
  line.textContent = text;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
}

function consoleDone(ok) {
  clearInterval(_progElapsedTimer);
  _progElapsedTimer = null;
  const bar = document.getElementById('ctags-prog-bar');
  bar.className = ok ? 'done' : 'error';
  const secs = Math.floor((Date.now() - _progStartTime) / 1000);
  const countEl = document.getElementById('ctags-prog-count');
  if (ok) {
    countEl.textContent = '完了 ✓';
    countEl.style.color = '#4ec9b0';
    countEl.style.fontWeight = 'bold';
    document.getElementById('ctags-prog-file').textContent = '(' + secs + 's)';
  } else {
    countEl.textContent = 'エラー';
    countEl.style.color = '#f88';
    countEl.style.fontWeight = 'bold';
    document.getElementById('ctags-prog-file').textContent = '';
  }
  document.getElementById('ctags-console-title').textContent = ok ? 'ctags 完了 ✓' : 'ctags エラー';
  document.getElementById('ctags-console-close').disabled = false;
}

async function runIndex() {
  if (_opRunning) return;
  _opRunning = true;
  renderPopover();
  consoleOpen();

  const es = new EventSource('/api/ctags/index');
  es.onmessage = e => consoleAppend(e.data);
  es.addEventListener('ctags-done', () => {
    es.close();
    _opRunning = false;
    fetchStatus().then(() => {
      renderPopover();
      // gtags ポップオーバーも更新（インデックス状態が変わったため）
      if (typeof window._gtagsRenderPopover === 'function') window._gtagsRenderPopover();
    });
    consoleDone(true);
  });
  es.addEventListener('ctags-error', e => {
    es.close();
    _opRunning = false;
    consoleAppend(e.data || 'エラーが発生しました', 'con-err');
    renderPopover();
    consoleDone(false);
  });
  es.onerror = () => {
    es.close();
    _opRunning = false;
    consoleAppend('接続エラー', 'con-err');
    renderPopover();
    consoleDone(false);
  };
}

document.addEventListener('DOMContentLoaded', () => {
  fetchStatus();

  const label = document.getElementById('ctags-label');
  const pop   = document.getElementById('ctags-popover');
  if (!label || !pop) return;

  label.onclick = e => {
    e.stopPropagation();
    const open = pop.style.display !== 'none';
    pop.style.display = open ? 'none' : 'block';
    if (!open) renderPopover();
  };

  document.addEventListener('click', e => {
    if (!pop.contains(e.target) && e.target !== label) {
      pop.style.display = 'none';
    }
  });

  const minimizeBtn = document.getElementById('ctags-console-minimize');
  if (minimizeBtn) {
    minimizeBtn.onclick = () => {
      const el = document.getElementById('ctags-console');
      const isMin = el.classList.toggle('minimized');
      minimizeBtn.textContent = isMin ? '□' : '─';
    };
  }

  const closeBtn = document.getElementById('ctags-console-close');
  if (closeBtn) {
    closeBtn.onclick = () => {
      document.getElementById('ctags-console').classList.remove('open');
    };
  }
});

})();
