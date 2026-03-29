// ===== Floating Peek =====
// 依存: utils.js (shortPath, detectLang), state.js (tabs, activeTabIdx, selNode)
//       graph.js (addToGraph), editor.js (openPeek, grepSearchWord, jumpToDefinition)
// initFloatingPeek(getHoverCtx) を ensureEditor() から呼ぶこと。
// getHoverCtx: () => { word: string, hit: {file,line}|null }

function initFloatingPeek(getHoverCtx) {

  const _floatingWins = new Map(); // word → DOM element
  let _floatZBase = 9000;
  let _floatCascadeIdx = 0;

  // ===== ウィンドウマネージャー =====
  const _floatMgr = (() => {
    const panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;bottom:32px;right:8px;z-index:9999;background:#252526;border:1px solid #555;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.5);font:12px sans-serif;min-width:160px;max-width:240px;display:none';

    const titleBar = document.createElement('div');
    titleBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:4px 8px;background:#2d2d2d;border-radius:4px 4px 0 0;color:#aaa;user-select:none;border-bottom:1px solid #444';
    const titleLabel = document.createElement('span');
    titleLabel.textContent = 'Floating Peek';
    titleLabel.style.cssText = 'flex:1';
    const mgBtnStyle = 'cursor:pointer;color:#888;font-size:11px;padding:0 3px';

    const tileBtn = document.createElement('span');
    tileBtn.textContent = '⊞';
    tileBtn.title = '横に整列';
    tileBtn.style.cssText = mgBtnStyle;
    tileBtn.onmouseenter = () => { tileBtn.style.color = '#ccc'; };
    tileBtn.onmouseleave = () => { tileBtn.style.color = '#888'; };
    tileBtn.onclick = () => {
      const visible = [..._floatingWins.values()].filter(w => !w._floatMinimized);
      if(!visible.length) return;
      const margin = 8;
      const topOffset = 40;
      const minW = 280;
      const screenW = window.innerWidth;
      const widths = visible.map(w => w.offsetWidth || parseInt(w.style.width) || 500);
      const totalNeeded = widths.reduce((s, w) => s + w, 0) + margin * (visible.length + 1);
      const scale = totalNeeded > screenW ? (screenW - margin * (visible.length + 1)) / widths.reduce((s, w) => s + w, 0) : 1;
      const finalWidths = widths.map(w => Math.max(minW, Math.floor(w * scale)));
      const totalUsed = finalWidths.reduce((s, w) => s + w, 0) + margin * (visible.length + 1);
      const startX = Math.max(margin, Math.floor((screenW - totalUsed) / 2));
      let x = startX;
      visible.forEach((w, i) => {
        w.style.left  = x + 'px';
        w.style.top   = topOffset + 'px';
        w.style.width = finalWidths[i] + 'px';
        x += finalWidths[i] + margin;
        _floatBringToFront(w);
      });
    };

    const minAllBtn = document.createElement('span');
    minAllBtn.textContent = '─';
    minAllBtn.title = '全て最小化 / 展開';
    minAllBtn.style.cssText = mgBtnStyle;
    minAllBtn.onmouseenter = () => { minAllBtn.style.color = '#ccc'; };
    minAllBtn.onmouseleave = () => { minAllBtn.style.color = '#888'; };
    minAllBtn.onclick = () => {
      const anyVisible = [..._floatingWins.values()].some(w => !w._floatMinimized);
      [..._floatingWins.values()].forEach(w => {
        if(anyVisible ? !w._floatMinimized : w._floatMinimized) w._floatToggleMin();
      });
    };

    const closeAllBtn = document.createElement('span');
    closeAllBtn.textContent = '✕';
    closeAllBtn.title = '全て閉じる';
    closeAllBtn.style.cssText = mgBtnStyle;
    closeAllBtn.onmouseenter = () => { closeAllBtn.style.color = '#ccc'; };
    closeAllBtn.onmouseleave = () => { closeAllBtn.style.color = '#888'; };
    closeAllBtn.onclick = () => {
      [..._floatingWins.values()].forEach(w => w._floatClose());
    };

    titleBar.appendChild(titleLabel);
    titleBar.appendChild(tileBtn);
    titleBar.appendChild(minAllBtn);
    titleBar.appendChild(closeAllBtn);
    panel.appendChild(titleBar);

    const list = document.createElement('div');
    list.style.cssText = 'padding:4px 0';
    panel.appendChild(list);
    document.body.appendChild(panel);

    let _dragWord = null;

    function _reorder(fromWord, toWord, before) {
      const entries = [..._floatingWins.entries()];
      const fromIdx = entries.findIndex(([w]) => w === fromWord);
      const toIdx   = entries.findIndex(([w]) => w === toWord);
      if(fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
      const [item] = entries.splice(fromIdx, 1);
      const insertAt = before
        ? (fromIdx < toIdx ? toIdx - 1 : toIdx)
        : (fromIdx < toIdx ? toIdx     : toIdx + 1);
      entries.splice(insertAt, 0, item);
      _floatingWins.clear();
      entries.forEach(([w, win]) => _floatingWins.set(w, win));
    }

    function render() {
      list.innerHTML = '';
      if(!_floatingWins.size) { panel.style.display = 'none'; return; }
      panel.style.display = '';

      let topZ = -1;
      _floatingWins.forEach(w => { const z = parseInt(w.style.zIndex)||0; if(z>topZ) topZ=z; });

      _floatingWins.forEach((win, word) => {
        const isTop = (parseInt(win.style.zIndex)||0) === topZ;
        const row = document.createElement('div');
        row.dataset.word = word;
        row.style.cssText = 'display:flex;align-items:center;padding:3px 8px;gap:6px;cursor:pointer;border-top:2px solid transparent;border-bottom:2px solid transparent';
        row.onmouseenter = () => { row.style.background = '#2a2d2e'; };
        row.onmouseleave = () => { row.style.background = ''; };

        const handle = document.createElement('span');
        handle.textContent = '⠿';
        handle.style.cssText = 'color:#555;cursor:grab;flex-shrink:0;font-size:11px';
        handle.draggable = true;
        handle.addEventListener('dragstart', e => {
          _dragWord = word;
          e.dataTransfer.effectAllowed = 'move';
          setTimeout(() => { row.style.opacity = '0.4'; }, 0);
        });
        handle.addEventListener('dragend', () => { row.style.opacity = ''; _dragWord = null; render(); });

        row.addEventListener('dragover', e => {
          if(!_dragWord || _dragWord === word) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const rect = row.getBoundingClientRect();
          const before = e.clientY < rect.top + rect.height / 2;
          row.style.borderTop    = before ? '2px solid #4ec9b0' : '2px solid transparent';
          row.style.borderBottom = before ? '2px solid transparent' : '2px solid #4ec9b0';
        });
        row.addEventListener('dragleave', () => {
          row.style.borderTop = row.style.borderBottom = '2px solid transparent';
        });
        row.addEventListener('drop', e => {
          e.preventDefault();
          row.style.borderTop = row.style.borderBottom = '2px solid transparent';
          if(!_dragWord || _dragWord === word) return;
          const rect = row.getBoundingClientRect();
          const before = e.clientY < rect.top + rect.height / 2;
          _reorder(_dragWord, word, before);
          render();
        });

        if(win._floatMinimized) {
          row.style.background = '#1e1e1e';
          row.onmouseenter = () => { row.style.background = '#252526'; };
          row.onmouseleave = () => { row.style.background = '#1e1e1e'; };
        }

        const dot = document.createElement('span');
        dot.textContent = win._floatMinimized ? '–' : (isTop ? '●' : '○');
        dot.style.cssText = 'color:' + (win._floatMinimized ? '#444' : isTop ? '#4ec9b0' : '#666') + ';font-size:10px;flex-shrink:0';

        const label = document.createElement('span');
        const displayName = win._floatTitle || word;
        label.textContent = displayName;
        label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:' + (win._floatMinimized ? '#555' : isTop ? '#ddd' : '#aaa') + (win._floatMinimized ? ';text-decoration:line-through' : '');
        label.title = displayName;

        const closeBtn = document.createElement('span');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = 'cursor:pointer;color:#666;padding:0 2px;flex-shrink:0';
        closeBtn.onmouseenter = () => { closeBtn.style.color = '#ccc'; };
        closeBtn.onmouseleave = () => { closeBtn.style.color = '#666'; };
        closeBtn.onclick = e => { e.stopPropagation(); win._floatClose(); };

        row.onclick = () => {
          if(win._floatMinimized) win._floatToggleMin();
          _floatBringToFront(win);
        };
        row.appendChild(handle);
        row.appendChild(dot);
        row.appendChild(label);
        row.appendChild(closeBtn);
        list.appendChild(row);
      });
    }

    return { render };
  })();

  function _floatBringToFront(win) {
    win.style.zIndex = ++_floatZBase;
    _floatMgr.render();
  }

  window.closeTopFloatingDef = function() {
    if(!_floatingWins.size) return false;
    let topWin = null, topZ = -1;
    _floatingWins.forEach(w => {
      const z = parseInt(w.style.zIndex) || 0;
      if(z > topZ) { topZ = z; topWin = w; }
    });
    if(topWin) topWin._floatClose();
    return true;
  };

  // ===== 共通ウィンドウ生成ヘルパー =====
  function _createFloatWin(key, title) {
    const _cascadeStep = 24, _cascadeMax = 8, _cascadeTopBase = 60, _cascadeLeftBase = 160;
    const ci = _floatCascadeIdx % _cascadeMax;
    _floatCascadeIdx++;
    const win = document.createElement('div');
    win.style.cssText = `position:fixed;z-index:${++_floatZBase};background:#1e1e1e;border:1px solid #555;border-radius:4px;box-shadow:0 4px 16px rgba(0,0,0,.6);width:500px;max-height:400px;display:flex;flex-direction:column;top:${_cascadeTopBase + ci * _cascadeStep}px;left:${_cascadeLeftBase + ci * _cascadeStep}px;resize:both;overflow:hidden;min-width:200px;min-height:80px`;
    _floatingWins.set(key, win);
    win._floatClose = () => { win.remove(); _floatingWins.delete(key); _floatMgr.render(); };
    if(_floatingWins.size > 15) {
      const oldest = _floatingWins.values().next().value;
      oldest._floatClose();
    }
    win._floatTitle = title;
    _floatMgr.render();
    win.addEventListener('mousedown', () => _floatBringToFront(win));

    const hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:center;padding:4px 10px;gap:4px;background:#2d2d2d;border-radius:4px 4px 0 0;cursor:move;font:12px monospace;color:#ccc;user-select:none;flex-shrink:0';
    const hdrLabel = document.createElement('span');
    hdrLabel.textContent = title;
    hdrLabel.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const btnStyle = 'cursor:pointer;padding:0 4px;color:#aaa';
    const minBtn = document.createElement('span');
    minBtn.textContent = '─';
    minBtn.style.cssText = btnStyle;
    const closeBtn = document.createElement('span');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = btnStyle;
    closeBtn.onclick = () => win._floatClose();
    hdr.appendChild(hdrLabel);
    hdr.appendChild(minBtn);
    hdr.appendChild(closeBtn);

    const body = document.createElement('div');
    body.style.cssText = 'overflow:auto;padding:8px;color:#aaa;font:12px monospace;flex:1';
    body.textContent = '読み込み中...';

    win._floatMinimized = false;
    win._floatToggleMin = () => {
      win._floatMinimized = !win._floatMinimized;
      win.style.display = win._floatMinimized ? 'none' : 'flex';
      _floatMgr.render();
    };
    minBtn.onclick = () => win._floatToggleMin();

    win.appendChild(hdr);
    win.appendChild(body);
    document.body.appendChild(win);

    win._floatFirstHit = null;
    win.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      const sel = window.getSelection()?.toString().trim();
      _showWordCtxMenu(sel || title, e.clientX, e.clientY, win._floatFirstHit);
    });

    let dx = 0, dy = 0;
    hdr.addEventListener('mousedown', me => {
      dx = me.clientX - win.offsetLeft; dy = me.clientY - win.offsetTop;
      const onMove = mv => { win.style.left = (mv.clientX - dx) + 'px'; win.style.top = (mv.clientY - dy) + 'px'; };
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    return { win, body };
  }

  // ===== Floating Peek ウィンドウ (定義検索) =====
  async function _showFloatingDef(word) {
    if(_floatingWins.has(word)) { _floatBringToFront(_floatingWins.get(word)); return; }

    const dir  = id('dir').value.trim();
    const glob = id('glob').value.trim();
    const p = new URLSearchParams({ word });
    if(dir)  p.set('dir', dir);
    if(glob) p.set('glob', glob);
    const file = tabs[activeTabIdx]?.file || '';
    if(file) p.set('file', file);

    const { win, body } = _createFloatWin(word, word);

    try {
      const r = await fetch('/api/hover?' + p);
      const hits = await r.json();
      body.innerHTML = '';
      if(!Array.isArray(hits) || !hits.length) { body.textContent = '定義が見つかりません'; return; }
      const defs = hits.filter(h => !h.decl);
      const show = defs.length ? defs : hits;
      if(show[0]) win._floatFirstHit = { file: show[0].file, line: show[0].line };
      show.slice(0, 3).forEach(h => {
        const loc = document.createElement('div');
        loc.style.cssText = 'color:#888;font-size:11px;margin-bottom:2px;cursor:pointer';
        loc.textContent = shortPath(h.file) + ':' + h.line;
        loc.onclick = () => openPeek(h.file, h.line);
        const pre = document.createElement('pre');
        pre.style.cssText = 'margin:0 0 10px;padding:6px;background:#252526;border-radius:3px;overflow:auto;font:12px/1.5 Consolas,monospace;color:#d4d4d4;white-space:pre;tab-size:4';
        pre.textContent = h.body || '';
        body.appendChild(loc);
        body.appendChild(pre);
        const lang = detectLang(h.file) || 'plaintext';
        monaco.editor.colorize(h.body || '', lang, {}).then(html => { pre.innerHTML = html; });
      });
    } catch { body.textContent = 'エラーが発生しました'; }
  }

  // ===== Floating Peek ウィンドウ (カーソル前後コンテキスト) =====
  async function _showFloatingCtx(file, line) {
    const key = '\x00ctx:' + file + ':' + line;
    if(_floatingWins.has(key)) { _floatBringToFront(_floatingWins.get(key)); return; }

    const title = shortPath(file) + ':' + line;
    const { win, body } = _createFloatWin(key, title);
    win._floatFirstHit = { file, line };

    try {
      const p = new URLSearchParams({ file, line, ctx: 15 });
      const r = await fetch('/api/snippet?' + p);
      const lines = await r.json();
      body.innerHTML = '';
      if(!Array.isArray(lines) || !lines.length) { body.textContent = 'コンテキストが見つかりません'; return; }
      const lang = detectLang(file) || 'plaintext';
      const pre = document.createElement('pre');
      pre.style.cssText = 'margin:0;padding:6px;background:#252526;border-radius:3px;font:12px/1.5 Consolas,monospace;color:#d4d4d4;white-space:pre;tab-size:4';
      const text = lines.map(l => l.text).join('\n');
      pre.textContent = text;
      body.appendChild(pre);
      monaco.editor.colorize(text, lang, {}).then(html => {
        pre.innerHTML = html;
        // ターゲット行をハイライト
        const htmlLines = pre.innerHTML.split('\n');
        const targetIdx = lines.findIndex(l => l.is_match);
        if(targetIdx >= 0 && htmlLines[targetIdx] !== undefined) {
          htmlLines[targetIdx] = `<span style="display:block;background:#094771">${htmlLines[targetIdx]}</span>`;
          pre.innerHTML = htmlLines.join('\n');
        }
      });
      // 行番号サイドバー
      const lineNums = document.createElement('div');
      lineNums.style.cssText = 'position:absolute;left:0;top:0;padding:6px 4px;color:#555;font:12px/1.5 Consolas,monospace;white-space:pre;pointer-events:none;user-select:none;text-align:right;min-width:32px';
      lineNums.textContent = lines.map(l => l.line).join('\n');
      pre.style.paddingLeft = '38px';
      pre.style.position = 'relative';
      pre.appendChild(lineNums);
    } catch { body.textContent = 'エラーが発生しました'; }
  }

  // ===== 共通右クリックコンテキストメニュー =====
  const _wordCtxMenuId = 'grepnavi-word-ctx';
  function _showWordCtxMenu(word, x, y, hoverHit) {
    document.getElementById(_wordCtxMenuId)?.remove();
    const menu = document.createElement('div');
    menu.id = _wordCtxMenuId;
    menu.style.cssText = 'position:fixed;z-index:9999;background:#2d2d2d;border:1px solid #444;border-radius:4px;padding:2px 0;font:12px sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.6);min-width:180px';
    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';

    // ヘッダー: ワード名を1回だけ表示
    const hdr = document.createElement('div');
    hdr.textContent = word;
    hdr.style.cssText = 'padding:4px 12px;color:#666;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px;border-bottom:1px solid #3a3a3a;margin-bottom:2px';
    menu.appendChild(hdr);

    const addSep = () => {
      const sep = document.createElement('div');
      sep.style.cssText = 'height:1px;background:#3a3a3a;margin:2px 0';
      menu.appendChild(sep);
    };

    const addItem = (iconClass, label, fn) => {
      const el = document.createElement('div');
      el.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 12px 5px 8px;color:#ccc;cursor:pointer;white-space:nowrap';
      const icon = document.createElement('i');
      icon.className = 'codicon ' + iconClass;
      icon.style.cssText = 'flex-shrink:0;font-size:14px;color:#858585;width:16px;text-align:center';
      const text = document.createElement('span');
      text.textContent = label;
      el.appendChild(icon);
      el.appendChild(text);
      el.onmouseenter = () => { el.style.background = '#094771'; icon.style.color = '#ccc'; };
      el.onmouseleave = () => { el.style.background = ''; icon.style.color = '#858585'; };
      el.onclick = () => { menu.remove(); fn(); };
      menu.appendChild(el);
    };

    // ナビゲーション
    addItem('codicon-search',      'grep',             () => grepSearchWord(word));
    addItem('codicon-go-to-file',  '定義へジャンプ',   () => jumpToDefinition(word));

    // Peek
    addSep();
    addItem('codicon-file-code',     'Floating Peek',  () => _showFloatingDef(word));
    if(hoverHit) {
      addItem('codicon-link-external', '行を開く: ' + shortPath(hoverHit.file) + ':' + hoverHit.line, () => openPeek(hoverHit.file, hoverHit.line));
    }

    // グラフ
    const hasGraph = typeof addToGraph === 'function';
    const hasCallTree = typeof window.openCallTree === 'function';
    if(hasGraph || hasCallTree) {
      addSep();
      if(hasGraph) {
        const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const match = hoverHit
          ? {id: genId(), file: hoverHit.file, line: hoverHit.line, text: word}
          : {id: genId(), file: '', line: 0, text: word};
        const nodeLabel = hoverHit ? shortPath(hoverHit.file) + ':' + hoverHit.line : word;
        addItem('codicon-add', 'ノードに追加: ' + nodeLabel, () => addToGraph(match, '', 'ref', word));
      }
      if(hasCallTree) {
        addItem('codicon-list-tree', 'コールツリー', () => window.openCallTree(word));
      }
    }

    document.body.appendChild(menu);
    const close = e => { if(!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); } };
    setTimeout(() => document.addEventListener('click', close), 0);
  }

  // ===== Monaco ホバーポップアップ右クリック =====
  function _attachHoverCtx() {
    document.querySelectorAll('.monaco-hover').forEach(widget => {
      if(widget._grepnaviCtx) return;
      widget._grepnaviCtx = true;
      widget.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        const sel = window.getSelection()?.toString().trim();
        const ctx = getHoverCtx();
        const word = sel || ctx.word;
        if(!word) return;
        _showWordCtxMenu(word, e.clientX, e.clientY, ctx.hit);
      });
    });
  }
  new MutationObserver(_attachHoverCtx).observe(document.body, { childList: true, subtree: true });

  // 外部公開
  return { showFloatingDef: _showFloatingDef, showFloatingCtx: _showFloatingCtx, showWordCtxMenu: _showWordCtxMenu };
}
