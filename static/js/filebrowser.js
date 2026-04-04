// ===== ファイルブラウザ =====
// 依存: state.js (_fbMode, _fbCurrentPath, _fbNavStack, _fbNavIdx, _fbListIdx)
//       utils.js (id, esc, st)
//       project.js (getProjectPath, getProjectHistory, getDirHistory, getSaveDirHistory,
//                   addDirHistory, openProject, saveProject, projectRoot)

let _fbDirCallback = null;
let _fbNavItems    = [];
let _fbGoingUp     = false;

function fbSetFocus(idx) {
  _fbNavItems.forEach((el, i) => el.classList.toggle('selected', i === idx));
  _fbListIdx = idx;
  if(_fbNavItems[idx]) _fbNavItems[idx].scrollIntoView({block: 'nearest'});
}

async function showFileBrowser(mode, dirCallback) {
  _fbMode = mode;
  _fbDirCallback = dirCallback || null;
  _fbNavStack = [];
  _fbNavIdx   = -1;

  const isDirMode      = mode === 'dir';
  const isOpenFileMode = mode === 'open-file';
  id('fb-title').textContent = isDirMode ? 'フォルダを選択'
    : isOpenFileMode          ? 'ファイルを開く'
    : mode === 'save'         ? '名前を付けて保存'
    :                           'プロジェクトを開く';
  id('fb-ok').textContent       = isDirMode ? '選択' : mode === 'save' ? '保存' : '開く';
  id('fb-ok').style.display     = isOpenFileMode ? 'none' : '';
  id('fb-filename-row').style.display = (isDirMode || isOpenFileMode) ? 'none' : '';
  id('fb-overlay').classList.add('open');

  let startDir = '';
  if(isOpenFileMode) {
    startDir = localStorage.getItem('grepnavi-open-file-dir') || projectRoot || '';
  } else if(isDirMode) {
    startDir = projectRoot || '';
  } else {
    const cur = getProjectPath();
    startDir = cur ? cur.replace(/\\/g, '/').split('/').slice(0, -1).join('/') : '';
    if(mode === 'save') {
      const name = cur ? cur.replace(/\\/g, '/').split('/').pop() : 'project.json';
      id('fb-filename').value = name;
    } else {
      id('fb-filename').value = '';
    }
  }
  await fbNavigate(startDir);
}

function renderBreadcrumb(fullPath) {
  const parts = fullPath.replace(/\\/g, '/').split('/').filter(Boolean);
  const bc = id('fb-breadcrumb');
  bc.innerHTML = '';
  parts.forEach((part, i) => {
    const accumulated = i === 0
      ? (part.endsWith(':') ? part + '/' : '/' + part)
      : parts.slice(0, i + 1).reduce((acc, p, j) => {
          if(j === 0) return p.endsWith(':') ? p + '/' : '/' + p;
          return acc.replace(/\/$/, '') + '/' + p;
        });
    const isLast = i === parts.length - 1;
    const seg = document.createElement('span');
    seg.className = 'fb-bc-seg' + (isLast ? ' fb-bc-cur' : '');
    seg.textContent = part;
    seg.title = accumulated;
    if(!isLast) seg.onclick = e => { e.stopPropagation(); fbNavigate(accumulated); };
    bc.appendChild(seg);
    if(!isLast) {
      const sep = document.createElement('span');
      sep.className = 'fb-bc-sep';
      sep.textContent = '›';
      bc.appendChild(sep);
    }
  });
  bc.scrollLeft = bc.scrollWidth;
}

function fbUpdateNavButtons(hasParent) {
  id('fb-back').disabled = _fbNavIdx <= 0;
  id('fb-fwd').disabled  = _fbNavIdx >= _fbNavStack.length - 1;
  if(hasParent !== undefined) id('fb-up').disabled = !hasParent;
}

function _fbFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  if(['c','h','cpp','hpp','cc','cxx'].includes(ext)) return 'codicon-file-code';
  if(['json'].includes(ext)) return 'codicon-json';
  if(['md','txt'].includes(ext)) return 'codicon-file-text';
  return 'codicon-file';
}

async function fbNavigate(dir, pushHistory = true, focusName = null) {
  const ext = (_fbMode === 'open-file') ? '' : '.json';
  const params = new URLSearchParams({ ext });
  if(dir) params.set('path', dir);
  const res = await fetch('/api/browse?' + params).catch(() => null);
  if(!res || !res.ok) { st('ディレクトリを開けませんでした'); return; }
  const data = await res.json();

  _fbCurrentPath = data.path;
  if(_fbMode === 'open-file') {
    try { localStorage.setItem('grepnavi-open-file-dir', data.path); } catch {}
  }
  if(pushHistory) {
    _fbNavStack = _fbNavStack.slice(0, _fbNavIdx + 1);
    _fbNavStack.push(data.path);
    _fbNavIdx = _fbNavStack.length - 1;
  }
  renderBreadcrumb(data.path);
  fbUpdateNavButtons(data.parent);

  const isDirMode = _fbMode === 'dir';

  const curDirEl = id('fb-current-dir');
  if(curDirEl) {
    if(isDirMode) {
      const name = data.path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || data.path;
      curDirEl.innerHTML = `選択中: <span class="fb-current-name">${esc(name)}</span> <span style="color:#555;font-size:10px">${esc(data.path)}</span>`;
      curDirEl.style.display = '';
    } else {
      curDirEl.style.display = 'none';
    }
  }

  _fbListIdx  = -1;
  _fbNavItems = [];
  const list   = id('fb-list');
  const recent = id('fb-recent-section');
  list.innerHTML   = '';
  recent.innerHTML = '';
  recent.style.display = 'none';

  function mkRow(cls, html) {
    const row = document.createElement('div');
    row.className = 'fb-item ' + cls;
    row.innerHTML = html;
    return row;
  }

  function addNavRow(row, clickAction, enterAction, dblAction) {
    const idx = _fbNavItems.length;
    _fbNavItems.push(row);
    row.onclick = () => { fbSetFocus(idx); if(clickAction) clickAction(); };
    row._enter  = enterAction || clickAction;
    if(dblAction) row.ondblclick = dblAction;
    list.appendChild(row);
  }

  function addRecentRow(row, clickAction, dblAction) {
    row.onclick = clickAction;
    if(dblAction) row.ondblclick = dblAction;
    recent.appendChild(row);
    recent.style.display = 'block';
  }

  function addRecentLabel(text) {
    const lbl = document.createElement('div');
    lbl.className = 'fb-section-label';
    lbl.textContent = text;
    recent.appendChild(lbl);
  }

  // 実ディレクトリ・ファイル（キーボード対象）
  (data.dirs || []).forEach(name => {
    const row = mkRow('fb-dir', `<i class="codicon codicon-folder"></i><span>${esc(name)}</span>`);
    addNavRow(row, null, () => fbNavigate(data.path + '/' + name), () => fbNavigate(data.path + '/' + name));
  });

  if(_fbMode === 'open-file') {
    (data.files || []).forEach(name => {
      const fullPath = data.path.replace(/\\/g, '/') + '/' + name;
      const row = mkRow('fb-file', `<i class="codicon ${_fbFileIcon(name)}"></i><span>${esc(name)}</span>`);
      addNavRow(row,
        null,
        () => { closeFb(); openPeekPermanent(fullPath, 1); },
        () => { closeFb(); openPeekPermanent(fullPath, 1); });
    });
  } else if(!isDirMode) {
    (data.files || []).forEach(name => {
      const row = mkRow('fb-file', `<i class="codicon codicon-json"></i><span>${esc(name)}</span>`);
      addNavRow(row,
        () => { id('fb-filename').value = name; },
        () => { id('fb-filename').value = name; fbOk(); },
        () => { id('fb-filename').value = name; fbOk(); });
    });
  }

  // 履歴（マウスのみ）
  if(isDirMode) {
    const rootHist = getDirHistory().filter(d => d !== data.path);
    if(rootHist.length) {
      addRecentLabel('最近使ったフォルダ');
      rootHist.slice(0, HISTORY_MAX).forEach(dir => {
        const name = dir.replace(/\\/g, '/').split('/').pop() || dir;
        const row  = mkRow('fb-dir fb-recent',
          `<i class="codicon codicon-history"></i><span title="${esc(dir)}">${esc(name)}</span><span class="fb-recent-dir">${esc(dir)}</span>`);
        addRecentRow(row, () => fbNavigate(dir), () => fbNavigate(dir));
      });
    }
  } else {
    const hist = getProjectHistory();
    if(hist.length) {
      addRecentLabel('最近使ったファイル');
      hist.slice(0, HISTORY_MAX).forEach(p => {
        const name = p.replace(/\\/g, '/').split('/').pop();
        const dir  = p.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
        const row  = mkRow('fb-file fb-recent',
          `<i class="codicon codicon-history"></i><span title="${esc(p)}">${esc(name)}</span><span class="fb-recent-dir">${esc(dir)}</span>`);
        if(_fbMode === 'open') {
          addRecentRow(row,
            () => { id('fb-filename').value = name; fbNavigate(dir); },
            async () => { closeFb(); await openProject(p); });
        } else {
          addRecentRow(row, () => { id('fb-filename').value = name; fbNavigate(dir); });
        }
      });
    }
    const dirHist = getSaveDirHistory().filter(d => d !== data.path);
    if(dirHist.length) {
      addRecentLabel('最近使ったフォルダ');
      dirHist.slice(0, HISTORY_MAX).forEach(dir => {
        const name = dir.replace(/\\/g, '/').split('/').pop() || dir;
        const row  = mkRow('fb-dir fb-recent',
          `<i class="codicon codicon-folder"></i><span title="${esc(dir)}">${esc(name)}</span><span class="fb-recent-dir">${esc(dir)}</span>`);
        addRecentRow(row, () => fbNavigate(dir), () => fbNavigate(dir));
      });
    }
  }

  // 上移動時: 元いたフォルダにフォーカス（なければ先頭）
  if(_fbGoingUp) {
    _fbGoingUp = false;
    let idx = focusName
      ? _fbNavItems.findIndex(el => el.querySelector('span')?.textContent === focusName)
      : -1;
    fbSetFocus(idx >= 0 ? idx : 0);
  }
}

async function fbOk() {
  if(_fbMode === 'dir') {
    const path = _fbCurrentPath;
    addDirHistory(path);
    closeFb();
    if(_fbDirCallback) _fbDirCallback(path);
    return;
  }
  const filename = id('fb-filename').value.trim();
  if(!filename) return;
  let fullPath = _fbCurrentPath.replace(/\\/g, '/');
  if(!fullPath.endsWith('/')) fullPath += '/';
  fullPath += filename.endsWith('.json') ? filename : filename + '.json';

  closeFb();
  if(_fbMode === 'save') await saveProject(fullPath);
  else                   await openProject(fullPath);
}

function closeFb() {
  id('fb-overlay').classList.remove('open');
}

addEventListener('DOMContentLoaded', () => {
  document.addEventListener('keydown', e => {
    if(!id('fb-overlay').classList.contains('open')) return;
    if(id('fb-path-input').style.display !== 'none') return;
    if(e.key === 'ArrowDown') {
      e.preventDefault();
      fbSetFocus(Math.min(_fbListIdx + 1, _fbNavItems.length - 1));
    } else if(e.key === 'ArrowUp') {
      e.preventDefault();
      fbSetFocus(Math.max(_fbListIdx - 1, 0));
    } else if(e.key === 'Enter') {
      if(_fbListIdx >= 0 && _fbNavItems[_fbListIdx]?._enter) {
        e.preventDefault();
        _fbNavItems[_fbListIdx]._enter();
      } else {
        fbOk();
      }
    } else if(e.key === 'ArrowLeft' || e.key === 'Backspace') {
      e.preventDefault();
      fbGoUp();
    } else if(e.key === 'ArrowRight') {
      e.preventDefault();
      const focused = _fbNavItems[_fbListIdx];
      if(focused?._enter && focused.classList.contains('fb-dir')) focused._enter();
    } else if(e.key === 'Escape') {
      closeFb();
    }
  });

  function fbGoUp() {
    const parts  = (_fbCurrentPath || '').replace(/\\/g, '/').split('/').filter(Boolean);
    const parent = parts.slice(0, -1).reduce((acc, p, i) => {
      if(i === 0) return p.endsWith(':') ? p + '/' : '/' + p;
      return acc.replace(/\/$/, '') + '/' + p;
    }, '');
    if(parent) { _fbGoingUp = true; fbNavigate(parent, true, parts[parts.length - 1] || null); }
  }

  id('fb-close').onclick   = closeFb;
  id('fb-cancel').onclick  = closeFb;
  id('fb-ok').onclick      = fbOk;
  id('fb-overlay').addEventListener('click', e => { if(e.target === id('fb-overlay')) closeFb(); });

  id('fb-back').onclick = () => {
    if(_fbNavIdx > 0) { _fbNavIdx--; fbNavigate(_fbNavStack[_fbNavIdx], false); }
  };
  id('fb-fwd').onclick = () => {
    if(_fbNavIdx < _fbNavStack.length - 1) { _fbNavIdx++; fbNavigate(_fbNavStack[_fbNavIdx], false); }
  };
  id('fb-up').onclick = fbGoUp;

  const _fbShowInput = () => {
    id('fb-breadcrumb').style.display = 'none';
    id('fb-path-edit').style.display  = 'none';
    const inp = id('fb-path-input');
    inp.value = _fbCurrentPath || '';
    inp.style.display = '';
    inp.focus();
    inp.select();
  };
  id('fb-path-edit').onclick = _fbShowInput;
  id('fb-path-input').onblur = () => {
    id('fb-path-input').style.display  = 'none';
    id('fb-breadcrumb').style.display  = '';
    id('fb-path-edit').style.display   = '';
  };
  id('fb-path-input').onkeydown = e => {
    e.stopPropagation();
    if(e.key === 'Enter') { fbNavigate(id('fb-path-input').value.trim()); id('fb-path-input').blur(); }
    if(e.key === 'Escape') { id('fb-path-input').blur(); }
  };
  id('fb-filename').onkeydown = e => { e.stopPropagation(); if(e.key === 'Enter') fbOk(); };
});
