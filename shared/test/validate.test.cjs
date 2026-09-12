const test = require('node:test');
const assert = require('node:assert/strict');
const { validateWorkflow, validateWorkflowStructure } = require('../dist/validate.js');
const { createExampleWorkflow } = require('../dist/index.js');

function node(id, type, config = {}) {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, config } };
}
function edge(id, source, target) {
  return { id, source, target };
}
function workflow(nodes, edges) {
  return { id: 'wf', name: 'wf', nodes, edges, variables: {}, createdAt: 0, updatedAt: 0 };
}

const linear = () =>
  workflow(
    [
      node('in', 'input'),
      node('draft', 'prompt', { model: 'gpt-4', userPrompt: '{{nodes.in.output}}' }),
      node('out', 'output'),
    ],
    [edge('e1', 'in', 'draft'), edge('e2', 'draft', 'out')]
  );

test('a linear input → prompt → output workflow is valid with no warnings', () => {
  const result = validateWorkflow(linear());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('an edge to a node that does not exist is an error', () => {
  const wf = linear();
  wf.edges.push(edge('e3', 'draft', 'ghost'));
  const result = validateWorkflow(wf);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('unknown node "ghost"')));
});

test('duplicate node ids are an error', () => {
  const wf = linear();
  wf.nodes.push(node('draft', 'prompt', { model: 'x', userPrompt: 'y' }));
  const result = validateWorkflow(wf);
  assert.ok(result.errors.some((e) => e.includes('Duplicate node id "draft"')));
});

test('a dependency cycle is an error naming the nodes on it', () => {
  const wf = workflow(
    [node('a', 'prompt', { model: 'x', userPrompt: 'y' }), node('b', 'prompt', { model: 'x', userPrompt: 'y' })],
    [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')]
  );
  const result = validateWorkflow(wf);
  assert.equal(result.valid, false);
  const cycle = result.errors.find((e) => e.startsWith('Dependency cycle'));
  assert.ok(cycle, 'expected a cycle error');
  assert.ok(cycle.includes('a') && cycle.includes('b'));
});

test('a self-loop edge is an error, not a cycle report', () => {
  const wf = linear();
  wf.edges.push(edge('loop', 'draft', 'draft'));
  const result = validateWorkflow(wf);
  assert.ok(result.errors.some((e) => e.includes('to itself')));
  assert.ok(!result.errors.some((e) => e.startsWith('Dependency cycle')));
});

test('an unknown node type is an error', () => {
  const wf = linear();
  wf.nodes.push(node('x', 'teleport'));
  const result = validateWorkflow(wf);
  assert.ok(result.errors.some((e) => e.includes('unknown type "teleport"')));
});

test('template references to unknown nodes are warnings, not errors', () => {
  const wf = linear();
  wf.nodes[1].data.config.userPrompt = '{{nodes.missing.output}}';
  const result = validateWorkflow(wf);
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((w) => w.includes('unknown node "missing"')));
});

test('an empty workflow is valid but warns', () => {
  const result = validateWorkflow(workflow([], []));
  assert.equal(result.valid, true);
  assert.ok(result.warnings.includes('Workflow has no nodes'));
});

test('a disconnected node, a missing model, and missing input/output all warn', () => {
  const wf = workflow([node('a', 'prompt', { userPrompt: 'hi' }), node('b', 'aggregate')], []);
  const { warnings, valid } = validateWorkflow(wf);
  assert.equal(valid, true);
  assert.ok(warnings.some((w) => w.includes('"a" is not connected')));
  assert.ok(warnings.some((w) => w.includes('"a" has no model')));
  assert.ok(warnings.includes('Workflow has no input node'));
  assert.ok(warnings.includes('Workflow has no output node'));
});

test('falling back on error with nothing to fall back to warns', () => {
  const wf = linear();
  wf.nodes.find((n) => n.id === 'draft').data.config.onError = { strategy: 'default' };
  const result = validateWorkflow(wf);

  assert.equal(result.valid, true, 'a warning never makes a workflow unrunnable');
  assert.ok(result.warnings.some((w) => w.includes('no fallback value')));
});

test('a fallback value, or any other strategy, is nothing to warn about', () => {
  const withValue = linear();
  withValue.nodes.find((n) => n.id === 'draft').data.config.onError = {
    strategy: 'default',
    fallbackValue: '',
  };
  assert.deepEqual(validateWorkflow(withValue).warnings, [], 'an empty string is still a value');

  const retrying = linear();
  retrying.nodes.find((n) => n.id === 'draft').data.config.onError = { strategy: 'retry' };
  assert.deepEqual(validateWorkflow(retrying).warnings, []);
});

test('structure check rejects non-objects and malformed nodes', () => {
  assert.equal(validateWorkflowStructure('nope').ok, false);
  assert.equal(validateWorkflowStructure({ nodes: 'x', edges: [] }).ok, false);
  const bad = validateWorkflowStructure({ nodes: [{ id: 'a' }], edges: [{ id: 'e' }] });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('nodes[0] is missing a type')));
  assert.ok(bad.errors.some((e) => e.includes('edges[0] is missing a source')));
});

test('structure check accepts a real workflow', () => {
  assert.deepEqual(validateWorkflowStructure(linear()), { ok: true, errors: [] });
});

const gated = (backHandle) =>
  workflow(
    [
      node('in', 'input'),
      node('draft', 'prompt', { model: 'gpt-4', userPrompt: '{{input}}' }),
      node('gate', 'human_gate', { instructions: 'look' }),
      node('out', 'output'),
    ],
    [
      edge('e1', 'in', 'draft'),
      edge('e2', 'draft', 'gate'),
      { id: 'e3', source: 'gate', target: 'out', sourceHandle: 'pass' },
      { id: 'e4', source: 'gate', target: 'draft', sourceHandle: backHandle },
    ]
  );

test('a human gate may send work back: its fail arrow closing a cycle is not an error', () => {
  const result = validateWorkflow(gated('fail'));
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('a gate pass arrow pointing backwards is still a cycle', () => {
  const result = validateWorkflow(gated('pass'));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('Dependency cycle')));
});

test('a gate with no fail arrow is warned about, not rejected', () => {
  const wf = gated('fail');
  wf.edges = wf.edges.filter((e) => e.id !== 'e4');
  const result = validateWorkflow(wf);
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((w) => w.includes('Human gate "gate" has no fail arrow')));
});

test('the shipped example workflow validates with no errors and no warnings', () => {
  const result = validateWorkflow(createExampleWorkflow());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.valid, true);
});
