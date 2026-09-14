import type { Workflow, WorkflowEdge, WorkflowNode } from './index';
import { conditionParseError, conditionVariables, CONDITION_VOCABULARY } from './conditions';
import { variableNameError, VARIABLES_SCOPE } from './variables';

export interface WorkflowValidation {
  /** True when there are no errors. Warnings never make a workflow invalid. */
  valid: boolean;
  /** Problems that make the workflow unrunnable or unloadable. */
  errors: string[];
  /** Things that will probably not do what the author expects. */
  warnings: string[];
}

const NODE_TYPES: ReadonlySet<string> = new Set([
  'prompt',
  'branch',
  'aggregate',
  'human_gate',
  'input',
  'output',
]);

/**
 * Node types that once existed, and what to build instead. A file that
 * still carries one is told that, rather than that the type is unknown:
 * its author did nothing wrong, the app changed under them.
 */
const RETIRED_NODE_TYPES: Readonly<Record<string, string>> = {
  model_compare:
    'fan prompt nodes off one input instead, one per model, and read them together ' +
    'downstream — Best of Four in Examples is the shape',
};

// Handlebars references into execution context: {{nodes.<id>.output}},
// {{#with nodes.<id>}}, {{#each nodes.<id>.output}} ...
const TEMPLATE_NODE_REF = /\{\{[#/]?\s*(?:with|each|if|unless)?\s*nodes\.([^\s.}]+)/g;

// The same, for a declared variable: {{vars.tone}}, {{#if vars.strict}}.
const TEMPLATE_VARS_REF = /\{\{[#/]?\s*(?:with|each|if|unless)?\s*vars\.([^\s.}]+)/g;

// A declared variable read by a condition — `vars.threshold > 0.5`. The parser
// reports only `vars` as a free name, whatever member is walked, so the name
// being read has to be recovered from the text.
const CONDITION_VARS_REF = /\bvars\.([A-Za-z_][A-Za-z0-9_]*)/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Shape check for untrusted JSON (imports). Answers "can this be loaded onto
 * the canvas at all?" — graph semantics are validateWorkflow's job.
 */
export function validateWorkflowStructure(input: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: ['Workflow must be a JSON object'] };
  }
  if (!Array.isArray(input.nodes)) errors.push('workflow.nodes must be an array');
  if (!Array.isArray(input.edges)) errors.push('workflow.edges must be an array');
  if (input.variables !== undefined && !isRecord(input.variables)) {
    errors.push('workflow.variables must be an object when present');
  }
  if (errors.length) return { ok: false, errors };

  (input.nodes as unknown[]).forEach((node, i) => {
    if (!isRecord(node)) {
      errors.push(`nodes[${i}] must be an object`);
      return;
    }
    if (typeof node.id !== 'string' || node.id === '') errors.push(`nodes[${i}] is missing a string id`);
    if (typeof node.type !== 'string') errors.push(`nodes[${i}] is missing a type`);
    const pos = node.position;
    if (!isRecord(pos) || typeof pos.x !== 'number' || typeof pos.y !== 'number') {
      errors.push(`nodes[${i}] needs a numeric position {x, y}`);
    }
    if (!isRecord(node.data)) errors.push(`nodes[${i}] needs a data object`);
  });
  (input.edges as unknown[]).forEach((edge, i) => {
    if (!isRecord(edge)) {
      errors.push(`edges[${i}] must be an object`);
      return;
    }
    if (typeof edge.id !== 'string' || edge.id === '') errors.push(`edges[${i}] is missing a string id`);
    if (typeof edge.source !== 'string') errors.push(`edges[${i}] is missing a source`);
    if (typeof edge.target !== 'string') errors.push(`edges[${i}] is missing a target`);
  });

  return { ok: errors.length === 0, errors };
}

/**
 * Graph-level validation of a structurally sound workflow.
 *
 * Errors are the things the executor cannot survive: unknown node types,
 * duplicate ids, edges to nodes that don't exist, and dependency cycles
 * (the executor waits for every predecessor before running a node, so a
 * cycle never terminates).
 */
export function validateWorkflow(workflow: Workflow): WorkflowValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const nodes: WorkflowNode[] = workflow.nodes ?? [];
  const edges: WorkflowEdge[] = workflow.edges ?? [];

  if (nodes.length === 0) {
    warnings.push('Workflow has no nodes');
  }

  // A declared name a prompt or a condition cannot read is worth saying early:
  // the variable is visible in the panel and reachable from nothing, and a
  // condition that reaches for it reads nothing rather than failing.
  const declared = new Set<string>(Object.keys(workflow.variables ?? {}));
  for (const name of declared) {
    const problem = variableNameError(name);
    if (problem) warnings.push(`Declared variable ${problem}`);
  }

  const nodeIds = new Set<string>();
  const nodeById = new Map<string, WorkflowNode>();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) {
      errors.push(`Duplicate node id "${node.id}"`);
    }
    nodeIds.add(node.id);
    nodeById.set(node.id, node);
    if (!NODE_TYPES.has(node.type)) {
      const retired = RETIRED_NODE_TYPES[node.type];
      errors.push(
        retired
          ? `Node "${node.id}" has the retired type "${node.type}": ${retired}`
          : `Node "${node.id}" has unknown type "${node.type}"`
      );
    }
  }

  const edgeIds = new Set<string>();
  const validEdges: WorkflowEdge[] = [];
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) {
      errors.push(`Duplicate edge id "${edge.id}"`);
    }
    edgeIds.add(edge.id);
    let ok = true;
    if (!nodeIds.has(edge.source)) {
      errors.push(`Edge "${edge.id}" starts at unknown node "${edge.source}"`);
      ok = false;
    }
    if (!nodeIds.has(edge.target)) {
      errors.push(`Edge "${edge.id}" ends at unknown node "${edge.target}"`);
      ok = false;
    }
    if (ok && edge.source === edge.target) {
      errors.push(`Edge "${edge.id}" connects node "${edge.source}" to itself`);
      ok = false;
    }
    if (ok) validEdges.push(edge);
  }

  // Only a human gate's fail arrow may point backwards: it sends work back
  // for another pass and the executor re-runs from there. Any other cycle
  // never terminates.
  const forwardEdges = validEdges.filter((edge) => !isReworkEdge(edge, nodeById));
  const cycleMembers = findCycleMembers(nodeIds, forwardEdges);
  if (cycleMembers.length) {
    errors.push(`Dependency cycle involving: ${cycleMembers.join(', ')}`);
  }

  // Per-node semantics — warnings only.
  const degree = new Map<string, number>();
  for (const edge of validEdges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  let hasInput = false;
  let hasOutput = false;
  for (const node of nodes) {
    if (node.type === 'input') hasInput = true;
    if (node.type === 'output') hasOutput = true;
    if (nodes.length > 1 && !degree.get(node.id)) {
      warnings.push(`Node "${node.id}" is not connected to anything`);
    }
    const config = (node.data?.config ?? {}) as Record<string, unknown>;
    // A node told to fall back on error with nothing to fall back to carries
    // null into everything downstream, which is almost never the intent.
    const onError = config.onError as Record<string, unknown> | undefined;
    if (onError?.strategy === 'default' && onError.fallbackValue === undefined) {
      warnings.push(`Node "${node.id}" falls back on error but has no fallback value: it would carry nothing`);
    }
    switch (node.type) {
      case 'prompt':
        if (!config.model) warnings.push(`Prompt node "${node.id}" has no model`);
        if (!config.userPrompt) warnings.push(`Prompt node "${node.id}" has an empty user prompt`);
        checkTemplateRefs(node.id, [config.systemPrompt, config.userPrompt], nodeIds, declared, warnings);
        break;
      case 'branch':
        if (!config.condition) warnings.push(`Branch node "${node.id}" has no condition`);
        else checkCondition(node.id, String(config.condition), nodeIds, declared, warnings);
        checkBranchArrows(node.id, validEdges, warnings);
        break;
      case 'human_gate':
        if (!validEdges.some((edge) => edge.source === node.id && edge.sourceHandle === 'fail')) {
          warnings.push(`Human gate "${node.id}" has no fail arrow: a rejection ends the run`);
        }
        break;
    }
  }
  if (nodes.length > 0 && !hasInput) warnings.push('Workflow has no input node');
  if (nodes.length > 0 && !hasOutput) warnings.push('Workflow has no output node');

  return { valid: errors.length === 0, errors, warnings };
}

function isReworkEdge(edge: WorkflowEdge, nodeById: Map<string, WorkflowNode>): boolean {
  return nodeById.get(edge.source)?.type === 'human_gate' && edge.sourceHandle === 'fail';
}

/** The names the executor puts in scope for every condition, whatever the graph. */
const CONDITION_SCOPE: ReadonlySet<string> = new Set(['input', 'inputs', 'nodes', VARIABLES_SCOPE]);

/**
 * A condition the author cannot run yet: it does not parse, or it reads a name
 * nothing will supply.
 *
 * The second half is where a canvas-built workflow lands. Every id the canvas
 * mints carries a hyphen, and a hyphen is subtraction — so `prompt-123 == "x"`
 * parses as `prompt` minus `123` and looks for a variable called `prompt`.
 * Catching it here is the difference between reading that at edit time and
 * discovering it part-way through a paid run.
 */
function checkCondition(
  nodeId: string,
  condition: string,
  nodeIds: Set<string>,
  declared: Set<string>,
  warnings: string[]
): void {
  const parseError = conditionParseError(condition);
  if (parseError) {
    warnings.push(`Branch node "${nodeId}" has a condition that does not parse: ${parseError}`);
    return;
  }
  const unknown = conditionVariables(condition).filter(
    (name) => !CONDITION_SCOPE.has(name) && !nodeIds.has(name) && !endsWithKnownNode(name, nodeIds)
  );
  for (const name of unknown) {
    warnings.push(
      `Branch node "${nodeId}" reads "${name}", which nothing supplies. ` +
      `A condition can use input, inputs, nodes, vars and the functions ` +
      `${CONDITION_VOCABULARY.join(', ')}; reach a node whose id has a hyphen with ` +
      `get(nodes, "the-id").`
    );
  }
  // An undeclared variable is not a free name — `vars` is in scope and the
  // member is simply missing, so the condition parses, evaluates to nothing,
  // and every comparison against it reads false. Silent, and always the same
  // way, which is exactly the kind of thing to say at edit time.
  for (const match of condition.matchAll(CONDITION_VARS_REF)) {
    if (!declared.has(match[1])) {
      warnings.push(
        `Branch node "${nodeId}" reads vars.${match[1]}, which the workflow does not declare: ` +
        `it reads as nothing, so the comparison is false whatever the run does`
      );
    }
  }
}

/** The legacy flat form: a node's own id, or its id with `_output` appended. */
function endsWithKnownNode(name: string, nodeIds: Set<string>): boolean {
  return name.endsWith('_output') && nodeIds.has(name.slice(0, -'_output'.length));
}

/**
 * A branch decides true or false, so those are the arrows it may have.
 *
 * A missing one is a path that ends at the branch, and an arrow on any other
 * handle can never fire because nothing else is ever chosen. An arrow with no
 * handle at all is the loud one: the executor takes an unhandled arrow
 * whatever was decided, so a branch wired that way does not branch.
 */
function checkBranchArrows(nodeId: string, edges: WorkflowEdge[], warnings: string[]): void {
  const out = edges.filter((edge) => edge.source === nodeId);
  if (out.length === 0) return;
  const handles = new Set<string>();
  for (const edge of out) {
    if (edge.sourceHandle) handles.add(edge.sourceHandle);
    else {
      warnings.push(
        `Branch node "${nodeId}" has an arrow with no true/false handle ("${edge.id}"): ` +
        `it fires whichever way the condition goes`
      );
    }
  }
  for (const expected of ['true', 'false']) {
    if (!handles.has(expected)) {
      warnings.push(`Branch node "${nodeId}" has no ${expected} arrow: that path ends here`);
    }
  }
  for (const handle of handles) {
    if (handle !== 'true' && handle !== 'false') {
      warnings.push(
        `Branch node "${nodeId}" has an arrow on "${handle}", which it can never choose: ` +
        `a branch chooses true or false`
      );
    }
  }
}

function checkTemplateRefs(
  nodeId: string,
  templates: unknown[],
  nodeIds: Set<string>,
  declared: Set<string>,
  warnings: string[]
): void {
  for (const template of templates) {
    if (typeof template !== 'string') continue;
    for (const match of template.matchAll(TEMPLATE_NODE_REF)) {
      const ref = match[1];
      if (!nodeIds.has(ref)) {
        warnings.push(`Node "${nodeId}" references unknown node "${ref}" in a template`);
      }
    }
    // Handlebars renders a missing variable as the empty string, so an
    // undeclared one reaches the model as a hole in the prompt rather than as
    // an error — the model answers anyway, and the prompt was never what the
    // author wrote.
    for (const match of template.matchAll(TEMPLATE_VARS_REF)) {
      const ref = match[1];
      if (!declared.has(ref)) {
        warnings.push(
          `Node "${nodeId}" reads {{vars.${ref}}}, which the workflow does not declare: ` +
          `it renders as nothing`
        );
      }
    }
  }
}

/**
 * Kahn's algorithm. Returns the ids that never reach in-degree zero — every
 * node on a cycle plus anything downstream of one — or [] for a DAG.
 */
function findCycleMembers(nodeIds: Set<string>, edges: WorkflowEdge[]): string[] {
  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) inDegree.set(id, 0);
  for (const edge of edges) {
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge.target);
    outgoing.set(edge.source, list);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) if (deg === 0) queue.push(id);

  let processed = 0;
  while (queue.length) {
    const id = queue.shift()!;
    processed++;
    for (const next of outgoing.get(id) ?? []) {
      const deg = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }
  if (processed === nodeIds.size) return [];
  return [...inDegree.entries()].filter(([, deg]) => deg > 0).map(([id]) => id);
}
