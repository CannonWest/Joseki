const test = require('node:test');
const assert = require('node:assert/strict');
const { validateWorkflow } = require('../dist/validate.js');
const { variableNameError, isValidVariableName } = require('../dist/variables.js');
const { evaluateCondition } = require('../dist/conditions.js');

function node(id, type, config = {}) {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, config } };
}
function edge(id, source, target) {
  return { id, source, target };
}
function workflow(nodes, edges, variables = {}) {
  return { id: 'wf', name: 'wf', nodes, edges, variables, createdAt: 0, updatedAt: 0 };
}

// ---------- names ----------

test('a plain identifier is a usable variable name', () => {
  for (const name of ['tone', 'maxScore', '_draft', 'a1']) {
    assert.equal(variableNameError(name), null, `${name} should be usable`);
    assert.equal(isValidVariableName(name), true);
  }
});

test('a hyphenated name is refused: the condition parser reads it as subtraction', () => {
  const problem = variableNameError('my-var');
  assert.ok(problem, 'expected a complaint');
  assert.match(problem, /subtraction/);
});

test('"length" is refused because the parser will not read it as a member', () => {
  // Not a style rule — vars.length is a parse error, so the variable would be
  // declarable and unreadable. Pinned here so the reserved list is not trimmed.
  assert.throws(() => evaluateCondition('vars.length > 1', { vars: { length: 5 } }));
  assert.match(variableNameError('length'), /reserved/);
});

test('a name that starts with a digit, or is empty, is refused', () => {
  assert.ok(variableNameError('1st'));
  assert.ok(variableNameError(''));
});

// ---------- what a condition sees ----------

test('a declared value reaches a condition as the type it was declared as', () => {
  // The point of not coercing: a number compares numerically. "0.7" > 0.5 is a
  // string comparison and happens to agree; "10" > 9 does not.
  assert.equal(evaluateCondition('vars.threshold > 9', { vars: { threshold: 10 } }), true);
  assert.equal(evaluateCondition('vars.tone == "dry"', { vars: { tone: 'dry' } }), true);
});

test('an undeclared variable reads as nothing, so every comparison is false', () => {
  assert.equal(evaluateCondition('vars.missing > 0.5', { vars: {} }), false);
  assert.equal(evaluateCondition('vars.missing < 0.5', { vars: {} }), false);
});

// ---------- validation ----------

const withVars = (config, variables) =>
  workflow(
    [node('in', 'input'), node('draft', 'prompt', { model: 'gpt-4', ...config }), node('out', 'output')],
    [edge('e1', 'in', 'draft'), edge('e2', 'draft', 'out')],
    variables
  );

test('a prompt reading a declared variable is clean', () => {
  const result = validateWorkflow(withVars({ userPrompt: 'Answer in {{vars.tone}}' }, { tone: 'dry' }));
  assert.equal(result.valid, true);
  assert.deepEqual(result.warnings, []);
});

test('a prompt reading an undeclared variable warns that it renders as nothing', () => {
  const result = validateWorkflow(withVars({ userPrompt: 'Answer in {{vars.tone}}' }, {}));
  assert.ok(result.warnings.some((w) => w.includes('vars.tone') && w.includes('renders as nothing')));
});

test('a condition reading a declared variable is clean, and vars is in scope', () => {
  const wf = workflow(
    [
      node('in', 'input'),
      node('gate', 'branch', { condition: 'vars.threshold > 0.5' }),
      node('yes', 'output'),
      node('no', 'output'),
    ],
    [
      edge('e1', 'in', 'gate'),
      { id: 'e2', source: 'gate', target: 'yes', sourceHandle: 'true' },
      { id: 'e3', source: 'gate', target: 'no', sourceHandle: 'false' },
    ],
    { threshold: 0.7 }
  );
  const result = validateWorkflow(wf);
  assert.equal(result.valid, true);
  assert.deepEqual(result.warnings, []);
});

test('a condition reading an undeclared variable warns that the comparison is always false', () => {
  const wf = workflow(
    [
      node('in', 'input'),
      node('gate', 'branch', { condition: 'vars.threshold > 0.5' }),
      node('yes', 'output'),
      node('no', 'output'),
    ],
    [
      edge('e1', 'in', 'gate'),
      { id: 'e2', source: 'gate', target: 'yes', sourceHandle: 'true' },
      { id: 'e3', source: 'gate', target: 'no', sourceHandle: 'false' },
    ],
    {}
  );
  const result = validateWorkflow(wf);
  assert.ok(result.warnings.some((w) => w.includes('vars.threshold') && w.includes('does not declare')));
});

test('a declared name nothing can read is reported against the workflow', () => {
  const result = validateWorkflow(withVars({ userPrompt: 'hi' }, { 'my-var': 1 }));
  assert.ok(result.warnings.some((w) => w.startsWith('Declared variable') && w.includes('my-var')));
});

// ---------- transform nodes ----------

const withTransform = (config, variables = {}) =>
  workflow(
    [node('in', 'input'), node('t', 'transform', config), node('out', 'output')],
    [edge('e1', 'in', 't'), edge('e2', 't', 'out')],
    variables
  );

test('a transform reading its input is valid with no warnings', () => {
  const result = validateWorkflow(withTransform({ expression: 'get(input, "score")' }));
  assert.equal(result.valid, true);
  assert.deepEqual(result.warnings, []);
});

test('a transform with no expression warns', () => {
  const result = validateWorkflow(withTransform({}));
  assert.ok(result.warnings.some((w) => w.includes('Transform node "t" has no expression')));
});

test('a transform expression that does not parse is caught before the run', () => {
  const result = validateWorkflow(withTransform({ expression: 'get(input, ' }));
  assert.ok(
    result.warnings.some((w) => w.includes('Transform node "t"') && w.includes('does not parse'))
  );
});

test('a transform reading a name nothing supplies is caught', () => {
  const result = validateWorkflow(withTransform({ expression: 'mystery + 1' }));
  assert.ok(result.warnings.some((w) => w.includes('reads "mystery"')));
});

test('a transform reading an undeclared variable warns that it carries nothing', () => {
  const result = validateWorkflow(withTransform({ expression: 'vars.threshold' }));
  assert.ok(
    result.warnings.some((w) => w.includes('vars.threshold') && w.includes('carries nothing'))
  );
});

test('transform is a known node type, not an unknown one', () => {
  const result = validateWorkflow(withTransform({ expression: 'input' }));
  assert.deepEqual(result.errors, []);
});
