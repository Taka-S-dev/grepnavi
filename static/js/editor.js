// ===== 単語ハイライト固定 =====
const PINNED_HL_COLORS = [
  { chip: '#00dcff', rgba: 'rgba(0,220,255,0.25)',   border: 'rgba(0,180,255,0.9)'  },
  { chip: '#50ff78', rgba: 'rgba(80,255,120,0.25)',  border: 'rgba(50,200,80,0.9)'  },
  { chip: '#ff6464', rgba: 'rgba(255,100,100,0.25)', border: 'rgba(255,60,60,0.9)'  },
  { chip: '#c864ff', rgba: 'rgba(200,100,255,0.25)', border: 'rgba(160,60,255,0.9)' },
  { chip: '#ffa03c', rgba: 'rgba(255,160,60,0.25)',  border: 'rgba(255,120,20,0.9)' },
  { chip: '#3cc8c8', rgba: 'rgba(60,200,200,0.25)',  border: 'rgba(20,160,160,0.9)' },
  { chip: '#ffb8d0', rgba: 'rgba(255,184,208,0.25)', border: 'rgba(255,140,180,0.9)'},
  { chip: '#ffdc00', rgba: 'rgba(255,220,0,0.35)',   border: 'rgba(255,180,0,0.9)'  },
];

const WORD_SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';

function applyPinnedHighlightToModel(ph, model) {
  if(!model) return;
  const uriStr = model.uri.toString();
  if(ph.modelDecos.has(uriStr)) return;
  // wholeWord=true → 単語一致、false → 部分一致
  const wordSeps = ph.wholeWord ? WORD_SEPARATORS : null;
  const matches = model.findMatches(ph.word, false, false, true, wordSeps, false);
  const decos = matches.map(m => ({
    range: m.range,
    options: { inlineClassName: `pinned-hl-${ph.colorIdx}` }
  }));
  const ids = model.deltaDecorations([], decos);
  ph.modelDecos.set(uriStr, ids);
}

function _pinnedHighlightsKey() {
  return 'grepnavi-pinned-highlights:' + (localStorage.getItem('grepnavi_project_root') || '');
}

function savePinnedHighlights() {
  localStorage.setItem(_pinnedHighlightsKey(), JSON.stringify(
    pinnedHighlights.map(ph => ({
      word: ph.word, wholeWord: ph.wholeWord, colorIdx: ph.colorIdx,
      originFile: ph.originFile, originLine: ph.originLine,
    }))
  ));
}

function loadPinnedHighlights() {
  try {
    const data = JSON.parse(localStorage.getItem(_pinnedHighlightsKey()) || '[]');
    pinnedHighlights = [];
    data.forEach(d => {
      const ph = { word: d.word, wholeWord: d.wholeWord ?? true, colorIdx: d.colorIdx,
                   modelDecos: new Map(), originFile: d.originFile, originLine: d.originLine };
      pinnedHighlights.push(ph);
      applyPinnedHighlightToModel(ph, monacoEditor?.getModel());
    });
    renderPinnedChips();
  } catch {}
}

function togglePinnedHighlight(word, wholeWord = true) {
  const idx = pinnedHighlights.findIndex(p => p.word === word);
  if(idx >= 0) {
    const ph = pinnedHighlights[idx];
    ph.modelDecos.forEach((ids, uriStr) => {
      const m = monaco.editor.getModels().find(m => m.uri.toString() === uriStr);
      if(m) m.deltaDecorations(ids, []);
    });
    pinnedHighlights.splice(idx, 1);
  } else {
    const usedColors = new Set(pinnedHighlights.map(p => p.colorIdx));
    let colorIdx = 0;
    for(let i = 0; i < PINNED_HL_COLORS.length; i++) {
      if(!usedColors.has(i)) { colorIdx = i; break; }
    }
    const originFile = tabs[activeTabIdx]?.file ?? null;
    const originLine = monacoEditor?.getPosition()?.lineNumber ?? null;
    const ph = { word, wholeWord, colorIdx, modelDecos: new Map(), originFile, originLine };
    pinnedHighlights.push(ph);
    applyPinnedHighlightToModel(ph, monacoEditor?.getModel());
  }
  savePinnedHighlights();
  renderPinnedChips();
}

let _jumpFlashIds = [];
function flashJumpTarget(range) {
  _jumpFlashIds = monacoEditor.deltaDecorations(_jumpFlashIds, [{
    range,
    options: { inlineClassName: 'pinned-hl-jump' },
  }]);
  setTimeout(() => {
    _jumpFlashIds = monacoEditor.deltaDecorations(_jumpFlashIds, []);
  }, 600);
}

function jumpPinnedHighlight(ph, dir) {
  const model = monacoEditor?.getModel();
  if(!model) return;
  const wordSeps = ph.wholeWord ? WORD_SEPARATORS : null;
  const matches = model.findMatches(ph.word, false, false, true, wordSeps, false);
  if(!matches.length) return;
  const curLine = monacoEditor.getPosition()?.lineNumber ?? 0;
  let idx;
  if(dir > 0) {
    idx = matches.findIndex(m => m.range.startLineNumber > curLine);
    if(idx < 0) idx = 0; // wrap
  } else {
    idx = matches.slice().reverse().findIndex(m => m.range.startLineNumber < curLine);
    idx = idx < 0 ? matches.length - 1 : matches.length - 1 - idx; // wrap
  }
  const target = matches[idx];
  monacoEditor.revealLineInCenter(target.range.startLineNumber);
  monacoEditor.setPosition({ lineNumber: target.range.startLineNumber, column: target.range.startColumn });
  flashJumpTarget(target.range);
}

function renderPinnedChips() {
  const panel = id('pinned-hl-panel');
  if(!panel) return;
  panel.innerHTML = '';
  panel.style.display = pinnedHighlights.length ? 'flex' : 'none';
  pinnedHighlights.forEach(ph => {
    const c = PINNED_HL_COLORS[ph.colorIdx];
    const chip = document.createElement('span');
    chip.className = 'pinned-chip';
    chip.title = ph.wholeWord ? '単語一致' : '部分一致';
    chip.style.cssText = `--chip-color:${c.chip};border-color:${c.border};background:${c.rgba}`;
    chip.innerHTML = `<span class="pinned-chip-nav" title="前の出現箇所">&#8249;</span><span class="pinned-chip-word">${ph.word}</span><span class="pinned-chip-count"></span><span class="pinned-chip-nav" title="次の出現箇所">&#8250;</span><span class="pinned-chip-x">×</span>`;
    const [btnPrev, btnNext] = chip.querySelectorAll('.pinned-chip-nav');
    btnPrev.onclick = () => jumpPinnedHighlight(ph, -1);
    btnNext.onclick = () => jumpPinnedHighlight(ph, +1);
    chip.querySelector('.pinned-chip-word').onclick = () => {
      if(ph.originFile) openPeek(ph.originFile, ph.originLine);
    };
    chip.querySelector('.pinned-chip-x').onclick = () => togglePinnedHighlight(ph.word);
    panel.appendChild(chip);
  });
  updatePinnedCounts();
}

function getPinnedHighlightStats(ph) {
  const model = monacoEditor?.getModel();
  if (!model) return { total: 0, current: 0 };
  const wordSeps = ph.wholeWord ? WORD_SEPARATORS : null;
  const matches = model.findMatches(ph.word, false, false, true, wordSeps, false);
  const total = matches.length;
  if (!total) return { total: 0, current: 0 };
  const pos = monacoEditor.getPosition();
  const curLine = pos?.lineNumber ?? 0;
  const curCol  = pos?.column ?? 0;
  let current = matches.findIndex(m =>
    m.range.startLineNumber > curLine ||
    (m.range.startLineNumber === curLine && m.range.startColumn >= curCol)
  );
  current = current < 0 ? total : current + 1;
  return { total, current };
}

function updatePinnedCounts() {
  const panel = id('pinned-hl-panel');
  if (!panel || !pinnedHighlights.length) return;
  const chips = panel.querySelectorAll('.pinned-chip');
  pinnedHighlights.forEach((ph, i) => {
    const el = chips[i]?.querySelector('.pinned-chip-count');
    if (!el) return;
    const { total, current } = getPinnedHighlightStats(ph);
    el.textContent = total ? `${current}/${total}` : '';
  });
}

// ===== 行メモ / ブックマーク (localStorage + JSON自動保存) =====

let _memoSaveTimer = null;
function _cancelMemoSave() { clearTimeout(_memoSaveTimer); _memoSaveTimer = null; }
function _scheduleMemoSave() {
  clearTimeout(_memoSaveTimer);
  _memoSaveTimer = setTimeout(() => {
    fetch('/api/graph/memos', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        line_memos: getLineMemos(),
        line_memo_categories: getLineMemoCategories(),
        line_memo_sources: getLineMemoSources(),
        range_memos: getRangeMemos(),
        bookmarks: getBookmarks(),
      }),
    });
  }, 500);
}

function getLineMemos() {
  try { return JSON.parse(localStorage.getItem('grepnavi-line-memos') || '{}'); } catch { return {}; }
}
// line memo の分類軸 (key 共通: "file::line"):
//   - categories: "draft" / "ok" / "warn" / "error" / "note" / undefined (旧メモ)
//   - sources   : "ai" / "user" / undefined (旧メモ = user 扱い)
function getLineMemoCategories() {
  try { return JSON.parse(localStorage.getItem('grepnavi-line-memo-categories') || '{}'); } catch { return {}; }
}
function getLineMemoSources() {
  try { return JSON.parse(localStorage.getItem('grepnavi-line-memo-sources') || '{}'); } catch { return {}; }
}
function setLineMemo(file, line, memo, category) {
  const memos = getLineMemos();
  const cats = getLineMemoCategories();
  const srcs = getLineMemoSources();
  const key = file + '::' + line;
  if(memo) {
    memos[key] = memo;
    cats[key] = category || cats[key] || 'note';
    srcs[key] = srcs[key] || 'user';
  } else {
    delete memos[key];
    delete cats[key];
    delete srcs[key];
  }
  localStorage.setItem('grepnavi-line-memos', JSON.stringify(memos));
  localStorage.setItem('grepnavi-line-memo-categories', JSON.stringify(cats));
  localStorage.setItem('grepnavi-line-memo-sources', JSON.stringify(srcs));
  _scheduleMemoSave();
}

function getBookmarks() {
  try { return JSON.parse(localStorage.getItem('grepnavi-bookmarks') || '{}'); } catch { return {}; }
}
function setBookmark(file, line, on, text) {
  const bm = getBookmarks();
  const key = file + '::' + line;
  if(on) bm[key] = text !== undefined ? text : (bm[key] || '');
  else delete bm[key];
  localStorage.setItem('grepnavi-bookmarks', JSON.stringify(bm));
  _scheduleMemoSave();
}
function refreshBookmarkDecorations() {
  if(!monacoEditor) return;
  const file = tabs[activeTabIdx]?.file;
  if(!file) { bookmarkDecoIds = monacoEditor.deltaDecorations(bookmarkDecoIds, []); return; }
  const bm = getBookmarks();
  // line memo と同様、path 形式差を吸収する。
  const decos = Object.keys(bm)
    .map(k => ({ key: k, ..._splitLineMemoKey(k) }))
    .filter(e => _samePath(e.file, file))
    .map(e => {
      return {
        range: new monaco.Range(e.line, 1, e.line, 1),
        options: {
          isWholeLine: true,
          glyphMarginClassName: 'bookmark-glyph',
          glyphMarginHoverMessage: { value: 'ブックマーク (Alt+B で解除)' },
        }
      };
    });
  bookmarkDecoIds = monacoEditor.deltaDecorations(bookmarkDecoIds, decos);
  if(typeof _memoListOpen !== 'undefined' && _memoListOpen) renderMemoList();
}

// "<file>::<line>" 形式 key を {file, line} に分解する。
// 末尾の "::<digits>" を line 番号として剥がし、それ以前を file path として扱う。
// path 自体に "::" が含まれていても末尾 1 箇所しか line として解釈しないので安全。
function _splitLineMemoKey(key) {
  const idx = key.lastIndexOf('::');
  if (idx < 0) return { file: key, line: 0 };
  return { file: key.substring(0, idx), line: parseInt(key.substring(idx + 2), 10) };
}

function refreshLineMemoDecorations() {
  if(!monacoEditor) return;
  const file = tabs[activeTabIdx]?.file;
  if(!file) {
    lineMemoDecoIds = monacoEditor.deltaDecorations(lineMemoDecoIds, []);
    renderLineMemoOverlay();
    return;
  }
  const memos = getLineMemos();
  const cats = getLineMemoCategories();
  // _samePath で slash 方向 / 大文字小文字を正規化して比較する。
  // bridge 経由で追加された memo は forward-slash 正規化済み、Monaco のタブは
  // Windows ネイティブの backslash パスなので exact string match だと一致しない。
  const decos = Object.entries(memos)
    .map(([key, memo]) => ({ key, memo, ...(_splitLineMemoKey(key)) }))
    .filter(e => _samePath(e.file, file))
    .map(e => {
      const cat = cats[e.key] || '';
      // category 別に glyphMarginClassName を変える: line-memo-glyph に
      // line-memo-glyph-<category> を追加して CSS で色付け / opacity 制御。
      const glyphClass = cat
        ? `line-memo-glyph line-memo-glyph-${cat}`
        : 'line-memo-glyph';
      return {
        range: new monaco.Range(e.line, 1, e.line, 1),
        options: {
          isWholeLine: true,
          glyphMarginClassName: glyphClass,
          glyphMarginHoverMessage: { value: '✎ ' + e.memo.split('\n').join('\n\n') },
        }
      };
    });
  lineMemoDecoIds = monacoEditor.deltaDecorations(lineMemoDecoIds, decos);
  renderLineMemoOverlay();
  if (_memoListOpen) renderMemoList();
}

function renderLineMemoOverlay() {
  document.getElementById('line-memo-overlay')?.remove();
  _lineMemoScrollDispose?.dispose(); _lineMemoScrollDispose = null;
  if(!monacoEditor || !showLineMemoInline) return;
  const file = tabs[activeTabIdx]?.file;
  if(!file) return;

  // path 正規化込みで比較 (refreshLineMemoDecorations と同じ理由)
  const lineMemos = Object.entries(getLineMemos())
    .map(([k, memo]) => ({ ..._splitLineMemoKey(k), memo, kind: 'line' }))
    .filter(e => _samePath(e.file, file));
  const nodeMemos = Object.values(graph.nodes || {})
    .filter(n => _samePath(n.match?.file, file) && n.match?.line && n.memo?.trim())
    .map(n => ({ line: n.match.line, memo: n.memo, kind: 'node' }));
  const allMemos = [...lineMemos, ...nodeMemos];
  if (!allMemos.length) return;

  const byLine = new Map();
  allMemos.forEach(m => {
    if (!byLine.has(m.line)) byLine.set(m.line, []);
    byLine.get(m.line).push(m);
  });

  const container = id('monaco-container');
  const overlay = document.createElement('div');
  overlay.id = 'line-memo-overlay';
  overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden;z-index:var(--z-overlay)';
  container.style.position = 'relative';
  container.appendChild(overlay);

  const lineH    = monacoEditor.getOption(monaco.editor.EditorOption.lineHeight);
  const fontSize = monacoEditor.getOption(monaco.editor.EditorOption.fontSize);

  function positionItems() {
    overlay.innerHTML = '';
    const scrollTop = monacoEditor.getScrollTop();
    byLine.forEach((items, line) => {
      const top  = monacoEditor.getTopForLineNumber(line) - scrollTop;
      if(top < -lineH || top > container.offsetHeight) return;
      const model   = monacoEditor.getModel();
      const endCol  = model ? model.getLineMaxColumn(line) : 1;
      const pos     = monacoEditor.getScrolledVisiblePosition({lineNumber: line, column: endCol});
      const left    = pos ? pos.left : 200;
      const el = document.createElement('div');
      el.className = 'line-memo-overlay-item';
      el.style.cssText = `position:absolute;top:${top}px;left:${left + 8}px;height:${lineH}px;line-height:${lineH}px;font-size:${fontSize}px`;
      const maxLen = items.length > 1 ? 50 : 80;
      const text = items.map(m => {
        const prefix = m.kind === 'node' ? '◎ ' : '';
        const oneLine = m.memo.replace(/\s+/g, ' ');
        const truncated = oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '…' : oneLine;
        return prefix + truncated;
      }).join('  │  ');
      // prefix は emoji 不使用 (フォント / OS 依存を避ける)。
      el.textContent = '▸ ' + text;
      overlay.appendChild(el);
    });
  }

  positionItems();
  _lineMemoScrollDispose = monacoEditor.onDidScrollChange(positionItems);
}

function toggleLineMemoInline() {
  showLineMemoInline = !showLineMemoInline;
  const btn = id('btn-line-memo-toggle');
  if(btn) { btn.classList.toggle('on', showLineMemoInline); btn.style.background = showLineMemoInline ? '#094771' : ''; }
  refreshLineMemoDecorations();
}

// memo 編集 popup の category 選択肢。null は「category 未設定 (= 旧メモ)」用。
const _MEMO_CATEGORIES = [
  { value: 'draft', label: '📝 draft' },
  { value: 'ok',    label: '✓ ok'    },
  { value: 'warn',  label: '⚠ warn'  },
  { value: 'error', label: '✕ error' },
  { value: 'note',  label: '📌 note' },
];

function _mkCategorySelect(currentCat) {
  const sel = document.createElement('select');
  sel.style.cssText = 'font-size:11px;background:#1a1a1a;color:#ccc;border:1px solid #444;border-radius:2px;padding:2px 4px;margin-right:auto';
  _MEMO_CATEGORIES.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.value;
    opt.textContent = c.label;
    if (c.value === (currentCat || 'note')) opt.selected = true;
    sel.appendChild(opt);
  });
  return sel;
}

function showLineMemoInput(file, line) {
  document.getElementById('line-memo-popup')?.remove();
  const key = file + '::' + line;
  const current = getLineMemos()[key] || '';
  const currentCat = getLineMemoCategories()[key] || '';
  const popup = document.createElement('div');
  popup.id = 'line-memo-popup';
  popup.style.cssText = 'position:fixed;z-index:var(--z-autocomplete);background:#2d2d2d;border:1px solid #555;border-radius:4px;padding:8px;box-shadow:0 4px 12px rgba(0,0,0,0.6);width:300px';
  const edRect = id('monaco-container').getBoundingClientRect();
  const lineH = monacoEditor.getOption(monaco.editor.EditorOption.lineHeight);
  const top = Math.min(edRect.top + (line - 1) * lineH - monacoEditor.getScrollTop() + lineH, window.innerHeight - 140);
  popup.style.left = (edRect.left + 64) + 'px';
  popup.style.top  = Math.max(top, edRect.top) + 'px';
  popup.innerHTML  = `<div style="color:#aaa;font-size:11px;margin-bottom:4px">L${line} の行メモ</div>`;
  const ta = document.createElement('textarea');
  ta.value = current;
  ta.style.cssText = 'width:100%;height:64px;background:#1a1a1a;border:1px solid #444;color:#ccc;font:11px Consolas,monospace;padding:4px;resize:vertical;box-sizing:border-box;border-radius:2px';
  ta.placeholder = 'Ctrl+Enter で保存 / Esc でキャンセル';
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:4px;margin-top:6px;justify-content:flex-end;align-items:center';
  const mkBtn = (label, bg) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `font-size:11px;padding:2px 8px;background:${bg};color:#ccc;border:1px solid #555;border-radius:2px;cursor:pointer`;
    return b;
  };
  const catSel   = _mkCategorySelect(currentCat);
  const btnSave   = mkBtn('保存', '#0e639c');
  const btnDel    = mkBtn('削除', '#3c3c3c');
  const btnCancel = mkBtn('キャンセル', '#3c3c3c');
  btnDel.style.display = current ? '' : 'none';
  btnRow.append(catSel, btnDel, btnCancel, btnSave);
  popup.append(ta, btnRow);
  document.body.appendChild(popup);
  ta.focus(); ta.select();
  const save = () => {
    setLineMemo(file, line, ta.value.trim(), catSel.value);
    popup.remove();
    refreshLineMemoDecorations();
  };
  const cancel = () => popup.remove();
  btnSave.onclick = save;
  btnCancel.onclick = cancel;
  btnDel.onclick = () => { setLineMemo(file, line, ''); popup.remove(); refreshLineMemoDecorations(); };
  ta.addEventListener('keydown', e => {
    if(e.key === 'Escape') { e.stopPropagation(); cancel(); }
    if(e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
  });
  setTimeout(() => document.addEventListener('mousedown', e => {
    if(!popup.contains(e.target)) cancel();
  }, {once: true}), 0);
}

// ===== 範囲メモ (localStorage) =====
function getRangeMemos() {
  try { return JSON.parse(localStorage.getItem('grepnavi-range-memos') || '[]'); } catch { return []; }
}
function saveRangeMemos(arr) {
  localStorage.setItem('grepnavi-range-memos', JSON.stringify(arr));
  _scheduleMemoSave();
}

function refreshRangeMemoDecorations() {
  if (!monacoEditor) return;
  const file = tabs[activeTabIdx]?.file;
  if (!file) {
    rangeMemoDecoIds = monacoEditor.deltaDecorations(rangeMemoDecoIds, []);
    return;
  }
  // _samePath で path 形式差を吸収 (line memo と同じ理由 — bridge は forward-slash、
  // Monaco タブは Windows native の backslash の可能性あり)。
  const memos = getRangeMemos().filter(m => _samePath(m.file, file));
  const decos = memos.map(m => {
    // category 別の背景色は range-memo-highlight に -<cat> サフィックスを追加して
    // CSS で塗り分け。draft は opacity だけ落とす。
    const cls = m.category
      ? `range-memo-highlight range-memo-highlight-${m.category}`
      : 'range-memo-highlight';
    return {
      range: new monaco.Range(m.startLine, m.startCol, m.endLine, m.endCol),
      options: {
        className: cls,
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      }
    };
  });
  rangeMemoDecoIds = monacoEditor.deltaDecorations(rangeMemoDecoIds, decos);
  renderRangeMemoOverlay();
  if (_memoListOpen) renderMemoList();
}

function renderRangeMemoOverlay() {
  document.getElementById('range-memo-overlay')?.remove();
  if (!monacoEditor || !showLineMemoInline) return;
  const file = tabs[activeTabIdx]?.file;
  if (!file) return;
  const memos = getRangeMemos().filter(m => _samePath(m.file, file));
  if (!memos.length) return;

  const container = id('monaco-container');
  const overlay = document.createElement('div');
  overlay.id = 'range-memo-overlay';
  overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden;z-index:var(--z-overlay)';
  container.style.position = 'relative';
  container.appendChild(overlay);

  const lineH = monacoEditor.getOption(monaco.editor.EditorOption.lineHeight);
  const fontSize = monacoEditor.getOption(monaco.editor.EditorOption.fontSize);
  const layoutInfo = monacoEditor.getLayoutInfo();
  const contentLeft = layoutInfo.contentLeft;

  function positionItems() {
    overlay.innerHTML = '';
    const scrollTop = monacoEditor.getScrollTop();
    memos.forEach(m => {
      const top = monacoEditor.getTopForLineNumber(m.endLine) - scrollTop;
      if (top < -lineH || top > container.offsetHeight) return;
      const model = monacoEditor.getModel();
      const endCol = model ? model.getLineMaxColumn(m.endLine) : 1;
      const pos = monacoEditor.getScrolledVisiblePosition({ lineNumber: m.endLine, column: endCol });
      const left = pos ? pos.left : contentLeft + 200;
      const el = document.createElement('div');
      el.className = 'line-memo-overlay-item range-memo-overlay-item';
      el.style.cssText = `position:absolute;top:${top}px;left:${left + 8}px;height:${lineH}px;line-height:${lineH}px;font-size:${fontSize}px`;
      el.textContent = '✎ ' + m.memo.split('\n').join(' ↵ ');
      overlay.appendChild(el);
    });
  }

  positionItems();
  _rangeMemoScrollDispose?.dispose();
  _rangeMemoScrollDispose = monacoEditor.onDidScrollChange(positionItems);
}

function showRangeMemoInput(file, startLine, startCol, endLine, endCol) {
  document.getElementById('range-memo-popup')?.remove();
  const arr = getRangeMemos();
  const existing = arr.find(m => m.file === file && m.startLine === startLine && m.startCol === startCol && m.endLine === endLine && m.endCol === endCol);
  const current = existing?.memo || '';
  const currentCat = existing?.category || '';

  const popup = document.createElement('div');
  popup.id = 'range-memo-popup';
  popup.style.cssText = 'position:fixed;z-index:var(--z-autocomplete);background:#2d2d2d;border:1px solid #555;border-radius:4px;padding:8px;box-shadow:0 4px 12px rgba(0,0,0,0.6);width:300px';
  const edRect = id('monaco-container').getBoundingClientRect();
  const lineH = monacoEditor.getOption(monaco.editor.EditorOption.lineHeight);
  const topPx = Math.min(edRect.top + (endLine - 1) * lineH - monacoEditor.getScrollTop() + lineH, window.innerHeight - 140);
  popup.style.left = (edRect.left + 64) + 'px';
  popup.style.top  = Math.max(topPx, edRect.top) + 'px';
  popup.innerHTML  = `<div style="color:#aaa;font-size:11px;margin-bottom:4px">L${startLine}–${endLine} の範囲メモ</div>`;

  const ta = document.createElement('textarea');
  ta.value = current;
  ta.style.cssText = 'width:100%;height:64px;background:#1a1a1a;border:1px solid #444;color:#ccc;font:11px Consolas,monospace;padding:4px;resize:vertical;box-sizing:border-box;border-radius:2px';
  ta.placeholder = 'Ctrl+Enter で保存 / Esc でキャンセル';

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:4px;margin-top:6px;justify-content:flex-end;align-items:center';
  const mkBtn = (label, bg) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `font-size:11px;padding:2px 8px;background:${bg};color:#ccc;border:1px solid #555;border-radius:2px;cursor:pointer`;
    return b;
  };
  const catSel   = _mkCategorySelect(currentCat);
  const btnSave   = mkBtn('保存', '#0e639c');
  const btnDel    = mkBtn('削除', '#3c3c3c');
  const btnCancel = mkBtn('キャンセル', '#3c3c3c');
  btnDel.style.display = existing ? '' : 'none';
  btnRow.append(catSel, btnDel, btnCancel, btnSave);
  popup.append(ta, btnRow);
  document.body.appendChild(popup);
  ta.focus(); ta.select();

  const save = () => {
    const memo = ta.value.trim();
    const arr2 = getRangeMemos().filter(m => !(m.file === file && m.startLine === startLine && m.startCol === startCol && m.endLine === endLine && m.endCol === endCol));
    if (memo) {
      arr2.push({
        id: existing?.id || Math.random().toString(36).slice(2),
        file, startLine, startCol, endLine, endCol, memo,
        category: catSel.value,
        source: existing?.source || 'user',
      });
    }
    saveRangeMemos(arr2);
    popup.remove();
    refreshRangeMemoDecorations();
  };
  const cancel = () => popup.remove();
  btnSave.onclick = save;
  btnCancel.onclick = cancel;
  btnDel.onclick = () => {
    const arr2 = getRangeMemos().filter(m => m.id !== existing?.id);
    saveRangeMemos(arr2);
    popup.remove();
    refreshRangeMemoDecorations();
  };
  ta.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
  });
  setTimeout(() => document.addEventListener('mousedown', e => {
    if (!popup.contains(e.target)) cancel();
  }, { once: true }), 0);
}

// ===== グラフ登録済み行のデコレーション =====
// extractFuncName は label から「同期対象の関数名」を抽出する。
// パターン:
//   "foo"                  → "foo"   (単純識別子そのまま)
//   "foo:42"               → "foo"   (末尾 ":<行番号>" は label として無視)
//   "foo(args)"            → "foo"   (最外側の呼び出し)
//   "if (foo(x))"          → "foo"   (制御構文の予約語はスキップ)
//   "a = b(c())"           → "b"     (左から最初の関数呼び出し)
//   "obj->method()"        → "method"
// 後で label を式に編集しても _def が保持されるため、誤爆しても挙動はリカバリ可能。
const _SKIP_KEYWORDS = new Set([
  'if','while','for','switch','return','sizeof','typeof','do','else','goto','case','defined',
]);
function extractFuncName(label) {
  if (!label) return null;
  // 末尾の `:<digits>` は行番号扱いで関数名抽出の対象から外す
  const trimmed = label.replace(/:\d+\s*$/, '');
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m;
  while ((m = re.exec(trimmed)) !== null) {
    if (!_SKIP_KEYWORDS.has(m[1])) return m[1];
  }
  // 括弧なしの単純識別子も受け入れる（シンボルだけ追加したケース / `foo:42` 剥がし後）
  const single = trimmed.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
  return single ? single[1] : null;
}

// ノードの定義位置を解決して node._def にキャッシュする。
// 解決済み (object) / 解決失敗 (null) / 未解決 (undefined) を区別。
//
// 優先順位:
//   1. node.def_override (user 手動指定)
//   2. node.def          (server に永続化された前回の auto 結果)
//   3. /api/definition   (resolve 後、server に PUT して 2 に昇格)
//
// 誤爆ガード:
//   A. word < 4 文字: "len" / "tmp" / "buf" 等の汎用名は誤ヒットしやすい
//   B. hit > 5 件: 多義シンボルは安全側で sync しない
const _SYNC_MIN_WORD_LEN = 4;
const _SYNC_MAX_HITS     = 5;
// 逆方向 sync (実態 pin → 呼び出し箇所強調) の表示中ファイル内ヒット上限。
// これを超える関数は printf 級の汎用名とみなして安全側でスキップ。
const _REVERSE_SYNC_MAX_HITS = 30;
const _RESOLVE_CONCURRENCY = 3;
const _resolveQueue = [];
let   _resolveInFlight = 0;
// refreshGraphDecorations は完了ごとに cascade して unresolved を再 forEach するため、
// dedupe しないと queue に同じ node が O(N^2) 件積まれる。
const _resolveInflight = new Map();

async function resolveNodeDef(node) {
  if (node._def !== undefined) return;
  if (node.def_override?.file && node.def_override?.line) {
    node._def = { file: node.def_override.file, line: node.def_override.line };
    return;
  }
  if (node.def?.file && node.def?.line) {
    node._def = { file: node.def.file, line: node.def.line };
    return;
  }
  // 旧版は memo 必須だったが、「先に pin、後で memo」flow や memo 無しの pin
  // だけ使うケースで sync が動かず混乱した。label さえあれば常に解決し、
  // memo の有無は表示側 (hover) で出し分ける。
  if (!node.label) return;
  if (_resolveInflight.has(node.id)) {
    return _resolveInflight.get(node.id);
  }
  const word = extractFuncName(node.label);
  if (!word) { node._def = null; return; }
  if (word.length < _SYNC_MIN_WORD_LEN) { node._def = null; return; }
  const p = new Promise(resolve => {
    _resolveQueue.push(() => _doResolveNodeDef(node, word).finally(resolve));
    _drainResolveQueue();
  }).finally(() => _resolveInflight.delete(node.id));
  _resolveInflight.set(node.id, p);
  return p;
}

function _drainResolveQueue() {
  while (_resolveInFlight < _RESOLVE_CONCURRENCY && _resolveQueue.length > 0) {
    const task = _resolveQueue.shift();
    _resolveInFlight++;
    task().finally(() => {
      _resolveInFlight--;
      _drainResolveQueue();
    });
  }
}

async function _doResolveNodeDef(node, word) {
  try {
    const p = new URLSearchParams({word});
    if (node.match?.file) p.set('file', node.match.file);
    const r = await fetch('/api/definition?' + p);
    if (!r.ok) { node._def = null; return; }
    const hits = await r.json();
    if (!hits.length) { node._def = null; return; }
    if (hits.length > _SYNC_MAX_HITS) { node._def = null; return; }
    // 最初のヒット = 実装ファイル優先（preferDefinitionHits 済）
    const def = { file: hits[0].file, line: hits[0].line };
    node._def = def;
    node.def = def;
    // PUT 失敗は無視: 次回 reload で resolve し直すだけ。
    try {
      await fetch('/api/graph/node/' + encodeURIComponent(node.id), {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({def}),
      });
    } catch (_) {}
  } catch (_) {
    node._def = null;
  }
}

// _samePath はファイルパスを正規化して比較する。
// 入力ソース別の差異 (スラッシュ方向、大小文字、末尾スラッシュ) を吸収:
//   - エクスプローラ:        "C:\path\to\file.c"
//   - /api/definition:       "C:\path\to\file.c" or with mixed slashes
//   - 検索結果:              "C:\path\to\file.c"
// Windows 想定で大小文字無視、スラッシュ正規化。
function _samePath(a, b) {
  if (!a || !b) return false;
  return a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();
}

// _isDefAnchored は「関数の実態そのものを pin したノード」かを判定する。
// match (pin した位置) と _def (resolve した実態) が同一行なら、call site ではなく
// 定義行を pin している。このノードだけが逆方向 sync (呼び出し箇所の強調) の対象。
function _isDefAnchored(n) {
  return !!(n?._def?.file && _samePath(n.match?.file, n._def.file) && n.match?.line === n._def.line);
}

// _revealLineSmart は openPeek で行ジャンプ時に「意図の強さに応じた reveal」を行う:
//   - line > 1 (検索結果 / マーク / 定義ジャンプ)        → 常に中央表示
//   - line = 1 (エクスプローラからの browse, デフォルト) → 既に見えていれば no-op
// browse 時にカーソル行を中央へ強制移動して先頭が下がる症状を防ぐ。
function _revealLineSmart(line) {
  if (line > 1) monacoEditor.revealLineInCenter(line);
  else          monacoEditor.revealLineInCenterIfOutsideViewport(line);
}

// 逆方向 sync で装飾した行 → 代表ノード。glyph クリックで実態へ飛ぶ用。
// refreshGraphDecorations のたびに表示中ファイル分だけを作り直す。
const _reverseSyncLines = new Map();

function refreshGraphDecorations() {
  if(!monacoEditor) return;
  const file = tabs[activeTabIdx]?.file;
  if(!file) {
    _reverseSyncLines.clear();
    graphDecoIds = monacoEditor.deltaDecorations(graphDecoIds, []);
    return;
  }
  const decos = [];

  // 1. call site decoration (既存): node.match の位置
  Object.values(graph.nodes)
    .filter(n => _samePath(n.match?.file, file) && n.match?.line)
    .forEach(n => decos.push({
      range: new monaco.Range(n.match.line, 1, n.match.line, 1),
      options: {
        isWholeLine: true,
        className: 'graph-node-line',
        glyphMarginClassName: 'graph-node-glyph',
        glyphMarginHoverMessage: {value: `**グラフ登録済み** ${n.label || ''}${n.memo ? '\n\n' + n.memo : ''}`},
      }
    }));

  // 2. def site decoration (新規): memo 付きノードの「関数実態」の位置に
  //    同じ memo を表示する。「呼び出し ↔ 実態」を視覚的にリンク。
  //    実態と call site が同じ行になる場合は重複を避ける。
  //    同じ def 行に複数ノードが sync する場合は 1 つの decoration にまとめる
  //    (Monaco は同一行に複数 decoration の hover を 1 件しか出さないことがあるため)。
  const defLineGroups = new Map(); // key: line → [{node, callFile}, ...]
  Object.values(graph.nodes)
    .filter(n => _samePath(n._def?.file, file) && n._def?.line
              && !(_samePath(n.match?.file, file) && n.match?.line === n._def.line))
    .forEach(n => {
      const callFile = (n.match?.file || '').replace(/\\/g, '/').split('/').pop();
      const arr = defLineGroups.get(n._def.line) || [];
      arr.push({ node: n, callFile });
      defLineGroups.set(n._def.line, arr);
    });
  defLineGroups.forEach((entries, line) => {
    const header = entries.length > 1
      ? `**ツリーノード (${entries.length}件)** _クリックで sync 元 (先頭) へ_`
      : `**ツリーノード "${entries[0].node.label || ''}"** _クリックで sync 元へ_`;
    const body = entries.map(({node, callFile}) => {
      const labelLine = entries.length > 1 ? `**"${node.label || ''}"** ` : '';
      const memoSection = node.memo && node.memo.trim() ? `\n\n${node.memo}` : '';
      return `${labelLine}呼び出し: ${callFile}:${node.match?.line}${memoSection}`;
    }).join('\n\n---\n\n');
    decos.push({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: 'graph-node-def-line',
        glyphMarginClassName: 'graph-node-def-glyph',
        glyphMarginHoverMessage: {value: `${header}\n\n${body}`},
      }
    });
  });

  // 3. call site decoration 逆方向 (新規): 「実態」を pin したノードは、表示中
  //    ファイル内のその関数の呼び出し行を強調する。「実態 → 呼び出し」のリンク。
  //    repo 全体の call site 列挙は 1:N で重くノイズも多いため、表示中ファイル内に
  //    限定して Monaco の findMatches で逆引きする (サーバー往復なし・索引不要)。
  _reverseSyncLines.clear();
  const model = monacoEditor.getModel();
  if (model) {
    // 実態行や pin 済み call site は type 1/2 の装飾を優先して二重装飾を避ける
    const occupied = new Set(decos.map(d => d.range.startLineNumber));
    const callLineGroups = new Map(); // key: line → [node, ...]
    Object.values(graph.nodes).filter(_isDefAnchored).forEach(n => {
      const word = extractFuncName(n.label);
      if (!word || word.length < _SYNC_MIN_WORD_LEN) return;
      const found = model.findMatches(
        '\\b' + word + '\\s*\\(', false, true, true, null, false, _REVERSE_SYNC_MAX_HITS + 1);
      if (found.length === 0 || found.length > _REVERSE_SYNC_MAX_HITS) return;
      found.forEach(fm => {
        const line = fm.range.startLineNumber;
        if (occupied.has(line)) return;
        const arr = callLineGroups.get(line) || [];
        if (!arr.includes(n)) arr.push(n);
        callLineGroups.set(line, arr);
      });
    });
    callLineGroups.forEach((nodes, line) => {
      _reverseSyncLines.set(line, nodes[0]);
      const body = nodes.map(n => {
        const defFile = (n.match?.file || '').replace(/\\/g, '/').split('/').pop();
        const memoSection = n.memo && n.memo.trim() ? `\n\n${n.memo}` : '';
        return `**"${n.label || ''}"** 実態: ${defFile}:${n.match?.line}${memoSection}`;
      }).join('\n\n---\n\n');
      decos.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: 'graph-node-call-line',
          glyphMarginClassName: 'graph-node-call-glyph',
          glyphMarginHoverMessage: {value: `**呼び出し箇所** _クリックで実態へ_\n\n${body}`},
        }
      });
    });
  }

  graphDecoIds = monacoEditor.deltaDecorations(graphDecoIds, decos);

  // 未解決ノードを非同期で resolve → 解決後、該当ファイルが
  // 今見えていれば再 refresh で def site decoration を反映。
  // memo 有無問わず resolve する (memo 後付け flow / pin だけの利用にも対応)。
  // 実態 pin ノードは呼び出し箇所がどのファイルにあるか分からないため常に再 refresh。
  Object.values(graph.nodes)
    .filter(n => n._def === undefined)
    .forEach(n => resolveNodeDef(n).then(() => {
      if (_samePath(n._def?.file, tabs[activeTabIdx]?.file) || _isDefAnchored(n)) _scheduleGraphDecoRefresh();
    }));
}

// resolve 完了が連続する間は refreshGraphDecorations を 50ms 単位で纏める。
let _refreshGraphDecoScheduled = false;
function _scheduleGraphDecoRefresh() {
  if (_refreshGraphDecoScheduled) return;
  _refreshGraphDecoScheduled = true;
  setTimeout(() => { _refreshGraphDecoScheduled = false; refreshGraphDecorations(); }, 50);
}

// ===== メモ一覧パネル → memo-list.js =====

// ===== Monaco ロード =====
let _monacoLoadPromise = null;
function loadMonaco() {
  if(monacoReady) return Promise.resolve();
  if(!_monacoLoadPromise) {
    _monacoLoadPromise = new Promise(resolve => {
      require(['vs/editor/editor.main'], () => {
        monacoReady = true;
        resolve();
      });
    });
  }
  return _monacoLoadPromise;
}

let _editorInitPromise = null;
async function ensureEditor() {
  await loadMonaco();
  if(monacoEditor) return;
  if(_editorInitPromise) { await _editorInitPromise; return; }
  let _resolve;
  _editorInitPromise = new Promise(r => { _resolve = r; });
  monaco.editor.defineTheme('grepnavi-dark', {
    base: 'vs-dark', inherit: true, rules: [],
    colors: {
      'editor.wordHighlightBackground':       '#f0c04055',
      'editor.wordHighlightBorder':           '#f0c040',
      'editor.wordHighlightStrongBackground': '#ff606055',
      'editor.wordHighlightStrongBorder':     '#ff6060',
      'editor.wordHighlightTextBackground':   '#f0c04055',
      'editor.wordHighlightTextBorder':       '#f0c040',
    }
  });
  monacoEditor = monaco.editor.create(id('monaco-container'), {
    value: '',
    language: 'plaintext',
    theme: 'grepnavi-dark',
    readOnly: true,
    minimap: {enabled: true, scale: 1, showSlider: 'mouseover'},
    scrollBeyondLastLine: false,
    fontSize: parseInt(localStorage.getItem('grepnavi-font-size')) || 12,
    lineNumbers: 'on',
    wordWrap: 'off',
    occurrencesHighlight: 'singleFile',
    selectionHighlight: true,
    renderLineHighlight: 'line',
    stickyScroll: {enabled: true, maxLineCount: 3},
    breadcrumbs: {enabled: true},
    glyphMargin: true,
    hover: { above: false },
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true },
  });
  new ResizeObserver(() => monacoEditor.layout()).observe(id('monaco-container'));
  // editor-state sync (MCP bridge 経由で AI が editor 状態を取れるようにする)
  if (typeof startEditorStateSync === 'function') startEditorStateSync();

  window.addEventListener('wheel', e => {
    if (!e.ctrlKey || !monacoEditor) return;
    const dom = monacoEditor.getDomNode();
    if (!dom) return;
    const r = dom.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    e.stopPropagation(); e.preventDefault();
    const cur = monacoEditor.getOption(monaco.editor.EditorOption.fontSize);
    const next = e.deltaY < 0 ? Math.min(cur + 1, 32) : Math.max(cur - 1, 8);
    monacoEditor.updateOptions({ fontSize: next });
    localStorage.setItem('grepnavi-font-size', next);
  }, { capture: true, passive: false });

  // ===== C/C++ 言語固有拡張 (editor-c.js) =====
  const { resolveLocalVar } = initEditorC(monacoEditor, monaco);

  monacoEditor.onDidChangeCursorPosition(() => updatePinnedCounts());

  // 編集時にプレビュータブを固定に昇格
  monacoEditor.onDidChangeModelContent(() => {
    if(activeTabIdx >= 0 && tabs[activeTabIdx]?.preview) {
      tabs[activeTabIdx].preview = false;
      renderTabs();
    }
  });
  initTabCtxMenu();

  // ホバー内リンクからファイルを開くコマンド
  monaco.editor.registerCommand('grepnavi.openFile', (_accessor, file, line) => {
    openPeek(file, Number(line));
  });

  // 右クリック → Jump Map に追加 (Alt+J)
  monacoEditor.addAction({
    id: 'grepnavi.addToJumpMap',
    label: 'Add to Jump Map',
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 1.5,
    keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyJ],
    run(ed) {
      const file = tabs[activeTabIdx]?.file;
      if(!file) return;
      const line = ed.getPosition()?.lineNumber ?? 1;
      const sel = ed.getSelection();
      const selectedText = sel && !sel.isEmpty() ? ed.getModel()?.getValueInRange(sel)?.trim() : null;
      const word = selectedText || ed.getModel()?.getWordAtPosition(ed.getPosition())?.word || `L${line}`;
      if(typeof window.addToJumpMap === 'function') window.addToJumpMap(word, file, line);
    }
  });

  // ブックマークトグル (Alt+B)
  monacoEditor.addAction({
    id: 'grepnavi.toggleBookmark',
    label: 'Toggle Bookmark',
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 1.4,
    keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyB],
    run(ed) {
      const file = tabs[activeTabIdx]?.file;
      if(!file) return;
      const line = ed.getPosition()?.lineNumber ?? 1;
      const bm = getBookmarks();
      const key = file + '::' + line;
      setBookmark(file, line, !(key in bm));
      refreshBookmarkDecorations();
    }
  });

  // Hover プロバイダー
  const HOVER_LANGS = ['c','cpp','go','python','javascript','typescript','rust','java'];
  // スキップするキーワード（制御構文・基本型など）
  const HOVER_SKIP = new Set([
    'if','else','while','for','switch','case','do','return','break','continue','goto',
    'struct','union','enum','typedef','static','extern','const','volatile','inline',
    'void','int','char','short','long','float','double','unsigned','signed','size_t',
    'bool','true','false','NULL','nullptr','auto','register','sizeof','typeof',
  ]);
  // ホバー結果キャッシュ（同じ単語は再検索しない）
  const _hoverCache = new Map(); // "word:dir:glob" -> {result, time}
  const HOVER_CACHE_TTL = 60_000; // 1分
  let _lastHoverWord = '';
  let _lastHoverHit  = null; // { file, line }

  // ===== Floating Peek 初期化 =====
  const { showFloatingDef: _showFloatingDef, showFloatingCtx: _showFloatingCtx, showFloatingSelection: _showFloatingSelection, showWordCtxMenu: _showWordCtxMenu } = initFloatingPeek(
    () => ({ word: _lastHoverWord, hit: _lastHoverHit })
  );


  HOVER_LANGS.forEach(lang => {
    monaco.languages.registerHoverProvider(lang, {
      provideHover: async (model, position, token) => {
        let word = model.getWordAtPosition(position);
        _lastHoverWord = word?.word || '';
        // B: 3文字未満・キーワードはスキップ
        if(!word || word.word.length < 3) return null;
        if(HOVER_SKIP.has(word.word)) return null;

        // C: ローカル/static 変数・引数の処理 (editor-c.js)
        // false → 通常ルックアップ
        // null  → 抑制（引数など）
        // { decl, type } → 宣言を常に表示。type があれば型定義もルックアップ
        const _localInfo = resolveLocalVar(model, word.word, position);
        if (_localInfo !== false) {
          if (!_localInfo) return null;
          // ローカル/static 変数 → 宣言テキストをそのまま表示
          return {
            range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
            contents: [{ value: '```c\n' + _localInfo.decl + '\n```', isTrusted: true }]
          };
        }

        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        try {
          const currentFile = tabs[activeTabIdx]?.file || '';
          const glob = id('glob').value.trim();
          const contents = [];

          // 1. グラフノードのメモ（キャッシュ不要・ローカル処理）
          //   - call site (同行 or 同ファイルで text に word 含む) のノード
          //   - def site (resolveNodeDef で解決した実態行) に sync しているノード
          //   def site にいる場合は呼び出し元 (call site) の情報を追記してリンク感を出す。
          const memoNodes = Object.values(graph.nodes).filter(n => n.memo && (
            (_samePath(n.match?.file, currentFile) && n.match?.line === position.lineNumber) ||
            (_samePath(n.match?.file, currentFile) && (n.match?.text||'').includes(word.word)) ||
            (_samePath(n._def?.file, currentFile) && n._def?.line === position.lineNumber) ||
            // 逆方向: 実態 pin ノードの関数名と同じ word なら、どのファイルの
            // 呼び出し箇所で hover してもメモを出す
            (_isDefAnchored(n) && extractFuncName(n.label) === word.word)
          ));
          if(memoNodes.length) {
            memoNodes.forEach(n => {
              const isDefSite = _samePath(n._def?.file, currentFile) && n._def?.line === position.lineNumber
                             && !(_samePath(n.match?.file, currentFile) && n.match?.line === position.lineNumber);
              let suffix = '';
              if (isDefSite && n.match?.file) {
                const callFile = n.match.file.replace(/\\/g, '/').split('/').pop();
                suffix = `\n\n*呼び出し: ${callFile}:${n.match.line}*`;
              } else if (_isDefAnchored(n) && !_samePath(n.match?.file, currentFile)) {
                // 別ファイルの呼び出し箇所から hover している場合は実態への導線を出す
                const defFile = n.match.file.replace(/\\/g, '/').split('/').pop();
                suffix = `\n\n*実態: ${defFile}:${n.match.line}*`;
              }
              contents.push({value:
                `💬 **${n.label || shortPath(n.match?.file||'')+':'+(n.match?.line||'')}**\n\n${n.memo}${suffix}`
              });
            });
            contents.push({value: '---'});
          }

          // A: キャッシュチェック（メモ以外の検索結果）
          const cacheKey = `${word.word}:${glob}`;
          const cached = _hoverCache.get(cacheKey);
          if(cached && Date.now() - cached.time < HOVER_CACHE_TTL) {
            const allContents = [...contents, ...cached.contents];
            if(!allContents.length) {
              if(_declContent) return {
                range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
                contents: _declContent
              };
              return null;
            }
            return {
              range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
              contents: allContents.map(c => ({...c, isTrusted: true}))
            };
          }

          // 2. /api/hover — struct/union/enum/define のブロック本体
          const hp = new URLSearchParams({word: word.word});
          if(glob) hp.set('glob', glob);
          const hoverFile = tabs[activeTabIdx]?.file || '';
          if(hoverFile) hp.set('file', hoverFile);
          const hr = await fetch('/api/hover?' + hp, {signal: controller.signal});
          const hoverHits = await hr.json();
          const hoverEngine = hr.headers.get('X-Engine') || '';
          const apiContents = [];
          if(Array.isArray(hoverHits) && hoverHits.length) {
            const kindLabel = {define:'#define', struct:'struct', enum:'enum', union:'union', typedef:'typedef', func:'function', enum_member:'enum'};
            const defs  = hoverHits.filter(h => !h.decl).slice(0, 3);
            const decls = hoverHits.filter(h =>  h.decl);
            const hits  = defs.length ? defs : decls.slice(0, 3);
            const multi = hits.length > 1;
            // 宣言ファイル一覧（定義がある場合のみ先頭に付記）
            const declNote = defs.length && decls.length
              ? '*declared in: ' + decls.map(d => {
                  const a = encodeURIComponent(JSON.stringify([d.file, d.line]));
                  return `[${shortPath(d.file)}:${d.line}](command:grepnavi.openFile?${a})`;
                }).join(', ') + '*\n\n'
              : '';
            for(let i = 0; i < hits.length; i++) {
              const h = hits[i];
              const args = encodeURIComponent(JSON.stringify([h.file, h.line]));
              const fileLink = `[${shortPath(h.file)}:${h.line}](command:grepnavi.openFile?${args})`;
              const counter = multi ? ` — **${i+1} / ${hits.length}**` : '';
              const engLabel = (i === 0 && hoverEngine) ? ` \`[${hoverEngine}]\`` : '';
              const header = `**${kindLabel[h.kind]||h.kind} \`${word.word}\`${counter}**${engLabel} — *${fileLink}*`;
              const body = h.body.length > 2000 ? h.body.slice(0, 2000) + '\n// ...' : h.body;
              const prefix = i === 0 ? declNote : '';
              if(i === 0) _lastHoverHit = { file: h.file, line: h.line, body: h.body };
              apiContents.push({value: prefix + header + '\n```c\n' + body + '\n```', isTrusted: true});
            }
          }

          // A: 結果をキャッシュ（最大200件、古いものを削除）
          _hoverCache.set(cacheKey, {contents: apiContents, time: Date.now()});
          if(_hoverCache.size > 200) {
            const oldest = [..._hoverCache.entries()].sort((a,b) => a[1].time - b[1].time)[0];
            _hoverCache.delete(oldest[0]);
          }

          const allContents = [...contents, ...apiContents];
          if(!allContents.length) {
            if(_declContent) return {
              range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
              contents: _declContent
            };
            return null;
          }
          return {
            range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
            contents: allContents.map(c => ({...c, isTrusted: true}))
          };
        } catch { return null; }
      }
    });
  });

  // シンボルプロバイダー
  ['c','cpp','go','python','javascript','typescript','rust','java'].forEach(lang => {
    monaco.languages.registerDocumentSymbolProvider(lang, {
      provideDocumentSymbols: async (model) => {
        const file = model.uri.scheme === 'grepnavi'
          ? model.uri.path.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g,'\\')
          : null;
        if (!file) return [];
        try {
          const r = await fetch('/api/symbols?' + new URLSearchParams({file}));
          const d = await r.json();
          if (!Array.isArray(d)) return [];
          return d.map(s => ({
            name: s.name, detail: s.detail,
            kind: monaco.languages.SymbolKind.Function,
            range: new monaco.Range(s.start_line, 1, s.end_line, 1),
            selectionRange: new monaco.Range(s.start_line, 1, s.start_line, 1),
          }));
        } catch { return []; }
      }
    });
  });

  // Ctrl+クリック → 定義ジャンプ
  monacoEditor.onMouseDown(e => {
    const pos = e.target.position;
    if(!pos) return;

    // glyph margin の sync 装飾 (def site) クリックで sync 元 (call site) にジャンプ。
    // Ctrl+Click (定義へ) の逆方向。複数 source ある場合は最初の 1 件採用。
    if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
      const currentFile = tabs[activeTabIdx]?.file;
      if (currentFile) {
        const syncSources = Object.values(graph.nodes).filter(n =>
          _samePath(n._def?.file, currentFile) && n._def?.line === pos.lineNumber
          && !(_samePath(n.match?.file, currentFile) && n.match?.line === pos.lineNumber)
        );
        if (syncSources.length > 0) {
          e.event.preventDefault();
          const n = syncSources[0];
          openPeek(n.match.file, n.match.line);
          return;
        }
      }
      // 逆方向 sync 装飾 (呼び出し箇所) クリックで実態へジャンプ
      const rn = _reverseSyncLines.get(pos.lineNumber);
      if (rn?.match?.file) {
        e.event.preventDefault();
        openPeek(rn.match.file, rn.match.line);
        return;
      }
    }

    const word = monacoEditor.getModel()?.getWordAtPosition(pos);
    if(!word) return;
    if(e.event.ctrlKey) { e.event.preventDefault(); jumpToDefinition(word.word); }
    else if(e.event.altKey) { e.event.preventDefault(); grepSearchWord(word.word); }
  });

  // F12 → 定義ジャンプ
  monacoEditor.addAction({
    id: 'grepnavi-goto-def', label: '定義へジャンプ',
    keybindings: [monaco.KeyCode.F12],
    run: ed => {
      const word = ed.getModel()?.getWordAtPosition(ed.getPosition());
      if(word) jumpToDefinition(word.word);
    }
  });

  // Alt+N → メモを追加/編集（選択中なら範囲メモ、未選択なら行メモ）
  monacoEditor.addAction({
    id: 'grepnavi-line-memo', label: 'メモを追加/編集 (Alt+N)',
    keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyN],
    contextMenuGroupId: 'grepnavi-mark',
    contextMenuOrder: 2,
    run: ed => {
      const file = tabs[activeTabIdx]?.file;
      if (!file) return;
      const sel = ed.getSelection();
      if (sel && !sel.isEmpty()) {
        showRangeMemoInput(file, sel.startLineNumber, sel.startColumn, sel.endLineNumber, sel.endColumn);
        return;
      }
      const pos = ed.getPosition();
      const line = pos?.lineNumber, col = pos?.column;
      // カーソルが既存の範囲メモ内にいれば範囲メモを開く
      const hit = getRangeMemos().find(m =>
        m.file === file &&
        (line > m.startLine || (line === m.startLine && col >= m.startCol)) &&
        (line < m.endLine   || (line === m.endLine   && col <= m.endCol))
      );
      if (hit) {
        showRangeMemoInput(file, hit.startLine, hit.startCol, hit.endLine, hit.endCol);
      } else {
        if (line) showLineMemoInput(file, line);
      }
    }
  });

  monacoEditor.addAction({
    id: 'grepnavi-open-external', label: '外部エディタで開く',
    contextMenuGroupId: 'grepnavi-nav',
    contextMenuOrder: 0,
    keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyE],
    run: ed => {
      const tab = tabs[activeTabIdx];
      if(!tab) return;
      openFile(tab.file, ed.getPosition()?.lineNumber ?? tab.line);
    }
  });

  // 右クリック → grep 検索（カーソル単語）
  monacoEditor.addAction({
    id: 'grepnavi-grep-word', label: 'grep 検索',
    contextMenuGroupId: 'grepnavi-nav',
    contextMenuOrder: 1,
    run: ed => {
      const sel = ed.getSelection();
      const model = ed.getModel();
      if(!model) return;
      const selText = sel && !sel.isEmpty() ? model.getValueInRange(sel).trim() : '';
      const word = selText || model.getWordAtPosition(ed.getPosition())?.word;
      if(word) grepSearchWord(word);
    }
  });

  // 右クリック → 定義へジャンプ
  monacoEditor.addAction({
    id: 'grepnavi-goto-def-menu', label: '定義へジャンプ',
    contextMenuGroupId: 'grepnavi-nav',
    contextMenuOrder: 2,
    run: ed => {
      const word = ed.getModel()?.getWordAtPosition(ed.getPosition())?.word;
      if(word) jumpToDefinition(word);
    }
  });

  // 右クリック → コールツリーで検索
  monacoEditor.addAction({
    id: 'grepnavi-calltree', label: 'コールツリーで検索',
    contextMenuGroupId: 'grepnavi-nav',
    contextMenuOrder: 3,
    run: ed => {
      const sel = ed.getSelection();
      const model = ed.getModel();
      if(!model) return;
      const word = (sel && !sel.isEmpty() ? model.getValueInRange(sel).trim() : null)
                   || model.getWordAtPosition(ed.getPosition())?.word;
      if(word && typeof window.openCallTree === 'function') window.openCallTree(word);
    }
  });

  // 右クリック → Floating Peek
  monacoEditor.addAction({
    id: 'grepnavi-float-def', label: 'Floating Peek',
    keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
    contextMenuGroupId: 'grepnavi-nav',
    contextMenuOrder: 4,
    run: ed => {
      const sel = ed.getSelection();
      const model = ed.getModel();
      if(!model) return;
      const curFile = tabs[activeTabIdx]?.file;
      // 複数行選択、または記号/スペースを含む選択なら選択範囲を固定表示
      if(sel && !sel.isEmpty()) {
        const text = model.getValueInRange(sel);
        const isMultiLine = sel.endLineNumber > sel.startLineNumber;
        const isMultiWord = /[\s\(\)\[\]\|&,;]/.test(text.trim());
        if(isMultiLine || isMultiWord) {
          if(curFile) _showFloatingSelection(curFile, sel.startLineNumber, sel.endLineNumber, text);
          return;
        }
      }
      const word = (sel && !sel.isEmpty() ? model.getValueInRange(sel).trim() : null)
                   || model.getWordAtPosition(ed.getPosition())?.word;
      if(word) {
        _showFloatingDef(word);
      } else {
        const curLine = ed.getPosition()?.lineNumber;
        if(curFile && curLine) _showFloatingCtx(curFile, curLine);
      }
    }
  });

  // Alt+H / 右クリック → 単語ハイライト固定/解除
  monacoEditor.addAction({
    id: 'grepnavi-pin-highlight', label: '単語ハイライトを固定/解除 (Alt+H)',
    keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyH],
    contextMenuGroupId: 'grepnavi-mark',
    contextMenuOrder: 1,
    run: ed => {
      const model = ed.getModel();
      const pos = ed.getPosition();
      if(!model || !pos) return;
      const sel = ed.getSelection();
      const selText = sel && !sel.isEmpty() ? model.getValueInRange(sel).trim() : '';
      const word = selText || model.getWordAtPosition(pos)?.word;
      if(word) togglePinnedHighlight(word, !selText);
    }
  });

  // Alt+G → 選択行をノードに追加
  monacoEditor.addAction({
    id: 'grepnavi-add-node', label: 'ノードに追加 (Alt+G)',
    keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyG],
    contextMenuGroupId: 'grepnavi-mark',
    contextMenuOrder: 2,
    run: ed => {
      const sel   = ed.getSelection();
      const model = ed.getModel();
      const file  = tabs[activeTabIdx]?.file;
      if(!sel || !model || !file) return;
      const line = sel.startLineNumber;
      const selectedText = model.getValueInRange(sel).split('\n')[0].trim();
      const text = selectedText || model.getLineContent(line).trim();
      const nodeId = (crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b=>b.toString(16).padStart(2,'0')).join(''));
      addToGraph({id: nodeId, file, line, text}, '', 'ref', text);
    }
  });

  monacoEditor.addAction({
    id: 'grepnavi-range-memo-delete', label: '選択範囲のメモを削除 (Delete)',
    keybindings: [monaco.KeyCode.Delete],
    contextMenuGroupId: 'grepnavi-mark',
    contextMenuOrder: 2.5,
    run: ed => {
      const sel = ed.getSelection();
      const file = tabs[activeTabIdx]?.file;
      if (!file || !sel) return;
      const sl = sel.startLineNumber, sc = sel.startColumn;
      const el = sel.endLineNumber,   ec = sel.endColumn;
      const arr = getRangeMemos();
      const target = arr.find(m => m.file === file && m.startLine === sl && m.startCol === sc && m.endLine === el && m.endCol === ec);
      if (target) {
        saveRangeMemos(arr.filter(m => m.id !== target.id));
        refreshRangeMemoDecorations();
        st('範囲メモを削除しました');
      } else {
        // 完全一致がなければカーソル行を含む範囲メモを削除
        const col = ed.getPosition()?.column ?? 1;
        const ln  = ed.getPosition()?.lineNumber ?? 1;
        const hit = arr.find(m => m.file === file &&
          (ln > m.startLine || (ln === m.startLine && col >= m.startCol)) &&
          (ln < m.endLine   || (ln === m.endLine   && col <= m.endCol)));
        if (hit) {
          saveRangeMemos(arr.filter(m => m.id !== hit.id));
          refreshRangeMemoDecorations();
          st('範囲メモを削除しました');
        } else {
          st('削除できる範囲メモがありません');
        }
      }
    }
  });

  monacoEditor.addAction({
    id: 'grepnavi-snapshot', label: 'コードスナップショットを開く',
    contextMenuGroupId: 'grepnavi-mark',
    contextMenuOrder: 3,
    run: ed => exportSelectionSnapshot(ed), // → editor-snapshot.js
  });


  // メモ専用プロバイダを最後に登録（Monaco は後着順で先頭表示）
  HOVER_LANGS.forEach(lang => {
    monaco.languages.registerHoverProvider(lang, {
      provideHover(_model, position) {
        const file = tabs[activeTabIdx]?.file;
        if (!file) return null;
        const line = position.lineNumber, col = position.column;
        const rangeParts = getRangeMemos().filter(m =>
          m.file === file &&
          (line > m.startLine || (line === m.startLine && col >= m.startCol)) &&
          (line < m.endLine   || (line === m.endLine   && col <= m.endCol))
        ).map(m => ({ value: '✎ ' + m.memo.split('\n').join('  \n') }));
        if (rangeParts.length) return { contents: rangeParts };
        const lm = getLineMemos()[file + '::' + line];
        if (lm) return { contents: [{ value: '✎ ' + lm.split('\n').join('  \n') }] };
        return null;
      }
    });
  });

  loadPinnedHighlights();
  _resolve();
}

// ページロード時に Monaco をバックグラウンドでプリロード（初回クリック遅延を防ぐ）
if(typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => { loadMonaco(); });

// ===== Ctrl+P ファイルクイックオープン =====
async function openFzf() {
  if(!fzfFiles) {
    try {
      const r = await fetch('/api/files');
      fzfFiles = await r.json();
    } catch { fzfFiles = []; }
  }
  id('fzf-overlay').classList.add('open');
  id('fzf-input').value = '';
  fzfRender('');
  setTimeout(() => id('fzf-input').focus(), 30);
}

function closeFzf() {
  id('fzf-overlay').classList.remove('open');
}

function fzfMatchToken(path, token) {
  const p = path.toLowerCase(), q = token.toLowerCase();
  const matched = new Set();
  let pi = 0, qi = 0, score = 0, consecutive = 0;
  while(pi < p.length && qi < q.length) {
    if(p[pi] === q[qi]) { matched.add(pi); qi++; score += 1 + consecutive; consecutive++; }
    else { consecutive = 0; }
    pi++;
  }
  return qi === q.length ? {score, matched} : null;
}

function fzfScore(path, query) {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if(!tokens.length) return 0;
  let total = 0;
  for(const t of tokens) {
    const r = fzfMatchToken(path, t);
    if(!r) return -1;
    total += r.score;
  }
  return total;
}

function fzfHighlight(path, query) {
  if(!query) return esc(path);
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const matched = new Set();
  for(const t of tokens) {
    const r = fzfMatchToken(path, t);
    if(r) r.matched.forEach(i => matched.add(i));
  }
  return [...path].map((c, i) =>
    matched.has(i) ? `<span class="fzf-hl">${esc(c)}</span>` : esc(c)
  ).join('');
}

function fzfFilter(files, query, limit) {
  if(!query.trim()) return files.slice(0, limit);
  return files
    .map(f => ({f, s: fzfScore(f, query)}))
    .filter(x => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(x => x.f);
}

function fzfRender(query) {
  const list = id('fzf-list');
  fzfFiltered = fzfFilter(fzfFiles, query, 100);
  id('fzf-count').textContent = `${fzfFiltered.length} / ${fzfFiles.length}`;
  fzfSelIdx = 0;
  list.innerHTML = '';
  fzfFiltered.forEach((f, i) => {
    const parts = f.replace(/\\/g, '/').split('/');
    const name = parts.pop();
    const dir  = parts.join('/');
    const div = document.createElement('div');
    div.className = 'fzf-item' + (i === 0 ? ' fzf-sel' : '');
    div.innerHTML = `<span class="fzf-name">${fzfHighlight(name, query)}</span>`
                  + (dir ? `<span class="fzf-dir">${fzfHighlight(dir+'/', query)}</span>` : '');
    div.onclick = () => fzfOpen(f);
    list.appendChild(div);
  });
}

function fzfMoveSel(delta) {
  const items = id('fzf-list').querySelectorAll('.fzf-item');
  if(!items.length) return;
  items[fzfSelIdx]?.classList.remove('fzf-sel');
  fzfSelIdx = Math.max(0, Math.min(items.length - 1, fzfSelIdx + delta));
  items[fzfSelIdx]?.classList.add('fzf-sel');
  items[fzfSelIdx]?.scrollIntoView({block:'nearest'});
}

async function fzfOpen(relPath) {
  closeFzf();
  const r = await fetch('/api/root');
  const d = await r.json();
  const abs = (d.root || '').replace(/\\/g,'/').replace(/\/$/, '') + '/' + relPath;
  await openPeek(abs, 1);
}

// ===== ナビゲーション履歴 =====
function navPush(file, line) {
  if(navSkipPush) return;
  const last = navHistory[navIndex];
  if(last && _samePath(last.file, file) && last.line === line) return;
  navHistory.splice(navIndex + 1);
  navHistory.push({file, line});
  if(navHistory.length > 100) { navHistory.shift(); }
  navIndex = navHistory.length - 1;
  updateNavButtons();
}

async function navBack() {
  if(navIndex <= 0) return;
  navIndex--;
  const h = navHistory[navIndex];
  navSkipPush = true;
  await openPeek(h.file, h.line);
  navSkipPush = false;
  updateNavButtons();
}

async function navForward() {
  if(navIndex >= navHistory.length - 1) return;
  navIndex++;
  const h = navHistory[navIndex];
  navSkipPush = true;
  await openPeek(h.file, h.line);
  navSkipPush = false;
  updateNavButtons();
}

function updateNavButtons() {
  const b = id('btn-nav-back'), f = id('btn-nav-fwd');
  if(b) b.disabled = navIndex <= 0;
  if(f) f.disabled = navIndex >= navHistory.length - 1;
}

// ===== タブ / Peek パネル =====
// プレビュータブを固定（permanent）に昇格する
function promotePreviewTab() {
  const idx = tabs.findIndex(t => t.preview);
  if(idx >= 0) { tabs[idx].preview = false; renderTabs(); }
}

async function openPeek(file, line, {permanent = false} = {}) {
  if(!file) return;
  if(typeof updateTitle === 'function') updateTitle(file);
  if(pageMode) {
    openFile(file, line);
    return;
  }
  navPush(file, line);
  await ensureEditor();
  const peekWasHidden = !id('peek').classList.contains('visible');
  id('peek').classList.add('visible');
  // display:none→flex の後、Monaco がサイズを認識するまで待つ
  if(peekWasHidden) await new Promise(r => setTimeout(r, 80));
  id('peek-placeholder')?.classList.add('hidden');
  id('peek-open').onclick = () => openFile(file, monacoEditor?.getPosition()?.lineNumber ?? line);

  // 同一ファイルが既に開いている場合はそこへ移動
  // _samePath で正規化比較しないと、エクスプローラ/定義ジャンプ/検索結果で
  // パス形式 (スラッシュ方向・大小文字) が違うときに同じファイルが重複タブで開く。
  const existIdx = tabs.findIndex(t => _samePath(t.file, file));
  if(existIdx >= 0) {
    const wasActive = activeTabIdx === existIdx;
    const matchLine = parseInt(line) || 1;
    const previewChanged = permanent && tabs[existIdx].preview;
    const lineChanged = !wasActive || monacoEditor.getPosition()?.lineNumber !== matchLine;
    if(permanent) tabs[existIdx].preview = false;
    tabs[existIdx].line = line;
    if(!wasActive) await switchTab(existIdx);
    // 同じ行を表示中のままなら decoration / scroll / layout を再実行しない
    // （エクスプローラのダブルクリックで click + click + dblclick が来た時に
    //  3 回スクロールが走って画面がブレるのを防ぐ）
    if(lineChanged) {
      // line=1 (エクスプローラからの browse) では「マッチした行」が存在しないので
      // 黄色ハイライトを出さない。古い decoration があれば消す。
      const decoSet = matchLine > 1 ? [{
        range: new monaco.Range(matchLine, 1, matchLine, 1),
        options: {isWholeLine: true, className: 'peek-match-decoration'}
      }] : [];
      tabs[existIdx].decoIds = monacoEditor.deltaDecorations(tabs[existIdx].decoIds || [], decoSet);
      monacoEditor.setPosition({lineNumber: matchLine, column: 1});
      _revealLineSmart(matchLine);
      await new Promise(r => setTimeout(r, 0));
      monacoEditor.layout();
    }
    // preview→permanent の昇格があったらタブの斜体表示を消す。
    // wasActive のとき switchTab をスキップする＝そのなかの renderTabs も呼ばれない
    // ため、ここで明示的に呼ぶ必要がある。
    if(previewChanged) renderTabs();
    return;
  }

  const r = await fetch('/api/file?' + new URLSearchParams({file}));
  if(!r.ok) {
    const msg = r.status === 415 ? 'バイナリファイルは表示できません'
              : r.status === 413 ? 'ファイルが大きすぎます (10MB超)'
              : `ファイルを開けません (${r.status})`;
    // エラータブを開く: 空のダミーモデル + tab.error フラグでオーバーレイ表示。
    // switchTab が error タブを検出して中央メッセージ + アクションを出す。
    const errUri = monaco.Uri.from({scheme:'grepnavi-err', path: file.replace(/\\/g,'/')});
    const errModel = monaco.editor.getModel(errUri) || monaco.editor.createModel('', 'plaintext', errUri);
    const errTab = {file, line: 1, label: file.replace(/\\/g,'/').split('/').pop(), model: errModel, decoIds: [], preview: !permanent, error: true, errorStatus: r.status, errorMsg: msg};
    const previewIdx2 = permanent ? -1 : tabs.findIndex(t => t.preview);
    if(previewIdx2 >= 0) {
      const oldModel = tabs[previewIdx2].model;
      tabs[previewIdx2] = errTab;
      await switchTab(previewIdx2);
      // 並行 openPeek で先に dispose 済みになっていることがあるため二重 dispose を避ける
      if(oldModel !== errModel && !oldModel?.isDisposed?.()) oldModel.dispose();
    } else {
      tabs.push(errTab);
      await switchTab(tabs.length - 1);
    }
    st(msg);
    // エラーファイルをキャッシュして次回グレーアウトに使う
    _unopenableFiles.add(file);
    return;
  }
  const text = await r.text();
  const mtimeRes = await fetch('/api/file/mtime?' + new URLSearchParams({file}));
  const mtime = mtimeRes.ok ? parseInt(await mtimeRes.text()) : 0;
  const lang = detectLang(file);
  const uri = monaco.Uri.from({scheme:'grepnavi', path: file.replace(/\\/g,'/')});
  const model = monaco.editor.getModel(uri) || monaco.editor.createModel(text, lang || 'plaintext', uri);
  const tab = {file, line, label: file.replace(/\\/g,'/').split('/').pop(), model, decoIds: [], preview: !permanent, mtime};

  // プレビュー開きの場合：既存プレビュータブをこのタブで置き換える
  const previewIdx = permanent ? -1 : tabs.findIndex(t => t.preview);
  if(previewIdx >= 0) {
    const oldModel = tabs[previewIdx].model;
    tabs[previewIdx] = tab;
    await switchTab(previewIdx);
    // switchTab で新モデルをセットした後に dispose する。
    // 並行 openPeek で先に dispose 済みになっていることがあるため二重 dispose を避ける
    if(oldModel !== tab.model && !oldModel?.isDisposed?.()) oldModel.dispose();
  } else {
    tabs.push(tab);
    await switchTab(tabs.length - 1);
  }

  const matchLine = parseInt(line) || 1;
  // line=1 (エクスプローラからの browse) では「マッチした行」が無いので
  // 黄色ハイライト (peek-match-decoration) を出さない。
  if (matchLine > 1) {
    tab.decoIds = monacoEditor.deltaDecorations([], [{
      range: new monaco.Range(matchLine, 1, matchLine, 1),
      options: {isWholeLine: true, className: 'peek-match-decoration'}
    }]);
  }
  monacoEditor.setPosition({lineNumber: matchLine, column: 1});
  _revealLineSmart(matchLine);
  // Monaco がレイアウトを確実に更新するまで待つ
  await new Promise(r => setTimeout(r, 0));
  monacoEditor.layout();
}

async function openPeekPermanent(file, line) {
  return openPeek(file, line, {permanent: true});
}

async function refreshSymbolDecorations() {
  if (!monacoEditor) return;
  const tab = tabs[activeTabIdx];
  if (!tab) return;
  const model = tab.model;
  try {
    const r = await fetch('/api/symbols?' + new URLSearchParams({ file: tab.file }));
    if (!r.ok) return;
    const symbols = await r.json();
    // fetch 中に別タブへ切替・preview 置換が起きたら以降は無意味なので早期 return:
    //   - モデルが dispose 済み: アクセスすると Monaco が例外を投げる
    //   - エディタに別モデルが乗っている: deltaDecorations しても画面に出ない
    // どちらの場合も再び switchTab されたときに refreshSymbolDecorations が呼び直されるので問題ない。
    if (model.isDisposed?.() || monacoEditor.getModel() !== model) return;
    const decos = [];
    for (const sym of symbols) {
      const line = sym.start_line;
      if (line < 1 || line > model.getLineCount()) continue;
      const text = model.getLineContent(line);
      const escaped = sym.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = new RegExp('\\b' + escaped + '\\b').exec(text);
      if (m) {
        const col = m.index + 1;
        decos.push({
          range: new monaco.Range(line, col, line, col + sym.name.length),
          options: { inlineClassName: 'symbol-fn-hl' }
        });
      }
    }
    tab.symbolDecoIds = monacoEditor.deltaDecorations(tab.symbolDecoIds || [], decos);
  } catch (_) {}
}

// ===== アクティブタブのファイル変更ポーリング =====

const FILE_POLL_INTERVAL = 2000; // ms

function startFilePolling() {
  stopFilePolling();
  if(document.hidden) return;
  _filePollTimer = setInterval(pollActiveFile, FILE_POLL_INTERVAL);
}

function stopFilePolling() {
  if(_filePollTimer !== null) { clearInterval(_filePollTimer); _filePollTimer = null; }
}

async function pollActiveFile() {
  const tab = tabs[activeTabIdx];
  if(!tab || tab.error) return;
  try {
    const res = await fetch('/api/file/mtime?' + new URLSearchParams({file: tab.file}));
    if(!res.ok) return;
    const mtime = parseInt(await res.text());
    if(mtime === tab.mtime) return;
    // ファイルが変更された → 内容を再取得
    const r = await fetch('/api/file?' + new URLSearchParams({file: tab.file}));
    if(!r.ok) return;
    const text = await r.text();
    tab.mtime = mtime;
    tab.model.setValue(text);
  } catch(_) {}
}

if(typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if(document.hidden) stopFilePolling(); else startFilePolling();
  });
}

// エラータブ用オーバーレイ。Monaco エディタの上に被せて中央に
// エラー内容 + 対処アクションを大きく表示する。
// status 別アクション: 415/413 は「外部エディタで開く」、それ以外は「再試行」も追加。
function _ensureFileErrorOverlay() {
  let overlay = document.getElementById('file-error-overlay');
  if (overlay) return overlay;
  const body = document.getElementById('peek-body');
  if (!body) return null;
  overlay = document.createElement('div');
  overlay.id = 'file-error-overlay';
  body.appendChild(overlay);
  return overlay;
}
function showFileErrorOverlay(tab) {
  const overlay = _ensureFileErrorOverlay();
  if (!overlay) return;
  const iconClass = tab.errorStatus === 415 ? 'codicon-file-binary'
                  : tab.errorStatus === 413 ? 'codicon-file-zip'
                  : 'codicon-warning';
  const buttons = [];
  if (tab.errorStatus !== 415 && tab.errorStatus !== 413) {
    buttons.push({label: '再試行', cmd: 'retry'});
  }
  buttons.push({label: '外部エディタで開く', cmd: 'external'});
  overlay.innerHTML =
    `<i class="codicon ${iconClass}"></i>` +
    `<div class="file-error-msg">${esc(tab.errorMsg || 'ファイルを開けません')}</div>` +
    `<div class="file-error-path" title="${esc(tab.file)}">${esc(tab.file)}</div>` +
    `<div class="file-error-actions">` +
      buttons.map(b => `<button data-cmd="${b.cmd}">${esc(b.label)}</button>`).join('') +
    `</div>`;
  overlay.classList.add('visible');
  overlay.querySelectorAll('button').forEach(btn => {
    btn.onclick = () => {
      if (btn.dataset.cmd === 'retry') {
        _unopenableFiles.delete(tab.file);
        openPeek(tab.file, tab.line, {permanent: true});
      } else if (btn.dataset.cmd === 'external') {
        openFile(tab.file, tab.line);
      }
    };
  });
}
function hideFileErrorOverlay() {
  document.getElementById('file-error-overlay')?.classList.remove('visible');
}

async function switchTab(idx) {
  if(idx < 0 || idx >= tabs.length) return;
  const tab = tabs[idx];
  // 並行 openPeek で当該タブのモデルがすでに dispose 済みだった場合の防御。
  // setModel すると Monaco 内部の isDominatedByLongLines 等が
  // _assertNotDisposed で投げる → コンソールに大量エラーが出る症状を回避。
  if(tab.model?.isDisposed?.()) {
    console.warn('switchTab: tab.model is disposed, skipping', tab.file);
    return;
  }
  if(activeTabIdx >= 0 && activeTabIdx < tabs.length)
    tabs[activeTabIdx].viewState = monacoEditor.saveViewState();
  activeTabIdx = idx;
  startFilePolling();
  monacoEditor.setModel(tab.model);
  if(tab.viewState) try { monacoEditor.restoreViewState(tab.viewState); } catch(_) {}
  id('peek-file').value = tab.file.replace(/\\/g, '/');
  // アドオン (インクルードグラフ等) が現在ファイルに追従できるよう通知
  document.dispatchEvent(new CustomEvent('grepnavi:active-file-changed', { detail: tab.file }));
  id('peek-open').onclick = () => openFile(tab.file, monacoEditor?.getPosition()?.lineNumber ?? tab.line);
  // エラータブはオーバーレイで中央に大きく表示。通常タブは消す。
  if (tab.error) showFileErrorOverlay(tab);
  else           hideFileErrorOverlay();
  refreshGraphDecorations();
  refreshLineMemoDecorations();
  refreshRangeMemoDecorations();
  refreshBookmarkDecorations();
  refreshSymbolDecorations();
  pinnedHighlights.forEach(ph => applyPinnedHighlightToModel(ph, tab.model));
  updatePinnedCounts();
  const isC = /\.(c|h|cpp|cc|cxx|hpp)$/i.test(tab.file);
  id('ifdef-ui').style.display = isC ? 'flex' : 'none';
  if(!isC) clearIfdefHighlight();
  renderTabs();
  // エクスプローラパネルが表示中なら連動してファイルを選択
  if(document.getElementById('explorer-panel')?.classList.contains('visible')) {
    window.explorerRevealFile?.(tab.file);
  }
  monacoEditor.layout();
  // タブ切替で active_file が変わったため editor-state を即時 push する。
  if (typeof bumpEditorStateSync === 'function') bumpEditorStateSync();
}

function closeTab(idx) {
  if(idx < 0 || idx >= tabs.length) return;
  tabs[idx].model.dispose();
  tabs.splice(idx, 1);
  if(!tabs.length) { stopFilePolling(); id('peek').classList.remove('visible'); activeTabIdx = -1; hideFileErrorOverlay(); renderTabs(); return; }
  const next = Math.min(idx, tabs.length - 1);
  activeTabIdx = -1;
  switchTab(next);
}

function closeTabsToRight(idx) {
  for(let i = tabs.length - 1; i > idx; i--) {
    tabs[i].model.dispose();
    tabs.splice(i, 1);
  }
  if(activeTabIdx > idx) { activeTabIdx = -1; switchTab(idx); } else renderTabs();
}

function closeOtherTabs(idx) {
  const keep = tabs[idx];
  tabs.forEach((t, i) => { if(i !== idx) t.model.dispose(); });
  tabs = [keep];
  activeTabIdx = -1;
  switchTab(0);
}

// ===== タブコンテキストメニュー =====
let _tabCtxIdx = -1;

function showTabCtxMenu(tabIdx, x, y) {
  _tabCtxIdx = tabIdx;
  const menu = id('tab-ctx-menu');
  const hasRight = tabIdx < tabs.length - 1;
  const hasOthers = tabs.length > 1;
  id('tab-ctx-close-right').classList.toggle('disabled', !hasRight);
  id('tab-ctx-close-others').classList.toggle('disabled', !hasOthers);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
  menu.classList.add('open');
  // 画面端クランプ
  const r = menu.getBoundingClientRect();
  if(r.right  > window.innerWidth)  menu.style.left = (x - (r.right - window.innerWidth) - 4) + 'px';
  if(r.bottom > window.innerHeight) menu.style.top  = (y - r.height) + 'px';
}

function hideTabCtxMenu() {
  id('tab-ctx-menu').classList.remove('open');
  _tabCtxIdx = -1;
}

function initTabCtxMenu() {
  id('tab-ctx-close').onclick = () => {
    const i = _tabCtxIdx; hideTabCtxMenu(); if(i >= 0) closeTab(i);
  };
  id('tab-ctx-close-right').onclick = () => {
    const i = _tabCtxIdx; hideTabCtxMenu();
    if(i >= 0 && !id('tab-ctx-close-right').classList.contains('disabled')) closeTabsToRight(i);
  };
  id('tab-ctx-close-others').onclick = () => {
    const i = _tabCtxIdx; hideTabCtxMenu();
    if(i >= 0 && !id('tab-ctx-close-others').classList.contains('disabled')) closeOtherTabs(i);
  };
  id('tab-ctx-copy-path').onclick = () => {
    const i = _tabCtxIdx; hideTabCtxMenu();
    if(i >= 0 && tabs[i]) navigator.clipboard.writeText(tabs[i].file).then(() => st('パスをコピーしました'));
  };
  id('tab-ctx-open-explorer').onclick = () => {
    const i = _tabCtxIdx; hideTabCtxMenu();
    if(i >= 0 && tabs[i]) fetch('/api/reveal?' + new URLSearchParams({file: tabs[i].file}));
  };
  id('tab-ctx-open-editor').onclick = () => {
    const i = _tabCtxIdx; hideTabCtxMenu();
    if(i >= 0 && tabs[i]) openFile(tabs[i].file);
  };
  document.addEventListener('mousedown', e => {
    if(!id('tab-ctx-menu').contains(e.target)) hideTabCtxMenu();
  }, true);
}

function renderTabs() {
  const bar = id('peek-tabs');
  bar.innerHTML = '';
  tabs.forEach((t, i) => {
    const tab = document.createElement('div');
    tab.className = 'ptab' + (i === activeTabIdx ? ' active' : '') + (t.preview ? ' preview' : '') + (t.error ? ' error' : '');
    const lbl = document.createElement('span');
    lbl.textContent = t.label;
    lbl.title = t.file;
    lbl.onclick = () => switchTab(i);
    // ダブルクリックでプレビューを固定に昇格
    lbl.ondblclick = () => { tabs[i].preview = false; renderTabs(); };
    const cls = document.createElement('span');
    cls.className = 'ptab-close';
    cls.textContent = '×';
    cls.onclick = e => { e.stopPropagation(); closeTab(i); };
    tab.appendChild(lbl);
    tab.appendChild(cls);
    tab.oncontextmenu = e => { e.preventDefault(); showTabCtxMenu(i, e.clientX, e.clientY); };
    bar.appendChild(tab);
    if(i === activeTabIdx) tab.scrollIntoView({block:'nearest', inline:'nearest'});
  });
}

function closePeek() {
  id('peek').classList.remove('visible');
  tabs.forEach(t => t.model.dispose());
  tabs = []; activeTabIdx = -1;
  renderTabs();
  if(typeof updateTitle === 'function') updateTitle();
}

function buildDefinitionParams(word, dir, glob, caseSensitive) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const p = new URLSearchParams({q: `\\b${escaped}\\b`, regex: '1', case: caseSensitive ? '1' : '0'});
  if(dir)  p.set('dir', dir);
  if(glob) p.set('glob', glob);
  return p;
}

// ===== grep 検索（検索欄に表示） =====
async function grepSearchWord(word) {
  if(!word || word.length < 2) return;
  id('tab-search')?.click();
  id('q').value = word;
  doSearch();
}

// ===== 定義ピークウィジェット（固定位置フローティング） =====
let _defDom = null;
let _defKeyHandler = null;

function closeDefPeek() {
  if (_defKeyHandler) { document.removeEventListener('keydown', _defKeyHandler); _defKeyHandler = null; }
  if (_defDom) { _defDom.remove(); _defDom = null; }
}


function showDefPeek(hits, word, pixelPos) {
  closeDefPeek();
  const ROW_H = 24;
  const HDR_H = 30;
  const MAX_ROWS = 8;
  const visRows = Math.min(hits.length, MAX_ROWS);

  const dom = document.createElement('div');
  dom.className = 'def-peek-zone';
  // エディタコンテナ基準で固定位置に配置
  dom.style.cssText = `position:absolute;z-index:var(--z-popover-low);top:${pixelPos.top}px;left:${pixelPos.left}px;min-width:400px;max-width:700px`;

  const hdr = document.createElement('div');
  hdr.className = 'def-peek-hdr';
  hdr.innerHTML = `<span>定義: <b>${esc(word)}</b>（${hits.length}件）</span><span class="def-peek-close">✕</span>`;
  dom.appendChild(hdr);

  const list = document.createElement('div');
  list.className = 'def-peek-list';
  list.style.height = (visRows * ROW_H) + 'px';
  list.tabIndex = 0;
  dom.appendChild(list);

  let sel = 0;
  const rows = hits.map((h, i) => {
    const row = document.createElement('div');
    row.className = 'def-peek-row' + (i === 0 ? ' def-peek-sel' : '');
    row.innerHTML = `<span class="def-peek-loc">${esc(shortPath(h.file))}:${h.line}</span><span class="def-peek-txt">${esc((h.text || '').trim())}</span>`;
    row.onclick = async () => { closeDefPeek(); if(typeof window.recordJump === 'function') window.recordJump(word, null, null, h.file, h.line); await openPeekPermanent(h.file, h.line); monacoEditor.focus(); };
    row.onmouseenter = () => { rows[sel].classList.remove('def-peek-sel'); sel = i; rows[sel].classList.add('def-peek-sel'); };
    list.appendChild(row);
    return row;
  });

  hdr.querySelector('.def-peek-close').onclick = () => { closeDefPeek(); monacoEditor.focus(); };

  _defKeyHandler = async e => {
    if (!_defDom) return;
    if (e.key === 'Escape')    { e.preventDefault(); e.stopPropagation(); closeDefPeek(); monacoEditor.focus(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); rows[sel].classList.remove('def-peek-sel'); sel = (sel + 1) % hits.length; rows[sel].classList.add('def-peek-sel'); rows[sel].scrollIntoView({block:'nearest'}); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); e.stopPropagation(); rows[sel].classList.remove('def-peek-sel'); sel = (sel - 1 + hits.length) % hits.length; rows[sel].classList.add('def-peek-sel'); rows[sel].scrollIntoView({block:'nearest'}); return; }
    if (e.key === 'Enter')     { e.preventDefault(); e.stopPropagation(); const h = hits[sel]; closeDefPeek(); if(typeof window.recordJump === 'function') window.recordJump(word, null, null, h.file, h.line); await openPeekPermanent(h.file, h.line); monacoEditor.focus(); return; }
  };
  document.addEventListener('keydown', _defKeyHandler);

  // エディタコンテナに追加（position:relative が必要）
  const container = monacoEditor.getDomNode().parentElement;
  container.style.position = 'relative';
  container.appendChild(dom);
  _defDom = dom;
  setTimeout(() => list.focus(), 0);
}

// ===== 定義ジャンプ =====
let _defAbortCtrl = null;
async function jumpToDefinition(word) {
  if(!word || word.length < 2) return;
  if(_defAbortCtrl) _defAbortCtrl.abort();
  _defAbortCtrl = new AbortController();
  // ジャンプ前の現在位置を履歴に記録（Alt+← で戻れるように）
  const curFile = tabs[activeTabIdx]?.file;
  const curLine = monacoEditor?.getPosition()?.lineNumber;
  if(curFile && curLine) navPush(curFile, curLine);
  let sf = 0;
  const stimer = setInterval(() => { sf=(sf+1)%SPINNER_FRAMES.length; st(SPINNER_FRAMES[sf]+' 定義を検索中: '+word); }, 80);
  st(SPINNER_FRAMES[0]+' 定義を検索中: '+word);
  const currentFile = tabs[activeTabIdx]?.file || '';
  const glob = id('glob').value.trim();

  let hits = [];
  let totalCount = 0;

  // /api/definition に1回だけリクエスト。
  // サーバー側で gtags→ripgrep フォールバックを処理するため、フロント側での2重呼び出しは不要。
  // dir は送らない（プロジェクトルート全体を検索するため）
  {
    const p = new URLSearchParams({word});
    if (glob) p.set('glob', glob);
    if (currentFile) p.set('file', currentFile);
    const _defEng = typeof window.getDefEngine === 'function' ? window.getDefEngine() : 'gtags';
    if (_defEng !== 'gtags') p.set('gtags', '0');
    if (_defEng === 'ctags') p.set('ctags', '1'); else p.set('ctags', '0');
    try {
      const r = await fetch('/api/definition?' + p, {signal: _defAbortCtrl.signal});
      if (r.ok) {
        hits = await r.json();
        totalCount = hits.length;
        const eng = r.headers.get('X-Engine');
        if (eng) window._lastDefEngine = eng;
      }
    } catch(e) { if(e?.name === 'AbortError') { clearInterval(stimer); return; } }
  }

  clearInterval(stimer);
  if(hits.length === 0) {
    const hint = (typeof window.gtagsEnabled === 'function' && window.gtagsEnabled())
      ? ' — インデックスが古い場合は再生成を試してください'
      : '';
    st('見つかりません: ' + word + hint);
    return;
  }

  // 現在ファイルを先頭に
  if(currentFile) {
    const inCurrent = hits.filter(m => m.file === currentFile);
    if(inCurrent.length) hits = [...inCurrent, ...hits.filter(m => m.file !== currentFile)];
  }

  const _engLabel = window._lastDefEngine ? ` [${window._lastDefEngine}]` : '';
  // 1件なら直接ジャンプ
  if(hits.length === 1) {
    st(`定義: ${shortPath(hits[0].file)}:${hits[0].line}${_engLabel}`);
    if(typeof window.recordJump === 'function') window.recordJump(word, curFile, curLine, hits[0].file, hits[0].line);
    await openPeekPermanent(hits[0].file, hits[0].line);
    return;
  }

  // 複数件はピークウィジェットで表示（検索欄を汚染しない）
  st(`定義 ${hits.length}件${_engLabel}`);
  const monacoPos = monacoEditor.getPosition() || { lineNumber: 1, column: 1 };
  const pixelPos = monacoEditor.getScrolledVisiblePosition(monacoPos) || { top: 40, left: 40 };
  // 1行分下にずらして表示
  const lineH = monacoEditor.getOption(monaco.editor.EditorOption.lineHeight) || 20;
  showDefPeek(hits, word, { top: pixelPos.top + lineH, left: Math.max(0, pixelPos.left) });
}

// ===== #ifdef ハイライト =====
async function applyIfdefHighlight() {
  const condStr = id('ifdef-cond').value.trim();
  if (!condStr) { st('条件を入力: 例 WIN32=1 DEBUG=0'); return; }
  if (!monacoEditor) { st('先にファイルを開いてください'); return; }
  const file = tabs[activeTabIdx]?.file;
  if (!file) { st('ファイルを開いてください'); return; }
  try {
    const r = await fetch('/api/ifdef?' + new URLSearchParams({file, defines: condStr}));
    const d = await r.json();
    if (d.error) { st('エラー: ' + d.error); return; }
    const inactive = new Set(d);
    const model = monacoEditor.getModel();
    const lineCount = model.getLineCount();
    const decos = [];
    let rs = null;
    for (let i = 1; i <= lineCount + 1; i++) {
      if (inactive.has(i)) { if (rs === null) rs = i; }
      else if (rs !== null) {
        decos.push({ range: new monaco.Range(rs, 1, i-1, model.getLineMaxColumn(i-1)),
          options: { isWholeLine: true, inlineClassName: 'ifdef-inactive-text',
            overviewRuler: {color: '#2a2a2a', position: monaco.editor.OverviewRulerLane.Full} }
        });
        rs = null;
      }
    }
    ifdefDecoIds = monacoEditor.deltaDecorations(ifdefDecoIds, decos);
    st(`プリプロセッサ適用: ${d.length} 行がグレーアウト`);
  } catch(e) { st('エラー: ' + e.message); }
}

function clearIfdefHighlight() {
  if (!monacoEditor) return;
  ifdefDecoIds = monacoEditor.deltaDecorations(ifdefDecoIds, []);
  st('#ifdef ハイライト解除');
}

// ===== 外部エディタで開く =====
function openFile(file, line) {
  if(!file) return;
  const params = new URLSearchParams({file});
  if(line) params.set('line', line);
  const editorCmd = getEditorCmd();
  if(editorCmd) params.set('editor', editorCmd);
  fetch('/api/open?' + params);
}

// ===== ペインリサイズ =====
addEventListener('DOMContentLoaded', () => {
  id('peek-hdr').addEventListener('mousedown', e => {
    if(e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
    peekResizing = true;
    peekStartY = e.clientY;
    peekStartH = id('peek').offsetHeight;
    document.body.style.cursor = 'ns-resize';
    e.preventDefault();
  });

  id('left-resizer').addEventListener('mousedown', e => {
    leftResizing = true;
    leftStartY = e.clientY;
    leftStartH = id('pane-search').offsetHeight;
    id('left-resizer').classList.add('active');
    document.body.style.cursor = 'ns-resize';
    e.preventDefault();
  });

  addEventListener('mousemove', e => {
    if(peekResizing) {
      const delta = peekStartY - e.clientY;
      const newH = Math.max(28, Math.min(peekStartH + delta, id('pane-right').offsetHeight * 0.95));
      id('peek').style.height = newH + 'px';
      id('peek').style.maxHeight = 'none';
      // style.height を書いた直後に layout() を呼ぶと、まだブラウザが reflow して
      // いないためコンテナサイズを古い値で読んでしまい、最下部までスクロールできなく
      // なる症状が出る。次フレーム（reflow 後）に呼ぶことで実際のサイズを認識させる。
      if(monacoEditor) requestAnimationFrame(() => monacoEditor.layout());
    }
    if(leftResizing) {
      const newH = Math.max(80, leftStartH + (e.clientY - leftStartY));
      id('pane-search').style.flex = 'none';
      id('pane-search').style.height = newH + 'px';
    }
  });

  addEventListener('mouseup', () => {
    if(peekResizing) {
      peekResizing = false;
      document.body.style.cursor = '';
      const h = id('peek').offsetHeight;
      if(h) localStorage.setItem('grepnavi-peek-h', h);
      // drag 終了時にも最終 layout を保証（mousemove の最後の layout が stale な状態で固定されるのを防ぐ）
      if(monacoEditor) requestAnimationFrame(() => monacoEditor.layout());
    }
    if(leftResizing) {
      leftResizing = false;
      document.body.style.cursor = '';
      id('left-resizer').classList.remove('active');
      const h = id('pane-search').offsetHeight;
      if(h) localStorage.setItem('grepnavi-left-search-h', h);
    }
  });

  const savedPeekH = localStorage.getItem('grepnavi-peek-h');
  if(savedPeekH) {
    id('peek').style.height = savedPeekH + 'px';
    id('peek').style.maxHeight = 'none';
  }
  const savedLeftH = localStorage.getItem('grepnavi-left-search-h');
  if(savedLeftH) {
    id('pane-search').style.flex = 'none';
    id('pane-search').style.height = savedLeftH + 'px';
  }
});

if (typeof module !== 'undefined') module.exports = { fzfMatchToken, fzfScore, fzfFilter, buildDefinitionParams, extractFuncName, _isDefAnchored };
