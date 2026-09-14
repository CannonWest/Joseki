/**
 * Declared variables — the values a workflow carries that no node produced.
 *
 * A run reads three things a node made (`input`, `inputs`, `nodes`) and one
 * thing the author wrote down: `vars`. A target language, a threshold, a tone,
 * a model slug named in three prompts — the constants of a workflow, declared
 * once and read everywhere, rather than retyped into each node that needs one.
 *
 * They are **single-assignment**: declared before the run and constant through
 * it. No node writes one. That is deliberate — the executor runs every ready
 * node at once, so a value a node could reassign would be read differently
 * depending on which sibling finished first, and two runs of one workflow
 * would stop meaning the same thing.
 *
 * Unlike `input`, a variable reaches a condition **as the value it was
 * declared as**: a number stays a number, so `vars.threshold > 0.5` compares
 * numerically rather than lexically. `input` is text because that is what a
 * model produced; a variable is text only if it was written as text.
 */

/** The name the executor puts the declared variables under, in templates and conditions alike. */
export const VARIABLES_SCOPE = 'vars';

/**
 * Names a variable may not take, because the condition parser refuses them as
 * member names — `vars.length` is a parse error, not a lookup.
 *
 * `length` is the one that bites: it is an entirely reasonable name for a
 * variable, and expr-eval reserves it along with the prototype-walking names.
 * A variable called `length` would be declarable, visible in the panel, and
 * unreadable by every condition in the workflow.
 */
export const RESERVED_VARIABLE_NAMES: ReadonlySet<string> = new Set([
  'length',
  'constructor',
  'prototype',
  '__proto__'
]);

/**
 * A name both readers can see: Handlebars walks `{{vars.x}}` and expr-eval
 * parses `vars.x` only when `x` is a plain identifier. A hyphen is subtraction
 * to the parser — the same trap that makes every canvas-minted node id need
 * `get(nodes, "…")` — so it is refused here rather than discovered in a
 * condition that silently reads two names and a minus sign.
 */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What is wrong with this variable name, or null when nothing is. */
export function variableNameError(name: string): string | null {
  if (name.length === 0) return 'a variable needs a name';
  if (!VARIABLE_NAME.test(name)) {
    return `"${name}" is not a name a prompt or a condition can read: ` +
      `start with a letter or underscore and use only letters, digits and underscores ` +
      `(a hyphen reads as subtraction)`;
  }
  if (RESERVED_VARIABLE_NAMES.has(name)) {
    return `"${name}" is reserved: a condition cannot read vars.${name}, ` +
      `because the expression parser refuses it as a member name`;
  }
  return null;
}

/** True when the name is one a template and a condition can both reach. */
export function isValidVariableName(name: string): boolean {
  return variableNameError(name) === null;
}
