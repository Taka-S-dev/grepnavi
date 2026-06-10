const { test } = require('node:test');
const assert = require('node:assert/strict');

// setup.js (--require) で browser globals をスタブ済み
global.id = () => null;

const { fzfMatchToken, fzfScore, fzfFilter, buildDefinitionParams, extractFuncName, _isDefAnchored } = require('../static/js/editor.js');

test('fzfMatchToken - exact match', () => {
  const r = fzfMatchToken('foobar', 'foo');
  assert.ok(r !== null);
  assert.ok(r.score > 0);
});

test('fzfMatchToken - no match', () => {
  assert.equal(fzfMatchToken('foobar', 'xyz'), null);
});

test('fzfMatchToken - consecutive chars score higher', () => {
  const consecutive = fzfMatchToken('foobar', 'foo');
  const scattered   = fzfMatchToken('fxoxo', 'foo');
  assert.ok(consecutive.score > scattered.score);
});

test('fzfScore - single token match', () => {
  assert.ok(fzfScore('src/main.c', 'main') > 0);
});

test('fzfScore - multi token AND', () => {
  assert.ok(fzfScore('src/main.c', 'src main') > 0);
});

test('fzfScore - token not found returns -1', () => {
  assert.equal(fzfScore('src/main.c', 'xyz'), -1);
});

test('fzfScore - empty query returns 0', () => {
  assert.equal(fzfScore('src/main.c', ''), 0);
});

test('fzfFilter - returns top N results', () => {
  const files = ['a.c', 'b.c', 'c.c', 'd.c', 'e.c'];
  const result = fzfFilter(files, '', 3);
  assert.equal(result.length, 3);
});

test('fzfFilter - filters and sorts by score', () => {
  const files = ['openssl/bio.c', 'openssl/ssl.c', 'curl/easy.c'];
  const result = fzfFilter(files, 'ssl', 10);
  assert.ok(result.every(f => f.includes('ssl')));
});

test('fzfFilter - no match returns empty', () => {
  const result = fzfFilter(['a.c', 'b.c'], 'xyz', 10);
  assert.equal(result.length, 0);
});

test('buildDefinitionParams - basic', () => {
  const p = buildDefinitionParams('foo', '', '', false);
  assert.ok(p.get('q').includes('foo'));
  assert.equal(p.get('regex'), '1');
  assert.equal(p.get('case'), '0');
});

test('buildDefinitionParams - case sensitive', () => {
  const p = buildDefinitionParams('Foo', '', '', true);
  assert.equal(p.get('case'), '1');
});

test('buildDefinitionParams - with dir and glob', () => {
  const p = buildDefinitionParams('bar', 'src', '*.h', false);
  assert.equal(p.get('dir'), 'src');
  assert.equal(p.get('glob'), '*.h');
});

test('buildDefinitionParams - escapes regex special chars', () => {
  const p = buildDefinitionParams('foo.bar', '', '', false);
  assert.ok(p.get('q').includes('foo\\.bar'));
});

// ----- extractFuncName -----
// call ↔ def sync の起点。label 形式が崩れると黙って sync が動かなくなる ため
// パターンごとに固定しておく。

test('extractFuncName - simple identifier', () => {
  assert.equal(extractFuncName('foo'), 'foo');
});

test('extractFuncName - <word>:<line> label form', () => {
  // 末尾 `:<line>` 形式の label から関数名を抽出する。
  // 取りこぼすと call ↔ def sync 装飾が全 ノード で動かなくなる。
  assert.equal(extractFuncName('ceph_inc_mds_stopping_blocker:51'), 'ceph_inc_mds_stopping_blocker');
  assert.equal(extractFuncName('foo:42'), 'foo');
});

test('extractFuncName - function call form', () => {
  assert.equal(extractFuncName('foo(args)'), 'foo');
});

test('extractFuncName - skip control keywords', () => {
  assert.equal(extractFuncName('if (foo(x))'), 'foo');
  assert.equal(extractFuncName('while (bar())'), 'bar');
});

test('extractFuncName - nested calls picks leftmost', () => {
  assert.equal(extractFuncName('a = b(c())'), 'b');
});

test('extractFuncName - method-like call', () => {
  assert.equal(extractFuncName('obj->method()'), 'method');
});

test('extractFuncName - returns null for empty / non-identifier', () => {
  assert.equal(extractFuncName(''), null);
  assert.equal(extractFuncName(null), null);
  assert.equal(extractFuncName(':42'), null);
  assert.equal(extractFuncName('123'), null);
});

test('extractFuncName - identifier with line plus call form still works', () => {
  // 「label を編集して `<word>:<line> ...` の後ろに何か足した」ケースは対象外
  // (この時は最初の identifier を func 名とみなす)
  assert.equal(extractFuncName('foo(x):42'), 'foo');
});

// ----- _isDefAnchored (逆方向 sync の対象判定) -----
test('_isDefAnchored - match and _def on same line = def pin', () => {
  assert.equal(_isDefAnchored({
    match: { file: 'C:\\src\\recipe.c', line: 42 },
    _def:  { file: 'C:\\src\\recipe.c', line: 42 },
  }), true);
});

test('_isDefAnchored - call site pin (different line) is not def-anchored', () => {
  assert.equal(_isDefAnchored({
    match: { file: 'C:\\src\\main.c',   line: 10 },
    _def:  { file: 'C:\\src\\recipe.c', line: 42 },
  }), false);
  assert.equal(_isDefAnchored({
    match: { file: 'C:\\src\\recipe.c', line: 10 },
    _def:  { file: 'C:\\src\\recipe.c', line: 42 },
  }), false);
});

test('_isDefAnchored - unresolved / failed resolve is not def-anchored', () => {
  assert.equal(_isDefAnchored({ match: { file: 'C:\\a.c', line: 1 } }), false);
  assert.equal(_isDefAnchored({ match: { file: 'C:\\a.c', line: 1 }, _def: null }), false);
  assert.equal(_isDefAnchored(null), false);
});

test('_isDefAnchored - path separators and case are normalized', () => {
  assert.equal(_isDefAnchored({
    match: { file: 'C:/src/Recipe.c',   line: 42 },
    _def:  { file: 'c:\\src\\recipe.c', line: 42 },
  }), true);
});
