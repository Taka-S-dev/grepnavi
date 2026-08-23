const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
const usage = fs.readFileSync(path.join(root, 'docs', 'usage.md'), 'utf8');

// キーの表記ゆれ（Shift+Alt / Alt+Shift、← と Left）を吸収して比べる。
// 比べたいのは「どのキーが載っているか」であって、書き順ではない。
function normKey(s) {
  const mods = [];
  let rest = s.trim();
  for (const [re, name] of [[/\bCtrl\+/i, 'Ctrl'], [/\bAlt\+/i, 'Alt'], [/\bShift\+/i, 'Shift']]) {
    if (re.test(rest)) { mods.push(name); rest = rest.replace(re, ''); }
  }
  return [...mods, rest.trim().toUpperCase()].join('+');
}

// ヘルプの1行は複数キーを並べることがある（F3 / Shift+F3）。説明文中の
// <kbd> も拾ってしまうので、行頭に連続して並ぶぶんだけを「その行のキー」とみなす。
function leadingKeys(row) {
  const m = row.match(/^(?:\s*<kbd>[^<]+<\/kbd>\s*\/?\s*)+/);
  return m ? [...m[0].matchAll(/<kbd>([^<]+)<\/kbd>/g)].map((x) => normKey(x[1])) : [];
}

function helpKeys() {
  const rows = [...html.matchAll(/<div class="help-row">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  assert.ok(rows.length > 20, 'ヘルプ行が読めていない');
  return new Set(rows.flatMap(leadingKeys));
}

function usageKeys() {
  // 表の1列目だけを見る（| `Alt+P` | 説明 | の形）
  const cells = [...usage.matchAll(/^\|\s*(`[^|]+`)\s*\|/gm)].map((m) => m[1]);
  assert.ok(cells.length > 20, 'usage.md の表が読めていない');
  return new Set(cells.flatMap((c) => [...c.matchAll(/`([^`]+)`/g)].map((x) => normKey(x[1]))));
}

// README と usage.md は「アプリ内の ? キーで同じ一覧が開く」と書いている。
// 片方だけ直すと、その一文が黙って嘘になる（実際に Alt+P が「パス表示切替」の
// ままヘルプに残り、押すとデバッグ行ダイアログが出る状態になっていた）。
test('ショートカット - アプリ内ヘルプと usage.md が同じキーを載せている', () => {
  const inApp = helpKeys();
  const inDoc = usageKeys();
  const onlyApp = [...inApp].filter((k) => !inDoc.has(k)).sort();
  const onlyDoc = [...inDoc].filter((k) => !inApp.has(k)).sort();
  assert.deepEqual(onlyApp, [], 'ヘルプにしか無いキー: ' + onlyApp.join(', '));
  assert.deepEqual(onlyDoc, [], 'usage.md にしか無いキー: ' + onlyDoc.join(', '));
});

// キーの割り当てそのものがずれていた実例（Alt+P / Alt+N）。表記の一致だけでは
// 拾えないので、動きが違うと困る数個は実装と突き合わせる。
test('ショートカット - Alt+P / Alt+N の割り当てが実装と一致する', () => {
  const editor = fs.readFileSync(path.join(root, 'static', 'js', 'editor.js'), 'utf8');
  const near = (key, id) => {
    const i = editor.indexOf(`id: '${id}'`);
    assert.notEqual(i, -1, `${id} が見つからない`);
    assert.match(editor.slice(i, i + 300), new RegExp(`KeyMod\\.Alt \\| monaco\\.KeyCode\\.${key}\\b`),
      `${id} が Alt+${key.replace('Key', '')} に割り当てられていない`);
  };
  near('KeyP', 'grepnavi-insert-debug');
  near('KeyN', 'grepnavi-line-memo');

  const row = (key) => {
    const m = html.match(new RegExp(`<div class="help-row"><kbd>${key.replace(/\+/g, '\\+')}</kbd><span>([^<]*)`));
    assert.ok(m, `ヘルプに ${key} の行が無い`);
    return m[1];
  };
  assert.match(row('Alt+P'), /デバッグ行/, 'ヘルプの Alt+P の説明が実装とずれている');
  assert.match(row('Alt+N'), /メモ/, 'ヘルプの Alt+N の説明が実装とずれている');
});
