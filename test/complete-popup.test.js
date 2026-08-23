const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'static', 'js', 'complete-popup.js');

// <datalist> はネイティブ描画で CSS が効かず、暗い画面に明るいポップアップが
// 浮く。テキスト入力の候補は自前のリスト（attachSuggestList）に統一する。
test('入力候補 - datalist を使わない', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'static', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<datalist/i, 'datalist はブラウザ既定の見た目になるので使わない');
  assert.doesNotMatch(html, /\blist="/, 'input の list= は datalist を呼び出す');
});

// 取り付け先の入力欄には既に別のキーハンドラが載っていることがある（挿入
// ダイアログは Esc をダイアログ閉じに使う）。同じ要素に後から足すと登録順で
// 負けるので、祖先のキャプチャ段階で取る。
test('入力候補 - キーは document のキャプチャ段階で取る', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.match(src, /document\.addEventListener\('keydown', onKey, true\)/,
    'keydown を document のキャプチャで取っていない。入力欄側の Esc に先を越される');
  assert.match(src, /document\.removeEventListener\('keydown', onKey, true\)/,
    'dispose で同じ引数（capture=true）で外していないと、ハンドラが残る');
});
