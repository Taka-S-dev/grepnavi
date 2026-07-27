const { test } = require('node:test');
const assert = require('node:assert/strict');
const { foreignRootName } = require('../static/js/utils.js');

const ROOT = 'C:\\Users\\t\\work\\C\\linux';

test('root 配下は空文字', () => {
  assert.equal(foreignRootName('C:\\Users\\t\\work\\C\\linux\\block\\blk-cgroup.c', ROOT), '');
});

test('区切り文字が混在していても root 配下と判定する', () => {
  assert.equal(foreignRootName('C:/Users/t/work/C/linux/block/a.c', ROOT), '');
});

test('大文字小文字は区別しない (Windows)', () => {
  assert.equal(foreignRootName('c:\\users\\t\\work\\c\\linux\\block\\a.c', ROOT), '');
});

test('兄弟ツリーはそのディレクトリ名を返す', () => {
  assert.equal(
    foreignRootName('C:\\Users\\t\\work\\C\\openssl-1.1.1q\\ssl\\d1_srtp.c', ROOT),
    'openssl-1.1.1q');
});

test('別ドライブは先頭セグメントを返す', () => {
  assert.equal(foreignRootName('D:\\other\\proj\\a.c', ROOT), 'D:');
});

test('root の親ディレクトリのファイルも root 外', () => {
  assert.equal(foreignRootName('C:\\Users\\t\\work\\C\\note.md', ROOT), 'note.md');
});

// linux と linux-next のように接頭辞が一致するだけの別ツリーを取りこぼさない
test('接頭辞が同じだけの別ディレクトリを root 配下と誤判定しない', () => {
  assert.equal(
    foreignRootName('C:\\Users\\t\\work\\C\\linux-next\\block\\a.c', ROOT),
    'linux-next');
});

test('file か root が空なら空文字', () => {
  assert.equal(foreignRootName('', ROOT), '');
  assert.equal(foreignRootName('C:\\x\\a.c', ''), '');
});

test('末尾スラッシュ付きの root でも判定できる', () => {
  assert.equal(foreignRootName('C:\\Users\\t\\work\\C\\linux\\a.c', ROOT + '\\'), '');
});
