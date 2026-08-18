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
