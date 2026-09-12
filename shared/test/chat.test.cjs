const test = require('node:test');
const assert = require('node:assert/strict');
const { activePath } = require('../dist/chat.js');

const message = (id, parentId) => ({ id, parentId });

test('activePath walks from the leaf to the root and returns the root first', () => {
  const messages = [
    message('u1', null),
    message('a1', 'u1'),
    message('a1b', 'u1'),
    message('u2', 'a1'),
    message('a2', 'u2'),
  ];
  assert.deepEqual(activePath(messages, 'a2').map((m) => m.id), ['u1', 'a1', 'u2', 'a2']);
  assert.deepEqual(activePath(messages, 'a1b').map((m) => m.id), ['u1', 'a1b']);
  assert.deepEqual(activePath(messages, 'u1').map((m) => m.id), ['u1']);
});

test('activePath is empty without a leaf or with an unknown one', () => {
  const messages = [message('u1', null)];
  assert.deepEqual(activePath(messages, null), []);
  assert.deepEqual(activePath(messages, undefined), []);
  assert.deepEqual(activePath(messages, 'missing'), []);
  assert.deepEqual(activePath([], 'u1'), []);
});

test('activePath stops at a missing parent and never loops on a cycle', () => {
  const orphaned = [message('u2', 'gone'), message('a2', 'u2')];
  assert.deepEqual(activePath(orphaned, 'a2').map((m) => m.id), ['u2', 'a2']);

  const cyclic = [message('a', 'b'), message('b', 'a')];
  assert.deepEqual(activePath(cyclic, 'a').map((m) => m.id), ['b', 'a']);
});

const { siblingsOf, latestLeafUnder } = require('../dist/chat.js');

// A tree with a retried first message and an edited second one:
//   u1 ─ a1 ─ u2 ─ a2
//   │        └ u2b ─ a2b ─ u3 ─ a3
//   u1b ─ a1b
const node = (id, parentId, createdAt) => ({ id, parentId, createdAt });
const tree = [
  node('u1', null, 1),
  node('a1', 'u1', 2),
  node('u2', 'a1', 3),
  node('a2', 'u2', 4),
  node('u2b', 'a1', 5),
  node('a2b', 'u2b', 6),
  node('u3', 'a2b', 7),
  node('a3', 'u3', 8),
  node('u1b', null, 9),
  node('a1b', 'u1b', 10),
];
const byId = (id) => tree.find((m) => m.id === id);

test('siblingsOf lists the alternatives at one point of the tree, oldest first, the message included', () => {
  assert.deepEqual(siblingsOf(tree, byId('u2b')).map((m) => m.id), ['u2', 'u2b']);
  assert.deepEqual(siblingsOf(tree, byId('u1')).map((m) => m.id), ['u1', 'u1b']);
  assert.deepEqual(siblingsOf(tree, byId('a1')).map((m) => m.id), ['a1']);
  // Equal timestamps order by id, so the counter never flips between renders.
  const tied = [node('x', null, 1), node('w', null, 1)];
  assert.deepEqual(siblingsOf(tied, tied[0]).map((m) => m.id), ['w', 'x']);
});

test('latestLeafUnder follows the newest child down to a leaf', () => {
  assert.equal(latestLeafUnder(tree, 'u2'), 'a2');
  assert.equal(latestLeafUnder(tree, 'a1'), 'a3');
  assert.equal(latestLeafUnder(tree, 'u1b'), 'a1b');
  assert.equal(latestLeafUnder(tree, 'a3'), 'a3');
  assert.equal(latestLeafUnder(tree, 'missing'), 'missing');
  const cyclic = [node('a', 'b', 1), node('b', 'a', 2)];
  assert.equal(latestLeafUnder(cyclic, 'a'), 'b');
});
