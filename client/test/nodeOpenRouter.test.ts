import test from 'node:test';
import assert from 'node:assert/strict';
import { patchPromptConfig, sectionParamsOf } from '../src/nodes/openrouter';

const base = {
  systemPrompt: '',
  userPrompt: 'Summarize: {{input}}',
  model: 'openai/gpt-4o-mini',
  temperature: 0.5,
  maxTokens: 1024
};

test('the sections see a node as a params bag with tools off, and only the bags it set', () => {
  assert.deepEqual(sectionParamsOf(base), { tools: false });
  assert.deepEqual(sectionParamsOf({ ...base, routing: { zdr: true }, reasoning: { effort: 'high' } }), {
    tools: false,
    routing: { zdr: true },
    reasoning: { effort: 'high' }
  });
});

test('a section patch sets one field and leaves the rest of the node alone', () => {
  const next = patchPromptConfig({ ...base, routing: { only: ['groq'] } }, { routing: { zdr: true } });
  assert.deepEqual(next.routing, { only: ['groq'], zdr: true });
  assert.equal(next.userPrompt, base.userPrompt);
  assert.equal(next.temperature, 0.5);
});

test('null clears a field, or a whole bag, the way the server would', () => {
  const withBoth = { ...base, routing: { only: ['groq'], zdr: true }, sampling: { topK: 40 } };

  const oneField = patchPromptConfig(withBoth, { routing: { zdr: null } });
  assert.deepEqual(oneField.routing, { only: ['groq'] });

  const wholeBag = patchPromptConfig(withBoth, { sampling: null });
  assert.equal('sampling' in wholeBag, false);
  assert.deepEqual(wholeBag.routing, withBoth.routing, 'the other bag is untouched');
});

test('the reasoning section’s mode change — several fields at once — lands as one', () => {
  const thinking = { ...base, reasoning: { effort: 'high' as const, exclude: true } };
  const budget = patchPromptConfig(thinking, { reasoning: { maxTokens: 4096, effort: null, enabled: null } });
  assert.deepEqual(budget.reasoning, { exclude: true, maxTokens: 4096 });
});
