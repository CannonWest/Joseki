import { Parser as ExprParser, type Value } from 'expr-eval';

/**
 * The little language a branch condition is written in.
 *
 * It is `expr-eval` — arithmetic, comparison, `and`/`or`/`not`, `if(...)`,
 * member access — with a vocabulary for the thing a workflow actually
 * branches on: text a model wrote. Nothing here can call out of the
 * expression, so a condition is data the way a prompt is data.
 *
 * Two shapes of the parser are worth knowing before reading further:
 *
 * - **A call's result cannot be walked into.** `json(input).score` does not
 *   parse; member access attaches to names, not to calls. That is why the
 *   accessor takes a path — `get(input, "score")` — rather than handing back
 *   an object to dot into.
 * - **Some member names are refused outright**, `constructor` and `length`
 *   among them, so `nodes.draft.length` is a parse error. Ask `length(...)`
 *   instead.
 */

/**
 * A value as text, which is how a condition sees anything a node produced.
 *
 * Nothing becomes the empty string rather than `"null"` — a node that
 * produced nothing has no text, and `length(x) == 0` should say so. An
 * object becomes its JSON, so `contains(...)` can look inside one.
 *
 * The executor's templates coerce the same way on purpose: `input` means one
 * thing in Joseki, whether a prompt interpolates it or a branch tests it.
 */
export function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Member names a path may never step through.
 *
 * The parser already refuses these in `a.b` form, but `get` takes its path as
 * a string and so slips past that check — the guard has to be re-stated here
 * or the accessor becomes the hole the parser was closing.
 */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** Text that could plausibly be a JSON object or array, worth a parse attempt. */
function looksLikeJson(value: string): boolean {
  const t = value.trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}

/**
 * Parse text as JSON, or give back nothing.
 *
 * A model asked for JSON sometimes answers with prose, and a condition is a
 * poor place to discover that by exception — `get` walks past an unparseable
 * step and the comparison downstream simply reads false.
 *
 * Nothing is `undefined` rather than `null` throughout this module, and the
 * difference matters: `null > -1` is true in JavaScript, because null counts
 * as zero, so a missing field would clear a threshold it never reached.
 * `undefined` compares as NaN, and every comparison against it reads false —
 * which is what a branch should decide about a field it never found. Ask
 * `isEmpty(...)` to test for it on purpose.
 */
function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Walk a dotted path into a value, parsing JSON text on the way down.
 *
 * A prompt node's output is always a string, so the field a model reported is
 * behind a parse. Doing that parse at each step is what lets one call reach
 * it: `get(input, "score")` where `input` is `{"score":0.82}`, and
 * `get(nodes, "prompt-1757.score")` where the node's output is that same
 * text.
 *
 * It is also the only way to name a node whose id carries a hyphen — which is
 * every node the canvas creates, since a hyphen is subtraction to the parser.
 *
 * A path that does not lead anywhere returns nothing rather than throwing;
 * a branch should decide false on a missing field, not fail the run.
 */
function getPath(source: unknown, path: unknown): unknown {
  const segments = asText(path).split('.').filter((s) => s.length > 0);
  let current: unknown = source;
  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.has(segment)) return undefined;
    if (typeof current === 'string' && looksLikeJson(current)) current = parseJson(current);
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Whitespace-separated runs. Empty text is no words, which `split` alone would call one. */
function countWords(value: unknown): number {
  const text = asText(value).trim();
  return text.length === 0 ? 0 : text.split(/\s+/).length;
}

/**
 * Text as a number, or NaN.
 *
 * `Number("")` is zero in JavaScript, and zero from an empty answer is how a
 * threshold gets crossed by accident. Blank text is not a number here, and
 * every comparison against NaN reads false.
 */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  const text = asText(value).trim();
  return text.length === 0 ? NaN : Number(text);
}

/**
 * The vocabulary, past what `expr-eval` already carries.
 *
 * Every one of them coerces its argument through `asText` first, so a branch
 * reading a node that produced an object or nothing at all behaves the same
 * way it does reading one that produced a sentence.
 */
export const CONDITION_FUNCTIONS: Record<string, (...args: any[]) => unknown> = {
  lower: (s) => asText(s).toLowerCase(),
  upper: (s) => asText(s).toUpperCase(),
  trim: (s) => asText(s).trim(),
  contains: (s, sub) => asText(s).includes(asText(sub)),
  startsWith: (s, prefix) => asText(s).startsWith(asText(prefix)),
  endsWith: (s, suffix) => asText(s).endsWith(asText(suffix)),
  words: countWords,
  number: toNumber,
  isEmpty: (s) => asText(s).trim().length === 0,
  json: (s) => (typeof s === 'string' ? parseJson(s) : s),
  get: getPath
};

/** Names a condition may use, for the error a typo earns and the hint beside the editor. */
export const CONDITION_VOCABULARY = Object.keys(CONDITION_FUNCTIONS).sort();

/**
 * What a branch node starts life with.
 *
 * A real condition rather than an empty one: the config panel used to *show*
 * `input == "yes"` while the node held nothing, so a branch the author never
 * opened read as unconfigured to the validator and as configured on screen.
 */
export const DEFAULT_BRANCH_CONDITION = 'input == "yes"';

const parser = new ExprParser();

for (const [name, fn] of Object.entries(CONDITION_FUNCTIONS)) {
  parser.functions[name] = fn;
}

// `length` ships with the parser as a unary operator, and it stringifies what
// it is given — so `length(x)` on a node that produced nothing answers 4, the
// width of the word "null". Text coercion first, and it answers 0.
parser.unaryOps.length = (value: unknown) => asText(value).length;

// There is deliberately no `null` keyword. A constant holding `undefined`
// evaluates to 0 here, and one holding `null` compares equal to neither a
// missing field nor unparsed JSON — either way `x == null` would lie. The
// honest test is `isEmpty(x)`, and the error below says so.

/**
 * Evaluate a condition against a scope.
 *
 * Throws with the expression and the vocabulary attached — a condition is
 * written in a text box with no autocomplete, so the error is the only place
 * a typo gets explained.
 */
export function evaluateCondition(condition: string, scope: Record<string, unknown>): unknown {
  try {
    // A node's output is whatever a model produced — an object, or nothing at
    // all — which is wider than the parser's declared value type. It reads
    // them at run time; only the typing is narrow.
    return parser.parse(condition).evaluate(scope as Value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const nullHint = /\bnull\b/.test(condition)
      ? ` There is no null here — ask isEmpty(x) instead.`
      : '';
    throw new Error(
      `Branch condition "${condition}" could not be evaluated: ${message}.${nullHint} ` +
      `Available: input, inputs, nodes, vars, and the functions ${CONDITION_VOCABULARY.join(', ')} ` +
      `(plus length, if, and, or, not). Reach a field with get(input, "score"), ` +
      `and a node whose id has a hyphen with get(nodes, "prompt-123").`
    );
  }
}

/** Parse a condition without running it, for the validator. Returns the error, or null. */
export function conditionParseError(condition: string): string | null {
  try {
    parser.parse(condition);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * The free names a condition reads — what it expects the run to supply.
 *
 * Functions and constants are not among them, so what comes back is exactly
 * the set the validator has to account for. Returns nothing for a condition
 * that does not parse; the parse error is the more useful complaint there.
 */
export function conditionVariables(condition: string): string[] {
  try {
    return parser.parse(condition).variables();
  } catch {
    return [];
  }
}
