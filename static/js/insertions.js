// ===== デバッグ仕込み挿入 (Alt+P) =====
// ダイアログの開閉、POST /api/insertions の送信、行シフトのクライアント側反映
// (localStorage 各マップ + in-memory graph.nodes) を担当する。
// サーバは ShiftLines を「挿入前」に適用済みなので、ここでは再計算せず
// サーバが返した ShiftResult をそのまま追従させるだけ (healAnchors と同じ規約)。

const LS_INSERT_PRESETS = 'grepnavi-insert-presets';

// {cond} を使わないテンプレは needsCond:false → 条件入力欄を隠す。
const _INSERT_BUILTIN_TEMPLATES = [
  { id: 'printf',      label: 'printf',        template: 'printf("[{tag}] %s:%d\\n", __func__, __LINE__);', needsCond: false },
  { id: 'cond_printf', label: '条件付き printf', template: 'if ({cond}) printf("[{tag}] %s:%d\\n", __func__, __LINE__);', needsCond: true },
  { id: 'free',        label: '自由入力',       template: '', needsCond: false },
];

function _insertPresets() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_INSERT_PRESETS) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function _insertTemplates() {
  return [
    ..._INSERT_BUILTIN_TEMPLATES,
    ..._insertPresets().map((p, i) => ({
      id: 'preset' + i,
      label: p.label || ('プリセット' + (i + 1)),
      template: p.template || '',
      needsCond: !!p.needsCond,
    })),
  ];
}

// ダイアログを開いた時点のカーソル行情報。テンプレ切替のたびに
// インデントを再計算しない (カーソル行のインデントを「そのまま前置」する仕様)。
let _insertDialogState = null; // {file, line, indent}

function _insertDialogRebuildTextarea() {
  const sel = document.getElementById('insert-dialog-template');
  const condInput = document.getElementById('insert-dialog-cond');
  const ta = document.getElementById('insert-dialog-ta');
  if (!sel || !condInput || !ta) return;
  const templates = _insertTemplates();
  const tpl = templates.find(t => t.id === sel.value) || templates[0];
  condInput.style.display = tpl.needsCond ? '' : 'none';
  const cond = condInput.value.trim() || 'cond';
  const body = tpl.needsCond ? tpl.template.replace('{cond}', cond) : tpl.template;
  const indent = _insertDialogState?.indent || '';
  ta.value = body ? indent + body : indent;
}

function openInsertDialog() {
  const ed = monacoEditor;
  const tab = tabs[activeTabIdx];
  if (!ed || !tab?.file) { st('挿入対象のファイルがありません'); return; }
  const pos = ed.getPosition();
  const line = pos?.lineNumber;
  if (!line) return;
  const model = ed.getModel();
  const lineContent = model ? model.getLineContent(line) : '';
  const indent = (lineContent.match(/^[ \t]*/) || [''])[0];
  _insertDialogState = { file: tab.file, line, indent };

  const sel = document.getElementById('insert-dialog-template');
  sel.innerHTML = '';
  _insertTemplates().forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.label;
    sel.appendChild(opt);
  });
  const fileLabel = document.getElementById('insert-dialog-file');
  if (fileLabel) fileLabel.textContent = tab.file.replace(/\\/g, '/') + ' : L' + line + ' の次に挿入';
  document.getElementById('insert-dialog-cond').value = '';
  _insertDialogRebuildTextarea();

  document.getElementById('insert-dialog-modal')?.classList.add('open');
  setTimeout(() => document.getElementById('insert-dialog-ta')?.focus(), 0);
}

function closeInsertDialog() {
  document.getElementById('insert-dialog-modal')?.classList.remove('open');
  _insertDialogState = null;
}

async function _insertDialogSubmit() {
  if (!_insertDialogState) { closeInsertDialog(); return; }
  const { file, line } = _insertDialogState;
  const ta = document.getElementById('insert-dialog-ta');
  // textarea の内容は改行区切りが仕様なので、送信直前に \n で分割し \r を落とす。
  // サーバは要素内の改行混入を 400 で弾く (記録行数と実際の行数がずれると
  // 以後の照合が壊れるため) — ここで確実に満たす。
  const textLines = (ta?.value || '').split('\n').map(l => l.replace(/\r/g, ''));
  if (!textLines.length || textLines.every(l => l.trim() === '')) { st('挿入する内容を入力してください'); return; }
  closeInsertDialog();
  await submitInsert(file, line, textLines);
}

async function submitInsert(file, line, textLines) {
  const r = await fetch('/api/insertions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file, line, lines: textLines }),
  }).catch(() => null);
  if (!r || !r.ok) { st(await _insertErrorMessage(r)); return; }
  const d = await r.json();
  applyShift(d.shift);
  // GraphResponse.Insertions は omitempty なので、この project 初の挿入だと
  // ロード直後の graph.insertions は undefined。ここで初期化してから積む。
  if (graph && !Array.isArray(graph.insertions)) graph.insertions = [];
  if (graph?.insertions) graph.insertions.push(d.insertion);
  await pollActiveFile(); // 変更したファイルを即再読込 (2秒のポーリング待ちをしない)
  refreshInsertionDecorations();
  st(`${d.insertion.id} を挿入しました`);
}

// ステータス別の文言。415/422 はエンコーディング起因で利用者にできることが
// 違う (415=そもそも編集不可、422=文字を変えれば通る可能性がある) ので分ける。
async function _insertErrorMessage(r) {
  if (!r) return '挿入に失敗しました (通信エラー)';
  if (r.status === 415) return 'このファイルのエンコーディングには挿入できません';
  if (r.status === 422) return 'ファイルのエンコーディングで表現できない文字が含まれています';
  if (r.status === 403) return '書き込みが無効か、対象がルート外です';
  let msg = '';
  try { msg = (await r.json())?.error || ''; } catch { /* ignore */ }
  return `挿入に失敗しました (${r.status}${msg ? ': ' + msg : ''})`;
}

// 挿入・撤去による行シフトをクライアント側の状態へ反映する。
// サーバは既に移動済みなので再保存はしない (healAnchors と同じ規約)。
function applyShift(shift) {
  if (!shift) return;
  for (const [id, line] of Object.entries(shift.node_moves || {})) {
    if (graph?.nodes?.[id]?.match) graph.nodes[id].match.line = line;
  }
  _moveKeys('grepnavi-line-memos', shift.memo_key_moves);
  _moveKeys('grepnavi-line-memo-categories', shift.memo_key_moves);
  _moveKeys('grepnavi-line-memo-sources', shift.memo_key_moves);
  _dropKeys('grepnavi-line-memos', shift.memo_keys_dropped);
  _dropKeys('grepnavi-line-memo-categories', shift.memo_keys_dropped);
  _dropKeys('grepnavi-line-memo-sources', shift.memo_keys_dropped);
  _moveKeys('grepnavi-bookmarks', shift.bookmark_key_moves);
  _dropKeys('grepnavi-bookmarks', shift.bookmark_keys_dropped);
  _applyRangeShift(shift.range_moves, shift.ranges_dropped);

  if (typeof renderCurrent === 'function') renderCurrent();
  if (typeof refreshGraphDecorations === 'function') refreshGraphDecorations();
  if (typeof refreshLineMemoDecorations === 'function') refreshLineMemoDecorations();
  if (typeof refreshBookmarkDecorations === 'function') refreshBookmarkDecorations();
  if (typeof refreshRangeMemoDecorations === 'function') refreshRangeMemoDecorations();
  // サーバは既に保存済みなので再保存しない (healAnchors と同じ規約)。
}

function _moveKeys(storageKey, moves) {
  if (!moves || !Object.keys(moves).length) return;
  let m;
  try { m = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { return; }
  for (const [from, to] of Object.entries(moves)) {
    if (from in m && !(to in m)) { m[to] = m[from]; delete m[from]; }
  }
  localStorage.setItem(storageKey, JSON.stringify(m));
}

// dropped: 挿入/撤去先の行そのものが消えたキー群。移動先が無いので単純削除する。
function _dropKeys(storageKey, dropped) {
  if (!dropped || !dropped.length) return;
  let m;
  try { m = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { return; }
  for (const k of dropped) delete m[k];
  localStorage.setItem(storageKey, JSON.stringify(m));
}

// range memos は "file::line" キー方式ではなく {id, file, startLine, endLine, ...}
// の配列 (grepnavi-range-memos) なので、id をキーに startLine/endLine を
// 直接書き換える専用の適用ロジックにする。
function _applyRangeShift(rangeMoves, rangesDropped) {
  const hasMoves = rangeMoves && Object.keys(rangeMoves).length;
  const hasDrops = rangesDropped && rangesDropped.length;
  if (!hasMoves && !hasDrops) return;
  if (typeof getRangeMemos !== 'function' || typeof saveRangeMemos !== 'function') return;
  const dropSet = new Set(rangesDropped || []);
  const arr = getRangeMemos().filter(m => !dropSet.has(m.id));
  if (hasMoves) {
    for (const m of arr) {
      const nv = rangeMoves[m.id];
      if (nv) { m.startLine = nv[0]; m.endLine = nv[1]; }
    }
  }
  saveRangeMemos(arr); // 内部で _scheduleMemoSave も呼ぶ
}

// ===== アクティブファイルの仕込み行装飾 (背景 + ガター + overviewRuler) =====
let insertionDecoIds = [];

function refreshInsertionDecorations() {
  if (!monacoEditor) return;
  const file = tabs[activeTabIdx]?.file;
  if (!file) {
    insertionDecoIds = monacoEditor.deltaDecorations(insertionDecoIds, []);
    return;
  }
  const insertions = Array.isArray(graph?.insertions) ? graph.insertions : [];
  const decos = [];
  for (const ins of insertions) {
    if (!ins.enabled || !_samePath(ins.file, file)) continue;
    for (const site of (ins.sites || [])) {
      decos.push({
        range: new monaco.Range(site.line, 1, site.line, 1),
        options: {
          isWholeLine: true,
          className: 'insertion-line-deco',
          glyphMarginClassName: 'insertion-glyph',
          glyphMarginHoverMessage: { value: `仕込み ${ins.id}: ${site.text}` },
          overviewRuler: {
            color: 'rgba(160,100,220,0.8)',
            position: monaco.editor.OverviewRulerLane.Right,
          },
        },
      });
    }
  }
  insertionDecoIds = monacoEditor.deltaDecorations(insertionDecoIds, decos);
}

// ===== ダイアログの結線 (DOMContentLoaded 後、他の init と同じタイミング) =====
function _initInsertDialog() {
  const modal = document.getElementById('insert-dialog-modal');
  const sel = document.getElementById('insert-dialog-template');
  const condInput = document.getElementById('insert-dialog-cond');
  const ta = document.getElementById('insert-dialog-ta');
  const btnOk = document.getElementById('insert-dialog-ok');
  const btnCancel = document.getElementById('insert-dialog-cancel');
  if (!modal || !sel || !condInput || !ta || !btnOk || !btnCancel) return;

  sel.addEventListener('change', _insertDialogRebuildTextarea);
  condInput.addEventListener('input', _insertDialogRebuildTextarea);
  btnOk.onclick = _insertDialogSubmit;
  btnCancel.onclick = closeInsertDialog;
  modal.addEventListener('click', (e) => { if (e.target === modal) closeInsertDialog(); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeInsertDialog(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); _insertDialogSubmit(); }
    else if (e.key === 'Tab') {
      // textarea 内では Tab はフォーカス移動ではなくタブ文字挿入にする。
      e.preventDefault();
      const start = ta.selectionStart, end = ta.selectionEnd;
      ta.value = ta.value.slice(0, start) + '\t' + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = start + 1;
    }
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initInsertDialog);
  } else {
    _initInsertDialog();
  }
}
