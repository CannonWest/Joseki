const test = require('node:test');
const assert = require('node:assert/strict');
const {
  asText,
  evaluateCondition,
  conditionParseError,
  conditionVariables,
  CONDITION_VOCABULARY,
} = require('../dist/conditions.js');

/** A scope shaped the way executeBranchNode builds one, flat names included. */
function scope(input, nodes = {}) {
  const s = { nodes, inputs: nodes, input: asText(input) };
  for (const [id, output] of Object.entries(nodes)) {
    s[id] = asText(output);
    s[`${id}_output`] = output;
  }
  return s;
}

const decide = (condition, ...args) => evaluateCondition(condition, scope(...args));

// ==================== length, the headline ====================

test('length measures the input, so a size threshold is a condition', () => {
  assert.equal(decide('length(input) > 500', 'x'.repeat(640)), true);
  assert.equal(decide('length(input) > 500', 'x'.repeat(499)), false);
});

test('length of nothing is zero, not the width of the word "null"', () => {
  // expr-eval's own length stringifies first, and would answer 4 here.
  assert.equal(decide('length(input)', null), 0);
  assert.equal(decide('length(input) == 0', undefined), true);
  assert.equal(decide('length(get(nodes, "missing"))', '', {}), 0);
});

// ==================== the text vocabulary ====================

test('text can be folded before it is compared', () => {
  assert.equal(decide('lower(input) == "yes"', 'YES'), true);
  assert.equal(decide('upper(input) == "YES"', 'yes'), true);
  assert.equal(decide('trim(input) == "yes"', '  yes\n'), true);
});

test('a substring test reads what expr-eval\'s "in" cannot', () => {
  assert.equal(decide('contains(input, "approved")', 'Verdict: approved'), true);
  assert.equal(decide('contains(lower(input), "approved")', 'APPROVED'), true);
  assert.equal(decide('contains(input, "denied")', 'Verdict: approved'), false);
  assert.equal(decide('startsWith(input, "Yes")', 'Yes, proceed'), true);
  assert.equal(decide('endsWith(trim(input), "?")', 'Is it? '), true);
});

test('words counts words, and no text is no words', () => {
  assert.equal(decide('words(input)', 'one two  three\nfour'), 4);
  assert.equal(decide('words(input) > 200', 'short'), false);
  assert.equal(decide('words(input)', '   '), 0);
});

test('blank text is not the number zero', () => {
  // Number('') is 0 in JavaScript, and a threshold crossed by an empty answer
  // is the bug this guards.
  assert.ok(Number.isNaN(decide('number(input)', '')));
  assert.equal(decide('number(input) > -1', ''), false);
  assert.equal(decide('number(input) > 41', ' 42 '), true);
});

// ==================== reaching into a model's answer ====================

test('get reaches a field the model reported, through the JSON it is wrapped in', () => {
  const reply = '{"score": 0.82, "verdict": "approved"}';
  assert.equal(decide('get(input, "score") > 0.5', reply), true);
  assert.equal(decide('get(input, "verdict") == "approved"', reply), true);
  assert.equal(decide('get(input, "score") > 0.9', reply), false);
});

test('get walks a nested path', () => {
  const reply = '{"result": {"scores": {"clarity": 7}}}';
  assert.equal(decide('get(input, "result.scores.clarity") >= 7', reply), true);
});

test('a field that is not there decides false rather than failing the run', () => {
  assert.equal(decide('get(input, "score") > 0.5', '{"other": 1}'), false);
  assert.equal(decide('get(input, "score") > 0.5', 'sorry, I cannot do that'), false);
});

test('json parses, and answers nothing for prose', () => {
  assert.deepEqual(evaluateCondition('json(input)', scope('{"a":1}')), { a: 1 });
  assert.equal(evaluateCondition('json(input)', scope('not json')), undefined);
});

test('nothing compares as nothing, never as zero', () => {
  // The trap this closes: null counts as zero in JavaScript, so a missing
  // field would clear a threshold it never reached.
  assert.equal(decide('get(input, "score") > -1', '{"other": 1}'), false);
  assert.equal(decide('get(input, "score") < 1', '{"other": 1}'), false);
  assert.equal(decide('isEmpty(get(input, "score"))', '{"other": 1}'), true);
  assert.equal(decide('isEmpty(get(input, "score"))', '{"score": 0.4}'), false);
  assert.equal(decide('isEmpty(input)', '   \n '), true);
});

// ==================== the hyphenated-id wall ====================

test('a node whose id has a hyphen is reachable through nodes', () => {
  const nodes = { 'prompt-1757712345678': 'the draft', example_draft: 'other' };
  assert.equal(decide('get(nodes, "prompt-1757712345678") == "the draft"', '', nodes), true);
});

test('and its JSON field is one call away', () => {
  const nodes = { 'prompt-1757712345678': '{"score": 0.91}' };
  assert.equal(decide('get(nodes, "prompt-1757712345678.score") > 0.9', '', nodes), true);
});

test('a hyphenated id written bare is subtraction, and says so', () => {
  assert.throws(
    () => decide('prompt-1757712345678 == "x"', '', { 'prompt-1757712345678': 'x' }),
    /could not be evaluated/
  );
});

test('an id the parser can read still works the old flat way', () => {
  const nodes = { example_draft: 'the draft' };
  assert.equal(decide('example_draft == "the draft"', '', nodes), true);
  assert.equal(decide('nodes.example_draft == "the draft"', '', nodes), true);
});

// ==================== safety ====================

test('a path cannot be walked into the prototype chain', () => {
  // The parser refuses these in `a.b` form; get takes its path as text and
  // would slip past that check without its own guard.
  assert.equal(evaluateCondition('get(nodes, "__proto__")', scope('', {})), undefined);
  assert.equal(evaluateCondition('get(nodes, "constructor")', scope('', {})), undefined);
  assert.equal(evaluateCondition('get(input, "constructor.name")', scope('{}')), undefined);
});

test('a condition cannot call out of itself', () => {
  assert.throws(() => decide('process.exit(1)', ''), /could not be evaluated/);
  assert.throws(() => decide('input.constructor', ''), /could not be evaluated/);
});

// ==================== errors that explain themselves ====================

test('an unknown name names the vocabulary it could have used', () => {
  assert.throws(() => decide('score > 0.5', ''), (err) => {
    assert.match(err.message, /score/);
    assert.match(err.message, /get\(nodes, "prompt-123"\)/);
    for (const fn of CONDITION_VOCABULARY) assert.match(err.message, new RegExp(fn));
    return true;
  });
});

test('writing null earns a pointer to isEmpty rather than a bare unknown-name', () => {
  assert.throws(() => decide('get(nodes, "missing") == null', '', {}), /no null here .* isEmpty/);
});

// ==================== what the validator asks ====================

test('conditionParseError finds the break, and is quiet about a good condition', () => {
  assert.equal(conditionParseError('length(input) > 500'), null);
  assert.ok(conditionParseError('length(input) >'));
  assert.ok(conditionParseError('contains(input, '));
});

test('conditionVariables reports the names a condition expects, not its functions', () => {
  assert.deepEqual(conditionVariables('contains(lower(input), "yes")'), ['input']);
  assert.deepEqual(conditionVariables('get(nodes, "a.b") > 1'), ['nodes']);
  assert.deepEqual(conditionVariables('score > 0.5'), ['score']);
  assert.deepEqual(conditionVariables('length(input) >'), []);
});

// ==================== asText, shared with the executor's templates ====================

test('asText makes nothing empty and an object its JSON', () => {
  assert.equal(asText(null), '');
  assert.equal(asText(undefined), '');
  assert.equal(asText('already'), 'already');
  assert.equal(asText({ a: 1 }), '{"a":1}');
});
