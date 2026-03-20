const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeDepths, findParent, findGrandparent, clientIsDescendant, getNodeSiblings } = require('../static/js/graph.js');

// nodes: { id: { id, children: [id, ...] } }
// edges: [{ from, to, label }]

const nodes = {
  a: { id: 'a', children: ['b', 'c'] },
  b: { id: 'b', children: ['d'] },
  c: { id: 'c', children: [] },
  d: { id: 'd', children: [] },
};
const edges = [
  { from: 'a', to: 'b', label: 'ref' },
  { from: 'a', to: 'c', label: 'ref' },
  { from: 'b', to: 'd', label: 'ref' },
];

test('findParent - direct parent', () => {
  assert.equal(findParent('b', nodes), 'a');
});

test('findParent - nested', () => {
  assert.equal(findParent('d', nodes), 'b');
});

test('findParent - root node', () => {
  assert.equal(findParent('a', nodes), '');
});

test('findGrandparent - two levels up', () => {
  assert.equal(findGrandparent('d', nodes), 'a');
});

test('findGrandparent - no grandparent', () => {
  assert.equal(findGrandparent('b', nodes), '');
});

test('computeDepths - root at 0', () => {
  const depths = computeDepths(nodes, edges);
  assert.equal(depths['a'], 0);
});

test('computeDepths - children at correct depth', () => {
  const depths = computeDepths(nodes, edges);
  assert.equal(depths['b'], 1);
  assert.equal(depths['c'], 1);
  assert.equal(depths['d'], 2);
});

test('computeDepths - empty graph', () => {
  const depths = computeDepths({}, []);
  assert.deepEqual(depths, {});
});

test('clientIsDescendant - direct child', () => {
  assert.equal(clientIsDescendant('b', 'a', nodes), true);
});

test('clientIsDescendant - indirect descendant', () => {
  assert.equal(clientIsDescendant('d', 'a', nodes), true);
});

test('clientIsDescendant - not a descendant', () => {
  assert.equal(clientIsDescendant('a', 'b', nodes), false);
});

test('clientIsDescendant - same node', () => {
  assert.equal(clientIsDescendant('a', 'a', nodes), false);
});

test('clientIsDescendant - cycle safety', () => {
  const cyclic = {
    x: { id: 'x', children: ['y'] },
    y: { id: 'y', children: ['x'] },
  };
  assert.doesNotThrow(() => clientIsDescendant('x', 'y', cyclic));
});

test('getNodeSiblings - children of same parent', () => {
  const siblings = getNodeSiblings('b', nodes, ['a']);
  assert.deepEqual(siblings, ['b', 'c']);
});

test('getNodeSiblings - root siblings', () => {
  const twoRoots = {
    a: { id: 'a', children: [] },
    b: { id: 'b', children: [] },
  };
  const siblings = getNodeSiblings('a', twoRoots, ['a', 'b']);
  assert.ok(siblings.includes('a'));
  assert.ok(siblings.includes('b'));
});
