const test = require('node:test');
const assert = require('node:assert/strict');
const { promptParams } = require('../dist/index.js');

const base = { systemPrompt: '', userPrompt: 'Hello', model: 'openai/gpt-4o-mini', temperature: 0.5, maxTokens: 512 };

test('promptParams carries the sampling fields a node set, and only those', () => {
  assert.deepEqual(promptParams(base), { temperature: 0.5, maxTokens: 512 });
  assert.deepEqual(promptParams({ ...base, topP: 0.9, presencePenalty: 0.2 }), {
    temperature: 0.5,
    maxTokens: 512,
    topP: 0.9,
    presencePenalty: 0.2,
  });
});

test('promptParams carries routing, sampling and reasoning through untouched', () => {
  const routing = { only: ['groq'], zdr: true, fallbackModels: ['openai/gpt-4o'] };
  const sampling = { topK: 40, seed: 7 };
  const reasoning = { effort: 'high', exclude: true };
  const params = promptParams({ ...base, routing, sampling, reasoning });

  assert.deepEqual(params.routing, routing);
  assert.deepEqual(params.sampling, sampling);
  assert.deepEqual(params.reasoning, reasoning);
});

test('promptParams never names a field the node left unset', () => {
  // A hand-built node with a bare config: nothing to send is an empty bag,
  // not a bag of undefineds — the gateway hears about a field or it does not.
  const params = promptParams({ systemPrompt: '', userPrompt: '', model: 'm' });
  assert.deepEqual(params, {});
  assert.equal('routing' in params, false);
  assert.equal('temperature' in params, false);
});
