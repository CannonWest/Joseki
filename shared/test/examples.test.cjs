const test = require('node:test');
const assert = require('node:assert/strict');
const { validateWorkflow } = require('../dist/validate.js');
const {
  EXAMPLES_FOLDER,
  SHIPPED_EXAMPLE_IDS,
  CONTENT_REVIEW_PIPELINE_ID,
  TRANSLATION_ROUND_TRIP_ID,
  BEST_OF_FOUR_ID,
  TICKET_TRIAGE_ID,
  createExampleWorkflow,
  createTranslationRoundTrip,
  createBestOfFour,
  createTicketTriage,
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
  assert.equal(createBestOfFour().id, BEST_OF_FOUR_ID);
  assert.equal(createTicketTriage().id, TICKET_TRIAGE_ID);
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

/** The four candidates: every prompt node in the fan but the judge. */
function candidatesOf(example) {
  return example.nodes.filter((node) => node.type === 'prompt' && node.id !== 'bestof_judge');
}

test('best of four fans out to four and back in to one', () => {
  const example = createBestOfFour();
  const candidates = candidatesOf(example);
  assert.equal(candidates.length, 4);

  // One input feeds all four, and all four feed the judge.
  for (const candidate of candidates) {
    assert.ok(
      example.edges.some((edge) => edge.source === 'bestof_input' && edge.target === candidate.id),
      `the input should feed ${candidate.id}`
    );
    assert.ok(
      example.edges.some((edge) => edge.source === candidate.id && edge.target === 'bestof_judge'),
      `${candidate.id} should feed the judge`
    );
  }
  assert.ok(example.edges.some((edge) => edge.source === 'bestof_judge' && edge.target === 'bestof_output'));
  // Four out, four in, one to the output — and nothing else.
  assert.equal(example.edges.length, 9);
  assert.equal(new Set(example.edges.map((edge) => edge.id)).size, 9);
});

test('the four candidates differ in the model and nothing else', () => {
  const candidates = candidatesOf(createBestOfFour());
  const models = candidates.map((candidate) => candidate.data.config.model);
  assert.equal(new Set(models).size, 4);
  // Four houses, so the field is not four sizes of one model.
  assert.equal(new Set(models.map((model) => model.split('/')[0])).size, 4);

  for (const candidate of candidates) {
    assert.equal(candidate.data.config.systemPrompt, candidates[0].data.config.systemPrompt);
    assert.equal(candidate.data.config.temperature, candidates[0].data.config.temperature);
    assert.equal(candidate.data.config.maxTokens, candidates[0].data.config.maxTokens);
    // The arrow in: the prompt the run was given.
    assert.equal(candidate.data.config.userPrompt, '{{input}}');
  }
});

test('the judge names every node it reads, because {{input}} would be only the first arrow', () => {
  const example = createBestOfFour();
  const judge = example.nodes.find((node) => node.id === 'bestof_judge');
  const userPrompt = judge.data.config.userPrompt;

  // The prompt the four were given, which arrived nowhere near this node.
  assert.match(userPrompt, /\{\{nodes\.bestof_input\.output\}\}/);
  for (const candidate of candidatesOf(example)) {
    assert.ok(
      userPrompt.includes(`{{nodes.${candidate.id}.output}}`),
      `the judge should read ${candidate.id}`
    );
  }
  // Four arrows arrive at once, so the shorthand would name one of them at random.
  assert.ok(!/\{\{\s*input\s*\}\}/.test(userPrompt));
});

test('the judge is blind: no model name survives into what it is sent', () => {
  const example = createBestOfFour();
  const judge = example.nodes.find((node) => node.id === 'bestof_judge');
  // What the model actually sees: every reference replaced by the text it fetches.
  const sent = [judge.data.config.systemPrompt, judge.data.config.userPrompt]
    .join('\n')
    .replace(/\{\{[^}]*\}\}/g, '<answer>');

  for (const candidate of candidatesOf(example)) {
    assert.ok(!sent.includes(candidate.data.config.model), `leaks ${candidate.data.config.model}`);
    assert.ok(!sent.includes(candidate.data.label), `leaks ${candidate.data.label}`);
    // The letter is all it gets; the canvas label carries the key to it.
    assert.match(candidate.data.label, /^[A-D] · \S/, `${candidate.id} should be labelled "<letter> · <model>"`);
    const letter = candidate.data.label.slice(0, 1);
    assert.ok(sent.includes(`Answer ${letter}`), `should name Answer ${letter}`);
  }
  // And the judge is not one of the field, so nothing scores its own work.
  const field = candidatesOf(example).map((candidate) => candidate.data.config.model);
  assert.ok(!field.includes(judge.data.config.model));
});

test('best of four is a straight fan — no gate — so chat can run it', () => {
  const example = createBestOfFour();
  assert.ok(!example.nodes.some((node) => node.type === 'human_gate'));

  const inputs = example.nodes.filter((node) => node.type === 'input');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].data.label, 'Prompt');
  assert.equal(inputs[0].data.config.required, true);

  // The judge reprints the winner in full, so it needs more room than a candidate.
  const judge = example.nodes.find((node) => node.id === 'bestof_judge');
  const candidate = candidatesOf(example)[0];
  assert.ok(judge.data.config.maxTokens > candidate.data.config.maxTokens);
});

test('ticket triage declares the two thresholds the priority transform reads', () => {
  const example = createTicketTriage();
  assert.deepEqual(example.variables, { highThreshold: 0.75, lowThreshold: 0.35 });

  const priority = example.nodes.find((node) => node.id === 'triage_priority');
  assert.equal(priority.type, 'transform');
  assert.match(priority.data.config.expression, /vars\.highThreshold/);
  assert.match(priority.data.config.expression, /vars\.lowThreshold/);
});

test('the priority transform can answer three ways, which the gate alone could not', () => {
  const { evaluateCondition } = require('../dist/conditions.js');
  const example = createTicketTriage();
  const expression = example.nodes.find((node) => node.id === 'triage_priority').data.config.expression;
  const vars = example.variables;

  const at = (urgency) => evaluateCondition(expression, { vars, input: JSON.stringify({ urgency }) });
  assert.equal(at(0.9), 'P1');
  assert.equal(at(0.5), 'P2');
  assert.equal(at(0.1), 'P3');
});

test('the gate routes on the transform\'s output, and both drafts read it too', () => {
  const example = createTicketTriage();
  const gate = example.nodes.find((node) => node.id === 'triage_gate');
  assert.equal(gate.data.config.condition, 'nodes.triage_priority == "P1"');

  const escalate = example.nodes.find((node) => node.id === 'triage_escalate');
  const standard = example.nodes.find((node) => node.id === 'triage_standard');
  assert.match(escalate.data.config.userPrompt, /\{\{nodes\.triage_priority\.output\}\}/);
  // The standard reply doesn't need the label spelled out to the customer.
  assert.ok(!standard.data.config.userPrompt.includes('triage_priority'));

  // Downstream of a branch, {{input}} would be the branch's own "true"/"false" —
  // so both drafts must name the nodes they actually want.
  assert.ok(!escalate.data.config.userPrompt.includes('{{input}}'));
  assert.ok(!standard.data.config.userPrompt.includes('{{input}}'));
  assert.match(escalate.data.config.userPrompt, /\{\{nodes\.triage_input\.output\}\}/);
  assert.match(standard.data.config.userPrompt, /\{\{nodes\.triage_input\.output\}\}/);
});

test('a join after the gate waits for exactly the path chosen, and only one path can reach output', () => {
  const example = createTicketTriage();
  assert.ok(example.edges.some((e) => e.source === 'triage_escalate' && e.target === 'triage_merge'));
  assert.ok(example.edges.some((e) => e.source === 'triage_standard' && e.target === 'triage_merge'));
  assert.ok(example.edges.some((e) => e.source === 'triage_merge' && e.target === 'triage_output'));
  assert.ok(!example.nodes.some((node) => node.type === 'human_gate'));
});

test('ticket triage is gated but has no human gate, so chat can run it', () => {
  const example = createTicketTriage();
  const inputs = example.nodes.filter((node) => node.type === 'input');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].data.label, 'Support Ticket');
  assert.equal(inputs[0].data.config.required, true);
});
