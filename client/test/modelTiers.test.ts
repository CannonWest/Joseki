import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeChoice, encodeChoice, tiersOf } from '../src/components/chat/ModelSelect';

const endpoint = (providerSlug: string, prompt: number) =>
  ({ providerSlug, pricing: { prompt, completion: prompt * 5, request: null, image: null } }) as any;

test('a menu value carries the model and the speed, and comes apart again', () => {
  assert.equal(encodeChoice('openai/gpt-6-astra', undefined), 'openai/gpt-6-astra');
  assert.equal(encodeChoice('openai/gpt-6-astra', 'flex'), 'openai/gpt-6-astra|flex');

  assert.deepEqual(decodeChoice('openai/gpt-6-astra'), ['openai/gpt-6-astra', undefined]);
  assert.deepEqual(decodeChoice('openai/gpt-6-astra|flex'), ['openai/gpt-6-astra', 'flex']);
  // A slug with its own punctuation survives the round trip.
  assert.deepEqual(decodeChoice(encodeChoice('anthropic/claude-haiku-4.5:x', 'priority')), [
    'anthropic/claude-haiku-4.5:x',
    'priority'
  ]);
});

test('the speeds on offer are read off the roster, by the tag each endpoint carries', () => {
  const tiers = tiersOf([
    endpoint('openai/flex', 5),
    endpoint('azure', 10),
    endpoint('openai', 10),
    endpoint('openai/fast', 20)
  ]);
  assert.deepEqual([...tiers.keys()].sort(), ['flex', 'priority']);
  assert.equal(tiers.get('flex')!.providerSlug, 'openai/flex');
  // OpenAI spells its priority tier "fast"; Google spells it "priority".
  assert.equal(tiers.get('priority')!.providerSlug, 'openai/fast');
  assert.equal(tiersOf([endpoint('google-ai-studio/priority', 3)]).has('priority'), true);
});

test('a model whose providers offer no tier offers no choice', () => {
  // 86% of the catalog: asking for a tier here would be silently ignored.
  const tiers = tiersOf([endpoint('groq', 5), endpoint('deepinfra/fp8', 2), endpoint('novita/fp8', 2)]);
  assert.equal(tiers.size, 0);
  assert.equal(tiersOf(undefined).size, 0, 'roster not loaded yet');
  assert.equal(tiersOf([]).size, 0);
});

test('when several providers serve one tier, the cheapest is the one quoted', () => {
  const tiers = tiersOf([
    endpoint('google-vertex/global/flex', 9),
    endpoint('google-ai-studio/flex', 4),
    endpoint('google-ai-studio', 8)
  ]);
  assert.equal(tiers.get('flex')!.pricing.prompt, 4);
});
