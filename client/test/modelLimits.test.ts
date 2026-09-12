import test from 'node:test';
import assert from 'node:assert/strict';
import { maxTokensWarning } from '../src/components/chat/format';

const model = (over: Record<string, unknown> = {}) =>
  ({ contextLength: 128000, maxCompletionTokens: 16384, ...over }) as any;

test('asking for more output than the model emits is worth saying before the run', () => {
  const warning = maxTokensWarning(32000, model());
  assert.match(warning ?? '', /emits at most 16k/);
  assert.match(warning ?? '', /32k will be refused/);
});

test('a setting inside the ceiling, or exactly on it, says nothing', () => {
  assert.equal(maxTokensWarning(4096, model()), null);
  assert.equal(maxTokensWarning(16384, model()), null, 'the ceiling itself is allowed');
});

test('nothing to compare against means no warning rather than a guess', () => {
  assert.equal(maxTokensWarning(999999, undefined), null, 'model not in the catalog');
  // The openrouter/* routers publish no ceiling — they resolve to another model.
  assert.equal(maxTokensWarning(999999, model({ maxCompletionTokens: undefined })), null);
  assert.equal(maxTokensWarning(undefined, model()), null, 'nothing set');
  assert.equal(maxTokensWarning(0, model()), null);
});

test('the ceiling is the output cap, not the context window', () => {
  // A million of context and eight thousand out is a real combination, and the
  // window is the wrong number to check against.
  const wide = model({ contextLength: 1_040_000, maxCompletionTokens: 8192 });
  assert.equal(maxTokensWarning(500_000, wide) === null, false, 'well inside the window, over the cap');
  assert.match(maxTokensWarning(16384, wide) ?? '', /emits at most 8k/);
});
