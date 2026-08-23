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
  assert.match(js, /setSelectionRange\(at, at \+ _INSERT_COND_PLACEHOLDER\.length\)/,
    'プレースホルダを選択していない。そのまま打っても条件に置き換わらない');
  assert.doesNotMatch(html, /insert-dialog-cond/,
    '条件式の専用入力欄は廃止した（本文側で書く。補完もそちらにしか効かない）');
});
