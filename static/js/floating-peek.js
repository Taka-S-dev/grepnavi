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

        const minRowBtn = document.createElement('span');
        minRowBtn.textContent = '─';
        minRowBtn.style.cssText = 'cursor:pointer;color:#666;padding:0 2px;flex-shrink:0';
        minRowBtn.onmouseenter = () => { minRowBtn.style.color = '#ccc'; };
        minRowBtn.onmouseleave = () => { minRowBtn.style.color = '#666'; };
        minRowBtn.onclick = e => { e.stopPropagation(); win._floatToggleMin(); };

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
        row.appendChild(minRowBtn);
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
    win.style.cssText = `position:fixed;z-index:${++_floatZBase};background:#1e1e1e;border:1px solid #555;border-radius:4px;box-shadow:0 4px 16px rgba(0,0,0,.6);width:500px;height:400px;display:flex;flex-direction:column;top:${_cascadeTopBase + ci * _cascadeStep}px;left:${_cascadeLeftBase + ci * _cascadeStep}px;resize:both;overflow:hidden;min-width:200px;min-height:80px`;
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
    win._floatEditors = [];
    win.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      const sel = window.getSelection()?.toString().trim();
      _showWordCtxMenu(sel || title, e.clientX, e.clientY, win._floatFirstHit, win._floatEditors);
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
      const hoverEngine = r.headers.get('X-Engine') || '';
      body.innerHTML = '';
      body.style.cssText = 'display:flex;flex-direction:column;overflow:hidden;padding:0;flex:1';
      if(!Array.isArray(hits) || !hits.length) {
        body.style.cssText = 'overflow:auto;padding:8px;color:#aaa;font:12px monospace;flex:1';
        body.textContent = '定義が見つかりません';
        return;
      }
      const defs = hits.filter(h => !h.decl);
      const show = defs.length ? defs : hits;
      if(show[0]) win._floatFirstHit = { file: show[0].file, line: show[0].line };
      const origClose = win._floatClose;
      win._floatClose = () => { win._floatEditors.forEach(e => e.dispose()); origClose(); };
      const isSingle = show.length === 1;
      const sliced = show.slice(0, 3);

      // 複数ヒット時はタブバーを表示し、1ペインずつ切り替え
      const tabBar = isSingle ? null : (() => {
        const tb = document.createElement('div');
        tb.style.cssText = 'display:flex;flex-shrink:0;border-bottom:1px solid #3a3a3a;background:#252526';
        body.appendChild(tb);
        return tb;
      })();

      const edContainers = [];
      const tabEls = [];

      function _switchTab(idx) {
        edContainers.forEach((c, j) => { c.style.display = j === idx ? 'flex' : 'none'; });
        tabEls.forEach((t, j) => {
          t.style.background = j === idx ? '#1e1e1e' : 'transparent';
          t.style.color = j === idx ? '#ccc' : '#777';
          t.style.borderBottom = j === idx ? '2px solid #007acc' : '2px solid transparent';
        });
        // Monaco は非表示時にレイアウトを更新しないため、表示直後に layout() を呼ぶ
        win._floatEditors[idx]?.layout();
      }

      sliced.forEach((h, i) => {
        const engSuffix = (i === 0 && hoverEngine) ? ` [${hoverEngine}]` : '';
        const label = shortPath(h.file) + ':' + h.line + engSuffix;

        if (tabBar) {
          const tab = document.createElement('div');
          tab.style.cssText = 'padding:4px 10px;font-size:11px;cursor:pointer;white-space:nowrap;border-bottom:2px solid transparent;user-select:none';
          tab.textContent = label;
          tab.onclick = () => _switchTab(i);
          tab.ondblclick = () => openPeekPermanent(h.file, h.line);
          tab.title = 'ダブルクリックでエディタで開く';
          tabBar.appendChild(tab);
          tabEls.push(tab);
        } else {
          // 単一ヒット: ファイルパスラベルをそのまま表示
          const loc = document.createElement('div');
          loc.style.cssText = 'color:#888;font-size:11px;padding:4px 8px 2px;cursor:pointer;flex-shrink:0';
          loc.textContent = label;
          loc.onclick = () => openPeekPermanent(h.file, h.line);
          body.appendChild(loc);
        }

        const edContainer = document.createElement('div');
        edContainer.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column';
        body.appendChild(edContainer);
        edContainers.push(edContainer);

        const lang = detectLang(h.file) || 'plaintext';
        const ed = monaco.editor.create(edContainer, {
          value: h.body || '',
          language: lang,
          readOnly: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 12,
          theme: 'vs-dark',
          lineNumbers: n => String(h.line + n - 1),
          lineNumbersMinChars: 4,
          contextmenu: false,
          automaticLayout: true,
        });
        // enum_member の場合、対象行をハイライト
        if (h.kind === 'enum_member' && h.body) {
          const bodyLines = h.body.split('\n');
          let targetLn = 2;
          if (bodyLines.length > 1 && bodyLines[1].trim() === '...') targetLn = 3;
          ed.deltaDecorations([], [{
            range: new monaco.Range(targetLn, 1, targetLn, 1),
            options: { isWholeLine: true, className: 'float-peek-target-line' }
          }]);
        }
        win._floatEditors.push(ed);
        _attachEditorCtxMenu(ed, win);
      });

      // 複数ヒット: 最初のタブをアクティブにする
      if (tabBar) _switchTab(0);
    } catch { body.textContent = 'エラーが発生しました'; }
  }

  // ===== Floating Peek ウィンドウ (選択範囲固定表示) =====
  function _showFloatingSelection(file, startLine, endLine, text) {
    const key = '\x00sel:' + file + ':' + startLine + ':' + endLine;
    if(_floatingWins.has(key)) { _floatBringToFront(_floatingWins.get(key)); return; }

    const title = shortPath(file) + ':' + startLine + '-' + endLine;
    const { win, body } = _createFloatWin(key, title);
    win._floatFirstHit = { file, line: startLine };

    body.innerHTML = '';
    body.style.cssText = 'overflow:hidden;padding:0;flex:1';

    const edContainer = document.createElement('div');
    edContainer.style.cssText = 'width:100%;height:100%';
    body.appendChild(edContainer);

    const lang = detectLang(file) || 'plaintext';
    const ed = monaco.editor.create(edContainer, {
      value: text,
      language: lang,
      readOnly: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12,
      theme: 'vs-dark',
      lineNumbers: n => String(startLine + n - 1),
      lineNumbersMinChars: 4,
      contextmenu: false,
      automaticLayout: true,
    });

    win._floatEditors.push(ed);
    _attachEditorCtxMenu(ed, win);
    const origClose = win._floatClose;
    win._floatClose = () => { ed.dispose(); origClose(); };
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
      body.style.cssText = 'overflow:hidden;padding:0;flex:1';
      if(!Array.isArray(lines) || !lines.length) {
        body.style.cssText = 'overflow:auto;padding:8px;color:#aaa;font:12px monospace;flex:1';
        body.textContent = 'コンテキストが見つかりません';
        return;
      }
      const lang = detectLang(file) || 'plaintext';
      const text = lines.map(l => l.text).join('\n');

      const edContainer = document.createElement('div');
      edContainer.style.cssText = 'width:100%;height:100%';
      body.appendChild(edContainer);

      const ed = monaco.editor.create(edContainer, {
        value: text,
        language: lang,
        readOnly: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 12,
        theme: 'vs-dark',
        lineNumbers: n => String(lines[n - 1]?.line ?? n),
        lineNumbersMinChars: 4,
        contextmenu: false,
        automaticLayout: true,
      });

      // ターゲット行をハイライト
      const targetIdx = lines.findIndex(l => l.is_match);
      if(targetIdx >= 0) {
        ed.deltaDecorations([], [{
          range: new monaco.Range(targetIdx + 1, 1, targetIdx + 1, 1),
          options: { isWholeLine: true, className: 'float-peek-target-line' },
        }]);
        ed.revealLineInCenter(targetIdx + 1);
      }

      win._floatEditors.push(ed);
      _attachEditorCtxMenu(ed, win);
      const origClose = win._floatClose;
      win._floatClose = () => { ed.dispose(); origClose(); };
    } catch { body.textContent = 'エラーが発生しました'; }
  }

  // ===== エディタの右クリックで単語を取得してメニュー表示 =====
  function _attachEditorCtxMenu(ed, win) {
    ed.onContextMenu(e => {
      const pos = ed.getPosition();
      const model = ed.getModel();
      const wordAtPos = pos && model ? model.getWordAtPosition(pos)?.word : '';
      const sel = ed.getSelection();
      const selText = sel && !sel.isEmpty() ? model?.getValueInRange(sel)?.trim() : '';
      const word = selText || wordAtPos || win._floatTitle || '';
      if(!word) return;
      _showWordCtxMenu(word, e.event.browserEvent.clientX, e.event.browserEvent.clientY, win._floatFirstHit, win._floatEditors);
    });
  }

  // ===== エディタ全体で単語をハイライト =====
  function _highlightInEditors(editors, word) {
    editors.forEach(ed => {
      const model = ed.getModel();
      if(!model) return;
      const matches = model.findMatches(word, false, false, true, null, false);
      ed._floatHighlightDecos = ed.deltaDecorations(
        ed._floatHighlightDecos || [],
        matches.map(m => ({
          range: m.range,
          options: { inlineClassName: 'float-peek-word-highlight' },
        }))
      );
    });
  }

  // ===== 共通右クリックコンテキストメニュー =====
  const _wordCtxMenuId = 'grepnavi-word-ctx';
  function _showWordCtxMenu(word, x, y, hoverHit, peekEditors) {
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
    if(peekEditors && peekEditors.length) {
      addItem('codicon-symbol-color', 'ハイライト: ' + word, () => _highlightInEditors(peekEditors, word));
    }
    if(hoverHit) {
      addItem('codicon-link-external', '行を開く: ' + shortPath(hoverHit.file) + ':' + hoverHit.line, () => openPeekPermanent(hoverHit.file, hoverHit.line));
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
  return { showFloatingDef: _showFloatingDef, showFloatingCtx: _showFloatingCtx, showFloatingSelection: _showFloatingSelection, showWordCtxMenu: _showWordCtxMenu };
}
