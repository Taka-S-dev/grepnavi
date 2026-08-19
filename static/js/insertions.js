// ===== デバッグ行の挿入 (Alt+P) =====
// ダイアログの開閉、POST /api/insertions の送信、行シフトのクライアント側反映
// (localStorage 各マップ + in-memory graph.nodes) を担当する。
// サーバは ShiftLines を「挿入前」に適用済みなので、ここでは再計算せず
// サーバが返した ShiftResult をそのまま追従させるだけ (healAnchors と同じ規約)。

const LS_INSERT_PRESETS = 'grepnavi-insert-presets';
const LS_INSERT_LAST_GROUP = 'grepnavi-insert-last-group';
const LS_INSERT_LAST_TPL = 'grepnavi-insert-last-template';

// 前回選んだテンプレート。id とラベルの両方を覚えるのは、プリセットの id が
// 並び順 (preset0, preset1...) だからで、間に1つ消えると別のプリセットを
// 指してしまう。ラベル一致を優先し、無ければ id、どちらも無ければ既定へ落とす。
function _rememberTemplate(sel) {
  const opt = sel?.selectedOptions?.[0];
  if (!opt) return;
  try { localStorage.setItem(LS_INSERT_LAST_TPL, JSON.stringify({ id: opt.value, label: opt.textContent })); } catch { /* ignore */ }
}

function _lastTemplateId() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LS_INSERT_LAST_TPL) || 'null'); } catch { /* ignore */ }
  if (!saved) return '';
  const templates = _insertTemplates();
  const byLabel = templates.find(t => t.label === saved.label);
  if (byLabel) return byLabel.id;
  return templates.some(t => t.id === saved.id) ? saved.id : '';
}

// 既存のデバッグ行からグループ名一覧を作る（datalist と撤去メニューの共通ソース）。
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

// 最後にテンプレートから組み立てた内容。利用者が手を入れたかどうかの判定に使う。
let _insertDialogGenerated = null;

// force=false のときは、利用者が textarea に手を入れていたら組み直さない。
// 条件式は1文字打つたびにここへ来るので、無条件に組み直すと書きかけが
// キーストロークごとに消える（しかも value 代入なので Ctrl+Z でも戻らない）。
// テンプレートを選び直したときは「その内容が欲しい」という意思表示なので組み直す。
function _insertDialogRebuildTextarea(force = false) {
  const sel = document.getElementById('insert-dialog-template');
  const condInput = document.getElementById('insert-dialog-cond');
  const ta = document.getElementById('insert-dialog-ta');
  if (!sel || !condInput || !ta) return;
  const templates = _insertTemplates();
  const tpl = templates.find(t => t.id === sel.value) || templates[0];
  condInput.style.display = tpl.needsCond ? '' : 'none';
  const delBtn = document.getElementById('insert-dialog-del-preset');
  if (delBtn) delBtn.style.display = /^preset\d+$/.test(sel.value) ? '' : 'none';
  if (!force && _insertDialogGenerated !== null && ta.value !== _insertDialogGenerated) return;

  const cond = condInput.value.trim() || 'cond';
  const body = tpl.needsCond ? tpl.template.replace('{cond}', cond) : tpl.template;
  const indent = _insertDialogState?.indent || '';
  // 複数行テンプレは全行にインデントを前置する（1行目だけだと段がずれる）。
  ta.value = body ? body.split('\n').map(l => indent + l).join('\n') : indent;
  _insertDialogGenerated = ta.value;
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
  _rememberTemplate(document.getElementById('insert-dialog-template'));
  _insertDialogRebuildTextarea(true);
  st(`プリセット「${name}」を保存しました`);
}

async function _deleteInsertPreset() {
  const sel = document.getElementById('insert-dialog-template');
  const m = /^preset(\d+)$/.exec(sel?.value || '');
  if (!m) return;
  const presets = _insertPresets();
  const name = presets[+m[1]]?.label || '';
  const proceed = typeof showConfirm === 'function'
    ? await showConfirm(`プリセット「${name}」を削除しますか？`, { danger: true })
    : confirm(`プリセット「${name}」を削除しますか？`);
  if (!proceed) return;
  presets.splice(+m[1], 1);
  localStorage.setItem(LS_INSERT_PRESETS, JSON.stringify(presets));
  _rebuildTemplateSelect('printf');
  // 消したプリセットを次回も選ぼうとしないよう、記憶も今の選択に合わせる。
  _rememberTemplate(document.getElementById('insert-dialog-template'));
  _insertDialogRebuildTextarea(true);
  st(`プリセット「${name}」を削除しました`);
}

function openInsertDialog() {
  const ed = monacoEditor;
  const tab = tabs[activeTabIdx];
  if (!ed || !tab?.file) { st('挿入対象のファイルがありません'); return; }
  // 開いたままエディタを触れるようになったので、Alt+P を二度押しできてしまう。
  // 開き直すと入力欄がテンプレートで上書きされ、書きかけが消える。
  if (document.getElementById('insert-dialog-modal')?.classList.contains('open')) {
    document.getElementById('insert-dialog-ta')?.focus();
    st('挿入ダイアログは開いています');
    return;
  }
  const pos = ed.getPosition();
  const line = pos?.lineNumber;
  if (!line) return;
  const model = ed.getModel();
  const lineContent = model ? model.getLineContent(line) : '';
  const indent = (lineContent.match(/^[ \t]*/) || [''])[0];
  // 開いたまま別の操作 (囲み・一括 ON/OFF など) で行がずれても、狙った場所へ
  // 入れられるよう、行の中身も控える。送信時に照合して位置を取り直す。
  _insertDialogState = { file: tab.file, line, indent, lineText: lineContent };

  // テンプレートも前回の選択から始める（グループと同じく、同じ調査では
  // 同じ形を続けて撒くのが典型のため）。
  _rebuildTemplateSelect(_lastTemplateId());
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
  _insertDialogGenerated = null; // 開き直しは前回の内容を引き継がない
  _insertDialogRebuildTextarea(true);

  const modal = document.getElementById('insert-dialog-modal');
  modal?.classList.add('open');
  // ピークが中央に居座っていると開いた瞬間から下敷きになるので、前へ出す。
  window.raiseAbovePeeks?.(modal);
  restorePanel(document.getElementById('insert-dialog-modal-box'), 'insert-dialog');
  refreshInsertTargetDecoration(true);
  monacoEditor.revealLineInCenterIfOutsideViewport(line);
  setTimeout(() => document.getElementById('insert-dialog-ta')?.focus(), 0);
}

function closeInsertDialog() {
  const modal = document.getElementById('insert-dialog-modal');
  modal?.classList.remove('open');
  // 前面化で付けた重なり順は残さない (次に開いたときは CSS の既定から始める)。
  if (modal) modal.style.zIndex = '';
  _insertDialogState = null;
  clearTimeout(_insertPulseTimer);
  refreshInsertTargetDecoration(); // 目印を消す (状態を null にした後に呼ぶ)
}

// 開いた時点の行が、今どこにあるか。ダイアログは開いたままエディタを操作できる
// ので、その間に囲みや一括 ON/OFF で行がずれうる。控えておいた行の中身と
// 照合し、一意に見つかったときだけ位置を取り直す (ピン追従と同じ規約:
// 曖昧なら動かさず、元の行番号のまま送る)。
function _resolveInsertLine(state) {
  const model = tabs[activeTabIdx]?.model;
  if (!model || !_samePath(tabs[activeTabIdx]?.file, state.file)) return state.line;
  const at = state.line <= model.getLineCount() ? model.getLineContent(state.line) : null;
  if (at !== null && at === state.lineText) return state.line;
  let found = 0, hit = 0;
  for (let i = 1; i <= model.getLineCount(); i++) {
    if (model.getLineContent(i) !== state.lineText) continue;
    if (++found > 1) return state.line;
    hit = i;
  }
  return found === 1 ? hit : state.line;
}

async function _insertDialogSubmit() {
  if (!_insertDialogState) { closeInsertDialog(); return; }
  const { file } = _insertDialogState;
  const line = _resolveInsertLine(_insertDialogState);
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
  // 開いている間に行がずれていたら、どこへ入れたのかを黙って変えない。
  if (line !== _insertDialogState.line) {
    st(`開いている間に行が動いたため L${_insertDialogState.line} → L${line} へ挿入します`);
  }
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

// ===== アクティブファイルのデバッグ行装飾 (背景 + ガター + overviewRuler) =====
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
    if (!_samePath(ins.file, file)) continue;
    // OFF (コメントアウト中) の行も装飾は出す — 消すと右クリックで ON に
    // 戻す入口ごと見えなくなる。色をグレーに落として状態だけ区別する。
    const off = ins.enabled === false;
    for (const site of (ins.sites || [])) {
      decos.push({
        range: new monaco.Range(site.line, 1, site.line, 1),
        options: {
          isWholeLine: true,
          className: off ? 'insertion-line-deco-off' : 'insertion-line-deco',
          glyphMarginClassName: off ? 'insertion-glyph-off' : 'insertion-glyph',
          glyphMarginHoverMessage: { value: `デバッグ行 ${ins.id}${off ? ' (OFF)' : ''}: ${site.text}` },
          overviewRuler: {
            color: off ? 'rgba(128,128,128,0.5)' : 'rgba(160,100,220,0.8)',
            position: monaco.editor.OverviewRulerLane.Right,
          },
        },
      });
    }
  }
  insertionDecoIds = monacoEditor.deltaDecorations(insertionDecoIds, decos);
  _updateInsertionCtxKey();
  // 挿入先の目印も同じ変化点で貼り直す (setValue で装飾が飛ぶため)。
  refreshInsertTargetDecoration();
}

// ===== 挿入先の目印 (ダイアログを開いている間だけ) =====
// ダイアログを開いたままエディタを触れるので、挿入先を見失いやすい。
// 行がずれても _resolveInsertLine で追い直し、常に「今の」挿入先を指す。
let _insertTargetDecoIds = [];
let _insertTargetModel = null;
let _insertPulseTimer = null;
let _insertPulseFlip = false;

// 付けたモデルへ直接返して消す。タブごとにモデルが違い、エディタ経由の
// deltaDecorations は「今表示しているモデル」しか対象にしないので、タブを
// 切り替えてから消そうとすると前のタブに装飾が残ったまま消せなくなる。
function _clearInsertTargetDeco() {
  if (_insertTargetDecoIds.length && _insertTargetModel && !_insertTargetModel.isDisposed?.()) {
    _insertTargetModel.deltaDecorations(_insertTargetDecoIds, []);
  }
  _insertTargetDecoIds = [];
  _insertTargetModel = null;
}

function refreshInsertTargetDecoration(pulse = false) {
  if (!monacoEditor) return;
  const state = _insertDialogState;
  const open = document.getElementById('insert-dialog-modal')?.classList.contains('open');
  const file = tabs[activeTabIdx]?.file;
  const model = monacoEditor.getModel();
  if (!open || !state || !file || !model || !_samePath(file, state.file)) {
    _clearInsertTargetDeco();
    return;
  }
  const line = _resolveInsertLine(state);
  // 表示も今の行に合わせる。開いた時点の番号のままだと、実際の挿入先と食い違う。
  const label = document.getElementById('insert-dialog-file');
  if (label) label.textContent = state.file.replace(/\\/g, '/') + ' : L' + line + ' の次に挿入';
  // 脈打たせるクラスは2種類を交互に使う。同じクラス名を貼り直しても CSS の
  // アニメーションは再生され直さず、続けて押したときに反応が無いように見える。
  if (pulse) _insertPulseFlip = !_insertPulseFlip;
  const pulseCls = pulse ? (_insertPulseFlip ? ' insert-target-pulse-a' : ' insert-target-pulse-b') : '';
  _clearInsertTargetDeco();
  _insertTargetModel = model;
  _insertTargetDecoIds = model.deltaDecorations([], [{
    range: new monaco.Range(line, 1, line, 1),
    options: {
      isWholeLine: true,
      className: 'insert-target-deco' + pulseCls,
      glyphMarginClassName: 'insert-target-glyph',
      glyphMarginHoverMessage: { value: 'この行の次にデバッグ行が入ります' },
      overviewRuler: { color: 'rgba(80,200,255,0.9)', position: monaco.editor.OverviewRulerLane.Right },
    },
  }]);
  if (pulse) {
    // 数回だけ脈打たせて静かなハイライトへ落とす。点滅し続けると、書いている間
    // ずっと視界の端で動くことになる。
    clearTimeout(_insertPulseTimer);
    _insertPulseTimer = setTimeout(() => refreshInsertTargetDecoration(false), 1500);
  }
}

// 挿入先へスクロールして戻る。フォーカスは動かさない (書きかけの入力欄から抜けない)。
function revealInsertTarget() {
  if (!monacoEditor || !_insertDialogState) return;
  const file = tabs[activeTabIdx]?.file;
  if (!file || !_samePath(file, _insertDialogState.file)) return;
  monacoEditor.revealLineInCenter(_resolveInsertLine(_insertDialogState));
}

// ===== デバッグ行の一覧・書き換え・撤去 (memo-list.js の行から呼ばれる) =====

// 409 (手動変更あり) を一度でも返したデバッグ行 ID。一覧に「手動変更」チップを出すためだけの
// UI 状態で、サーバ側の真実の記録ではない (再試行して成功すれば消す)。
const _insertionManualChangeIds = new Set();

// PUT/DELETE 共通のステータス別文言。403 は書き込み無効 (-host 指定時など)。
// 400 の「行が連続していない」は、囲みか、間に別のデバッグ行が割り込んだ
// ケース。「失敗しました (400)」だけでは何をすればよいか分からないので分ける。
function _insertionWriteErrorMessage(r, id, body) {
  if (r && r.status === 409) return '手動変更があるため操作できません (' + id + ')';
  if (r && r.status === 403) return 'この構成ではファイル書き込みが無効です (-host 指定時など)';
  if (r && r.status === 400 && /not contiguous/.test(body || '')) {
    return 'この行はまとめて書き換えられません（行が連続していません）';
  }
  return '操作に失敗しました' + (r ? ` (${r.status})` : ' (通信エラー)');
}

// 撤去を Ctrl+Z で戻せる残り時間。控えはサーバが持っているので、ここが覚えるのは
// 「今 Ctrl+Z を押したらデバッグ行の話になる」という窓だけ。窓を切らないと、忘れた頃の
// Ctrl+Z が黙って撤去を戻し、押した本人はグラフ側が戻ると思っている。
// メモ削除の undo (memo-list.js) と同じ 30 秒に揃える。
const _INSERTION_UNDO_MS = 30000;
let _insertionUndoTimer = null;
let _insertionUndoPending = false;

function _armInsertionUndo() {
  _insertionUndoPending = true;
  clearTimeout(_insertionUndoTimer);
  _insertionUndoTimer = setTimeout(() => { _insertionUndoPending = false; }, _INSERTION_UNDO_MS);
}

function _disarmInsertionUndo() {
  _insertionUndoPending = false;
  clearTimeout(_insertionUndoTimer);
}

// 直前の1操作 (撤去・移動) の取り消し。どちらを戻すかはサーバの控えが決める。
// 戻せない理由 (ファイルが変わった、ID が再採番された) もサーバが判定するので、
// ここでは結果をそのまま伝える — 黙って何も起きないのが一番困る。
async function undoInsertionChange() {
  _disarmInsertionUndo();
  const r = await fetch('/api/insertions/restore', { method: 'POST' }).catch(() => null);
  if (!r || !r.ok) {
    let reason = '';
    try { reason = (await r.json()).error || ''; } catch { /* 応答なし・非 JSON */ }
    st('デバッグ行を戻せません' + (reason ? ': ' + reason : ''));
    return;
  }
  const d = await r.json();
  for (const sh of d.shifts || []) applyShift(sh);
  // 撤去戻しなら記録は消えている、移動戻しなら古い位置のまま残っている。
  // 同じ ID を除いてから積み直せば、どちらでも1件になる。
  graph.insertions = (graph.insertions || []).filter((i) => i.id !== d.insertion.id).concat([d.insertion]);
  await pollActiveFile();
  refreshInsertionDecorations();
  renderMemoList();
  updateInsertionBadge();
  st(d.insertion.id + (d.kind === 'move' ? ' を元の場所へ戻しました' : ' を戻しました'));
}

// Ctrl+Z を他所へ譲るか。撤去はエディタの右クリックからが主なので、直後はほぼ必ず
// Monaco がフォーカスを持っている。エディタは読み取り専用 (editor.js の readOnly) で
// 戻すものが無く、ここで譲ると撤去の取り消しが永久に届かない。書き換え可能に
// なったときだけ譲る。Monaco のフォーカスを先に判定するのは、その実体が隠し
// textarea で、下の入力欄判定に引っかかってしまうため。
function _undoBelongsElsewhere() {
  if (typeof monacoEditor !== 'undefined' && monacoEditor?.hasTextFocus?.()) {
    return !monacoEditor.getRawOptions?.().readOnly;
  }
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || !!document.activeElement?.isContentEditable;
}

// グローバル Ctrl+Z の1段目。撤去直後の窓の中だけ発火し、それ以外は後続の
// listener (memo-list.js のメモ復元 → app.js の graph undo) へ素通しする。
// この listener が先に走るのは index.html の読み込み順による (insertions.js が上)。
// capture で受けるのは Monaco 自身のキーバインドより先に出るため — Monaco は
// 処理したキーの伝播を止めるので、bubble で待つと届かないことがある。
document.addEventListener('keydown', e => {
  if (e.key !== 'z' || !(e.ctrlKey || e.metaKey) || e.shiftKey) return;
  if (!_insertionUndoPending) return;
  if (_undoBelongsElsewhere()) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  undoInsertionChange();
}, true);

async function _deleteInsertion(item) {
  const r = await fetch("/api/insertions/" + encodeURIComponent(item._insId), { method: "DELETE" }).catch(() => null);
  if (!r || !r.ok) {
    if (r && r.status === 409) {
      _insertionManualChangeIds.add(item._insId);
      renderMemoList();
      // 手動で行を消された・書き換えられた記録はここで詰みになる（409 が
      // 出続ける）。ファイルに触らない後始末を、その場で明示の確認つきで出す。
      const proceed = typeof showConfirm === 'function'
        ? await showConfirm('記録した行がファイルで見つかりません（手動で削除・変更された可能性）。' + String.fromCharCode(10) +
            '記録だけ削除しますか？ ファイルの行には触りません。' + String.fromCharCode(10) +
            '複数行の記録では、まだ残っている行もファイルに残ります。', { danger: true })
        : false;
      if (proceed) await _deleteInsertionRecordOnly(item._insId);
      else st(_insertionWriteErrorMessage(r, item._insId));
      return;
    }
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
  _armInsertionUndo();
  st(item._insId + " を撤去しました (Ctrl+Z で戻せます)");
}

// デバッグ行を移動する。撤去して入れ直すのと違って ID を保つのが要点で、本文に
// 焼き込まれた {tag} と実行時の出力が食い違わない。line の意味は挿入と同じ
// 「この行の後ろ」。行メモの移動と違って別ファイルへも移せる — 記録がファイルを
// 持っているので移せてしまい、禁じる理由もない（置き場所を間違えたときに効く）。
async function moveInsertion(insId, file, line) {
  const before = (graph?.insertions || []).find((i) => i.id === insId);
  const r = await fetch('/api/insertions/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: insId, file, line }),
  }).catch(() => null);
  if (!r || !r.ok) { st(await _moveInsertionErrorMessage(r, insId)); return; }
  const d = await r.json();
  for (const sh of d.shifts || []) applyShift(sh);
  graph.insertions = (graph.insertions || []).filter((i) => i.id !== d.insertion.id).concat([d.insertion]);
  await pollActiveFile();
  refreshInsertionDecorations();
  renderMemoList();
  updateInsertionBadge();
  _armInsertionUndo();
  const where = before && !_samePath(before.file, d.insertion.file)
    ? `${shortPath(d.insertion.file)}:L${d.insertion.sites?.[0]?.line}`
    : `L${d.insertion.sites?.[0]?.line}`;
  st(`${d.insertion.id} を ${where} へ移しました (Ctrl+Z で戻せます)`);
}

// マーク一覧の ⇅ から。移動先はエディタのカーソル行で、対象は一覧で選んだ行。
// 「移動先だけ決まっていて対象を選びたい」ときの入口 (移動モードはその逆)。
async function moveInsertionToCursor(item) {
  const cur = typeof monacoEditor !== 'undefined' && monacoEditor?.getPosition();
  const file = tabs[activeTabIdx]?.file;
  if (!cur || !file) { st('移動先の行をエディタで開き、カーソルを置いてから押してください'); return; }
  await moveInsertion(item._insId, file, cur.lineNumber);
}

// 400 は移動できない形の説明が要る (押せてしまう操作なので、断る理由まで言う)。
// それ以外は撤去・書き換えと同じ文言に寄せる。
async function _moveInsertionErrorMessage(r, id) {
  if (r && r.status === 400) {
    let msg = '';
    try { msg = (await r.json())?.error || ''; } catch { /* ignore */ }
    if (/wrap/.test(msg)) return '囲みは移動できません（対象コードを挟む形が壊れます）';
    if (/already is/.test(msg)) return 'すでにその場所です';
    if (/out of range/.test(msg)) return 'そのファイルにはその行がありません';
    if (/contiguous/.test(msg)) return 'この行はまとめて移動できません（行が連続していません）';
    return '移動できません' + (msg ? ': ' + msg : '');
  }
  return _insertionWriteErrorMessage(r, id);
}

// ===== 移動モード (デバッグ行を右クリック → 移動先をクリック) =====
// 対象を先に選び、移動先はマウスで指す。右クリックした時点でカーソルはその
// デバッグ行の上にあるので、「カーソル行へ移動」では自分自身を指してしまう。
// 別ファイルへも移せるので、モード中のタブ切り替えは取り消さない。
let _insMoveState = null; // { insId }
let _insMoveDecoIds = [];
let _insMoveModel = null;
let _insMoveDisposables = [];
let _insMoveLine = 0;

// 装飾は付けたモデルへ直接返して消す。タブごとにモデルが違い、エディタ経由の
// deltaDecorations は今表示中のモデルしか対象にしない (挿入先の目印と同じ理由)。
function _clearInsMoveDeco() {
  if (_insMoveDecoIds.length && _insMoveModel && !_insMoveModel.isDisposed?.()) {
    _insMoveModel.deltaDecorations(_insMoveDecoIds, []);
  }
  _insMoveDecoIds = [];
  _insMoveModel = null;
}

function _paintInsMoveTarget(line) {
  const model = monacoEditor?.getModel();
  if (!model || !line) { _clearInsMoveDeco(); return; }
  if (_insMoveModel === model && _insMoveDecoIds.length && _insMoveLine === line) return;
  _clearInsMoveDeco();
  _insMoveLine = line;
  _insMoveModel = model;
  _insMoveDecoIds = model.deltaDecorations([], [{
    range: new monaco.Range(line, 1, line, 1),
    options: {
      isWholeLine: true,
      className: 'insmove-target-deco',
      glyphMarginClassName: 'insmove-target-glyph',
      glyphMarginHoverMessage: { value: 'この行の次へ移します' },
      overviewRuler: { color: 'rgba(160,100,220,0.9)', position: monaco.editor.OverviewRulerLane.Right },
    },
  }]);
}

function startInsertionMove(insId) {
  if (!monacoEditor) return;
  endInsertionMove();
  _insMoveState = { insId };
  document.body.classList.add('insmove-active');
  // マウスは行の上を通るので、通った行をそのまま移動先の候補として描く。
  _insMoveDisposables.push(monacoEditor.onMouseMove((e) => {
    if (_insMoveState) _paintInsMoveTarget(e.target?.position?.lineNumber);
  }));
  _insMoveDisposables.push(monacoEditor.onMouseDown((e) => {
    if (!_insMoveState) return;
    // 右クリックはモードを抜けるだけ (メニューを出したいのに移動が起きると驚く)。
    if (e.event?.rightButton) { endInsertionMove(); st('移動をやめました'); return; }
    const line = e.target?.position?.lineNumber;
    const file = tabs[activeTabIdx]?.file;
    if (!line || !file) return;
    const id = _insMoveState.insId;
    endInsertionMove();
    moveInsertion(id, file, line);
  }));
  document.addEventListener('keydown', _insMoveKey, true);
  st(`${insId} の移動先をクリックしてください (Esc で取消)`);
}

// Esc は capture で受ける。Monaco 自身も Esc を持っているので、bubble で待つと
// 届かないことがある (Ctrl+Z の1段目と同じ事情)。
function _insMoveKey(e) {
  if (e.key !== 'Escape' || !_insMoveState) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  endInsertionMove();
  st('移動をやめました');
}

function endInsertionMove() {
  if (!_insMoveState && !_insMoveDisposables.length) return;
  _insMoveState = null;
  _insMoveLine = 0;
  _clearInsMoveDeco();
  document.body.classList.remove('insmove-active');
  document.removeEventListener('keydown', _insMoveKey, true);
  for (const d of _insMoveDisposables) d.dispose?.();
  _insMoveDisposables = [];
}

// 記録だけの削除。サーバ側は「行が照合できないとき」しか通さないので、
// 生きているデバッグ行を管理外に残す事故にはならない。
async function _deleteInsertionRecordOnly(insId) {
  const r = await fetch('/api/insertions/' + encodeURIComponent(insId) + '?record_only=1',
                        { method: 'DELETE' }).catch(() => null);
  if (!r || !r.ok) { st(_insertionWriteErrorMessage(r, insId)); return; }
  _insertionManualChangeIds.delete(insId);
  graph.insertions = (graph.insertions || []).filter((i) => i.id !== insId);
  refreshInsertionDecorations();
  renderMemoList();
  updateInsertionBadge();
  st(insId + ' の記録を削除しました（ファイルは変更していません）');
}

// まとめて（行を増減しつつ）書き換えてよいレコードか。サーバ側の判定と
// 同じ規則にする — 食い違うと、押せるのに 400 で断られる操作ができてしまう。
// 囲みは対象コードを挟む構造なので丸ごと置き換えてはいけない。kind が無い
// 古い記録もあるため、ガード行の形でも見分ける。
function _canBlockEdit(ins) {
  const sites = ins?.sites || [];
  if (!sites.length || ins.kind === 'wrap') return false;
  const guard = (text, re) => re.test(String(text || '').trim().replace(/^\/\/\s*/, ''));
  if (sites.length === 2 && (guard(sites[0].text, /^#if 0/) || guard(sites[1].text, /^#endif/))) return false;
  const lines = sites.map((s) => s.line).sort((a, b) => a - b);
  return lines.every((l, i) => l === lines[0] + i);
}

// 一覧の ✎ ボタンとエディタ右クリックの両方から呼ぶ。
// 連続レコードは全行を textarea で開き、行を増減してよい (PUT の lines)。
// 囲みのような非連続レコードは、カーソル位置の 1 行だけを書き換える。
// siteIdx は一覧からは常に 0、右クリックからはカーソル行に一致した site。
async function _rewriteInsertion(item, siteIdx = 0) {
  const ins = (graph?.insertions || []).find((i) => i.id === item._insId);
  const block = _canBlockEdit(ins);
  // code: 等幅・広い枠で開き、行頭の字下げを保つ。trim すると Tab で付けた
  // 段が書き換えのたびに消えてしまう。
  const raw = await showInputModal(
    block ? 'デバッグ行を書き換え（行を増減できます）' : 'デバッグ行を書き換え',
    block ? '1行ずつ挿入されます' : 'テキスト',
    block ? ins.sites.map((s) => s.text).join('\n') : item.memo,
    { code: true, multiline: block });
  if (raw == null) return;

  if (!block) {
    // 貼り付けで改行が混ざりうる。1 行の置き換えなので事前に単一行化する。
    const newText = raw.replace(/[\r\n]+/g, ' ');
    if (!newText.trim()) { st('挿入する内容を入力してください'); return; }
    if (await _putInsertionText(item._insId, siteIdx, newText)) {
      st(item._insId + ' を書き換えました');
    }
    return;
  }

  const lines = raw.split('\n').map((l) => l.replace(/\r/g, ''));
  // 末尾の空行は入力の操作痕跡。途中の空行は意図した空行かもしれないので残す。
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (!lines.length) { st('挿入する内容を入力してください'); return; }
  if (await _putInsertionLines(item._insId, lines)) {
    const n = ins.sites.length;
    st(item._insId + ' を書き換えました' + (lines.length !== n ? `（${n} 行 → ${lines.length} 行）` : ''));
  }
}

// PUT の共通部。書き換えモーダルと Tab 字下げの両方から呼ぶ。
// 成功時は graph.insertions を差し替えてから再描画する。
async function _putInsertionText(insId, siteIdx, newText) {
  return _putInsertion(insId, { site: siteIdx, new_text: newText });
}

// 全行の差し替え。行数が変わるので、サーバが返すシフトを他の記録へ反映する。
async function _putInsertionLines(insId, lines) {
  return _putInsertion(insId, { lines });
}

async function _putInsertion(insId, body) {
  const r = await fetch("/api/insertions/" + encodeURIComponent(insId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!r || !r.ok) {
    if (r && r.status === 409) { _insertionManualChangeIds.add(insId); renderMemoList(); }
    let errText = '';
    try { errText = (await r.clone().json())?.error || ''; } catch { /* ignore */ }
    st(_insertionWriteErrorMessage(r, insId, errText));
    // 記録の食い違い (クライアント側の行番号が古い) が原因のことがあるので、
    // 正本を読み直してから諦める。次の操作は最新の状態で判断できる。
    if (r && r.status === 400) await loadGraph();
    return false;
  }
  const d = await r.json();
  // 行数が変わった場合だけ shift が返る。1 行の置き換えでは行が動かない。
  if (d.shift) {
    applyShift(d.shift); // localStorage 側のメモ・ブックマークを追従させる
    // 同じファイルの他のデバッグ行も動いている。graph.insertions はここでは
    // 追従できない (シフトの対象外) ので、サーバから読み直す。
    await loadGraph();
  } else {
    const idx = (graph.insertions || []).findIndex((i) => i.id === insId);
    if (idx >= 0) graph.insertions[idx] = d.insertion;
    else { if (!Array.isArray(graph.insertions)) graph.insertions = []; graph.insertions.push(d.insertion); }
  }
  _insertionManualChangeIds.delete(insId);
  await pollActiveFile();
  refreshInsertionDecorations();
  renderMemoList();
  // OFF の記録を書き換えて ON に直った場合に、バッジの OFF 件数も合わせる。
  updateInsertionBadge();
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

// デバッグ行の一時 OFF (行頭 // でコメントアウト) / ON (コメント解除)。
// 撤去と違って行位置の記録が生きたままなので、何度でも往復できる。
// opts: {id} で1件 / {group} でそのグループ ("" は無グループ) / どちらも無し = 全部。
async function toggleInsertions(opts) {
  const body = { enabled: !!opts.enabled };
  if (opts.id) body.id = opts.id;
  else if (opts.group !== undefined) body.group = opts.group;
  const r = await fetch('/api/insertions/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!r || !r.ok) { st(_insertionWriteErrorMessage(r, opts.id || '')); return; }
  const d = await r.json();
  for (const u of d.insertions || []) {
    const idx = (graph.insertions || []).findIndex((i) => i.id === u.id);
    if (idx >= 0) graph.insertions[idx] = u;
  }
  await pollActiveFile();
  refreshInsertionDecorations();
  renderMemoList();
  updateInsertionBadge();
  const verb = opts.enabled ? 'ON' : 'OFF (コメントアウト)';
  const n = (d.toggled || []).length;
  if (d.skipped && d.skipped.length) {
    st(`${n} 件を ${verb} / ${d.skipped.length} 件スキップ: ` +
       d.skipped.map((s) => `${s.id} (${s.reason})`).join(', '));
  } else if (n) {
    st(`デバッグ行 ${n} 件を ${verb} にしました`);
  } else {
    st('対象がありません (既にその状態です)');
  }
}

// 選択範囲を #if 0 / #endif で囲む。既存行は書き換えず前後に1行ずつ挿入する
// だけなので、撤去すれば完全に元へ戻る。グループ・ON/OFF・撤去は printf の
// デバッグ行とまったく同じに扱える (2 sites の1レコード)。
async function wrapSelectionInIfZero() {
  const ed = monacoEditor;
  const tab = tabs[activeTabIdx];
  if (!ed || !tab?.file) { st('対象のファイルがありません'); return; }
  const sel = ed.getSelection();
  if (!sel || sel.isEmpty()) { st('囲む範囲を選択してください'); return; }
  let startLine = sel.startLineNumber, endLine = sel.endLineNumber;
  // 行頭 (次行の0文字目) まで伸びた選択は、その行を含める意図ではない。
  if (endLine > startLine && sel.endColumn === 1) endLine--;
  const group = await showInputModal('選択範囲を #if 0 で囲む', 'グループ (空欄可)',
    localStorage.getItem(LS_INSERT_LAST_GROUP) || '');
  if (group == null) return;
  const g = group.trim();
  localStorage.setItem(LS_INSERT_LAST_GROUP, g);

  const r = await fetch('/api/insertions/wrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: tab.file, start_line: startLine, end_line: endLine, group: g }),
  }).catch(() => null);
  if (!r || !r.ok) { st(await _insertErrorMessage(r)); return; }
  const d = await r.json();
  for (const s of d.shifts || []) applyShift(s);
  if (graph && !Array.isArray(graph.insertions)) graph.insertions = [];
  if (graph?.insertions) graph.insertions.push(d.insertion);
  await pollActiveFile();
  refreshInsertionDecorations();
  updateInsertionBadge();
  if (typeof renderMemoList === 'function' && typeof _memoListOpen !== 'undefined' && _memoListOpen) renderMemoList();
  st(`${d.insertion.id} で L${startLine}–L${endLine} を #if 0 で囲みました`);
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
  const msg = group === undefined ? `デバッグ行 ${n} 件をすべて撤去します。よろしいですか？`
    : group === '' ? `無グループのデバッグ行 ${n} 件を撤去します。よろしいですか？`
    : `グループ「${group}」のデバッグ行 ${n} 件を撤去します。よろしいですか？`;
  const proceed = typeof showConfirm === 'function'
    ? await showConfirm(msg, { danger: true })
    : confirm(msg);
  if (!proceed) return;

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
  // サーバはまとめ撤去で1件戻しの控えを捨てる。こちらの窓も閉じないと、
  // Ctrl+Z がグラフ undo へ落ちずにエラーだけ出す。
  _disarmInsertionUndo();
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
  const all = graph?.insertions || [];
  const n = all.length;
  const off = all.filter((i) => i.enabled === false).length;
  const badge = document.getElementById('insertion-badge');
  if (badge) {
    badge.style.display = n ? '' : 'none';
    badge.textContent = 'デバッグ行 ' + n + (off ? ` (OFF ${off})` : '');
  }
  const removeAllBtn = document.getElementById('memo-list-removeall-insertions');
  if (removeAllBtn) removeAllBtn.style.display = n ? '' : 'none';

  // グループ撤去ボタン: 名前付きグループが1つ以上あるときだけ出す
  // （グループ未使用のユーザに余計な UI を見せない）。
  const grpBtn = document.getElementById('memo-list-insgroup-remove');
  if (grpBtn) {
    const named = [..._insertionGroups().keys()].filter(Boolean);
    grpBtn.style.display = named.length ? '' : 'none';
  }
  // ON/OFF ボタンはデバッグ行が1件でもあれば出す (グループ未使用でも使える)。
  const toggleBtn = document.getElementById('memo-list-instoggle');
  if (toggleBtn) toggleBtn.style.display = n ? '' : 'none';
}

// デバッグ行まわりのポップアップメニューの共通部。select は「閉じているときに
// 選択中の項目を表示する」部品なので、命令メニューに使うと見出し行が必要になって
// 紛らわしい。右クリックメニューと同じ見た目のポップアップに、命令だけを並べる。
// items: [{label, run, checked}]。checked は「今その状態」を示すだけで、押せる。
function _showInsMenu(anchorEl, items) {
  hideInsGroupMenu();
  if (!items.length) return;
  const menu = document.createElement('div');
  menu.id = 'insgroup-menu';
  // チェック印を使うメニューだけ印の列を作る。使わないメニュー (撤去・ON/OFF)
  // にも列を空けると、全項目が理由もなく右へずれる。
  const hasCheck = items.some((it) => it.checked);
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'tab-ctx-item';
    if (hasCheck) {
      // 印は固定幅の枠に入れる。テキストへ空白を足す方式は、HTML の空白
      // 畳み込みに引っかかると幅が出ず、印の有無で文字位置がずれる。
      const mark = document.createElement('span');
      mark.className = 'ins-menu-check';
      mark.textContent = it.checked ? '✓' : '';
      el.appendChild(mark);
    }
    el.appendChild(document.createTextNode(it.label));
    el.onclick = () => { hideInsGroupMenu(); it.run(); };
    menu.appendChild(el);
  }
  document.body.appendChild(menu);
  // 画面外にはみ出さないよう、実寸を測ってから収める。
  const r = anchorEl.getBoundingClientRect();
  const box = menu.getBoundingClientRect();
  const below = r.bottom + 2;
  menu.style.left = Math.max(4, Math.min(r.left, window.innerWidth - box.width - 4)) + 'px';
  menu.style.top = (below + box.height <= window.innerHeight - 4
    ? below
    : Math.max(4, r.top - box.height - 2)) + 'px'; // 下に入らなければアンカーの上へ
  // 開くきっかけの mousedown 自体で即閉じないよう、次の tick で外側クリック監視を張る
  setTimeout(() => document.addEventListener('mousedown', _insGroupMenuOutside), 0);
  document.addEventListener('keydown', _insGroupMenuKey, true);
}

// Escape で閉じる。マウスを動かさずに取り消せる方が速い。
// capture 段階で受けて stopImmediatePropagation するのは、document に付いた
// 他の Escape 処理 (フローティング定義・エクスプローラのメニュー等) と
// 二重に発火させないため。同じ document 上の listener は stopPropagation では止まらない。
function _insGroupMenuKey(e) {
  if (e.key !== 'Escape') return;
  e.stopImmediatePropagation();
  e.preventDefault();
  hideInsGroupMenu();
}

// グループ撤去メニュー。
// 各 show* の先頭で閉じるのは、項目が空で早期 return する経路でも
// 開きっぱなしのメニューを残さないため (_showInsMenu まで届かない)。
function showInsGroupMenu(anchorBtn) {
  hideInsGroupMenu();
  const counts = _insertionGroups();
  const named = [...counts.keys()].filter(Boolean).sort();
  if (!named.length) return;
  const items = named.map((name) => ({
    label: `「${name}」を撤去 (${counts.get(name)}件)`,
    run: () => removeAllInsertions(name),
  }));
  if (counts.has('')) {
    items.push({ label: `無グループを撤去 (${counts.get('')}件)`, run: () => removeAllInsertions('') });
  }
  _showInsMenu(anchorBtn, items);
}

// ON/OFF メニュー。件数 0 の項目は出さない (押しても何も起きない項目を並べない)。
function showInsToggleMenu(anchorBtn) {
  hideInsGroupMenu();
  const all = Array.isArray(graph?.insertions) ? graph.insertions : [];
  if (!all.length) return;
  const items = [];
  const add = (label, opts) => items.push({ label, run: () => toggleInsertions(opts) });
  const counts = new Map(); // group -> {on, off}（"" = 無グループ）
  for (const ins of all) {
    const g = ins.group || '';
    const c = counts.get(g) || { on: 0, off: 0 };
    if (ins.enabled === false) c.off++; else c.on++;
    counts.set(g, c);
  }
  const onTotal = all.filter((i) => i.enabled !== false).length;
  const offTotal = all.length - onTotal;
  if (onTotal) add(`すべて OFF (${onTotal}件)`, { enabled: false });
  if (offTotal) add(`すべて ON (${offTotal}件)`, { enabled: true });
  const named = [...counts.keys()].filter(Boolean).sort();
  for (const name of named) {
    const c = counts.get(name);
    if (c.on) add(`「${name}」を OFF (${c.on}件)`, { group: name, enabled: false });
    if (c.off) add(`「${name}」を ON (${c.off}件)`, { group: name, enabled: true });
  }
  // 無グループ項目は名前付きグループがあるときだけ (無ければ「すべて」と同じで冗長)。
  if (named.length && counts.has('')) {
    const c = counts.get('');
    if (c.on) add(`無グループを OFF (${c.on}件)`, { group: '', enabled: false });
    if (c.off) add(`無グループを ON (${c.off}件)`, { group: '', enabled: true });
  }
  _showInsMenu(anchorBtn, items);
}

// 1件のデバッグ行の所属グループを選ぶメニュー。既存グループから選べるように
// するのは、手入力だと表記ゆれで別グループになってしまうため。
function showInsGroupPicker(anchorEl, insId) {
  hideInsGroupMenu();
  const ins = (graph?.insertions || []).find((i) => i.id === insId);
  if (!ins) return;
  const cur = ins.group || '';
  const items = [];
  for (const name of [..._insertionGroups().keys()].filter(Boolean).sort()) {
    items.push({ label: `「${name}」へ移す`, checked: name === cur, run: () => _setInsertionGroup(insId, name) });
  }
  if (cur) items.push({ label: '無グループにする', run: () => _setInsertionGroup(insId, '') });
  items.push({
    label: '新しいグループ…',
    run: async () => {
      const name = await showInputModal('デバッグ行のグループ', 'グループ名', cur);
      if (name == null) return;
      await _setInsertionGroup(insId, name.trim());
    },
  });
  _showInsMenu(anchorEl, items);
}

// テキスト中に「グループ名そのもの」が現れているか。{group} の展開結果は
// [GN1|name] のように区切り文字に挟まれるので、前後が語の一部でない出現だけを
// 数える。境界を ASCII だけで判定すると日本語名 (「テスト」が「テストデータ」に
// 当たる等) で誤検知が残るため、Unicode プロパティで語構成文字を判定する。
// 名前に正規表現の特殊文字が入りうるのでエスケープしてから使う。
function _textMentionsGroup(sites, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(^|[^\\p{L}\\p{N}_])' + esc + '([^\\p{L}\\p{N}_]|$)', 'u');
  return sites.some((s) => re.test(s.text));
}

async function _setInsertionGroup(insId, group) {
  const before = (graph?.insertions || []).find((i) => i.id === insId);
  const oldGroup = before?.group || '';
  // 同じ名前を選んだ・入力したときも「効かないボタン」に見えないよう一言返す
  // （チェック印の付いた項目も押せるので、この経路は普通に踏まれる）。
  if (group === oldGroup) { st('グループは変わっていません'); return; }
  const r = await fetch('/api/insertions/group', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: insId, group }),
  }).catch(() => null);
  if (!r || !r.ok) { st(_insertionWriteErrorMessage(r, insId)); return; }
  const d = await r.json();
  const idx = (graph.insertions || []).findIndex((i) => i.id === insId);
  if (idx >= 0) graph.insertions[idx] = d.insertion;
  renderMemoList();
  updateInsertionBadge();
  // {group} は挿入時にテキストへ焼き込まれるので、付け替えても実行時の出力は
  // 古い名前のまま。それが起きている行のときだけ知らせる (毎回言うと雑音)。
  // 単純な部分一致だと "io" のような短い名前が無関係な語に当たるため、
  // 識別子の一部になっていない出現だけを見る (完全な判定はできない)。
  const stale = oldGroup && _textMentionsGroup(d.insertion.sites || [], oldGroup);
  const dest = group ? `「${group}」` : '無グループ';
  st(`${insId} を ${dest} へ移しました` +
     (stale ? `（挿入テキストの「${oldGroup}」はそのままです。必要なら書き換えてください）` : ''));
}

function _insGroupMenuOutside(e) {
  if (e.target.closest('#insgroup-menu')) return;
  hideInsGroupMenu();
}

function hideInsGroupMenu() {
  document.removeEventListener('mousedown', _insGroupMenuOutside);
  document.removeEventListener('keydown', _insGroupMenuKey, true);
  document.getElementById('insgroup-menu')?.remove();
}

// ===== エディタ右クリックメニュー (デバッグ行の上でのみ表示) =====

// カーソル行に一致するデバッグ行の site を返す。無ければ null。
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

// 「デバッグ行の上にいるか」のコンテキストキー。Monaco のコンテキストメニューは
// precondition が false の項目を出さないので、これで表示自体を絞る。
// カーソル移動だけでなく挿入・撤去・タブ切替でも変わるため、
// refreshInsertionDecorations (全変化点から呼ばれる) でも更新する。
// grepnaviInsertionOff は OFF/ON をメニュー項目の出し分けに使う
// (「OFF にする」と「ON に戻す」を同時に出さない)。
let _insertionCtxKey = null;
let _insertionOffCtxKey = null;

function _updateInsertionCtxKey() {
  const hit = _insertionSiteAtCursor();
  _insertionCtxKey?.set(!!hit);
  _insertionOffCtxKey?.set(!!hit && hit.ins.enabled === false);
}

function registerInsertionEditorActions() {
  if (!monacoEditor || _insertionCtxKey) return;
  _insertionCtxKey = monacoEditor.createContextKey('grepnaviOnInsertionLine', false);
  _insertionOffCtxKey = monacoEditor.createContextKey('grepnaviInsertionOff', false);
  monacoEditor.onDidChangeCursorPosition(_updateInsertionCtxKey);

  // 挿入 (1, editor.js) の次: 選択があるときだけ出す。
  monacoEditor.addAction({
    id: 'grepnavi-insertion-wrap', label: '選択範囲を #if 0 で囲む',
    contextMenuGroupId: '3_debug', contextMenuOrder: 2,
    precondition: 'editorHasSelection',
    run: () => wrapSelectionInIfZero(),
  });

  monacoEditor.addAction({
    id: 'grepnavi-insertion-rewrite', label: 'デバッグ行を書き換え',
    contextMenuGroupId: '3_debug', contextMenuOrder: 3,
    precondition: 'grepnaviOnInsertionLine',
    run: () => {
      const hit = _insertionSiteAtCursor();
      if (!hit) return;
      _rewriteInsertion({ _insId: hit.ins.id, memo: hit.ins.sites[hit.siteIdx].text }, hit.siteIdx);
    },
  });
  // ON/OFF は排他で片方だけ出す。対象は site 単位ではなくデバッグ行1件の
  // 全 sites (囲みの #if 0 / #endif ペアを片方だけ OFF にすると壊れるため)。
  monacoEditor.addAction({
    id: 'grepnavi-insertion-off', label: 'デバッグ行を OFF (コメントアウト)',
    contextMenuGroupId: '3_debug', contextMenuOrder: 4,
    precondition: 'grepnaviOnInsertionLine && !grepnaviInsertionOff',
    run: () => {
      const hit = _insertionSiteAtCursor();
      if (hit) toggleInsertions({ id: hit.ins.id, enabled: false });
    },
  });
  monacoEditor.addAction({
    id: 'grepnavi-insertion-on', label: 'デバッグ行を ON (コメント解除)',
    contextMenuGroupId: '3_debug', contextMenuOrder: 4,
    precondition: 'grepnaviOnInsertionLine && grepnaviInsertionOff',
    run: () => {
      const hit = _insertionSiteAtCursor();
      if (hit) toggleInsertions({ id: hit.ins.id, enabled: true });
    },
  });
  // グループはまとめ単位で、撒き終わってから決めたくなる。エディタ側にも
  // 入口を置いて、一覧を開かずに付け替えられるようにする。
  monacoEditor.addAction({
    id: 'grepnavi-insertion-group', label: 'デバッグ行のグループを変更',
    contextMenuGroupId: '3_debug', contextMenuOrder: 5,
    precondition: 'grepnaviOnInsertionLine',
    run: () => {
      const hit = _insertionSiteAtCursor();
      if (!hit) return;
      // アンカーはカーソル行の画面座標。エディタ内に出す方が視線移動が少ない。
      // 座標が取れないときはエディタの左上に寄せる (document.body を使うと
      // bottom が文書全体の高さになり、画面外へ飛ぶ)。
      const box = monacoEditor.getDomNode()?.getBoundingClientRect();
      const pos = monacoEditor.getScrolledVisiblePosition(monacoEditor.getPosition());
      const rect = !box ? null
        : pos ? { left: box.left + pos.left, top: box.top + pos.top, bottom: box.top + pos.top + pos.height }
        : { left: box.left, top: box.top, bottom: box.top };
      showInsGroupPicker(rect ? { getBoundingClientRect: () => rect } : document.body, hit.ins.id);
    },
  });
  // 移動は対象と行き先が別々の行なので、メニューだけでは完結しない。押した時点では
  // 対象を選ぶだけにして、行き先はマウスで指してもらう (startInsertionMove)。
  monacoEditor.addAction({
    id: 'grepnavi-insertion-move', label: 'デバッグ行を移動 (移動先をクリック)',
    contextMenuGroupId: '3_debug', contextMenuOrder: 6,
    precondition: 'grepnaviOnInsertionLine',
    run: () => {
      const hit = _insertionSiteAtCursor();
      if (hit) startInsertionMove(hit.ins.id);
    },
  });
  // Delete キーでも撤去できる。読み取り専用エディタで Delete は元々何も
  // しないので取り合いにならず、デバッグ行の上に限る（Tab の字下げと同じ
  // keybindingContext）。誤爆は Ctrl+Z で同じ ID・同じ本文のまま戻るので、
  // 確認ダイアログは挟まない。メニューにはキーが併記される。
  monacoEditor.addAction({
    id: 'grepnavi-insertion-delete', label: 'デバッグ行を撤去',
    contextMenuGroupId: '3_debug', contextMenuOrder: 9,
    keybindings: [monaco.KeyCode.Delete],
    keybindingContext: 'grepnaviOnInsertionLine',
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

  // テンプレートの選び直しは明示的な指定なので上書きする。条件式の入力は
  // 追随にとどめ、手を入れた内容は消さない。
  sel.addEventListener('change', () => { _rememberTemplate(sel); _insertDialogRebuildTextarea(true); });
  condInput.addEventListener('input', () => _insertDialogRebuildTextarea(false));
  const fileLabel = document.getElementById('insert-dialog-file');
  if (fileLabel) {
    fileLabel.title = 'クリックで挿入先へスクロール';
    fileLabel.addEventListener('click', () => { revealInsertTarget(); refreshInsertTargetDecoration(true); });
  }
  btnOk.onclick = _insertDialogSubmit;
  btnCancel.onclick = closeInsertDialog;
  const btnSavePreset = document.getElementById('insert-dialog-save-preset');
  const btnDelPreset = document.getElementById('insert-dialog-del-preset');
  if (btnSavePreset) btnSavePreset.onclick = _saveInsertPreset;
  if (btnDelPreset) btnDelPreset.onclick = _deleteInsertPreset;
  const box = document.getElementById('insert-dialog-modal-box');
  makePanelDraggable(box, box?.querySelector('.node-modal-title'), 'insert-dialog');
  // 背景クリックで閉じる仕掛けは置かない。オーバーレイは pointer-events:none で
  // 素通しになっており、そこへのクリックは背面のエディタが受ける
  // (書きかけの内容を、外したクリック1つで失わない)。
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeInsertDialog(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); _insertDialogSubmit(); }
    else if (e.key === 'Tab') { e.preventDefault(); _taIndent(ta, e.shiftKey); }
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initInsertDialog);
  } else {
    _initInsertDialog();
  }
}
