import test from 'node:test';
import assert from 'node:assert/strict';
import { splitModelId } from '../src/components/chat/ModelSelect';

test('a model id splits into the author that made it and the slug that names it', () => {
  assert.deepEqual(splitModelId('openai/gpt-4o-mini'), ['openai', 'gpt-4o-mini']);
  assert.deepEqual(splitModelId('meta-llama/llama-3.1-8b-instruct'), ['meta-llama', 'llama-3.1-8b-instruct']);
});

test('only the first slash divides them — the slug keeps its own punctuation', () => {
  // A variant is part of the slug, not another level of namespace.
  assert.deepEqual(splitModelId('anthropic/claude-haiku-4.5:batch'), ['anthropic', 'claude-haiku-4.5:batch']);
  assert.deepEqual(splitModelId('a/b/c'), ['a', 'b/c']);
});

test('an id with no author is all slug, rather than half an id', () => {
  assert.deepEqual(splitModelId('gpt-4'), ['', 'gpt-4']);
  assert.deepEqual(splitModelId(''), ['', '']);
});
