const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'static', 'index.html'), 'utf8');
const scriptOrder = [...html.matchAll(/<script src="\/js\/([\w-]+)\.js"><\/script>/g)].map((m) => m[1]);

// Ctrl+Z は3つの listener の連鎖で、先に登録されたものが先に走る。デバッグ行の撤去戻し
// (insertions.js) → メモ復元 (memo-list.js) → グラフ undo (app.js) の順でないと、
// 撤去直後の Ctrl+Z がグラフ側に奪われる。登録順は index.html の読み込み順そのもの。
test('Ctrl+Z listeners load in undo-precedence order', () => {
  const at = (name) => {
    const i = scriptOrder.indexOf(name);
    assert.notEqual(i, -1, `${name}.js が index.html から読み込まれていない`);
    return i;
  };
  assert.ok(at('insertions') < at('memo-list'), 'insertions.js は memo-list.js より先に読む');
  assert.ok(at('memo-list') < at('app'), 'memo-list.js は app.js より先に読む');
});

// 条件付きテンプレはスニペットのプレースホルダ方式: 展開すると cond が入り、
// それが選択された状態で開く（専用の入力欄は持たない）。空の条件で
// if (cond) がそのまま挿入される事故を、選択が残ることで気づけるようにする。
test('挿入ダイアログ - 条件付きテンプレは cond を選択状態で開く', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', 'static');
  const js = fs.readFileSync(path.join(root, 'js', 'insertions.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(js, /ta\.select\(at, at \+ _INSERT_COND_PLACEHOLDER\.length\)/,
    'プレースホルダを選択していない。そのまま打っても条件に置き換わらない');
  assert.doesNotMatch(html, /insert-dialog-cond/,
    '条件式の専用入力欄は廃止した（本文側で書く。補完もそちらにしか効かない）');
});

// コード欄は本体と同じ Monaco。素の textarea では字下げが何段目か見えず
// （タブは不可視でガイドも引けない）、タブ幅も補完も本体とそろわない。
test('挿入ダイアログ - コード欄は Monaco で字下げが見える', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', 'static');
  const js = fs.readFileSync(path.join(root, 'js', 'insertions.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /insert-dialog-ta/, 'textarea が残っている');
  assert.match(html, /id="insert-dialog-ed"/, 'Monaco を載せる器が無い');
  assert.match(js, /guides: \{ indentation: true/, '字下げガイドを切っている（この置き換えの目的）');
  assert.match(js, /automaticLayout: true/, 'ダイアログはリサイズできるので追従が要る');
  // Monaco はキーを全部持つので、ダイアログの確定と取り消しは明示登録が要る
  assert.match(js, /KeyMod\.CtrlCmd \| monaco\.KeyCode\.Enter/, 'Ctrl+Enter を登録していない');
  assert.match(js, /KeyCode\.Escape[\s\S]*'!suggestWidgetVisible'/, 'Esc を登録していない（補完中は補完側が優先）');
});

// 生成の順序: エディタを作る前にテンプレを展開すると、書き込む先が無く
// 初回だけ本文が空で開く（2回目以降は動くので気づきにくい）。
test('挿入ダイアログ - エディタを作ってからテンプレを展開する', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const js = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'insertions.js'), 'utf8');
  const open = js.slice(js.indexOf('function openInsertDialog'));
  const ensure = open.indexOf('_ensureInsertEditor()');
  const rebuild = open.indexOf('_insertDialogRebuildTextarea(true)');
  assert.ok(ensure > 0 && rebuild > 0, '呼び出しが見つからない');
  assert.ok(ensure < rebuild, '_ensureInsertEditor は _insertDialogRebuildTextarea より前に呼ぶ');
});

// Monaco の setValue はカーソルを先頭へ、スクロールを 0 へ戻す。外部変更で
// ファイルを読み直すたびに読んでいた場所を失い、デバッグ行の Tab 字下げは
// 1 回ごとに行から外れて（キーの前提が崩れて）効かなくなる。
test('ファイル再読込 - カーソルとスクロールを保つ', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', 'static', 'js');
  const ed = fs.readFileSync(path.join(root, 'editor.js'), 'utf8');
  const poll = ed.slice(ed.indexOf('async function pollActiveFile'));
  const end = poll.search(/\r?\n\}\r?\n/); // 関数の終わり（CRLF のファイルもある）
  const body = poll.slice(0, end < 0 ? poll.length : end);
  assert.match(body, /getSelections\(\)/, '再読込前に選択を控えていない');
  // 比べるのは実際の呼び出し同士（コメント中の setValue に引っかからないように）
  assert.ok(body.indexOf('getSelections()') < body.indexOf('.setValue(text)'),
    '控えるのは setValue より前でなければ意味がない');
  assert.match(body, /setSelections\(keep\.selections\)/, '再読込後に戻していない');

  // 字下げは連打する操作なので、書き換え後もカーソルを同じ行に残す
  const ins = fs.readFileSync(path.join(root, 'insertions.js'), 'utf8');
  const indent = ins.slice(ins.indexOf('async function _indentInsertionAtCursor'));
  assert.match(indent.slice(0, 900), /setPosition\(\{ lineNumber: pos\.lineNumber/,
    '字下げ後にカーソルを戻していない。1回ごとに行をクリックし直すことになる');
});
