// ===== GNU Global UI =====
// このファイルと index.html の参照・addon.js の gtagsEnabled() 呼び出しを削除するだけで取り外し可能。

(function() {

let _installed = false;
let _indexed   = false;

window.gtagsEnabled = function() {
  return _installed && _indexed && localStorage.getItem('gtagsEnabled') !== 'false';
};

let _stale = false;

async function fetchStatus() {
  try {
    const r = await fetch('/api/gtags/status');
    if (!r.ok) return;
    const d = await r.json();
    _installed = !!d.installed;
    _indexed   = !!d.indexed;
    _stale     = !!d.stale;
    renderGear();
  } catch {}
}

function renderGear() {
  const label = document.getElementById('gtags-engine-label');
  if (!label) return;
  if (!_installed) { label.style.display = 'none'; return; }
  const active = _indexed && localStorage.getItem('gtagsEnabled') !== 'false';
  label.style.display = '';
  if (active && _stale) {
    label.textContent = 'GNU Global ⚠';
    label.style.color = '#c8a84b';
    label.title = '定義ジャンプエンジン設定（インデックスが古い可能性があります）';
  } else {
    label.textContent = active ? 'GNU Global' : 'ripgrep';
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
    if (_indexed) {
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

  function startTimer(btn, label) {
    let secs = 0;
    const update = () => { btn.innerHTML = `<span class="gtags-spinner"></span>${label} ${secs}s`; };
    update();
    return setInterval(() => { secs++; update(); }, 1000);
  }

  async function runIndexOp(btn, url, label) {
    btn.disabled = true;
    const timer = startTimer(btn, label);
    try {
      const r = await fetch(url, { method: 'POST' });
      clearInterval(timer);
      if (r.ok) { await fetchStatus(); renderPopover(); return true; }
      btn.textContent = 'エラー';
      return false;
    } catch {
      clearInterval(timer);
      btn.textContent = 'エラー';
      return false;
    }
  }

  // 生成ボタン
  const buildBtn = document.getElementById('gtags-pop-build');
  if (buildBtn) {
    buildBtn.onclick = () => runIndexOp(buildBtn, '/api/gtags/index', '生成中');
  }

  // 更新ボタン
  const updateBtn = document.getElementById('gtags-pop-update');
  if (updateBtn) {
    updateBtn.onclick = async () => {
      const ok = await runIndexOp(updateBtn, '/api/gtags/update', '更新中');
      if (ok) { updateBtn.textContent = '✓ 完了'; setTimeout(renderPopover, 1500); return; }
      setTimeout(async () => {
        if (!confirm('インデックスが壊れている可能性があります。\n削除して再生成しますか？')) { renderPopover(); return; }
        await runIndexOp(updateBtn, '/api/gtags/rebuild', '再生成中');
      }, 500);
    };
  }

  // 完全再生成ボタン
  const rebuildBtn = document.getElementById('gtags-pop-rebuild');
  if (rebuildBtn) {
    rebuildBtn.onclick = () => runIndexOp(rebuildBtn, '/api/gtags/rebuild', '再生成中');
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
});

})();
