const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findNumLiteralAt, formatNumLiteral, formatValueBits, evalNumExpr, formatCalcResult, calcIdentifiers, substituteCalcIdents } = require('../static/js/numlit.js');

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

// ===== formatValueBits（ホバーカードの計算値への焼き込み）=====

test('計算値の 2進とビット位置の一行', () => {
  assert.equal(formatValueBits('66'), '`0b0100_0010` — bit 6, 1 が立っている (0=最下位)');
});

test('64bit 値も正確、13ビット以上は個数', () => {
  assert.equal(formatValueBits('18446744073709551615'),
    '`0b' + '1111_'.repeat(15) + '1111' + '` — bit 64個が立っている');
});

test('0・負値・数値でない文字列は空', () => {
  assert.equal(formatValueBits('0'), '');
  assert.equal(formatValueBits('-1'), '');
  assert.equal(formatValueBits('abc'), '');
  assert.equal(formatValueBits(''), '');
});

// ===== evalNumExpr / formatCalcResult（基数変換電卓）=====

test('式の評価: 優先順位は C 準拠', () => {
  assert.equal(evalNumExpr('1<<6 | 2'), 66n);
  assert.equal(evalNumExpr('1|2<<3'), 17n);   // << が | より強い
  assert.equal(evalNumExpr('2+3*4'), 14n);
  assert.equal(evalNumExpr('(2+3)*4'), 20n);
  assert.equal(evalNumExpr('1<<2+3'), 32n);   // シフトは加算より弱い
  assert.equal(evalNumExpr('100/7%5'), 4n);   // 左結合
  assert.equal(evalNumExpr('~0'), -1n);
  assert.equal(evalNumExpr('- -1'), 1n);
  assert.equal(evalNumExpr('0xff & 0x0f'), 15n);
  assert.equal(evalNumExpr('0x42UL'), 66n);   // 接尾辞は無視
});

test('比較演算子: C の優先順位に忠実', () => {
  assert.equal(evalNumExpr('(1<<4)==16'), 1n);
  assert.equal(evalNumExpr('(1<<4)!=16'), 0n);
  assert.equal(evalNumExpr('1<2'), 1n);
  assert.equal(evalNumExpr('16>=16'), 1n);
  // C の定番の罠: 比較は & より強いので 1 & (2==2) と解釈される
  assert.equal(evalNumExpr('1&2==2'), 1n);
  assert.equal(evalNumExpr('(1&2)==2'), 0n); // 1&2=0 なので false
  // シフトは比較より強い: (1<<4) == 16 と同じ
  assert.equal(evalNumExpr('1<<4==16'), 1n);
});

test('電卓出力: 比較は true / false で答える', () => {
  assert.equal(formatCalcResult('(1<<4)==16'), 'true');
  assert.equal(formatCalcResult('(1<<4)==17'), 'false');
  assert.equal(formatCalcResult('(1==1)+5'), 'dec  6\nhex  0x6\nbin  0b0000_0110\nbit  2, 1 が立っている (0=最下位)');
});

test('式の評価: 対象外は null', () => {
  assert.equal(evalNumExpr('FOO|1'), null);   // 識別子は扱わない
  assert.equal(evalNumExpr('1||1'), null);    // 論理演算（| 2つに割れて構文で落ちる）
  assert.equal(evalNumExpr('1=2'), null);     // 代入
  assert.equal(evalNumExpr('!1'), null);      // 論理否定
  assert.equal(evalNumExpr('1/0'), null);
  assert.equal(evalNumExpr('1<<64'), null);   // シフト範囲外
  assert.equal(evalNumExpr('089'), null);     // 不正な8進
  assert.equal(evalNumExpr('1.5'), null);
  assert.equal(evalNumExpr('(1'), null);
  assert.equal(evalNumExpr(''), null);
});

test('電卓出力: 通常値は縦積みブロック', () => {
  assert.equal(formatCalcResult('1<<6|2'),
    'dec  66\nhex  0x42\nbin  0b0100_0010\nbit  6, 1 が立っている (0=最下位)');
});

// ===== 識別子の抽出と置換（マクロ解決電卓）=====

test('識別子の列挙: リテラルの接尾辞は識別子ではない', () => {
  assert.deepEqual(calcIdentifiers('ERR_R_FATAL | 0xffUL'), ['ERR_R_FATAL']);
  assert.deepEqual(calcIdentifiers('A|A|B'), ['A', 'B']); // 重複は1回
  assert.deepEqual(calcIdentifiers('1<<6'), []);
});

test('識別子の置換: 括弧で包んで優先順位を守る', () => {
  assert.equal(substituteCalcIdents('A|B<<2', { A: '64', B: '3' }), '(64)|(3)<<2');
  assert.equal(substituteCalcIdents('A|0xffUL', { A: '64' }), '(64)|0xffUL'); // 接尾辞は無傷
  assert.equal(substituteCalcIdents('A|B', { A: '64' }), '(64)|B'); // 未解決は残す
});

test('置換後の式は既存の評価器で計算できる', () => {
  const src = substituteCalcIdents('MALLOC == 65', { MALLOC: '65' });
  assert.equal(formatCalcResult(src), 'true');
});

test('電卓出力: 負値は 10進のみ、64bit 超は 10進と16進のみ', () => {
  assert.equal(formatCalcResult('1-2'), 'dec  -1');
  assert.equal(formatCalcResult('(1<<63)*4'),
    'dec  36,893,488,147,419,103,232\nhex  0x20000000000000000');
});
