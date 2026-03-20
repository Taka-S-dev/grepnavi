const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSearchParams, nextResultIndex, buildSearchSummary, upsertSearchTab } = require('../static/js/search.js');

test('buildSearchParams - basic query', () => {
  const p = buildSearchParams('foo', '', '', false, false, false);
  assert.equal(p.get('q'), 'foo');
  assert.equal(p.get('regex'), '0');
  assert.equal(p.get('case'), '0');
  assert.equal(p.get('word'), '0');
  assert.equal(p.has('dir'), false);
  assert.equal(p.has('glob'), false);
});

test('buildSearchParams - with flags and dir/glob', () => {
  const p = buildSearchParams('bar', 'src', '*.c', true, true, true);
  assert.equal(p.get('regex'), '1');
  assert.equal(p.get('case'), '1');
  assert.equal(p.get('word'), '1');
  assert.equal(p.get('dir'), 'src');
  assert.equal(p.get('glob'), '*.c');
});

test('nextResultIndex - forward wrap', () => {
  assert.equal(nextResultIndex(4, 1, 5), 0);
});

test('nextResultIndex - backward wrap', () => {
  assert.equal(nextResultIndex(0, -1, 5), 4);
});

test('nextResultIndex - empty results', () => {
  assert.equal(nextResultIndex(0, 1, 0), -1);
});

test('nextResultIndex - from no selection forward', () => {
  assert.equal(nextResultIndex(-1, 1, 5), 0);
});

test('nextResultIndex - from no selection backward', () => {
  assert.equal(nextResultIndex(-1, -1, 5), 4);
});

test('buildSearchSummary - under limit', () => {
  const s = buildSearchSummary(3, 2, 'foo', 100);
  assert.equal(s.title, '2 ファイル · 3 件  "foo"');
  assert.equal(s.overText, '');
});

test('buildSearchSummary - over limit', () => {
  const s = buildSearchSummary(200, 50, 'foo', 100);
  assert.ok(s.overText.length > 0);
});

test('upsertSearchTab - add new tab', () => {
  const { tabs, activeIdx } = upsertSearchTab([], 'foo', { title: 'foo' }, 10);
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].query, 'foo');
  assert.equal(activeIdx, 0);
});

test('upsertSearchTab - update existing tab', () => {
  const initial = [{ query: 'foo', title: 'old', pinned: false }];
  const { tabs, activeIdx } = upsertSearchTab(initial, 'foo', { title: 'new' }, 10);
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].title, 'new');
  assert.equal(activeIdx, 0);
});

test('upsertSearchTab - evict oldest unpinned when over limit', () => {
  const initial = Array.from({ length: 3 }, (_, i) => ({ query: `q${i}`, pinned: false }));
  const { tabs } = upsertSearchTab(initial, 'q3', {}, 3);
  assert.equal(tabs.length, 3);
  assert.equal(tabs.find(t => t.query === 'q0'), undefined);
});

test('upsertSearchTab - pinned tabs are not evicted', () => {
  const initial = [
    { query: 'q0', pinned: true },
    { query: 'q1', pinned: false },
    { query: 'q2', pinned: false },
  ];
  const { tabs } = upsertSearchTab(initial, 'q3', {}, 3);
  assert.ok(tabs.find(t => t.query === 'q0'));
});
