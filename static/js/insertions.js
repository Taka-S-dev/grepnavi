// ===== デバッグ仕込み挿入 (Alt+P) =====
// ダイアログの開閉、POST /api/insertions の送信、行シフトのクライアント側反映
// (localStorage 各マップ + in-memory graph.nodes) を担当する。
// サーバは ShiftLines を「挿入前」に適用済みなので、ここでは再計算せず
// サーバが返した ShiftResult をそのまま追従させるだけ (healAnchors と同じ規約)。

const LS_INSERT_PRESETS = 'grepnavi-insert-presets';
const LS_INSERT_LAST_GROUP = 'grepnavi-insert-last-group';

// 既存の仕込みからグループ名一覧を作る（datalist と撤去セレクトの共通ソース）。
function _insertionGroups() {
  const counts = new Map(); // name -> count（"" = 無グループ）
  for (const ins of (Array.isArray(graph?.insertions) ? graph.insertions : [])) {
    const g = ins.group || '';
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  return counts;
}

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
  // 複数行テンプレは全行にインデントを前置する（1行目だけだと段がずれる）。
  ta.value = body ? body.split('\n').map(l => indent + l).join('\n') : indent;
  const delBtn = document.getElementById('insert-dialog-del-preset');
  if (delBtn) delBtn.style.display = /^preset\d+$/.test(sel.value) ? '' : 'none';
}

// テンプレ select の再構築。selectId を渡すとそれを選択状態にする
// （プリセット保存直後に保存したものを選ぶため）。
function _rebuildTemplateSelect(selectId) {
  const sel = document.getElementById('insert-dialog-template');
  if (!sel) return;
  sel.innerHTML = '';
  _insertTemplates().forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.label;
    sel.appendChild(opt);
  });
  if (selectId && [...sel.options].some(o => o.value === selectId)) sel.value = selectId;
}

// 今の textarea の内容を名前付きテンプレとして保存する。保存するのは
// 「ダイアログを開いた行のインデントを除いた中身」— テンプレは挿入のたびに
// その場のインデントが前置されるので、保存時のインデントを含めると二重になる。
// {tag} {cond} {group} は文字列のまま保存され、次回の挿入時に展開される。
async function _saveInsertPreset() {
  const ta = document.getElementById('insert-dialog-ta');
  const indent = _insertDialogState?.indent || '';
  const lines = (ta?.value || '').split('\n').map(l =>
    indent && l.startsWith(indent) ? l.slice(indent.length) : l);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const template = lines.join('\n');
  if (!template.trim()) { st('保存する内容がありません'); return; }
  const name = await showInputModal('プリセットとして保存', 'プリセット名');
  if (!name) return;
  const presets = _insertPresets();
  presets.push({ label: name, template, needsCond: template.includes('{cond}') });
  localStorage.setItem(LS_INSERT_PRESETS, JSON.stringify(presets));
  _rebuildTemplateSelect('preset' + (presets.length - 1));
  _insertDialogRebuildTextarea();
  st(`プリセット「${name}」を保存しました`);
}

async function _deleteInsertPreset() {
  const sel = document.getElementById('insert-dialog-template');
  const m = /^preset(\d+)$/.exec(sel?.value || '');
  if (!m) return;
  const presets = _insertPresets();
  const name = presets[+m[1]]?.label || '';
  if (!confirm(`プリセット「${name}」を削除しますか？`)) return;
  presets.splice(+m[1], 1);
  localStorage.setItem(LS_INSERT_PRESETS, JSON.stringify(presets));
  _rebuildTemplateSelect('printf');
  _insertDialogRebuildTextarea();
  st(`プリセット「${name}」を削除しました`);
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

  _rebuildTemplateSelect();
  const fileLabel = document.getElementById('insert-dialog-file');
  if (fileLabel) fileLabel.textContent = tab.file.replace(/\\/g, '/') + ' : L' + line + ' の次に挿入';
  document.getElementById('insert-dialog-cond').value = '';

  // グループ: 既存グループ名を datalist で補完し、前回使ったものを既定にする
  // （連続で同じ調査に撒くのが典型パターンのため）。
  const groupInput = document.getElementById('insert-dialog-group');
  const groupList = document.getElementById('insert-dialog-group-list');
  if (groupInput && groupList) {
    groupList.innerHTML = '';
    for (const name of [..._insertionGroups().keys()].filter(Boolean).sort()) {
      const opt = document.createElement('option');
      opt.value = name;
      groupList.appendChild(opt);
    }
    groupInput.value = localStorage.getItem(LS_INSERT_LAST_GROUP) || '';
  }
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
  // textarea の末尾の空行 (Enter だけで終わったもの) はダイアログの操作痕跡であって
  // 意図した挿入内容ではないので落とす。ただし途中の空行はユーザが意図的に
  // 入れた空行かもしれないので残す。
  while (textLines.length && textLines[textLines.length - 1].trim() === '') textLines.pop();
  if (!textLines.length) { st('挿入する内容を入力してください'); return; }
  const group = (document.getElementById('insert-dialog-group')?.value || '').trim();
  localStorage.setItem(LS_INSERT_LAST_GROUP, group);
  closeInsertDialog();
  await submitInsert(file, line, textLines, group);
}

async function submitInsert(file, line, textLines, group) {
  const r = await fetch('/api/insertions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file, line, lines: textLines, group: group || '' }),
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
  if (typeof updateInsertionBadge === 'function') updateInsertionBadge();
  if (typeof renderMemoList === 'function' && typeof _memoListOpen !== 'undefined' && _memoListOpen) renderMemoList();
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
  // 連鎖する移動 (::5→::6 と ::6→::7) を1件ずつ適用すると、適用順次第で
  // 移動先が既存キーに見えて取りこぼす。_stageKeyMoves (graph.js、healAnchors と共有)
  // で全 source を退避してから書き戻す。
  _stageKeyMoves(m, Object.entries(moves));
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
          glyphMarginHoverMessage: { value: `デバッグ行 ${ins.id}: ${site.text}` },
          overviewRuler: {
            color: 'rgba(160,100,220,0.8)',
            position: monaco.editor.OverviewRulerLane.Right,
          },
        },
      });
    }
  }
  insertionDecoIds = monacoEditor.deltaDecorations(insertionDecoIds, decos);
  _updateInsertionCtxKey();
}

// ===== 仕込み一覧・書き換え・撤去 (memo-list.js の行から呼ばれる) =====

// 409 (手動変更あり) を一度でも返した仕込み ID。一覧に「手動変更」チップを出すためだけの
// UI 状態で、サーバ側の真実の記録ではない (再試行して成功すれば消す)。
const _insertionManualChangeIds = new Set();

// PUT/DELETE 共通のステータス別文言。403 は書き込み無効 (-host 指定時など)。
function _insertionWriteErrorMessage(r, id) {
  if (r && r.status === 409) return '手動変更があるため操作できません (' + id + ')';
  if (r && r.status === 403) return 'この構成ではファイル書き込みが無効です (-host 指定時など)';
  return '操作に失敗しました' + (r ? ` (${r.status})` : ' (通信エラー)');
}

async function _deleteInsertion(item) {
  const r = await fetch("/api/insertions/" + encodeURIComponent(item._insId), { method: "DELETE" }).catch(() => null);
  if (!r || !r.ok) {
    if (r && r.status === 409) { _insertionManualChangeIds.add(item._insId); renderMemoList(); }
    st(_insertionWriteErrorMessage(r, item._insId));
    return;
  }
  const d = await r.json();
  for (const s of d.shifts || []) applyShift(s);
  _insertionManualChangeIds.delete(item._insId);
  graph.insertions = (graph.insertions || []).filter((i) => i.id !== item._insId);
  await pollActiveFile();
  refreshInsertionDecorations();
  renderMemoList();
  updateInsertionBadge();
  st(item._insId + " を撤去しました");
}

// 一覧の ✎ ボタンとエディタ右クリックの両方から呼ぶ: showInputModal で
// site テキストを編集 → PUT → graph.insertions の該当エントリを差し替える。
// siteIdx は一覧からは常に 0 (sites[0] を表示しているため)、右クリックからは
// カーソル行に一致した site。
async function _rewriteInsertion(item, siteIdx = 0) {
  const newTextRaw = await showInputModal('デバッグ行を書き換え', 'テキスト', item.memo);
  if (newTextRaw == null) return;
  // textarea 由来だと改行が混ざりうる。サーバは複数行を 400 で弾くので事前に単一行化する。
  const newText = newTextRaw.replace(/[\r\n]+/g, ' ').trim();
  if (!newText) { st('挿入する内容を入力してください'); return; }
  if (await _putInsertionText(item._insId, siteIdx, newText)) {
    st(item._insId + ' を書き換えました');
  }
}

// PUT の共通部。書き換えモーダルと Tab 字下げの両方から呼ぶ。
// 成功時は graph.insertions を差し替えてから再描画する。
async function _putInsertionText(insId, siteIdx, newText) {
  const r = await fetch("/api/insertions/" + encodeURIComponent(insId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ site: siteIdx, new_text: newText }),
  }).catch(() => null);
  if (!r || !r.ok) {
    if (r && r.status === 409) { _insertionManualChangeIds.add(insId); renderMemoList(); }
    st(_insertionWriteErrorMessage(r, insId));
    return false;
  }
  const d = await r.json();
  const idx = (graph.insertions || []).findIndex((i) => i.id === insId);
  if (idx >= 0) graph.insertions[idx] = d.insertion;
  else { if (!Array.isArray(graph.insertions)) graph.insertions = []; graph.insertions.push(d.insertion); }
  _insertionManualChangeIds.delete(insId);
  await pollActiveFile();
  refreshInsertionDecorations();
  renderMemoList();
  return true;
}

// デバッグ行の字下げ単位。前の行 (無ければ自分) のインデントにタブが
// 使われていればタブ、そうでなければスペース4つ — ファイルの流儀に合わせる。
function _indentUnitAt(line) {
  const model = monacoEditor?.getModel();
  if (!model) return '\t';
  for (const ln of [line - 1, line]) {
    if (ln < 1 || ln > model.getLineCount()) continue;
    const ind = (model.getLineContent(ln).match(/^[ \t]*/) || [''])[0];
    if (ind.includes('\t')) return '\t';
    if (ind.length) return '    ';
  }
  return '\t';
}

// カーソル行のデバッグ行を1段字下げ (delta>0) / 字上げ (delta<0) する。
async function _indentInsertionAtCursor(delta) {
  const hit = _insertionSiteAtCursor();
  if (!hit) return;
  const site = hit.ins.sites[hit.siteIdx];
  let text = site.text;
  if (delta > 0) {
    text = _indentUnitAt(site.line) + text;
  } else if (text.startsWith('\t')) {
    text = text.slice(1);
  } else {
    text = text.replace(/^ {1,4}/, '');
  }
  if (text === site.text) return; // 既に行頭
  await _putInsertionText(hit.ins.id, hit.siteIdx, text);
}

// ヘッダの「全部撤去」ボタンとグループ撤去セレクト。skipped (手動変更等で
// 撤去できなかった分) は一覧から消さず、理由を st にまとめて出す。
// group: undefined = 全部、"" = 無グループのみ、"x" = そのグループのみ
// （サーバ側は「フィールド省略」と「空文字」をポインタで区別する）。
async function removeAllInsertions(group) {
  const all = graph?.insertions || [];
  const targets = group === undefined ? all : all.filter((i) => (i.group || '') === group);
  const n = targets.length;
  if (!n) return;
  const label = group === undefined ? 'すべて' : group === '' ? '無グループの' : `グループ「${group}」の`;
  if (!confirm(`${label}デバッグ行 ${n} 件を撤去します。よろしいですか？`)) return;

  const r = await fetch('/api/insertions/removeall', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: group === undefined ? '{}' : JSON.stringify({ group }),
  }).catch(() => null);
  if (!r || !r.ok) {
    if (r && r.status === 403) st('この構成ではファイル書き込みが無効です (-host 指定時など)');
    else st('全部撤去に失敗しました');
    return;
  }
  const d = await r.json();
  for (const s of d.shifts || []) applyShift(s);
  const removed = new Set(d.removed || []);
  graph.insertions = (graph.insertions || []).filter((i) => !removed.has(i.id));
  if (typeof pollActiveFile === "function") await pollActiveFile();
  await loadGraph();
  updateInsertionBadge();
  if (d.skipped && d.skipped.length) {
    st(`${removed.size} 件撤去 / ${d.skipped.length} 件スキップ: ` +
       d.skipped.map((s) => `${s.id} (${s.reason})`).join(', '));
  } else {
    st(`デバッグ行 ${removed.size} 件を撤去しました`);
  }
}

// ツールバーの残数バッジ + マーク一覧ヘッダの「全部撤去」ボタンの表示切替。
// 両方とも「今開いているとは限らないパネル要素」なので null ガード必須。
function updateInsertionBadge() {
  const n = (graph?.insertions || []).length;
  const badge = document.getElementById('insertion-badge');
  if (badge) {
    badge.style.display = n ? '' : 'none';
    badge.textContent = 'デバッグ行 ' + n;
  }
  const removeAllBtn = document.getElementById('memo-list-removeall-insertions');
  if (removeAllBtn) removeAllBtn.style.display = n ? '' : 'none';

  // グループ撤去セレクト: 名前付きグループが1つ以上あるときだけ出す
  // （グループ未使用のユーザに余計な UI を見せない）。
  const sel = document.getElementById('memo-list-insgroup-remove');
  if (sel) {
    const counts = _insertionGroups();
    const named = [...counts.keys()].filter(Boolean).sort();
    sel.style.display = named.length ? '' : 'none';
    if (named.length) {
      sel.innerHTML = '';
      const ph = document.createElement('option');
      ph.value = '';
      ph.textContent = 'デバッグ行グループ撤去…';
      sel.appendChild(ph);
      for (const name of named) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = `${name} (${counts.get(name)})`;
        sel.appendChild(opt);
      }
      if (counts.has('')) {
        const opt = document.createElement('option');
        opt.value = ' ungrouped'; // 先頭が空白 = 無グループの番兵 (グループ名は trim 済み)
        opt.textContent = `無グループ (${counts.get('')})`;
        sel.appendChild(opt);
      }
    }
  }
}

// ===== エディタ右クリックメニュー (仕込み行の上でのみ表示) =====

// カーソル行に一致する仕込み site を返す。無ければ null。
function _insertionSiteAtCursor() {
  const file = tabs[activeTabIdx]?.file;
  const line = monacoEditor?.getPosition()?.lineNumber;
  if (!file || !line) return null;
  for (const ins of (Array.isArray(graph?.insertions) ? graph.insertions : [])) {
    if (!_samePath(ins.file, file)) continue;
    const siteIdx = (ins.sites || []).findIndex((s) => s.line === line);
    if (siteIdx >= 0) return { ins, siteIdx };
  }
  return null;
}

// 「仕込み行の上にいるか」のコンテキストキー。Monaco のコンテキストメニューは
// precondition が false の項目を出さないので、これで表示自体を絞る。
// カーソル移動だけでなく挿入・撤去・タブ切替でも変わるため、
// refreshInsertionDecorations (全変化点から呼ばれる) でも更新する。
let _insertionCtxKey = null;

function _updateInsertionCtxKey() {
  _insertionCtxKey?.set(!!_insertionSiteAtCursor());
}

function registerInsertionEditorActions() {
  if (!monacoEditor || _insertionCtxKey) return;
  _insertionCtxKey = monacoEditor.createContextKey('grepnaviOnInsertionLine', false);
  monacoEditor.onDidChangeCursorPosition(_updateInsertionCtxKey);

  monacoEditor.addAction({
    id: 'grepnavi-insertion-rewrite', label: 'デバッグ行を書き換え',
    contextMenuGroupId: 'grepnavi-mark', contextMenuOrder: 2.5,
    precondition: 'grepnaviOnInsertionLine',
    run: () => {
      const hit = _insertionSiteAtCursor();
      if (!hit) return;
      _rewriteInsertion({ _insId: hit.ins.id, memo: hit.ins.sites[hit.siteIdx].text }, hit.siteIdx);
    },
  });
  monacoEditor.addAction({
    id: 'grepnavi-insertion-delete', label: 'デバッグ行を撤去',
    contextMenuGroupId: 'grepnavi-mark', contextMenuOrder: 2.6,
    precondition: 'grepnaviOnInsertionLine',
    run: () => {
      const hit = _insertionSiteAtCursor();
      if (hit) _deleteInsertion({ _insId: hit.ins.id });
    },
  });
  // Tab / Shift+Tab はデバッグ行の上でだけ字下げ・字上げとして働く。
  // keybindingContext で縛るので、通常の行では Monaco 既定の挙動のまま。
  monacoEditor.addAction({
    id: 'grepnavi-insertion-indent', label: 'デバッグ行を字下げ',
    keybindings: [monaco.KeyCode.Tab],
    keybindingContext: 'grepnaviOnInsertionLine',
    precondition: 'grepnaviOnInsertionLine',
    run: () => _indentInsertionAtCursor(1),
  });
  monacoEditor.addAction({
    id: 'grepnavi-insertion-outdent', label: 'デバッグ行を字上げ',
    keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.Tab],
    keybindingContext: 'grepnaviOnInsertionLine',
    precondition: 'grepnaviOnInsertionLine',
    run: () => _indentInsertionAtCursor(-1),
  });
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
  const btnSavePreset = document.getElementById('insert-dialog-save-preset');
  const btnDelPreset = document.getElementById('insert-dialog-del-preset');
  if (btnSavePreset) btnSavePreset.onclick = _saveInsertPreset;
  if (btnDelPreset) btnDelPreset.onclick = _deleteInsertPreset;
  modal.addEventListener('click', (e) => { if (e.target === modal) closeInsertDialog(); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeInsertDialog(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); _insertDialogSubmit(); }
    else if (e.key === 'Tab') {
      // textarea 内では Tab はフォーカス移動ではなく字下げ操作にする。
      // Shift+Tab はカーソル行の行頭からタブ1つ (無ければスペース最大4つ) を外す。
      e.preventDefault();
      const start = ta.selectionStart, end = ta.selectionEnd;
      if (e.shiftKey) {
        const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
        const head = ta.value.slice(lineStart);
        const m = head.match(/^(\t| {1,4})/);
        if (!m) return;
        ta.value = ta.value.slice(0, lineStart) + ta.value.slice(lineStart + m[1].length);
        const pos = Math.max(lineStart, start - m[1].length);
        ta.selectionStart = ta.selectionEnd = pos;
      } else {
        ta.value = ta.value.slice(0, start) + '\t' + ta.value.slice(end);
        ta.selectionStart = ta.selectionEnd = start + 1;
      }
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
