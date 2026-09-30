const { test } = require('node:test');
const assert = require('node:assert/strict');
const { previewLines, startsInsideBlockComment, cIdentRanges, previewSide, tileRects } = require('../static/js/utils.js');

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

// 吹き出しは目印の横に出す。下に出すと下の行を覆い、クリックできなくなる
// （右端のパネルの行から出したときに、実際に下の段が隠れた）。
test('previewSide - 右に入れば右、入らなければ左、パネルの中からはパネルの左', () => {
  // ツリーのラベル: 右に十分な空きがある
  assert.deepEqual(previewSide({ left: 60, right: 300 }, 1400, null), { side: 'right', width: 920, left: 336 });
  // 右が狭ければ、目印の左へ
  assert.equal(previewSide({ left: 900, right: 1300 }, 1400, null).side, 'left');
  // 右端のパネル (左端 1020) の中の行: 右に空きがあっても使わず、パネルの左に出す
  const p = previewSide({ left: 1040, right: 1380 }, 1400, 1020);
  assert.deepEqual(p, { side: 'left', width: 920, left: 1012 - 920 });
  assert.ok(p.left + p.width <= 1020, 'パネルに重ならない');
  // 横がどちらも狭い窓だけ、下に出す
  assert.equal(previewSide({ left: 60, right: 300 }, 500, null).side, 'below');
});

// 並べて見比べるための配置。重ねると見比べられないので、横一列で重ならないこと。
test('tileRects - 横一列に重ならず並べ、入りきらない分は先頭側を省く', () => {
  const area = { left: 12, top: 64, width: 996, height: 500 };
  const { rects, skipped } = tileRects(3, area, 8, 320);
  assert.equal(skipped, 0);
  assert.deepEqual(rects.map(r => [r.left, r.width]), [[12, 326], [346, 326], [680, 326]]);
  for (let i = 1; i < rects.length; i++) assert.ok(rects[i].left >= rects[i - 1].left + rects[i - 1].width, '重ならない');
  assert.ok(rects[2].left + rects[2].width <= area.left + area.width, '領域からはみ出さない');
  // 6 段を幅 996 に: 320px を保てるのは 3 枚まで。先頭の 3 段を省く
  const many = tileRects(6, area, 8, 320);
  assert.equal(many.rects.length, 3);
  assert.equal(many.skipped, 3);
  // 1 枚なら領域いっぱい
  assert.deepEqual(tileRects(1, area, 8, 320).rects, [{ left: 12, top: 64, width: 996, height: 500 }]);
});
