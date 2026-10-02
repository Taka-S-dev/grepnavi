const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nodeDir, bandLabel, splitNodeLabel, adjacentDistinctBands, locationText, layerGraph } = require('../static/js/utils.js');

const ROOT = 'C:\\Users\\t\\work\\C\\openssl';

// 帯の鍵はディレクトリ。同じディレクトリの別ファイルが同じ帯に入らないと
// 帯が細切れになって俯瞰にならない。
test('nodeDir - 同じディレクトリの別ファイルは同じ鍵', () => {
  assert.equal(nodeDir('C:\\Users\\t\\work\\C\\openssl\\ssl\\ssl_lib.c', ROOT), 'ssl');
  assert.equal(nodeDir('C:/Users/t/work/C/openssl/ssl/s3_lib.c', ROOT), 'ssl');
  assert.equal(nodeDir('C:/Users/t/work/C/openssl/ssl/record/rec_layer_s3.c', ROOT), 'ssl/record');
});

test('nodeDir - root 直下は空文字、大文字小文字は区別しない', () => {
  assert.equal(nodeDir('C:/Users/t/work/C/openssl/e_os.h', ROOT), '');
  assert.equal(nodeDir('c:/users/t/work/c/OPENSSL/ssl/x.c', ROOT), 'ssl');
});

// 別ツリーのファイルが混ざったとき、その ssl/ を現在ツリーの ssl/ と同じ帯にしてはいけない。
test('nodeDir - root 外はツリー名から始める', () => {
  assert.equal(nodeDir('C:/Users/t/work/C/linux/net/core/dev.c', ROOT), 'linux/net/core');
});

test('nodeDir - root 未設定ならディレクトリそのまま', () => {
  assert.equal(nodeDir('/abs/a/b.c', ''), '/abs/a');
  assert.equal(nodeDir('', ROOT), '');
});

// 深いツリーで毎回フルパスが出ると名前が面を隠す。親の帯の中では差分だけ。
test('bandLabel - 親の帯の中では差分だけ', () => {
  assert.equal(bandLabel('drivers/net/ethernet/intel/e1000e', 'drivers/net/ethernet/intel'), 'e1000e/');
  assert.equal(bandLabel('ssl/record', 'ssl'), 'record/');
});

test('bandLabel - 親と無関係ならフルパス、root は "./"', () => {
  assert.equal(bandLabel('crypto/evp', 'ssl/record'), 'crypto/evp/');
  assert.equal(bandLabel('ssl', undefined), 'ssl/');
  assert.equal(bandLabel('', 'ssl'), './');
  // "ssl" と "ssl2" は接頭辞が同じでも親子ではない
  assert.equal(bandLabel('ssl2/x', 'ssl'), 'ssl2/x/');
});

// 「関数名 — 説明」の名前だけ太くする。区切りの書き方は人によって揺れる。
test('splitNodeLabel - 区切りの揺れを吸収する', () => {
  assert.deepEqual(splitNodeLabel('SSL_read — 受信の公開 API'), { head: 'SSL_read', rest: '受信の公開 API' });
  assert.deepEqual(splitNodeLabel('ssl3_read_bytes - 受信の本体'), { head: 'ssl3_read_bytes', rest: '受信の本体' });
  assert.deepEqual(splitNodeLabel('登録行: ssl3_read が実体'), { head: '登録行', rest: 'ssl3_read が実体' });
  assert.deepEqual(splitNodeLabel('ssl3_read → ssl3_read_internal'), { head: 'ssl3_read', rest: 'ssl3_read_internal' });
});

test('splitNodeLabel - 区切りが無ければ全体が名前', () => {
  assert.deepEqual(splitNodeLabel('ssl3_read_n'), { head: 'ssl3_read_n', rest: '' });
  // 関数名中のハイフンや "->" は区切りではない
  assert.deepEqual(splitNodeLabel('s->method->ssl_read'), { head: 's->method->ssl_read', rest: '' });
  assert.deepEqual(splitNodeLabel(''), { head: '', rest: '' });
});

// 色は 6 色の使い回しなので、別のディレクトリが同じ色になることがある。
// スタックの一覧は「どこでモジュールをまたいだか」を見るものなので、隣り合う
// 別ディレクトリが同じ色では境目が消える（実際に ssl/ と crypto/bio/ が同じ青で並んだ）。
test('adjacentDistinctBands - 隣り合う別ディレクトリは必ず違う色にする', () => {
  const bandOf = d => ({ 'ssl/statem': 4, 'ssl': 0, 'crypto/bio': 0, 'apps': 1 })[d];
  // ssl と crypto/bio はどちらも 0。隣り合うので後ろをずらす
  assert.deepEqual(adjacentDistinctBands(['ssl/statem', 'ssl', 'crypto/bio', 'crypto/bio', 'crypto/bio'], bandOf, 6),
    [4, 0, 1, 1, 1]);
  // 衝突しなければツリーと同じ色のまま
  assert.deepEqual(adjacentDistinctBands(['ssl', 'apps', 'ssl'], bandOf, 6), [0, 1, 0]);
  // ずらした色が次のディレクトリとぶつかったら、そちらもずらす
  assert.deepEqual(adjacentDistinctBands(['ssl', 'crypto/bio', 'apps'], bandOf, 6), [0, 1, 2]);
  // 最後の色からは先頭へ戻る
  assert.deepEqual(adjacentDistinctBands(['a', 'b'], () => 5, 6), [5, 0]);
});

// コピーするのは、フルパスと行の範囲。貼った先（AI）がルートを知らなくても通じる形にする。
test('locationText - フルパスと行の範囲を 1 行にする', () => {
  assert.equal(locationText('C:\\work\\openssl\\ssl\\ssl_lib.c', 1026, 1030), 'C:/work/openssl/ssl/ssl_lib.c:1026-1030'); // 区切りは / に揃える
  assert.equal(locationText('C:/work/openssl/ssl/ssl_lib.c', 1034, 1034), 'C:/work/openssl/ssl/ssl_lib.c:1034');           // 1 行なら範囲にしない
  assert.equal(locationText('/home/u/src/x.c', 3, 9), '/home/u/src/x.c:3-9');
});

// モジュールの内部を層に並べる。使う側が左、使われる側が右。循環は戻り辺として
// 外し、残りが一方向に流れる並びになること。
test('layerGraph - 使う側を左、使われる側を右に並べ、循環は戻り辺にする', () => {
  const g = layerGraph([
    { from: 'bss_file.c', to: 'bio_lib.c' },
    { from: 'b_sock.c', to: 'b_addr.c' },
    { from: 'b_addr.c', to: 'bio_lib.c' },
    { from: 'b_sock.c', to: 'bio_lib.c' },
  ]);
  assert.equal(g.col.get('bss_file.c'), 0);
  assert.equal(g.col.get('b_sock.c'), 0);
  assert.equal(g.col.get('b_addr.c'), 1);
  assert.equal(g.col.get('bio_lib.c'), 2);   // 使う側の最大列 + 1
  assert.deepEqual(g.back, []);
  assert.deepEqual(g.cols.map(c => c.length), [2, 1, 1]);

  // 相互参照: 片方が戻り辺になり、残りで層が組める
  const c = layerGraph([
    { from: 'a.c', to: 'b.c' },
    { from: 'b.c', to: 'a.c' },
    { from: 'b.c', to: 'core.c' },
  ]);
  assert.equal(c.back.length, 1);
  assert.equal(c.col.get('core.c'), 2);
  assert.equal(Math.abs(c.col.get('a.c') - c.col.get('b.c')), 1);

  // 自己参照は無視し、辺が無いときは空
  assert.deepEqual(layerGraph([]).cols, []);
  assert.deepEqual(layerGraph([{ from: 'x.c', to: 'x.c' }]).cols, [['x.c']]);
});
