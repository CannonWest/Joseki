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
