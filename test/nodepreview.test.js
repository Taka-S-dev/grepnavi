const { test } = require('node:test');
const assert = require('node:assert/strict');
const { previewLines, startsInsideBlockComment, cIdentRanges } = require('../static/js/utils.js');

const L = (line, text, is_match = false) => ({ line, text, is_match });

// 深いブロックの中のノードは、そのまま出すと吹き出しの左半分が空白になる。
// 字下げは落とさず、ノードの行の周りに共通する幅を返して、横スクロールで寄せる。
test('previewLines - 字下げは残し、注目範囲に共通する幅を返す', () => {
  const { rows, focusIndent } = previewLines(
    [L(9, 'void f(void)'), L(10, '        if (x) {'), L(11, '            y();', true), L(12, '        }'), L(13, '}')], 0, 1);
  assert.deepEqual(rows.map(r => r.text), ['void f(void)', '        if (x) {', '            y();', '        }', '}']);
  assert.equal(focusIndent, 8); // 前後 1 行だけを見る。字下げ 0 の外側の行は数えない
  assert.deepEqual(rows.map(r => r.isMatch), [false, false, true, false, false]);
});

// 空行は字下げ 0 に見えるが、計算に入れると幅がいつも 0 になる。
test('previewLines - 空行は字下げの計算に入れない', () => {
  const { focusIndent } = previewLines([L(1, '    a;'), L(2, '', true), L(3, '    b;')], 0, 4);
  assert.equal(focusIndent, 4);
});

test('previewLines - タブは幅 4 に開き、極端に長い行は切る', () => {
  const { rows, focusIndent } = previewLines([L(1, '\tfoo();', true), L(2, 'x'.repeat(30))], 10, 0);
  assert.equal(rows[0].text, '    foo();');
  assert.equal(focusIndent, 4);
  assert.equal(rows[1].text, 'x'.repeat(9) + '…');
});

// 切り出しがコメントの途中から始まると、字句解析はコメントの地の文をコードとして扱う。
test('startsInsideBlockComment - 開く記号より先に閉じる記号が来たら途中から', () => {
  assert.equal(startsInsideBlockComment([' * accepts them', ' */', 'if (x) {']), true);
  assert.equal(startsInsideBlockComment(['int a;', '/* note */', 'b();']), false);
  assert.equal(startsInsideBlockComment(['x(); */ y(); /* z']), true);
  assert.equal(startsInsideBlockComment(['a();', 'b();']), false);
});

// エディタと同じ重ね方: 索引にあるマクロはマクロの色、それ以外で ( が続く語は
// 関数呼び出しの色。コメント・文字列・数値の中と、制御構文の語は塗らない。
test('cIdentRanges - マクロと関数呼び出しに色の範囲を返す', () => {
  const text = 'if (SSLerr(SSL_F_X, n) && check(s)) return 0x1F;';
  const num = text.indexOf('0x1F');
  const got = cIdentRanges(text, [[num, num + 4]], new Set(['SSLerr', 'SSL_F_X']));
  assert.deepEqual(got.map(r => [text.slice(r.start, r.end), r.cls]), [
    ['SSLerr', 'monaco-define-macro'],   // ( が続いてもマクロが優先
    ['SSL_F_X', 'monaco-define-macro'],
    ['check', 'monaco-local-func'],
  ]);
});

test('cIdentRanges - 除外範囲に掛かる語は塗らない', () => {
  const text = 'log("call foo()"); /* bar() */';
  const str = [text.indexOf('"'), text.lastIndexOf('"') + 1];
  const com = [text.indexOf('/*'), text.length];
  const got = cIdentRanges(text, [str, com], null);
  assert.deepEqual(got.map(r => text.slice(r.start, r.end)), ['log']);
});
