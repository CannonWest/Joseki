import test from 'node:test';
import assert from 'node:assert/strict';
import { outputFilename, previewOf, resolveFormat, serializeOutput } from '../src/output/format';

test('auto is markdown for text and json for structure; an explicit choice wins', () => {
  assert.equal(resolveFormat('a summary', 'auto'), 'markdown');
  assert.equal(resolveFormat('a summary', undefined), 'markdown');
  assert.equal(resolveFormat({ comparisons: [] }, 'auto'), 'json');
  assert.equal(resolveFormat(['a', 'b'], 'auto'), 'json');
  assert.equal(resolveFormat({ x: 1 }, 'text'), 'text');
  assert.equal(resolveFormat('prose', 'json'), 'json');
});

test('serializeOutput gives each format its body, extension and mime', () => {
  assert.deepEqual(serializeOutput('# Title\n\nBody', 'markdown'), {
    text: '# Title\n\nBody',
    extension: 'md',
    mime: 'text/markdown'
  });
  assert.deepEqual(serializeOutput('plain', 'text'), { text: 'plain', extension: 'txt', mime: 'text/plain' });
  assert.deepEqual(serializeOutput({ a: 1, b: [2] }, 'json'), {
    text: '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}',
    extension: 'json',
    mime: 'application/json'
  });
});

test('a structured value asked for as text is still readable, and json of a string is a JSON string', () => {
  assert.equal(serializeOutput({ a: 1 }, 'text').text, '{\n  "a": 1\n}');
  assert.equal(serializeOutput('quote "me"', 'json').text, '"quote \\"me\\""');
  assert.equal(serializeOutput(undefined, 'markdown').text, '');
  assert.equal(serializeOutput(null, 'text').text, '');
  assert.equal(serializeOutput(undefined, 'json').text, '');
});

test('outputFilename slugs the names, keeps the extension and stamps local time', () => {
  const at = new Date(2026, 8, 12, 7, 14, 8); // 2026-09-12 07:14:08 local
  assert.equal(
    outputFilename('Content Review Pipeline', 'Final Output', 'md', at),
    'Content_Review_Pipeline-Final_Output-2026-09-12-071408.md'
  );
  assert.equal(outputFilename('  ', 'a/b: c?', 'json', at), 'output-a_b_c-2026-09-12-071408.json');
});

test('previewOf flattens whitespace and truncates with an ellipsis', () => {
  assert.equal(previewOf('one\n\ntwo   three'), 'one two three');
  const long = 'x'.repeat(200);
  const preview = previewOf(long, 50);
  assert.equal(preview.length, 50);
  assert.ok(preview.endsWith('…'));
  assert.equal(previewOf({ a: 1 }), '{ "a": 1 }');
  assert.equal(previewOf(undefined), '');
});
