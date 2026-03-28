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
  renderPinnedChips();
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
    chip.innerHTML = `<span class="pinned-chip-nav" title="前の出現箇所">&#8249;</span><span class="pinned-chip-word">${ph.word}</span><span class="pinned-chip-nav" title="次の出現箇所">&#8250;</span><span class="pinned-chip-x">×</span>`;
    const [btnPrev, btnNext] = chip.querySelectorAll('.pinned-chip-nav');
    btnPrev.onclick = () => jumpPinnedHighlight(ph, -1);
    btnNext.onclick = () => jumpPinnedHighlight(ph, +1);
    chip.querySelector('.pinned-chip-word').onclick = () => {
      if(ph.originFile) openPeek(ph.originFile, ph.originLine);
    };
    chip.querySelector('.pinned-chip-x').onclick = () => togglePinnedHighlight(ph.word);
    panel.appendChild(chip);
  });
}

// ===== 行メモ (localStorage) =====
function getLineMemos() {
  try { return JSON.parse(localStorage.getItem('grepnavi-line-memos') || '{}'); } catch { return {}; }
}
function setLineMemo(file, line, memo) {
  const memos = getLineMemos();
  const key = file + '::' + line;
  if(memo) memos[key] = memo; else delete memos[key];
  localStorage.setItem('grepnavi-line-memos', JSON.stringify(memos));
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
  const decos = Object.entries(memos)
    .filter(([key]) => key.startsWith(file + '::'))
    .map(([key, memo]) => {
      const line = parseInt(key.split('::')[1]);
      return {
        range: new monaco.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: 'line-memo-glyph',
          glyphMarginHoverMessage: { value: memo.split('\n').join('\n\n') },
        }
      };
    });
  lineMemoDecoIds = monacoEditor.deltaDecorations(lineMemoDecoIds, decos);
  renderLineMemoOverlay();
}

function renderLineMemoOverlay() {
  document.getElementById('line-memo-overlay')?.remove();
  if(!monacoEditor || !showLineMemoInline) return;
  const file = tabs[activeTabIdx]?.file;
  if(!file) return;
  const memos = Object.entries(getLineMemos()).filter(([k]) => k.startsWith(file + '::'));
  if(!memos.length) return;

  const container = id('monaco-container');
  const overlay = document.createElement('div');
  overlay.id = 'line-memo-overlay';
  overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden;z-index:5';
  container.style.position = 'relative';
  container.appendChild(overlay);

  const lineH    = monacoEditor.getOption(monaco.editor.EditorOption.lineHeight);
  const fontSize = monacoEditor.getOption(monaco.editor.EditorOption.fontSize);
  const layoutInfo = monacoEditor.getLayoutInfo();
  const contentLeft = layoutInfo.contentLeft;

  function positionItems() {
    overlay.innerHTML = '';
    const scrollTop = monacoEditor.getScrollTop();
    memos.forEach(([key, memo]) => {
      const line = parseInt(key.split('::')[1]);
      const top  = monacoEditor.getTopForLineNumber(line) - scrollTop;
      if(top < -lineH || top > container.offsetHeight) return;
      const model   = monacoEditor.getModel();
      const endCol  = model ? model.getLineMaxColumn(line) : 1;
      const pos     = monacoEditor.getScrolledVisiblePosition({lineNumber: line, column: endCol});
      const left    = pos ? pos.left : contentLeft + 200;
      const el = document.createElement('div');
      el.className = 'line-memo-overlay-item';
      el.style.cssText = `position:absolute;top:${top}px;left:${left + 8}px;height:${lineH}px;line-height:${lineH}px;font-size:${fontSize}px`;
      el.textContent = '// ' + memo.split('\n').join(' ↵ ');
      overlay.appendChild(el);
    });
  }

  positionItems();
  _lineMemoScrollDispose?.dispose();
  _lineMemoScrollDispose = monacoEditor.onDidScrollChange(positionItems);
}

function toggleLineMemoInline() {
  showLineMemoInline = !showLineMemoInline;
  const btn = id('btn-line-memo-toggle');
  if(btn) { btn.classList.toggle('on', showLineMemoInline); btn.style.background = showLineMemoInline ? '#094771' : ''; }
  refreshLineMemoDecorations();
}

function showLineMemoInput(file, line) {
  document.getElementById('line-memo-popup')?.remove();
  const current = getLineMemos()[file + '::' + line] || '';
  const popup = document.createElement('div');
  popup.id = 'line-memo-popup';
  popup.style.cssText = 'position:fixed;z-index:9999;background:#2d2d2d;border:1px solid #555;border-radius:4px;padding:8px;box-shadow:0 4px 12px rgba(0,0,0,0.6);width:300px';
  const edRect = id('monaco-container').getBoundingClientRect();
  const lineH = monacoEditor.getOption(monaco.editor.EditorOption.lineHeight);
  const top = Math.min(edRect.top + (line - 1) * lineH - monacoEditor.getScrollTop() + lineH, window.innerHeight - 140);
  popup.style.left = (edRect.left + 64) + 'px';
  popup.style.top  = Math.max(top, edRect.top) + 'px';
  popup.innerHTML  = `<div style="color:#aaa;font-size:11px;margin-bottom:4px">行 ${line} のメモ</div>`;
  const ta = document.createElement('textarea');
  ta.value = current;
  ta.style.cssText = 'width:100%;height:64px;background:#1a1a1a;border:1px solid #444;color:#ccc;font:11px Consolas,monospace;padding:4px;resize:vertical;box-sizing:border-box;border-radius:2px';
  ta.placeholder = 'Ctrl+Enter で保存 / Esc でキャンセル';
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:4px;margin-top:6px;justify-content:flex-end';
  const mkBtn = (label, bg) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `font-size:11px;padding:2px 8px;background:${bg};color:#ccc;border:1px solid #555;border-radius:2px;cursor:pointer`;
    return b;
  };
  const btnSave   = mkBtn('保存', '#0e639c');
  const btnDel    = mkBtn('削除', '#3c3c3c');
  const btnCancel = mkBtn('キャンセル', '#3c3c3c');
  btnDel.style.display = current ? '' : 'none';
  btnRow.append(btnDel, btnCancel, btnSave);
  popup.append(ta, btnRow);
  document.body.appendChild(popup);
  ta.focus(); ta.select();
  const save = () => {
    setLineMemo(file, line, ta.value.trim());
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

// ===== グラフ登録済み行のデコレーション =====
function refreshGraphDecorations() {
  if(!monacoEditor) return;
  const file = tabs[activeTabIdx]?.file;
  if(!file) { graphDecoIds = monacoEditor.deltaDecorations(graphDecoIds, []); return; }
  const decos = Object.values(graph.nodes)
    .filter(n => n.match?.file === file && n.match?.line)
    .map(n => ({
      range: new monaco.Range(n.match.line, 1, n.match.line, 1),
      options: {
        isWholeLine: true,
        className: 'graph-node-line',
        glyphMarginClassName: 'graph-node-glyph',
        glyphMarginHoverMessage: {value: `**グラフ登録済み** ${n.label || ''}${n.memo ? '\n\n' + n.memo : ''}`},
      }
    }));
  graphDecoIds = monacoEditor.deltaDecorations(graphDecoIds, decos);
}

// ===== Monaco ロード =====
let _monacoLoadPromise = null;
function loadMonaco() {
  if(monacoReady) return Promise.resolve();
  if(!_monacoLoadPromise) {
    _monacoLoadPromise = new Promise(resolve => {
      require(['vs/editor/editor.main'], () => { monacoReady = true; resolve(); });
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
    fontSize: 12,
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
  initTabCtxMenu();

  // ホバー内リンクからファイルを開くコマンド
  monaco.editor.registerCommand('grepnavi.openFile', (_accessor, file, line) => {
    openPeek(file, Number(line));
  });

  // 右クリック → Jump Map に追加
  monacoEditor.addAction({
    id: 'grepnavi.addToJumpMap',
    label: 'Add to Jump Map',
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 1.5,
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

  HOVER_LANGS.forEach(lang => {
    monaco.languages.registerHoverProvider(lang, {
      provideHover: async (model, position, token) => {
        const word = model.getWordAtPosition(position);
        // B: 3文字未満・キーワードはスキップ
        if(!word || word.word.length < 3) return null;
        if(HOVER_SKIP.has(word.word)) return null;
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        try {
          const currentFile = tabs[activeTabIdx]?.file || '';
          const dir  = id('dir').value.trim();
          const glob = id('glob').value.trim();
          const contents = [];

          // 1. グラフノードのメモ（キャッシュ不要・ローカル処理）
          const memoNodes = Object.values(graph.nodes).filter(n => n.memo && (
            (n.match?.file === currentFile && n.match?.line === position.lineNumber) ||
            (n.match?.file === currentFile && (n.match?.text||'').includes(word.word))
          ));
          if(memoNodes.length) {
            memoNodes.forEach(n => {
              contents.push({value:
                `💬 **${n.label || shortPath(n.match?.file||'')+':'+(n.match?.line||'')}**\n\n${n.memo}`
              });
            });
            contents.push({value: '---'});
          }

          // A: キャッシュチェック（メモ以外の検索結果）
          const cacheKey = `${word.word}:${dir}:${glob}`;
          const cached = _hoverCache.get(cacheKey);
          if(cached && Date.now() - cached.time < HOVER_CACHE_TTL) {
            const allContents = [...contents, ...cached.contents];
            if(!allContents.length) return null;
            return {
              range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
              contents: allContents.map(c => ({...c, isTrusted: true}))
            };
          }

          // 2. /api/hover — struct/union/enum/define のブロック本体（C: /api/search は廃止）
          const hp = new URLSearchParams({word: word.word});
          if(dir)  hp.set('dir',  dir);
          if(glob) hp.set('glob', glob);
          const hoverFile = tabs[activeTabIdx]?.file || '';
          if(hoverFile) hp.set('file', hoverFile);
          const hr = await fetch('/api/hover?' + hp, {signal: controller.signal});
          const hoverHits = await hr.json();
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
              const header = `**${kindLabel[h.kind]||h.kind} \`${word.word}\`${counter}** — *${fileLink}*`;
              const body = h.body.length > 2000 ? h.body.slice(0, 2000) + '\n// ...' : h.body;
              const prefix = i === 0 ? declNote : '';
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
          if(!allContents.length) return null;
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

  // Alt+N → 行メモを追加/編集
  monacoEditor.addAction({
    id: 'grepnavi-line-memo', label: '行メモを追加/編集 (Alt+N)',
    keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyN],
    contextMenuGroupId: 'grepnavi-mark',
    contextMenuOrder: 3,
    run: ed => {
      const file = tabs[activeTabIdx]?.file;
      const line = ed.getPosition()?.lineNumber;
      if(!file || !line) return;
      showLineMemoInput(file, line);
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
  if(last && last.file === file && last.line === line) return;
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
async function openPeek(file, line) {
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

  const existIdx = tabs.findIndex(t => t.file === file);
  if(existIdx >= 0) {
    tabs[existIdx].line = line;
    await switchTab(existIdx);
    const matchLine = parseInt(line) || 1;
    tabs[existIdx].decoIds = monacoEditor.deltaDecorations(tabs[existIdx].decoIds || [], [{
      range: new monaco.Range(matchLine, 1, matchLine, 1),
      options: {isWholeLine: true, className: 'peek-match-decoration'}
    }]);
    monacoEditor.setPosition({lineNumber: matchLine, column: 1});
    monacoEditor.layout();
    monacoEditor.revealLineInCenter(matchLine);
    return;
  }

  const r = await fetch('/api/file?' + new URLSearchParams({file}));
  if(!r.ok) return;
  const text = await r.text();
  const lang = detectLang(file);
  const uri = monaco.Uri.from({scheme:'grepnavi', path: file.replace(/\\/g,'/')});
  const model = monaco.editor.getModel(uri) || monaco.editor.createModel(text, lang || 'plaintext', uri);
  const tab = {file, line, label: file.replace(/\\/g,'/').split('/').pop(), model, decoIds: []};
  tabs.push(tab);
  await switchTab(tabs.length - 1);

  const matchLine = parseInt(line) || 1;
  tab.decoIds = monacoEditor.deltaDecorations([], [{
    range: new monaco.Range(matchLine, 1, matchLine, 1),
    options: {isWholeLine: true, className: 'peek-match-decoration'}
  }]);
  monacoEditor.setPosition({lineNumber: matchLine, column: 1});
  monacoEditor.layout();
  monacoEditor.revealLineInCenter(matchLine);
}

async function refreshSymbolDecorations() {
  if (!monacoEditor) return;
  const tab = tabs[activeTabIdx];
  if (!tab) return;
  try {
    const r = await fetch('/api/symbols?' + new URLSearchParams({ file: tab.file }));
    if (!r.ok) return;
    const symbols = await r.json();
    const model = tab.model;
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

async function switchTab(idx) {
  if(idx < 0 || idx >= tabs.length) return;
  if(activeTabIdx >= 0 && activeTabIdx < tabs.length)
    tabs[activeTabIdx].viewState = monacoEditor.saveViewState();
  activeTabIdx = idx;
  const tab = tabs[idx];
  monacoEditor.setModel(tab.model);
  if(tab.viewState) try { monacoEditor.restoreViewState(tab.viewState); } catch(_) {}
  id('peek-file').textContent = tab.file + ':' + tab.line;
  refreshGraphDecorations();
  refreshLineMemoDecorations();
  refreshSymbolDecorations();
  pinnedHighlights.forEach(ph => applyPinnedHighlightToModel(ph, tab.model));
  const isC = /\.(c|h|cpp|cc|cxx|hpp)$/i.test(tab.file);
  id('ifdef-ui').style.display = isC ? 'flex' : 'none';
  if(!isC) clearIfdefHighlight();
  renderTabs();
}

function closeTab(idx) {
  if(idx < 0 || idx >= tabs.length) return;
  tabs[idx].model.dispose();
  tabs.splice(idx, 1);
  if(!tabs.length) { id('peek').classList.remove('visible'); activeTabIdx = -1; renderTabs(); return; }
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
  document.addEventListener('mousedown', e => {
    if(!id('tab-ctx-menu').contains(e.target)) hideTabCtxMenu();
  }, true);
}

function renderTabs() {
  const bar = id('peek-tabs');
  bar.innerHTML = '';
  tabs.forEach((t, i) => {
    const tab = document.createElement('div');
    tab.className = 'ptab' + (i === activeTabIdx ? ' active' : '');
    const lbl = document.createElement('span');
    lbl.textContent = t.label;
    lbl.title = t.file;
    lbl.onclick = () => switchTab(i);
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
  dom.style.cssText = `position:absolute;z-index:100;top:${pixelPos.top}px;left:${pixelPos.left}px;min-width:400px;max-width:700px`;

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
    row.onclick = async () => { closeDefPeek(); if(typeof window.recordJump === 'function') window.recordJump(word, null, null, h.file, h.line); await openPeek(h.file, h.line); monacoEditor.focus(); };
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
    if (e.key === 'Enter')     { e.preventDefault(); e.stopPropagation(); const h = hits[sel]; closeDefPeek(); if(typeof window.recordJump === 'function') window.recordJump(word, null, null, h.file, h.line); await openPeek(h.file, h.line); monacoEditor.focus(); return; }
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
async function jumpToDefinition(word) {
  if(!word || word.length < 2) return;
  // ジャンプ前の現在位置を履歴に記録（Alt+← で戻れるように）
  const curFile = tabs[activeTabIdx]?.file;
  const curLine = monacoEditor?.getPosition()?.lineNumber;
  if(curFile && curLine) navPush(curFile, curLine);
  let sf = 0;
  const stimer = setInterval(() => { sf=(sf+1)%SPINNER_FRAMES.length; st(SPINNER_FRAMES[sf]+' 定義を検索中: '+word); }, 80);
  st(SPINNER_FRAMES[0]+' 定義を検索中: '+word);
  const currentFile = tabs[activeTabIdx]?.file || '';
  const dir = id('dir').value.trim();
  const glob = id('glob').value.trim();

  let hits = [];
  let totalCount = 0;

  // /api/definition に1回だけリクエスト。
  // サーバー側で gtags→ripgrep フォールバックを処理するため、フロント側での2重呼び出しは不要。
  {
    const p = new URLSearchParams({word});
    if (dir)  p.set('dir', dir);
    if (glob) p.set('glob', glob);
    if (typeof window.gtagsEnabled === 'function' && !window.gtagsEnabled()) p.set('gtags', '0');
    try {
      const r = await fetch('/api/definition?' + p);
      if (r.ok) {
        hits = await r.json();
        totalCount = hits.length;
      }
    } catch {}
  }

  clearInterval(stimer);
  if(hits.length === 0) { st('見つかりません: ' + word); return; }

  // 現在ファイルを先頭に
  if(currentFile) {
    const inCurrent = hits.filter(m => m.file === currentFile);
    if(inCurrent.length) hits = [...inCurrent, ...hits.filter(m => m.file !== currentFile)];
  }

  // 1件なら直接ジャンプ
  if(hits.length === 1) {
    st(`定義: ${shortPath(hits[0].file)}:${hits[0].line}`);
    if(typeof window.recordJump === 'function') window.recordJump(word, curFile, curLine, hits[0].file, hits[0].line);
    await openPeek(hits[0].file, hits[0].line);
    return;
  }

  // 複数件はピークウィジェットで表示（検索欄を汚染しない）
  st(`定義 ${hits.length}件`);
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
      const newH = Math.max(120, Math.min(peekStartH + delta, id('pane-right').offsetHeight * 0.8));
      id('peek').style.height = newH + 'px';
      id('peek').style.maxHeight = 'none';
      if(monacoEditor) monacoEditor.layout();
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

if (typeof module !== 'undefined') module.exports = { fzfMatchToken, fzfScore, fzfFilter, buildDefinitionParams };
