const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findNumLiteralAt, formatNumLiteral } = require('../static/js/numlit.js');

// ===== findNumLiteralAt =====

test('数値リテラルを column で拾う', () => {
  const line = 'x = 0x42 | MASK;';
  const hit = findNumLiteralAt(line, 6); // 0x42 の中
  assert.deepEqual(hit, { text: '0x42', startColumn: 5, endColumn: 9 });
});

test('リテラルの端の column でも拾う', () => {
  const line = 'n = 192;';
  assert.equal(findNumLiteralAt(line, 5).text, '192');  // 先頭
  assert.equal(findNumLiteralAt(line, 8).text, '192');  // 末尾+1（Monaco の endColumn）
  assert.equal(findNumLiteralAt(line, 4), null);        // 手前の空白
});

test('接尾辞込みで拾う', () => {
  assert.equal(findNumLiteralAt('m = 0xffUL;', 6).text, '0xffUL');
});

test('識別子の一部の数字は拾わない', () => {
  assert.equal(findNumLiteralAt('var2 = 1;', 4), null);
  assert.equal(findNumLiteralAt('int abc123;', 9), null);
});

test('浮動小数は拾わない', () => {
  assert.equal(findNumLiteralAt('f = 1.5;', 5), null);   // 1 (直後が .)
  assert.equal(findNumLiteralAt('f = 1.5;', 7), null);   // 5 (直前が .)
  assert.equal(findNumLiteralAt('f = 1e5;', 5), null);   // 指数表記
});

test('文字リテラルはクォート込みで拾う', () => {
  const hit = findNumLiteralAt("if (c == 'A') {", 11);
  assert.deepEqual(hit, { text: "'A'", startColumn: 10, endColumn: 13 });
  assert.equal(findNumLiteralAt("c = '\\n';", 6).text, "'\\n'");
});

// ===== formatNumLiteral =====

test('16進 → 各基数の縦積みブロックとビット位置', () => {
  const md = formatNumLiteral('0x42');
  assert.match(md, /dec {2}66/);
  assert.match(md, /hex {2}0x42/);
  assert.match(md, /bin {2}0b0100_0010/);
  assert.match(md, /bit {2}6, 1/); // MSB から降順（2進の読み順と一致）
});

test('10進 → 16進と2進', () => {
  const md = formatNumLiteral('192');
  assert.match(md, /hex {2}0xc0/);
  assert.match(md, /bin {2}0b1100_0000/);
  assert.match(md, /bit {2}7, 6/);
});

test('8進は注記付き（010 が 8 に見えない事故の定番）', () => {
  const md = formatNumLiteral('010');
  assert.match(md, /8進表記/);
  assert.match(md, /dec {2}8/);
});

test('不正な8進は出さない', () => {
  assert.equal(formatNumLiteral('089'), null);
});

test('接尾辞は値に影響しない', () => {
  assert.match(formatNumLiteral('0xffUL'), /dec {2}255/);
});

test('10進はカンマ区切り', () => {
  assert.match(formatNumLiteral('0xffffffff'), /dec {2}4,294,967,295/);
});

test('2進の桁数は値の幅に合わせる（16bit 値は16桁）', () => {
  assert.match(formatNumLiteral('0x100'), /bin {2}0b0000_0001_0000_0000/);
});

test('64bit マスクも正確（Number の安全整数超え）', () => {
  const md = formatNumLiteral('0xffffffffffffffff');
  assert.match(md, /dec {2}18,446,744,073,709,551,615/);
  assert.match(md, /bit {2}64個/); // ビット列挙は12個超で個数表示
});

test('C の整数幅を超える値は出さない', () => {
  assert.equal(formatNumLiteral('0x1ffffffffffffffff'), null);
});

test('0 はビット行なし', () => {
  const md = formatNumLiteral('0');
  assert.match(md, /hex {2}0x0/);
  assert.ok(!md.includes('bit'));
});

test('文字リテラルは文字コードを出す', () => {
  assert.match(formatNumLiteral("'A'"), /dec {2}65/);
  assert.match(formatNumLiteral("'A'"), /hex {2}0x41/);
  assert.match(formatNumLiteral("'\\n'"), /dec {2}10/);
  assert.match(formatNumLiteral("'\\0'"), /dec {2}0/);
  assert.match(formatNumLiteral("'\\x41'"), /dec {2}65/);
  assert.match(formatNumLiteral("'\\101'"), /dec {2}65/); // 8進エスケープ
});

test('非 ASCII の文字リテラルは出さない（バイト値が文字コード依存）', () => {
  assert.equal(formatNumLiteral("'あ'"), null);
});
