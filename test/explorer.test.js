const { test } = require('node:test');
const assert = require('node:assert/strict');
const { filteredTreeItems, nextFileIdx } = require('../static/js/explorer.js');

const m = (rel, positions = new Set()) => ({ rel, abs: 'C:/p/' + rel, positions });

// 絞り込みを木のまま出す: 一致したファイルだけで木を組み直し、途中のフォルダは全部開く。
// フォルダが先、ファイルが後、それぞれ名前順。
test('filteredTreeItems - 一致したファイルだけで木を組み直す', () => {
  const items = filteredTreeItems([m('ssl/ssl_lib.c'), m('ssl/record/rec_layer_s3.c'), m('crypto/bio/b_print.c')], new Set());
  assert.deepEqual(items.map(i => [i.type, i.name, i.depth]), [
    ['dir', 'crypto', 0], ['dir', 'bio', 1], ['file', 'b_print.c', 2],
    ['dir', 'ssl', 0], ['dir', 'record', 1], ['file', 'rec_layer_s3.c', 2], ['file', 'ssl_lib.c', 1],
  ]);
  assert.ok(items.filter(i => i.type === 'dir').every(i => i.expanded && i.filtered));
});

// 一致文字の位置は rel 基準で来るので、ファイル名の中で光らせるにはディレクトリ分の
// オフセットが要る。
test('filteredTreeItems - ファイル名のハイライト位置にディレクトリ分のオフセットが付く', () => {
  const [, f] = filteredTreeItems([m('ssl/ssl_lib.c', new Set([4, 5, 6]))], new Set());
  assert.equal(f.type, 'file');
  assert.equal(f.nameOffset, 'ssl/'.length);
  assert.deepEqual([...f.positions], [4, 5, 6]);
});

// 絞り込み中に手で畳んだフォルダは中身を出さない。通常時の展開状態とは独立。
test('filteredTreeItems - 畳んだフォルダの中は出さない', () => {
  const items = filteredTreeItems([m('ssl/record/a.c'), m('ssl/b.c')], new Set(['ssl/record']));
  assert.deepEqual(items.map(i => i.name), ['ssl', 'record', 'b.c']);
  assert.equal(items[1].expanded, false);
});

test('filteredTreeItems - root 直下のファイルは深さ 0', () => {
  const items = filteredTreeItems([m('e_os.h')], new Set());
  assert.deepEqual(items.map(i => [i.type, i.depth]), [['file', 0]]);
});

// 上下キーはファイルだけを渡る。フォルダ行を選択にしても Enter で開けるものが無い。
test('nextFileIdx - フォルダ行を飛ばし、端で止まる', () => {
  const items = [{ type: 'dir' }, { type: 'dir' }, { type: 'file' }, { type: 'dir' }, { type: 'file' }];
  assert.equal(nextFileIdx(items, 2, 1), 4);
  assert.equal(nextFileIdx(items, 4, 1), 4);
  assert.equal(nextFileIdx(items, 4, -1), 2);
  assert.equal(nextFileIdx(items, 2, -1), 2);
});
