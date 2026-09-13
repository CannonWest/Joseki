const test = require('node:test');
const assert = require('node:assert/strict');
const { validateWorkflow } = require('../dist/validate.js');
const {
  EXAMPLES_FOLDER,
  SHIPPED_EXAMPLE_IDS,
  CONTENT_REVIEW_PIPELINE_ID,
  TRANSLATION_ROUND_TRIP_ID,
  createExampleWorkflow,
  createTranslationRoundTrip,
  shippedExamples,
} = require('../dist/index.js');

test('every shipped example validates clean, and lives in the Examples folder', () => {
  for (const example of shippedExamples()) {
    const result = validateWorkflow(example);
    assert.deepEqual(result.errors, [], example.name);
    assert.deepEqual(result.warnings, [], example.name);
    assert.equal(example.folder, EXAMPLES_FOLDER, example.name);
  }
});

test('the shipped ids are the ids the examples are created under, and no two share one', () => {
  const created = shippedExamples().map((example) => example.id);
  assert.deepEqual(created, [...SHIPPED_EXAMPLE_IDS]);
  assert.equal(new Set(created).size, created.length);
  assert.equal(createExampleWorkflow().id, CONTENT_REVIEW_PIPELINE_ID);
  assert.equal(createTranslationRoundTrip().id, TRANSLATION_ROUND_TRIP_ID);
});

test('the round trip is a straight line: no branch, no gate, so chat can run it', () => {
  const example = createTranslationRoundTrip();
  const types = example.nodes.map((node) => node.type);
  assert.deepEqual(types, ['input', 'prompt', 'prompt', 'prompt', 'output']);
  assert.ok(!types.includes('human_gate'));

  // Each node feeds exactly the next one.
  for (let i = 0; i < example.nodes.length - 1; i++) {
    const from = example.nodes[i].id;
    const to = example.nodes[i + 1].id;
    assert.ok(
      example.edges.some((edge) => edge.source === from && edge.target === to),
      `${from} should feed ${to}`
    );
  }
  assert.equal(example.edges.length, example.nodes.length - 1);
});

test('the round trip shows both ways a prompt reads an earlier node', () => {
  const example = createTranslationRoundTrip();
  const prompt = (id) => example.nodes.find((node) => node.id === id).data.config.userPrompt;

  assert.equal(prompt('roundtrip_to_french'), '{{input}}');
  assert.equal(prompt('roundtrip_back_to_english'), '{{nodes.roundtrip_to_french.output}}');
  // The comparison needs the original as well as the arrow in.
  assert.match(prompt('roundtrip_drift'), /\{\{nodes\.roundtrip_input\.output\}\}/);
  assert.match(prompt('roundtrip_drift'), /\{\{input\}\}/);
});

test('the round trip has a single required input, named so a chat caller can find it', () => {
  const example = createTranslationRoundTrip();
  const inputs = example.nodes.filter((node) => node.type === 'input');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].data.label, 'English Text');
  assert.equal(inputs[0].data.config.required, true);
});
