const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nodeDir, bandLabel, splitNodeLabel } = require('../static/js/utils.js');

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
