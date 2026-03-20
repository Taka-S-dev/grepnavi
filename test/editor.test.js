const { test } = require('node:test');
const assert = require('node:assert/strict');

// stub browser globals required by editor.js at module load time
global.addEventListener = () => {};
global.id = () => null;

const { fzfMatchToken, fzfScore, fzfFilter, buildDefinitionParams } = require('../static/js/editor.js');

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
