import type { Workflow, WorkflowEdge, WorkflowNode } from './index';

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
  'model_compare',
  'input',
  'output',
]);

// Handlebars references into execution context: {{nodes.<id>.output}},
// {{#with nodes.<id>}}, {{#each nodes.<id>.output}} ...
const TEMPLATE_NODE_REF = /\{\{[#/]?\s*(?:with|each|if|unless)?\s*nodes\.([^\s.}]+)/g;

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

  const nodeIds = new Set<string>();
  const nodeById = new Map<string, WorkflowNode>();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) {
      errors.push(`Duplicate node id "${node.id}"`);
    }
    nodeIds.add(node.id);
    nodeById.set(node.id, node);
    if (!NODE_TYPES.has(node.type)) {
      errors.push(`Node "${node.id}" has unknown type "${node.type}"`);
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

  const cycleMembers = findCycleMembers(nodeIds, validEdges);
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
    switch (node.type) {
      case 'prompt':
        if (!config.model) warnings.push(`Prompt node "${node.id}" has no model`);
        if (!config.userPrompt) warnings.push(`Prompt node "${node.id}" has an empty user prompt`);
        checkTemplateRefs(node.id, [config.systemPrompt, config.userPrompt], nodeIds, warnings);
        break;
      case 'model_compare':
        if (!Array.isArray(config.models) || config.models.length === 0) {
          warnings.push(`Model-compare node "${node.id}" has no models to compare`);
        }
        checkTemplateRefs(node.id, [config.prompt], nodeIds, warnings);
        break;
      case 'branch':
        if (!config.condition) warnings.push(`Branch node "${node.id}" has no condition`);
        break;
    }
  }
  if (nodes.length > 0 && !hasInput) warnings.push('Workflow has no input node');
  if (nodes.length > 0 && !hasOutput) warnings.push('Workflow has no output node');

  return { valid: errors.length === 0, errors, warnings };
}

function checkTemplateRefs(
  nodeId: string,
  templates: unknown[],
  nodeIds: Set<string>,
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
