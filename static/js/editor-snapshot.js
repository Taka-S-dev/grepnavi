// ===== SELECTION SNAPSHOT =====

// ---------- 共通データ収集 ----------
async function _gatherSnapshotData(ed) {
  const editor = ed || monacoEditor;
  if (!editor) { st('エディタが開かれていません'); return null; }
  const sel = editor.getSelection();
  if (!sel || sel.isEmpty()) { st('範囲を選択してください'); return null; }

  const model     = editor.getModel();
  const startLine = sel.startLineNumber;
  const endLine   = sel.endLineNumber;
  const file      = tabs[activeTabIdx]?.file || '';

  // 行コンテンツ
  const lines = [];
  for (let i = startLine; i <= endLine; i++) lines.push(model.getLineContent(i));

  // 行メモ
  const allMemos = getLineMemos();
  const memos = {};
  for (let i = startLine; i <= endLine; i++) {
    const v = allMemos[file + '::' + i];
    if (v) memos[i] = v;
  }

  // Monaco DOM walk → シンタックスハイライト付き HTML
  const viewLines  = document.querySelector('.monaco-editor .view-lines');
  const lineHtmlMap = {};
  const walkVL = (vl) => {
    let html = '';
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        html += node.textContent.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const color = getComputedStyle(node).color;
        html += `<span${color ? ` style="color:${color}"` : ''}>`;
        node.childNodes.forEach(walk);
        html += '</span>';
      }
    };
    vl.childNodes.forEach(walk);
    return html;
  };
  const captureVisible = () => {
    if (!viewLines) return;
    const allVl = Array.from(viewLines.querySelectorAll('.view-line'));
    for (let n = startLine; n <= endLine; n++) {
      if (lineHtmlMap[n]) continue;
      const top = editor.getTopForLineNumber(n);
      for (const vl of allVl) {
        if (Math.abs(parseFloat(vl.style.top || '0') - top) < 2) {
          lineHtmlMap[n] = walkVL(vl); break;
        }
      }
    }
  };
  captureVisible();
  const origScrollTop = editor.getScrollTop();
  let lastMissing = -1;
  for (;;) {
    const missing = [];
    for (let i = startLine; i <= endLine; i++) if (!lineHtmlMap[i]) missing.push(i);
    if (!missing.length || missing.length === lastMissing) break;
    lastMissing = missing.length;
    editor.revealLine(missing[0], monaco.editor.ScrollType.Immediate);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    captureVisible();
  }
  editor.setScrollTop(origScrollTop, monaco.editor.ScrollType.Immediate);
  for (let i = startLine; i <= endLine; i++) {
    if (!lineHtmlMap[i])
      lineHtmlMap[i] = (lines[i - startLine] || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  const colorLines = [];
  for (let i = startLine; i <= endLine; i++) colorLines.push(lineHtmlMap[i]);

  // 範囲メモ
  const rangeMemoList = getRangeMemos().filter(m =>
    m.file === file && m.startLine <= endLine && m.endLine >= startLine
  );

  // memoByLine
  const memoByLine = {};
  const addMemo = (li, entry) => { if (!memoByLine[li]) memoByLine[li] = []; memoByLine[li].push(entry); };
  for (let i = startLine; i <= endLine; i++) {
    const v = memos[i];
    if (v) addMemo(i - startLine, { text: v, type: 'line' });
  }
  rangeMemoList.forEach(m => addMemo(Math.max(m.startLine, startLine) - startLine, { text: m.memo, type: 'range' }));

  // rangeHighlights（タブ展開後の視覚列も計算）
  const tabSize = monacoEditor?.getModel()?.getOptions()?.tabSize || 4;
  function modelToVis(lineText, modelCol0) {
    let v = 0;
    for (let i = 0; i < modelCol0 && i < lineText.length; i++) {
      if (lineText[i] === '\t') v = Math.floor(v / tabSize + 1) * tabSize;
      else v++;
    }
    return v;
  }
  const rangeHighlights = {};
  rangeMemoList.forEach(m => {
    const fromLi = Math.max(m.startLine, startLine) - startLine;
    const toLi   = Math.min(m.endLine,   endLine)   - startLine;
    for (let i = fromLi; i <= toLi; i++) {
      const absLine  = startLine + i;
      const lineText = lines[i] || '';
      const from = (absLine === m.startLine) ? m.startCol - 1 : 0;
      const to   = (absLine === m.endLine)   ? m.endCol   - 1 : lineText.length;
      const visFrom = modelToVis(lineText, from);
      const visTo   = modelToVis(lineText, to);
      if (!rangeHighlights[i]) rangeHighlights[i] = [];
      rangeHighlights[i].push({ from, to, visFrom, visTo });
    }
  });

  // memoEntries（フラットリスト、snippet付き）
  const SNIPPET_MAX = 5;
  const memoEntries = [];
  Object.entries(memoByLine).sort((a,b) => a[0]-b[0]).forEach(([li, arr]) => {
    arr.forEach(m => {
      let snippet = null;
      if (m.type === 'range') {
        const rm = rangeMemoList.find(r => r.memo === m.text);
        if (rm) {
          const fromLi = Math.max(rm.startLine, startLine) - startLine;
          const toLi   = Math.min(rm.endLine,   endLine)   - startLine;
          const sl = [];
          for (let i = fromLi; i <= toLi && sl.length < SNIPPET_MAX; i++) {
            const t = lines[i] ?? '';
            const absLine = startLine + i;
            const sliceStart = (absLine === rm.startLine) ? rm.startCol - 1 : 0;
            const sliceEnd   = (absLine === rm.endLine)   ? rm.endCol - 1   : t.length;
            sl.push(t.slice(sliceStart, sliceEnd));
          }
          snippet = sl.join('\n') + ((toLi - fromLi + 1) > SNIPPET_MAX ? '\n…' : '');
        }
      }
      memoEntries.push({ li: Number(li), text: m.text, type: m.type, snippet });
    });
  });

  return { editor, startLine, endLine, file, lines, colorLines, memoByLine, memoEntries, rangeMemoList, rangeHighlights, tabSize };
}

// ---------- ポップアップ HTML 出力 ----------
async function exportSelectionSnapshot(ed) {
  st('スナップショット生成中...');
  const d = await _gatherSnapshotData(ed);
  if (!d) return;
  const { startLine, endLine, file, lines, colorLines, memoByLine, memoEntries, rangeHighlights, tabSize } = d;

  const LINE_H = 20;

  // 行HTML
  let codeRows = '';
  for (let i = 0; i < lines.length; i++) {
    const absLine = startLine + i;
    const hasMemo = memoByLine[i] != null;
    const hlRanges = rangeHighlights[i];
    const cls = ['code-line', hasMemo ? 'has-memo' : ''].filter(Boolean).join(' ');
    const hlAttr = hlRanges ? ` data-hl='${JSON.stringify(hlRanges)}'` : '';
    codeRows += `<div class="${cls}" data-li="${i}"${hlAttr}><span class="ln">${absLine}</span><span class="code">${colorLines[i] || ''}</span></div>`;
  }

  // メモボックスHTML
  let memoBoxes = '';
  memoEntries.forEach((m, idx) => {
    const esc = m.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\n/g,'<br>');
    const snippetHtml = m.snippet
      ? `<div class="memo-snippet">${m.snippet.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\n/g,'<br>')}</div>`
      : '';
    memoBoxes += `<div class="memo-box memo-${m.type}" data-li="${m.li}" data-mi="${idx}">${snippetHtml}<div class="memo-text">${esc}</div></div>`;
  });

  const fname    = file.replace(/\\/g, '/').split('/').pop() || 'snapshot';
  const fileFwd  = file.replace(/\\/g, '/');
  const rootFwd  = (projectRoot || '').replace(/\\/g, '/').replace(/\/$/, '');
  const fpath    = rootFwd && fileFwd.startsWith(rootFwd) ? fileFwd.slice(rootFwd.length).replace(/^\//, '') : fileFwd;

  const popup = window.open('', '_blank', 'width=1100,height=700,scrollbars=yes');
  popup.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${fname} L${startLine}-${endLine}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#1e1e1e;font:13px/20px Consolas,"Courier New",monospace;color:#d4d4d4;}
  .snap-toolbar{background:#1a1a1a;border-bottom:1px solid #333;padding:4px 16px;display:flex;align-items:center;gap:8px;justify-content:flex-end;}
  .export-btn{background:#2d2d2d;border:1px solid #555;border-radius:3px;color:#ccc;font:11px "Segoe UI",sans-serif;padding:3px 10px;cursor:pointer;}
  .export-btn:hover{background:#3a3a3a;color:#fff;}
  .file-header{background:#252526;border-bottom:1px solid #3c3c3c;padding:6px 16px;display:flex;align-items:center;gap:10px;}
  .file-header .fname{color:#ccc;font:bold 13px "Segoe UI",sans-serif;}
  .file-header .fpath{color:#888;font:11px "Segoe UI",sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .file-header .frange{color:#569cd6;font:11px "Segoe UI",sans-serif;flex-shrink:0;}
  .layout{display:flex;align-items:flex-start;padding:12px 0;}
  .code-panel{flex:0 0 auto;padding:8px 0;margin:0 16px;background:#252526;border:1px solid #3c3c3c;border-radius:4px;}
  .code-line{display:flex;align-items:baseline;min-height:${LINE_H}px;white-space:pre;position:relative;}
  .code-line.has-memo{background:rgba(255,200,50,0.04);}
  .range-hl{position:absolute;top:0;bottom:0;background:rgba(255,70,70,0.12);border-bottom:2px solid rgba(255,80,80,0.8);pointer-events:none;border-radius:2px 2px 0 0;}
  .ln{color:#606060;text-align:right;width:48px;flex-shrink:0;padding-right:12px;padding-left:12px;user-select:none;position:relative;z-index:1;border-right:1px solid #3c3c3c;margin-right:12px;}
  .code{white-space:pre;color:#d4d4d4;}
  .connector-panel{flex:0 0 60px;position:relative;}
  .memo-panel{flex:1;padding:0 16px;display:flex;flex-direction:column;gap:12px;justify-content:flex-start;}
  .memo-box{background:#fefcbf;border:none;border-radius:2px 0 2px 2px;padding:10px 14px;color:#333;font:12px "Segoe UI",sans-serif;line-height:1.6;min-width:160px;box-shadow:2px 3px 8px rgba(0,0,0,0.5),inset 0 -2px 4px rgba(0,0,0,0.08);position:relative;}
  .memo-box::before{content:'';display:block;position:absolute;top:0;left:0;right:0;height:6px;background:rgba(0,0,0,0.08);border-radius:2px 0 0 0;}
  .memo-box::after{content:'';position:absolute;top:0;right:0;width:20px;height:20px;background:linear-gradient(to bottom left,#1e1e1e 50%,#c4ad30 50%);z-index:1;}
  .memo-box.memo-range{background:#fff0f0;}
  .memo-box.memo-range::before{background:rgba(255,80,80,0.15);border-radius:2px 0 0 0;}
  .memo-box.memo-range::after{background:linear-gradient(to bottom left,#1e1e1e 50%,#c89898 50%);}
  .memo-snippet{font:10px/1.5 Consolas,"Courier New",monospace;color:#aaa;background:#d8d8d8;border-radius:0 3px 3px 0;padding:4px 8px;margin-bottom:8px;white-space:pre-wrap;word-break:break-all;border-left:3px solid #888;}
  .memo-text{white-space:pre-wrap;word-break:break-word;margin-top:4px;font:13px/1.6 "Segoe UI","Hiragino Sans",sans-serif;color:#222;}
  svg.connector{position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible;pointer-events:none;}
</style>
</head><body>
<div class="snap-toolbar">
  <button class="export-btn" onclick="window.opener.exportSnapshotAsDrawio(window.opener.monacoEditor)">draw.io</button>
  <button class="export-btn" onclick="window.opener.exportSnapshotAsPptx(window.opener.monacoEditor)">PowerPoint</button>
</div>
<div class="file-header">
  <span class="fname">${fname}</span>
  <span class="fpath">${fpath}</span>
  <span class="frange">L${startLine}–${endLine}</span>
</div>
<div class="layout">
  <div class="code-panel" id="code-panel">${codeRows}</div>
  <div class="connector-panel" id="connector-panel"><svg class="connector" id="svg-connector"></svg></div>
  <div class="memo-panel" id="memo-panel">${memoBoxes}</div>
</div>
<script>
(function(){
  const LINE_H = ${LINE_H};
  const memoEntries = ${JSON.stringify(memoEntries.map(m => m.li))};
  const rawLines = ${JSON.stringify(lines)};
  const tabSize = ${tabSize};
  const codePanel = document.getElementById('code-panel');
  const memoPanel = document.getElementById('memo-panel');
  const connPanel = document.getElementById('connector-panel');
  const svg       = document.getElementById('svg-connector');

  function draw() {
    const codeRect = codePanel.getBoundingClientRect();
    const connRect = connPanel.getBoundingClientRect();
    const memoRect = memoPanel.getBoundingClientRect();
    connPanel.style.height = Math.max(codeRect.height, memoRect.height) + 'px';
    svg.setAttribute('viewBox', '0 0 60 ' + connPanel.offsetHeight);
    svg.innerHTML = '';
    memoPanel.querySelectorAll('.memo-box').forEach((box, mi) => {
      const li = memoEntries[mi];
      const codeRow = codePanel.querySelector('.code-line[data-li="'+li+'"]');
      if (!codeRow) return;
      const rowRect = codeRow.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      const y1 = rowRect.top + rowRect.height/2 - connRect.top;
      const y2 = boxRect.top + boxRect.height/2 - connRect.top;
      const path = document.createElementNS('http://www.w3.org/2000/svg','path');
      path.setAttribute('d','M0,'+y1+' C30,'+y1+' 30,'+y2+' 60,'+y2);
      path.setAttribute('stroke','#c8a000'); path.setAttribute('stroke-width','1.5');
      path.setAttribute('stroke-dasharray','4 3'); path.setAttribute('fill','none'); path.setAttribute('opacity','0.9');
      svg.appendChild(path);
      const dot = document.createElementNS('http://www.w3.org/2000/svg','circle');
      dot.setAttribute('cx','60'); dot.setAttribute('cy',y2); dot.setAttribute('r','3'); dot.setAttribute('fill','#c8a000');
      svg.appendChild(dot);
    });
  }

  function expandTabs(text) {
    let out = '', v = 0;
    for (const ch of text) {
      if (ch === '\t') { const sp = tabSize - (v % tabSize); out += ' '.repeat(sp); v += sp; }
      else { out += ch; v++; }
    }
    return out;
  }

  function drawRangeHighlights() {
    codePanel.querySelectorAll('.range-hl').forEach(el => el.remove());
    const _ruler = document.createElement('span');
    _ruler.style.cssText = 'position:fixed;top:-9999px;left:-9999px;white-space:pre;visibility:hidden;pointer-events:none;';
    document.body.appendChild(_ruler);
    const firstCode = codePanel.querySelector('.code');
    if (firstCode) _ruler.style.font = getComputedStyle(firstCode).font;
    codePanel.querySelectorAll('.code-line[data-hl]').forEach(row => {
      const ranges = JSON.parse(row.getAttribute('data-hl'));
      const li = parseInt(row.getAttribute('data-li'));
      const expanded = expandTabs(rawLines[li] || '');
      const codeEl = row.querySelector('.code');
      if (!codeEl) return;
      const rowRect  = row.getBoundingClientRect();
      const codeRect = codeEl.getBoundingClientRect();
      const GUTTER   = codeRect.left - rowRect.left;
      ranges.forEach(({from, to, visFrom, visTo}) => {
        const pFrom = visFrom !== undefined ? visFrom : from;
        const pTo   = visTo   !== undefined ? visTo   : to;
        _ruler.textContent = expanded.slice(0, pFrom);
        const leftW = _ruler.getBoundingClientRect().width;
        _ruler.textContent = expanded.slice(pFrom, pTo);
        const selW  = Math.max(_ruler.getBoundingClientRect().width, 4);
        const hl = document.createElement('div');
        hl.className = 'range-hl';
        hl.style.left  = (GUTTER + leftW) + 'px';
        hl.style.width = selW + 'px';
        row.appendChild(hl);
      });
    });
    document.body.removeChild(_ruler);
  }

  function drawIndentGuides() {
    codePanel.querySelector('.indent-guide-overlay')?.remove();
    const codeLines = codePanel.querySelectorAll('.code-line');
    if (!codeLines.length) return;
    const firstLn = codePanel.querySelector('.ln');
    const lnRect  = firstLn ? firstLn.getBoundingClientRect() : null;
    const lnMargin = firstLn ? parseFloat(getComputedStyle(firstLn).marginRight) || 12 : 12;
    const GUTTER = lnRect ? lnRect.width + lnMargin : 64;
    const firstCode = codePanel.querySelector('.code');
    const chW = (firstCode ? parseFloat(getComputedStyle(firstCode).fontSize) : 13) * 0.601;
    function leadingLen(text) {
      let n = 0;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === ' ' || c === '\u00a0') n++;
        else if (c === '\t') n += 4;
        else break;
      }
      return n;
    }
    const indentLengths = [];
    codeLines.forEach(row => { const n = leadingLen(row.querySelector('.code')?.textContent || ''); if (n > 0 && n <= 16) indentLengths.push(n); });
    let indentSize = 4;
    if (indentLengths.length) {
      indentSize = indentLengths.reduce((a, b) => { let x=a,y=b; while(y){let t=y;y=x%y;x=t;} return x; });
      if (indentSize < 1 || indentSize > 8) indentSize = 4;
    }
    const indentPx = chW * indentSize;
    let maxLevel = 0;
    codeLines.forEach(row => { maxLevel = Math.max(maxLevel, Math.floor(leadingLen(row.querySelector('.code')?.textContent || '') / indentSize)); });
    if (maxLevel <= 0) return;
    const bracketColors = {};
    var bDepth = 0;
    codeLines.forEach(function(row) {
      var codeEl = row.querySelector('.code');
      if (!codeEl) return;
      function walkColor(node, color) {
        if (node.nodeType === 3) {
          var t = node.textContent;
          for (var ci = 0; ci < t.length; ci++) {
            if (t[ci] === '{') { bDepth++; if (!bracketColors[bDepth]) bracketColors[bDepth] = color; }
            else if (t[ci] === '}') bDepth = Math.max(0, bDepth - 1);
          }
        } else if (node.nodeType === 1) {
          var c = node.style.color || color;
          node.childNodes.forEach(function(ch) { walkColor(ch, c); });
        }
      }
      codeEl.childNodes.forEach(function(ch) { walkColor(ch, 'rgba(255,255,255,0.6)'); });
    });
    function toGuideColor(raw) {
      if (!raw) return 'rgba(255,255,255,0.2)';
      var m = raw.match(/rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\)/);
      return m ? 'rgba('+m[1]+','+m[2]+','+m[3]+',0.45)' : raw;
    }
    codePanel.style.position = 'relative';
    const panelRect = codePanel.getBoundingClientRect();
    const overlay = document.createElement('div');
    overlay.className = 'indent-guide-overlay';
    overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10;';
    const lineStartDepth = [];
    var runDepth = 0;
    codeLines.forEach(function(row) {
      lineStartDepth.push(runDepth);
      var t = row.querySelector('.code')?.textContent || '';
      for (var ci = 0; ci < t.length; ci++) {
        if (t[ci] === '{') runDepth++;
        else if (t[ci] === '}') runDepth = Math.max(0, runDepth - 1);
      }
    });
    const lineLevels = Array.from(codeLines).map((row, idx) => Math.min(Math.floor(leadingLen(row.querySelector('.code')?.textContent || '') / indentSize), lineStartDepth[idx]));
    for (let i = 0; i < lineLevels.length; i++) {
      if ((codeLines[i].querySelector('.code')?.textContent || '').trim() === '') {
        lineLevels[i] = Math.min(i > 0 ? lineLevels[i-1] : 0, i < lineLevels.length-1 ? lineLevels[i+1] : 0);
      }
    }
    codeLines.forEach((row, idx) => {
      const text = row.querySelector('.code')?.textContent || '';
      const contentText = text.trimStart();
      let leadingClose = 0;
      for (let ci = 0; ci < contentText.length && contentText[ci] === '}'; ci++) leadingClose++;
      const braceLevel = Math.max(0, lineStartDepth[idx] - leadingClose);
      const wsLevel = Math.max(lineLevels[idx], Math.floor(leadingLen(text) / indentSize));
      const totalLevel = Math.max(braceLevel, wsLevel);
      if (totalLevel <= 0) return;
      const rowRect = row.getBoundingClientRect();
      const top = rowRect.top - panelRect.top;
      const h   = rowRect.height;
      for (let l = 1; l <= totalLevel; l++) {
        const guide = document.createElement('div');
        guide.style.cssText = 'position:absolute;top:' + top + 'px;left:' + (GUTTER+(l-1)*indentPx) + 'px;width:1px;height:' + h + 'px;background:' + (l <= braceLevel ? toGuideColor(bracketColors[l]) : 'rgba(255,255,255,0.14)') + ';';
        overlay.appendChild(guide);
      }
    });
    codePanel.appendChild(overlay);
  }

  window.addEventListener('load',   () => { draw(); drawRangeHighlights(); drawIndentGuides(); });
  window.addEventListener('resize', () => { draw(); drawRangeHighlights(); drawIndentGuides(); });
})();
<\/script>
</body></html>`);
  popup.document.close();
  st('キャプチャ用ウィンドウを開きました');
}

// ---------- draw.io 出力 ----------
async function exportSnapshotAsDrawio(ed) {
  st('draw.io 形式で生成中...');
  const d = await _gatherSnapshotData(ed);
  if (!d) return;
  const { startLine, endLine, file, lines, colorLines, memoByLine, memoEntries, rangeHighlights } = d;

  const LINE_H    = 20;
  const FONT_SIZE = 13;
  const chW       = FONT_SIZE * 0.601;
  const GUTTER_W  = 72; // 行番号エリア幅

  // コードパネルのサイズを推定
  const maxLen = Math.max(...lines.map(l => l.length), 40);
  const codeW  = Math.min(Math.ceil(GUTTER_W + maxLen * chW + 24), 1200);
  const codeH  = lines.length * LINE_H + 16;

  // コード → Canvas 直描画 → base64 PNG
  const pngBase64 = _codeToBase64(colorLines, startLine, codeW, codeH, LINE_H, FONT_SIZE, GUTTER_W, lines, rangeHighlights, memoByLine);

  // draw.io レイアウト定数
  const PAD    = 20;
  const CONN_W = 80;
  const MEMO_W = 220;
  const MEMO_X = PAD + codeW + CONN_W;

  // ファイルパス
  const fname   = file.replace(/\\/g, '/').split('/').pop() || 'snapshot';
  const fileFwd = file.replace(/\\/g, '/');
  const rootFwd = (projectRoot || '').replace(/\\/g, '/').replace(/\/$/, '');
  const fpath   = rootFwd && fileFwd.startsWith(rootFwd) ? fileFwd.slice(rootFwd.length).replace(/^\//, '') : fileFwd;

  // XML セル生成
  let cells = '';

  // ヘッダーラベル
  cells += `<mxCell id="header" value="${_escXml(fname + '  ' + fpath + '  L' + startLine + '–' + endLine)}" style="text;html=0;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontSize=11;fontColor=#888888;fontFamily=Segoe UI,sans-serif;" vertex="1" parent="1"><mxGeometry x="${PAD}" y="0" width="${codeW}" height="${PAD}" as="geometry"/></mxCell>`;

  // コード画像（style の ; 分割問題を避けるため value の <img> タグとして埋め込む）
  const imgVal = _escXml(`<img src="data:image/png;base64,${pngBase64}" width="${codeW}" height="${codeH}"/>`);
  cells += `<mxCell id="code-img" value="${imgVal}" style="text;html=1;align=left;verticalAlign=top;strokeColor=#3c3c3c;fillColor=none;" vertex="1" parent="1"><mxGeometry x="${PAD}" y="${PAD}" width="${codeW}" height="${codeH}" as="geometry"/></mxCell>`;

  // メモボックス＋コネクタ
  let memoY = PAD;
  memoEntries.forEach((m, idx) => {
    const memoId = 'memo-' + idx;
    const connId = 'conn-' + idx;
    const memoH  = Math.max(60, (m.text.split('\n').length + (m.snippet ? m.snippet.split('\n').length + 1 : 0)) * 16 + 30);

    const isRange    = m.type === 'range';
    const fillColor  = isRange ? '#fff0f0' : '#fefcbf';
    const strokeColor = isRange ? '#c89898' : '#c4ad30';

    let memoHtml = '';
    if (m.snippet) memoHtml += `<font style="font-size:9px;" color="#aaaaaa" face="Consolas,Courier New">${_escXml(m.snippet)}</font><br/>`;
    memoHtml += _escXml(m.text).replace(/\n/g, '<br/>');
    const memoVal = _escXml(memoHtml);

    cells += `<mxCell id="${memoId}" value="${memoVal}" style="shape=note;whiteSpace=wrap;html=1;backgroundOutline=1;size=15;fontSize=11;fontFamily=Segoe UI,Hiragino Sans,sans-serif;fillColor=${fillColor};strokeColor=${strokeColor};align=left;verticalAlign=top;spacingLeft=8;spacingTop=8;spacingRight=8;spacingBottom=8;" vertex="1" parent="1"><mxGeometry x="${MEMO_X}" y="${memoY}" width="${MEMO_W}" height="${memoH}" as="geometry"/></mxCell>`;

    // コネクタ（コード画像右端の該当行Y → メモ左端中央Y）
    const srcX = PAD + codeW;
    const srcY = PAD + 8 + m.li * LINE_H + LINE_H / 2;
    const dstY = memoY + memoH / 2;
    cells += `<mxCell id="${connId}" value="" style="edgeStyle=none;strokeColor=#c8a000;strokeWidth=1.5;dashed=1;dashPattern=4 3;endArrow=none;startArrow=none;" edge="1" parent="1"><mxGeometry relative="1" as="geometry"><mxPoint x="${srcX}" y="${srcY}" as="sourcePoint"/><mxPoint x="${MEMO_X}" y="${dstY}" as="targetPoint"/></mxGeometry></mxCell>`;

    memoY += memoH + 12;
  });

  const totalW = memoEntries.length ? MEMO_X + MEMO_W + PAD : PAD + codeW + PAD;
  const totalH = Math.max(PAD + codeH + PAD, memoY + PAD);

  const xml = `<mxfile host="Electron" modified="${new Date().toISOString()}" agent="grepnavi" version="21.0.0" type="device">
  <diagram name="snapshot" id="snap-${Date.now()}">
    <mxGraphModel grid="0" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" pageWidth="${totalW}" pageHeight="${totalH}" math="0" shadow="0">
      <root>
        <mxCell id="0"/><mxCell id="1" parent="0"/>
        ${cells}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

  const blob = new Blob([xml], { type: 'application/xml' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `${fname}_L${startLine}-${endLine}.drawio`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  st('draw.io ファイルをダウンロードしました');
}

// ---------- PowerPoint 出力 ----------
async function exportSnapshotAsPptx(ed) {
  st('PowerPoint 形式で生成中...');
  try {
    const d = await _gatherSnapshotData(ed);
    if (!d) return;
    const { startLine, endLine, file, lines, colorLines, memoByLine, memoEntries, rangeHighlights } = d;

    const LINE_H    = 20;
    const FONT_SIZE = 13;
    const chW       = FONT_SIZE * 0.601;
    const GUTTER_W  = 72;
    const maxLen    = Math.max(...lines.map(l => l.length), 40);
    const codeW     = Math.min(Math.ceil(GUTTER_W + maxLen * chW + 24), 1200);
    const codeH     = lines.length * LINE_H + 16;

    const pngBase64 = _codeToBase64(colorLines, startLine, codeW, codeH, LINE_H, FONT_SIZE, GUTTER_W, lines, rangeHighlights, memoByLine);

    const PAD     = 20;
    const CONN_W  = 80;
    const MEMO_W  = 220;
    const MEMO_X  = PAD + codeW + CONN_W;
    const MEMO_LH = 18;

    const fname   = file.replace(/\\/g, '/').split('/').pop() || 'snapshot';
    const fileFwd = file.replace(/\\/g, '/');
    const rootFwd = (projectRoot || '').replace(/\\/g, '/').replace(/\/$/, '');
    const fpath   = rootFwd && fileFwd.startsWith(rootFwd) ? fileFwd.slice(rootFwd.length).replace(/^\//, '') : fileFwd;

    let memoY = PAD;
    const memoLayouts = memoEntries.map(m => {
      const textLines    = m.text.split('\n').length;
      const snippetLines = m.snippet ? m.snippet.split('\n').length + 1 : 0;
      const h = Math.max(60, (textLines + snippetLines) * MEMO_LH + 24);
      const y = memoY;
      memoY += h + 12;
      return { y, h };
    });

    const totalW = MEMO_X + MEMO_W + PAD;
    const totalH = Math.max(PAD + codeH + PAD, memoY + PAD);
    const px = v => parseFloat((v / 96).toFixed(4));

    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: 'SNAP', width: px(totalW), height: px(totalH) });
    pptx.layout = 'SNAP';

    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };

    slide.addText(`${fname}  ${fpath}  L${startLine}–${endLine}`, {
      x: px(PAD), y: 0, w: px(codeW), h: px(PAD),
      fontSize: 8, color: '888888', fontFace: 'Segoe UI', valign: 'middle',
    });

    slide.addImage({
      data: 'data:image/png;base64,' + pngBase64,
      x: px(PAD), y: px(PAD), w: px(codeW), h: px(codeH),
    });

    memoEntries.forEach((m, idx) => {
      const { y: my, h: mh } = memoLayouts[idx];
      const isRange   = m.type === 'range';
      const fillColor = isRange ? 'FFF0F0' : 'FEFCBF';
      const lineColor = isRange ? 'C89898' : 'C4AD30';

      const runs = [];
      if (m.snippet) {
        runs.push({ text: m.snippet + '\n', options: { fontSize: 8, color: 'AAAAAA', fontFace: 'Consolas' } });
      }
      runs.push({ text: m.text, options: { fontSize: 11, color: '222222', fontFace: 'Segoe UI' } });

      slide.addText(runs, {
        x: px(MEMO_X), y: px(my), w: px(MEMO_W), h: px(mh),
        fill: { color: fillColor },
        line: { color: lineColor, width: 1 },
        valign: 'top', margin: [8, 10, 8, 10], wrap: true,
      });

      const srcX = PAD + codeW;
      const srcY = PAD + 8 + m.li * LINE_H + LINE_H / 2;
      const dstY = my + mh / 2;
      const flip = srcY > dstY;
      slide.addShape(pptx.ShapeType.line, {
        x: px(srcX), y: px(Math.min(srcY, dstY)),
        w: px(CONN_W), h: px(Math.max(Math.abs(dstY - srcY), 1)),
        line: { color: 'C8A000', width: 1.5, dashType: 'dash' },
        ...(flip ? { flipV: true } : {}),
      });
    });

    await pptx.writeFile({ fileName: `${fname}_L${startLine}-${endLine}.pptx` });
    st('PowerPoint ファイルをダウンロードしました');
  } catch (e) {
    console.error('pptx error:', e);
    st('エラー: ' + e.message);
  }
}

// ---------- ヘルパー ----------

// colorLines (HTML span文字列の配列) → Canvas 直描画 → base64 PNG
function _codeToBase64(colorLines, startLine, width, height, lineH, fontSize, gutterW, lines, rangeHighlights, memoByLine) {
  const canvas = document.createElement('canvas');
  canvas.width  = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const font    = fontSize + 'px Consolas,"Courier New",monospace';
  const PAD_TOP  = 8;
  const PAD_LEFT = 8;
  const SEP_X    = gutterW - 1;
  const CODE_X   = gutterW + PAD_LEFT;

  // 背景
  ctx.fillStyle = '#252526';
  ctx.fillRect(0, 0, width, height);

  // ガター区切り線
  ctx.strokeStyle = '#3c3c3c';
  ctx.lineWidth   = 1;
  ctx.beginPath(); ctx.moveTo(SEP_X, 0); ctx.lineTo(SEP_X, height); ctx.stroke();

  ctx.font = font;
  // 実際のフォントレンダリングに基づく文字幅（固定値でなく実測）
  const chW = ctx.measureText('m').width;
  ctx.textBaseline = 'top';

  const parser = new DOMParser();

  // ---------- フェーズ1: colorLines を解析してブレース色と行開始深さを収集 ----------
  const bracketColors   = {};
  const lineStartDepth  = [];
  let bDepth = 0;

  colorLines.forEach(lineHtml => {
    lineStartDepth.push(bDepth);
    const doc = parser.parseFromString('<span>' + lineHtml + '</span>', 'text/html');
    const walk = (node, color) => {
      if (node.nodeType === Node.TEXT_NODE) {
        for (const ch of node.textContent) {
          if (ch === '{') { bDepth++; if (!bracketColors[bDepth]) bracketColors[bDepth] = color; }
          else if (ch === '}') bDepth = Math.max(0, bDepth - 1);
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const c = node.style?.color || color;
        node.childNodes.forEach(ch => walk(ch, c));
      }
    };
    doc.body.firstChild?.childNodes.forEach(ch => walk(ch, 'rgba(255,255,255,0.6)'));
  });

  // ---------- インデントガイド計算 ----------
  function leadingLen(text) {
    let n = 0;
    for (const c of text) { if (c === ' ' || c === '\u00a0') n++; else if (c === '\t') n += 4; else break; }
    return n;
  }
  const indentLengths = (lines || []).map(l => leadingLen(l)).filter(n => n > 0 && n <= 16);
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  let indentSize = indentLengths.length ? indentLengths.reduce(gcd) : 4;
  if (indentSize < 1 || indentSize > 8) indentSize = 4;
  const indentPx = chW * indentSize;

  const lineLevels = (lines || colorLines).map((text, i) =>
    Math.min(Math.floor(leadingLen(text) / indentSize), lineStartDepth[i] || 0)
  );
  for (let i = 0; i < lineLevels.length; i++) {
    if ((lines ? lines[i] : '').trim() === '') {
      lineLevels[i] = Math.min(i > 0 ? lineLevels[i-1] : 0, i < lineLevels.length-1 ? lineLevels[i+1] : 0);
    }
  }
  function toGuideColor(raw) {
    if (!raw) return 'rgba(255,255,255,0.2)';
    const m = raw.match(/rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\)/);
    return m ? `rgba(${m[1]},${m[2]},${m[3]},0.45)` : 'rgba(255,255,255,0.2)';
  }

  // ---------- フェーズ2: 行ハイライト＋レンジハイライト（テキスト描画の前） ----------
  colorLines.forEach((_, i) => {
    const y = PAD_TOP + i * lineH;
    // 行メモのある行は薄い黄色背景
    if (memoByLine && memoByLine[i] != null) {
      ctx.fillStyle = 'rgba(255,200,50,0.08)';
      ctx.fillRect(0, y, width, lineH);
    }
  });
  if (rangeHighlights) {
    colorLines.forEach((_, i) => {
      const ranges = rangeHighlights[i];
      if (!ranges) return;
      const y = PAD_TOP + i * lineH;
      ranges.forEach(({ from, to, visFrom, visTo }) => {
        const pFrom = visFrom !== undefined ? visFrom : from;
        const pTo   = visTo   !== undefined ? visTo   : to;
        const x1 = CODE_X + pFrom * chW;
        const w2 = Math.max((pTo - pFrom) * chW, 4);
        ctx.fillStyle = 'rgba(255,70,70,0.12)';
        ctx.fillRect(x1, y, w2, lineH);
        ctx.fillStyle = 'rgba(255,80,80,0.8)';
        ctx.fillRect(x1, y + lineH - 2, w2, 2);
      });
    });
  }

  // ---------- フェーズ3: テキスト描画 ----------
  colorLines.forEach((lineHtml, i) => {
    const y       = PAD_TOP + i * lineH + 3;
    const absLine = startLine + i;

    // 行番号
    ctx.fillStyle = '#606060';
    ctx.textAlign = 'right';
    ctx.fillText(String(absLine), SEP_X - 8, y);

    // コードトークン
    ctx.textAlign = 'left';
    let x = CODE_X;
    const doc = parser.parseFromString('<span>' + lineHtml + '</span>', 'text/html');
    const drawNode = (node, color) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent;
        if (text) { ctx.fillStyle = color; ctx.fillText(text, x, y); x += ctx.measureText(text).width; }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const c = node.style?.color || color;
        node.childNodes.forEach(ch => drawNode(ch, c));
      }
    };
    doc.body.firstChild?.childNodes.forEach(ch => drawNode(ch, '#d4d4d4'));
  });

  // ---------- フェーズ4: インデントガイド（テキストの上に半透明で描画） ----------
  (lines || []).forEach((text, i) => {
    const contentText = text.trimStart();
    let leadingClose = 0;
    for (let ci = 0; ci < contentText.length && contentText[ci] === '}'; ci++) leadingClose++;
    const braceLevel = Math.max(0, (lineStartDepth[i] || 0) - leadingClose);
    const wsLevel    = Math.max(lineLevels[i], Math.floor(leadingLen(text) / indentSize));
    const totalLevel = Math.max(braceLevel, wsLevel);
    if (totalLevel <= 0) return;
    const y = PAD_TOP + i * lineH;
    for (let l = 1; l <= totalLevel; l++) {
      ctx.fillStyle = l <= braceLevel ? toGuideColor(bracketColors[l]) : 'rgba(255,255,255,0.14)';
      ctx.fillRect(CODE_X + (l - 1) * indentPx, y, 1, lineH);
    }
  });

  return canvas.toDataURL('image/png').replace('data:image/png;base64,', '');
}

function _escXml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
