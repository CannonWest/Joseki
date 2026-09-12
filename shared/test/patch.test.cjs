const test = require('node:test');
const assert = require('node:assert/strict');
const { mergePatch } = require('../dist/patch.js');

test('mergePatch merges nested objects key by key without mutating the target', () => {
  const target = { temperature: 0.7, routing: { order: ['a'], zdr: true } };
  const patched = mergePatch(target, { routing: { zdr: false, sort: 'price' } });
  assert.deepEqual(patched, { temperature: 0.7, routing: { order: ['a'], zdr: false, sort: 'price' } });
  assert.deepEqual(target, { temperature: 0.7, routing: { order: ['a'], zdr: true } });
});

test('mergePatch deletes a key on null, at any depth', () => {
  const target = { temperature: 0.7, routing: { order: ['a'], zdr: true }, reasoning: { effort: 'high' } };
  assert.deepEqual(mergePatch(target, { reasoning: null }), {
    temperature: 0.7,
    routing: { order: ['a'], zdr: true },
  });
  assert.deepEqual(mergePatch(target, { routing: { order: null } }), {
    temperature: 0.7,
    routing: { zdr: true },
    reasoning: { effort: 'high' },
  });
  assert.deepEqual(mergePatch(target, { missing: null }), target);
});

test('mergePatch replaces arrays and scalars whole', () => {
  const target = { stop: ['a', 'b'], routing: { order: ['x', 'y'] } };
  assert.deepEqual(mergePatch(target, { stop: ['c'], routing: { order: ['z'] } }), {
    stop: ['c'],
    routing: { order: ['z'] },
  });
  assert.deepEqual(mergePatch({ a: 1 }, { a: { b: 2 } }), { a: { b: 2 } });
  assert.deepEqual(mergePatch({ a: { b: 2 } }, { a: 1 }), { a: 1 });
});

test('mergePatch treats undefined as no change and a non-object patch as a replacement', () => {
  assert.deepEqual(mergePatch({ a: 1, b: 2 }, { a: undefined }), { a: 1, b: 2 });
  assert.deepEqual(mergePatch({ a: 1 }, {}), { a: 1 });
  assert.deepEqual(mergePatch(undefined, { a: 1 }), { a: 1 });
  assert.equal(mergePatch({ a: 1 }, 5), 5);
  assert.equal(mergePatch({ a: 1 }, null), null);
});

test('mergePatch matches the RFC 7386 appendix cases', () => {
  const cases = [
    [{ a: 'b' }, { a: 'c' }, { a: 'c' }],
    [{ a: 'b' }, { b: 'c' }, { a: 'b', b: 'c' }],
    [{ a: 'b' }, { a: null }, {}],
    [{ a: 'b', b: 'c' }, { a: null }, { b: 'c' }],
    [{ a: ['b'] }, { a: 'c' }, { a: 'c' }],
    [{ a: 'c' }, { a: ['b'] }, { a: ['b'] }],
    [{ a: { b: 'c' } }, { a: { b: 'd', c: null } }, { a: { b: 'd' } }],
    [{ a: [{ b: 'c' }] }, { a: [1] }, { a: [1] }],
    [['a', 'b'], ['c', 'd'], ['c', 'd']],
    [{ a: 'b' }, ['c'], ['c']],
    [{ a: 'foo' }, null, null],
    [{ a: 'foo' }, 'bar', 'bar'],
    [{ e: null }, { a: 1 }, { e: null, a: 1 }],
    [[1, 2], { a: 'b', c: null }, { a: 'b' }],
    [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
  ];
  for (const [target, patch, expected] of cases) {
    assert.deepEqual(mergePatch(target, patch), expected, JSON.stringify({ target, patch }));
  }
});
