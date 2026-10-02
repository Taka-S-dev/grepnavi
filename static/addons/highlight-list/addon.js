// ===== ハイライト一覧 Addon =====
// 追跡ハイライト（Alt+H）している語が、開いているタブのどこに出ているかを一覧で見せる。
// チップの ‹ › は順に辿るためのもので、「全部でいくつ、どのファイルのどこか」は
// 一覧でしか分からない。範囲を開いているタブに限るのはエディタのモデルから
// その場で数えられるため。プロジェクト全体は検索パネルの仕事で、ここでは扱わない。

(function() {

let _hllOpen = false;
// 畳んだ見出し（語 / 語|ファイル）。描き直しても持ち越す
const _hllClosed = new Set();

document.addEventListener('DOMContentLoaded', () => {
  document.body.insertAdjacentHTML('beforeend', `
    <div id="hll-sidebar" class="side-panel">
      <div id="hll-resizer"></div>
      <div id="hll-header">
        <span id="hll-title">ハイライト一覧</span>
        <span id="hll-scope">開いているタブ</span>
        <span id="hll-spacer"></span>
        <button id="hll-close" title="閉じる (Alt+Shift+H)">×</button>
      </div>
      <div id="hll-body"></div>
    </div>
  `);

  const addonBar = document.getElementById('addon-buttons');
  if (addonBar) {
    const btn = document.createElement('button');
    btn.id = 'btn-highlight-list';
    btn.className = 'sec';
    btn.textContent = 'hl';
    btn.dataset.menuLabel = 'ハイライト一覧';
    btn.dataset.menuHint = 'Alt+Shift+H';
    btn.title = 'hl — ハイライト一覧 (追跡ハイライトの出現箇所を開いているタブから一覧)  Alt+Shift+H';
    addonBar.appendChild(btn);
    btn.onclick = () => hllToggle();
  }
  document.getElementById('hll-close').onclick = () => hllToggle(false);

  document.addEventListener('keydown', e => {
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'h') {
      e.preventDefault();
      hllToggle();
    }
  });

  const resizer = document.getElementById('hll-resizer');
  const sidebar = document.getElementById('hll-sidebar');
  sidebar.style.width = (parseInt(localStorage.getItem('hll-width')) || 420) + 'px';
  resizer.addEventListener('mousedown', e => {
    e.preventDefault();
    const startX = e.clientX, startW = sidebar.offsetWidth;
    const move = ev => { sidebar.style.width = Math.max(260, Math.min(900, startW + startX - ev.clientX)) + 'px'; };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      localStorage.setItem('hll-width', sidebar.offsetWidth);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  // ハイライトの付け外しは renderPinnedChips に集まるので、そこに乗る
  if (typeof renderPinnedChips === 'function') {
    const orig = renderPinnedChips;
    renderPinnedChips = function() { orig.apply(this, arguments); hllSchedule(); };
  }
  document.addEventListener('grepnavi:active-file-changed', hllSchedule);
});

function hllToggle(force) {
  const p = document.getElementById('hll-sidebar');
  _hllOpen = force === undefined ? !p.classList.contains('open') : !!force;
  p.classList.toggle('open', _hllOpen);
  document.getElementById('btn-highlight-list')?.classList.toggle('on', _hllOpen);
  if (_hllOpen) {
    window.closeOtherSidePanels?.(p);
    hllWatchCursor();
    hllRender();
  }
}

// カーソルの行が変わったら現在位置の印を動かす。エディタは遅れて作られるので、
// パネルを開くたびに付け直す（同じエディタには一度だけ）
let _hllWatched = null;
function hllWatchCursor() {
  if (typeof monacoEditor === 'undefined' || !monacoEditor || _hllWatched === monacoEditor) return;
  _hllWatched = monacoEditor;
  monacoEditor.onDidChangeCursorPosition(() => { if (_hllOpen) hllMarkCurrent(); });
  monacoEditor.onDidChangeModelContent(() => hllSchedule());
}

let _hllTimer = 0;
function hllSchedule() {
  if (!_hllOpen) return;
  clearTimeout(_hllTimer);
  _hllTimer = setTimeout(hllRender, 80);
}

function hllRender() {
  const body = document.getElementById('hll-body');
  if (!body || !_hllOpen) return;
  body.textContent = '';
  const phs = (typeof pinnedHighlights !== 'undefined' && pinnedHighlights) || [];
  if (!phs.length) {
    const e = document.createElement('div');
    e.className = 'hll-empty';
    e.textContent = '追跡ハイライト（Alt+H）している語が、開いているタブのどこに出ているかをここに並べます。';
    body.appendChild(e);
    return;
  }
  const openTabs = (typeof tabs !== 'undefined' && tabs || []).filter(t => t.model && !t.error);
  let needName = false;
  phs.forEach(ph => {
    const c = PINNED_HL_COLORS[ph.colorIdx];
    const perFile = openTabs.map(t => ({ tab: t, matches: findPinnedMatches(t.model, ph) })).filter(x => x.matches.length);
    const total = perFile.reduce((n, x) => n + x.matches.length, 0);

    const wordKey = ph.word;
    const wordOpen = !_hllClosed.has(wordKey);
    const head = document.createElement('div');
    head.className = 'hll-word' + (wordOpen ? '' : ' hll-closed');
    head.style.setProperty('--hl', c.chip);
    const caret = document.createElement('span');
    caret.className = 'hll-caret';
    caret.textContent = wordOpen ? '▾' : '▸';
    head.appendChild(caret);
    // 見出しの余白で開閉。チップとボタンのクリックは奪わない
    head.onclick = ev => {
      if (ev.target.closest('.hll-chip, .hll-btn')) return;
      if (_hllClosed.has(wordKey)) _hllClosed.delete(wordKey); else _hllClosed.add(wordKey);
      hllRender();
    };
    const chip = document.createElement('span');
    chip.className = 'hll-chip';
    chip.style.cssText = `border-color:${c.border};background:${c.rgba}`;
    chip.textContent = ph.word;
    chip.title = 'ハイライトを付けた場所へ戻る';
    chip.onclick = () => { if (ph.originFile && typeof openPeek === 'function') openPeek(ph.originFile, ph.originLine); };
    head.appendChild(chip);
    const cnt = document.createElement('span');
    cnt.className = 'hll-count';
    cnt.textContent = total ? `${total} 件 / ${perFile.length} ファイル` : '開いているタブには無し';
    head.appendChild(cnt);
    const spacer = document.createElement('span');
    spacer.className = 'hll-spacer';
    head.appendChild(spacer);
    const x = document.createElement('button');
    x.className = 'hll-btn hll-x';
    x.textContent = '×';
    x.title = 'このハイライトを外す';
    x.onclick = () => { if (typeof togglePinnedHighlight === 'function') togglePinnedHighlight(ph.word); };
    head.appendChild(x);
    body.appendChild(head);
    if (!wordOpen) return;

    perFile.forEach(({ tab, matches }) => {
      const fileKey = wordKey + '|' + tab.file;
      const fileOpen = !_hllClosed.has(fileKey);
      const fh = document.createElement('div');
      fh.className = 'hll-file' + (fileOpen ? '' : ' hll-closed');
      const fcaret = document.createElement('span');
      fcaret.className = 'hll-caret';
      fcaret.textContent = fileOpen ? '▾' : '▸';
      fh.appendChild(fcaret);
      fh.appendChild(document.createTextNode(tab.label || tab.file.split(/[\\/]/).pop()));
      fh.title = tab.file;
      const fc = document.createElement('span');
      fc.className = 'hll-count';
      fc.textContent = String(matches.length);
      fh.appendChild(fc);
      fh.onclick = () => {
        if (_hllClosed.has(fileKey)) _hllClosed.delete(fileKey); else _hllClosed.add(fileKey);
        hllRender();
      };
      body.appendChild(fh);
      if (!fileOpen) return;
      matches.forEach(m => {
        const ln = m.range.startLineNumber;
        const row = document.createElement('div');
        row.className = 'hll-row';
        row.dataset.file = tab.file;
        row.dataset.line = ln;
        const num = document.createElement('span');
        num.className = 'hll-line';
        num.textContent = ln;
        row.appendChild(num);
        // 囲む関数。「OPENSSL_free(buf)」だけより、どの関数の中かが読める
        const fn = typeof stackFuncName === 'function' ? stackFuncName(tab.file, ln) : '';
        if (!fn) needName = true;
        const fnEl = document.createElement('span');
        fnEl.className = 'hll-fn';
        fnEl.textContent = fn ? fn : '';
        row.appendChild(fnEl);
        const text = document.createElement('span');
        text.className = 'hll-text';
        const line = tab.model.getLineContent(ln);
        const s = m.range.startColumn - 1, e = m.range.endColumn - 1;
        text.append(line.slice(0, s).replace(/^\s+/, ''));
        const hit = document.createElement('span');
        hit.className = 'hll-hit';
        hit.style.cssText = `background:${c.rgba};border-bottom:1px solid ${c.border}`;
        hit.textContent = line.slice(s, e);
        text.appendChild(hit);
        text.append(line.slice(e));
        row.appendChild(text);
        row.onclick = () => hllGo(tab.file, m.range);
        // 浮き窓は行の ⧉ で（乗せたときだけ見える）。ダブルクリックに割り当てると、
        // 行を続けてクリックしているときに誤って開く
        const pop = document.createElement('button');
        pop.className = 'hll-pop';
        pop.textContent = '⧉';
        pop.title = 'この場所を浮き窓で開く';
        pop.onclick = ev => { ev.stopPropagation(); if (typeof window.showFloatingCtx === 'function') window.showFloatingCtx(tab.file, ln); };
        row.appendChild(pop);
        body.appendChild(row);
      });
    });
  });
  // 囲む関数名は取得が後から来る。来たら描き直す
  if (needName) setTimeout(() => { if (_hllOpen) hllRender(); }, 600);
  hllMarkCurrent();
}

// 行をクリック: そのファイルを開き、一致した語の位置へ。
// 別のファイルの行なら、エディタがそのファイルに切り替わってから位置を合わせる。
// 開く処理が終わる前に合わせると、切り替えで位置が上書きされて動かなかったように見える
function hllGo(file, range) {
  if (typeof openPeek !== 'function') return;
  const place = () => {
    if (typeof monacoEditor === 'undefined' || !monacoEditor) return false;
    const cur = (typeof tabs !== 'undefined' && tabs[activeTabIdx] && tabs[activeTabIdx].file) || '';
    if (cur.replace(/\\/g, '/').toLowerCase() !== file.replace(/\\/g, '/').toLowerCase()) return false;
    monacoEditor.setPosition({ lineNumber: range.startLineNumber, column: range.startColumn });
    monacoEditor.revealLineInCenter(range.startLineNumber);
    if (typeof flashJumpTarget === 'function') flashJumpTarget(range);
    hllMarkCurrent();
    return true;
  };
  Promise.resolve(openPeek(file, range.startLineNumber)).then(() => {
    if (place()) return;
    let tries = 0;
    const t = setInterval(() => { if (place() || ++tries > 20) clearInterval(t); }, 100);
  });
}

// 現在のファイル・行の行に印
function hllMarkCurrent() {
  const body = document.getElementById('hll-body');
  if (!body) return;
  const file = (typeof tabs !== 'undefined' && tabs[activeTabIdx] && tabs[activeTabIdx].file) || '';
  const line = (typeof monacoEditor !== 'undefined' && monacoEditor && monacoEditor.getPosition()?.lineNumber) || 0;
  body.querySelectorAll('.hll-row').forEach(r => {
    r.classList.toggle('hll-cur', r.dataset.file === file && +r.dataset.line === line);
  });
}

window.toggleHighlightList = hllToggle;

})();
