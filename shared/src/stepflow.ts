/**
 * Copyright 2025 [Your Name]
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Stepflow Protocol Compatibility Layer
 * 
 * This module implements compatibility with the Stepflow protocol for GenAI workflows.
 * Stepflow is an open-source project by DataStax Inc., licensed under Apache License 2.0.
 * 
 * For more information about Stepflow, visit: https://stepflow.org
 * Stepflow Source: https://github.com/stepflow-ai/stepflow
 * 
 * This implementation converts between MaestroAI's visual graph format
 * and Stepflow's YAML/JSON workflow definitions.
 * 
 * Reference: https://stepflow.org/schemas/v1/flow.json
 */

import type { Workflow, WorkflowNode, WorkflowEdge, NodeType } from './index';

// ==================== Stepflow Schema Types ====================

export interface StepflowWorkflow {
  schema: 'https://stepflow.org/schemas/v1/flow.json';
  name: string;
  description?: string;
  // Stepflow canonical format
  schemas?: {
    input?: StepflowInputSchema;
    batch?: StepflowBatchSchema;
  };
  // Legacy MaestroAI format (kept for backward compatibility on import)
  input_schema?: StepflowInputSchema;
  steps: StepflowStep[];
  // Flow-level output referencing terminal step(s)
  output?: StepflowInputValue;
}

export interface StepflowInputSchema {
  type: 'object';
  properties?: Record<string, StepflowSchemaProperty>;
  required?: string[];
}

export interface StepflowBatchSchema {
  type: 'array';
  items: {
    type: 'object';
    properties?: Record<string, StepflowSchemaProperty>;
    required?: string[];
  };
}

export interface StepflowSchemaProperty {
  type: string;
  description?: string;
  default?: any;
}

export interface StepflowStep {
  id: string;
  component: string;
  input: Record<string, StepflowInputValue>;
  on_error?: StepflowErrorHandler;
  must_execute?: boolean;
  metadata?: Record<string, any>;
}

export type StepflowInputValue = 
  | string 
  | number 
  | boolean 
  | null
  | StepflowInputValue[]
  | { [key: string]: StepflowInputValue }
  | { $from: StepflowFromReference }
  | { $step: string; path?: string }
  | { $input: string }
  | { $variable: string; default?: any }
  | { $template: string }
  | { $literal: any };

export interface StepflowFromReference {
  workflow?: { path: string };
  step?: string;
  path?: string;
}

export interface StepflowErrorHandler {
  // Stepflow native format
  type?: 'retry' | 'default' | 'fail';
  max_attempts?: number;
  value?: any;
  // Legacy MaestroAI export format
  action?: 'retry' | 'skip' | 'fail';
  max_retries?: number;
}

// ==================== ID Mapping for Round-Trip Consistency ====================

/**
 * Maps original node IDs to sanitized Stepflow-compatible IDs.
 * This ensures bidirectional consistency during export/import round-trips.
 */
export interface IdMapping {
  originalToSanitized: Map<string, string>;
  sanitizedToOriginal: Map<string, string>;
}

/**
 * Creates a bidirectional ID mapping for a workflow.
 */
export function createIdMapping(nodes: WorkflowNode[]): IdMapping {
  const originalToSanitized = new Map<string, string>();
  const sanitizedToOriginal = new Map<string, string>();
  
  for (const node of nodes) {
    const sanitized = sanitizeId(node.id);
    originalToSanitized.set(node.id, sanitized);
    sanitizedToOriginal.set(sanitized, node.id);
  }
  
  return { originalToSanitized, sanitizedToOriginal };
}

/**
 * Sanitizes node IDs for Stepflow compatibility with collision handling.
 * Stepflow step IDs should be alphanumeric with underscores.
 */
export function sanitizeId(id: string, existingIds: Set<string> = new Set()): string {
  let sanitized = id
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^[0-9]/, '_$&');  // Can't start with number
  
  // Handle collisions by appending a counter
  let counter = 1;
  let uniqueId = sanitized;
  while (existingIds.has(uniqueId) && uniqueId !== id) {
    uniqueId = `${sanitized}_${counter}`;
    counter++;
  }
  
  return uniqueId;
}

// ==================== Stepflow Component Mapping ====================

/**
 * Maps MaestroAI node types to Stepflow component paths
 */
const STEPFLOW_COMPONENT_MAP: Record<NodeType, string> = {
  'input': '/builtin/input',
  'output': '/builtin/output',
  'prompt': '/builtin/openai',  // Default to OpenAI, can be overridden
  'branch': '/builtin/conditional',
  'aggregate': '/builtin/aggregate',
  'human_gate': '/builtin/pause',
  'model_compare': '/builtin/parallel'  // Fan out to multiple models
};

/**
 * Maps model IDs to Stepflow component paths via prefix matching.
 * New model variants (e.g. gpt-4o-mini) resolve automatically to the
 * correct provider component without requiring explicit entries.
 */
const MODEL_PROVIDER_PREFIXES: Array<{ prefix: string; component: string }> = [
  // OpenAI family
  { prefix: 'gpt-',          component: '/builtin/openai' },
  { prefix: 'o1-',           component: '/builtin/openai' },
  { prefix: 'o3-',           component: '/builtin/openai' },
  // Anthropic family
  { prefix: 'claude-',       component: '/stepflow-anthropic/anthropic' },
  // Cohere family
  { prefix: 'command-',      component: '/stepflow-cohere/cohere' },
  { prefix: 'c4ai-',         component: '/stepflow-cohere/cohere' },
  // Local / self-hosted (e.g. ollama, vLLM)
  { prefix: 'local/',        component: '/python/local_llm' },
  { prefix: 'ollama/',       component: '/python/local_llm' },
];

/**
 * Resolve a model ID to its Stepflow component path.
 * Falls back to /builtin/openai for unknown models (many providers
 * expose an OpenAI-compatible API).
 */
export function resolveModelComponent(modelId: string): string {
  const match = MODEL_PROVIDER_PREFIXES.find(({ prefix }) =>
    modelId.toLowerCase().startsWith(prefix)
  );
  if (match) return match.component;

  console.warn(
    `[Stepflow] Unknown model "${modelId}", defaulting to /builtin/openai. ` +
    `Add a prefix mapping in MODEL_PROVIDER_PREFIXES for accurate routing.`
  );
  return '/builtin/openai';
}

// ==================== Conversion Functions ====================

/**
 * Converts a MaestroAI workflow to Stepflow YAML/JSON format
 */
export function convertToStepflow(workflow: Workflow): StepflowWorkflow {
  // Create ID mapping for round-trip consistency
  const idMapping = createIdMapping(workflow.nodes);
  
  // Build adjacency list for dependency tracking
  const incomingEdges = new Map<string, WorkflowEdge[]>();
  const outgoingEdges = new Map<string, WorkflowEdge[]>();
  
  for (const edge of workflow.edges) {
    if (!incomingEdges.has(edge.target)) {
      incomingEdges.set(edge.target, []);
    }
    incomingEdges.get(edge.target)!.push(edge);
    
    if (!outgoingEdges.has(edge.source)) {
      outgoingEdges.set(edge.source, []);
    }
    outgoingEdges.get(edge.source)!.push(edge);
  }
  
  // Find input nodes (no incoming edges)
  const inputNodes = workflow.nodes.filter(n => !incomingEdges.has(n.id));
  
  // Convert nodes to steps
  const steps: StepflowStep[] = [];
  const processedNodes = new Set<string>();
  
  // Process nodes in topological order
  function processNode(node: WorkflowNode): void {
    if (processedNodes.has(node.id)) return;
    
    // Check if all dependencies are processed
    const deps = incomingEdges.get(node.id) || [];
    const allDepsProcessed = deps.every(e => processedNodes.has(e.source));
    
    if (!allDepsProcessed) {
      // Process dependencies first
      for (const edge of deps) {
        const depNode = workflow.nodes.find(n => n.id === edge.source);
        if (depNode) processNode(depNode);
      }
    }
    
    const step = convertNodeToStep(node, deps, workflow.nodes, idMapping);
    steps.push(step);
    processedNodes.add(node.id);
  }
  
  // Start from input nodes
  for (const node of inputNodes) {
    processNode(node);
  }
  
  // Process any remaining nodes
  for (const node of workflow.nodes) {
    processNode(node);
  }

  // Find output nodes (nodes with no outgoing edges or explicit output type)
  const outgoingNodeIds = new Set(workflow.edges.map(e => e.source));
  const outputNodes = workflow.nodes.filter(
    n => !outgoingNodeIds.has(n.id) || n.type === 'output'
  );

  const result: any = {
    schema: 'https://stepflow.org/schemas/v1/flow.json',
    name: workflow.name,
    description: `Generated from MaestroAI workflow: ${workflow.name}`,
    steps
  };

  // Use Stepflow's canonical schemas.input (not input_schema)
  if (inputNodes.length > 0) {
    result.schemas = {
      input: generateInputSchema(inputNodes)
    };
  }

  // Add flow-level output referencing the terminal step(s)
  if (outputNodes.length === 1) {
    result.output = { $step: idMapping.originalToSanitized.get(outputNodes[0].id) };
  } else if (outputNodes.length > 1) {
    const outputObj: Record<string, any> = {};
    for (const node of outputNodes) {
      outputObj[idMapping.originalToSanitized.get(node.id)!] = { 
        $step: idMapping.originalToSanitized.get(node.id) 
      };
    }
    result.output = outputObj;
  }

  return result as StepflowWorkflow;
}

/**
 * Converts a single MaestroAI node to a Stepflow step
 */
function convertNodeToStep(
  node: WorkflowNode, 
  incomingEdges: WorkflowEdge[],
  allNodes: WorkflowNode[],
  idMapping: IdMapping
): StepflowStep {
  const config = node.data.config as Record<string, any>;
  
  switch (node.type) {
    case 'input':
      return convertInputNode(node, config, idMapping);
      
    case 'output':
      return convertOutputNode(node, incomingEdges, idMapping);
      
    case 'prompt':
      return convertPromptNode(node, config, incomingEdges, idMapping);
      
    case 'branch':
      return convertBranchNode(node, config, incomingEdges, idMapping);
      
    case 'aggregate':
      return convertAggregateNode(node, config, incomingEdges, idMapping);
      
    case 'human_gate':
      return convertHumanGateNode(node, config, incomingEdges, idMapping);
      
    case 'model_compare':
      return convertModelCompareNode(node, config, incomingEdges, idMapping);
      
    default:
      throw new Error(`Unsupported node type: ${node.type}`);
  }
}

function convertInputNode(node: WorkflowNode, config: any, idMapping: IdMapping): StepflowStep {
  return {
    id: idMapping.originalToSanitized.get(node.id)!,
    component: '/builtin/input',
    input: {
      input_type: config.inputType || 'text',
      required: config.required ?? false,
      description: config.description || 'User input'
    }
  };
}

function convertOutputNode(
  node: WorkflowNode, 
  incomingEdges: WorkflowEdge[],
  idMapping: IdMapping
): StepflowStep {
  const input: Record<string, StepflowInputValue> = {
    format: 'json'
  };
  
  // Reference the previous step's output
  if (incomingEdges.length > 0) {
    const sourceId = idMapping.originalToSanitized.get(incomingEdges[0].source)!;
    input.value = { $step: sourceId };
  }
  
  return {
    id: idMapping.originalToSanitized.get(node.id)!,
    component: '/builtin/output',
    input
  };
}

/**
 * Converts a MaestroAI ErrorHandlerConfig to a Stepflow on_error object.
 */
function buildOnError(config: any): StepflowErrorHandler | undefined {
  const errorConfig = config?.onError;
  if (!errorConfig) return undefined;

  switch (errorConfig.strategy) {
    case 'retry':
      return {
        type: 'retry',
        max_attempts: errorConfig.maxAttempts ?? 3
      };
    case 'default':
      return {
        type: 'default',
        value: errorConfig.fallbackValue ?? null
      };
    case 'fail':
      return { type: 'fail' };
    default:
      return undefined;
  }
}

function convertPromptNode(
  node: WorkflowNode,
  config: any,
  incomingEdges: WorkflowEdge[],
  idMapping: IdMapping
): StepflowStep {
  const model = config.model || 'gpt-4';
  const component = resolveModelComponent(model);
  
  // Build messages array
  const messages: any[] = [];
  
  if (config.systemPrompt) {
    messages.push({
      role: 'system',
      content: interpolateTemplate(config.systemPrompt, incomingEdges, idMapping)
    });
  }
  
  messages.push({
    role: 'user',
    content: interpolateTemplate(config.userPrompt, incomingEdges, idMapping)
  });
  
  const step: StepflowStep = {
    id: idMapping.originalToSanitized.get(node.id)!,
    component,
    input: {
      model: config.model || 'gpt-4',
      messages,
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 2048,
      top_p: config.topP ?? 1.0,
      frequency_penalty: config.frequencyPenalty ?? 0,
      presence_penalty: config.presencePenalty ?? 0
    }
  };

  const onError = buildOnError(config);
  if (onError) {
    step.on_error = onError;
  }
  
  // Support must_execute flag
  if (config.mustExecute) {
    step.must_execute = true;
  }

  return step;
}

function convertBranchNode(
  node: WorkflowNode, 
  config: any, 
  incomingEdges: WorkflowEdge[],
  idMapping: IdMapping
): StepflowStep {
  // Stepflow conditional branching
  const branches = config.branches || [
    { id: 'true', label: 'True', condition: config.condition || 'true' }
  ];
  
  return {
    id: idMapping.originalToSanitized.get(node.id)!,
    component: '/builtin/conditional',
    input: {
      condition: config.condition || 'true',
      branches: branches.map((b: any) => ({
        id: b.id,
        label: b.label,
        condition: b.condition
      }))
    }
  };
}

function convertAggregateNode(
  node: WorkflowNode, 
  config: any, 
  incomingEdges: WorkflowEdge[],
  idMapping: IdMapping
): StepflowStep {
  const strategy = config.strategy || 'concat';
  
  // Build input references from all incoming edges
  const inputs = incomingEdges.map(edge => ({
    $step: idMapping.originalToSanitized.get(edge.source)!
  }));
  
  return {
    id: idMapping.originalToSanitized.get(node.id)!,
    component: '/builtin/aggregate',
    input: {
      strategy,  // 'concat', 'vote', 'merge'
      separator: config.separator || '\n',
      inputs
    }
  };
}

function convertHumanGateNode(
  node: WorkflowNode, 
  config: any, 
  incomingEdges: WorkflowEdge[],
  idMapping: IdMapping
): StepflowStep {
  const input: Record<string, StepflowInputValue> = {
    instructions: config.instructions || config.approvalPrompt || 'Please review and approve',
    allow_edit: config.allowEdit ?? true
  };
  
  if (config.timeout) {
    input.timeout_seconds = config.timeout;
  }
  
  // Reference the value to review
  if (incomingEdges.length > 0) {
    input.value = { $step: idMapping.originalToSanitized.get(incomingEdges[0].source)! };
  }
  
  return {
    id: idMapping.originalToSanitized.get(node.id)!,
    component: '/builtin/pause',
    input
  };
}

function convertModelCompareNode(
  node: WorkflowNode, 
  config: any, 
  incomingEdges: WorkflowEdge[],
  idMapping: IdMapping
): StepflowStep {
  const models = config.models || ['gpt-4', 'claude-3-opus'];
  
  // Create parallel steps for each model
  const prompt = interpolateTemplate(config.prompt, incomingEdges, idMapping);
  
  return {
    id: idMapping.originalToSanitized.get(node.id)!,
    component: '/builtin/parallel',
    input: {
      branches: models.map((model: string) => ({
        component: resolveModelComponent(model),
        input: {
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: config.temperature ?? 0.7,
          max_tokens: config.maxTokens ?? 2048
        }
      }))
    }
  };
}

// ==================== Helper Functions ====================

/**
 * Generates input schema for Stepflow based on input nodes
 */
function generateInputSchema(inputNodes: WorkflowNode[]): StepflowInputSchema {
  const properties: Record<string, StepflowSchemaProperty> = {};
  
  for (const node of inputNodes) {
    const config = node.data.config as any;
    properties[node.id] = {
      type: config.inputType === 'number' ? 'number' : 'string',
      description: config.description || node.data.label
    };
  }
  
  return {
    type: 'object',
    properties,
    required: inputNodes
      .filter(n => (n.data.config as any)?.required)
      .map(n => n.id)
  };
}

/**
 * Converts a MaestroAI prompt template to the appropriate Stepflow value type.
 *
 * - Pure references like "{{nodes.step1.output}}" become { $step: "step1" }
 * - Pure input references like "{{input}}" become { $input: "$" }
 * - Mixed text + references stay as { $template: "..." } with Stepflow syntax
 * - Plain strings pass through unchanged
 * - Escaped braces \{\{ become literal {{ via $literal
 */
export function interpolateTemplate(
  template: string,
  incomingEdges: WorkflowEdge[],
  idMapping: IdMapping
): string | StepflowInputValue {
  if (!template.includes('{{')) {
    return template;
  }

  // Handle escaped braces - convert to $literal
  if (template.includes('\\{{')) {
    const literalMatch = template.match(/^\\\{\{(.*?)\\\}\}$/);
    if (literalMatch) {
      // Extract content without the escaped braces wrapper
      return { $literal: literalMatch[1] } as any;
    }
    // Replace escaped braces with placeholders, process, then wrap
    template = template.replace(/\\\{\{/g, 'ESCAPED_OPEN').replace(/\\\}\}/g, 'ESCAPED_CLOSE');
  }

  // Regex to find all Handlebars expressions
  const handlebarsPattern = /\{\{\s*(.*?)\s*\}\}/g;
  const matches = [...template.matchAll(handlebarsPattern)];

  if (matches.length === 0) {
    // Restore escaped braces if no matches
    return template
      .replace(/ESCAPED_OPEN/g, '{{')
      .replace(/ESCAPED_CLOSE/g, '}}');
  }

  // If the entire template is a single reference with no surrounding text,
  // emit a native Stepflow value expression (not a $template string)
  if (matches.length === 1) {
    const fullMatch = matches[0][0];
    const trimmedTemplate = template.trim();

    if (trimmedTemplate === fullMatch) {
      const expr = matches[0][1].trim();

      // {{input}} -> { $input: "$" }
      if (expr === 'input') {
        return { $input: '$' } as any;
      }

      // {{nodes.step_id.output}} -> { $step: "step1" }
      const nodeRef = expr.match(/^nodes\.(\w+)\.output$/);
      if (nodeRef) {
        const sanitizedId = idMapping.originalToSanitized.get(nodeRef[1]) || nodeRef[1];
        return { $step: sanitizedId } as any;
      }

      // {{nodes.step_id.output.field}} -> { $step: "step1", path: "$.field" }
      const nodePathRef = expr.match(/^nodes\.(\w+)\.output\.(.+)$/);
      if (nodePathRef) {
        const sanitizedId = idMapping.originalToSanitized.get(nodePathRef[1]) || nodePathRef[1];
        return { $step: sanitizedId, path: `$.${nodePathRef[2]}` } as any;
      }
      
      // {{variable.name}} -> { $variable: "name" }
      const varRef = expr.match(/^variable\.(\w+)$/);
      if (varRef) {
        return { $variable: varRef[1] } as any;
      }
    }
  }

  // Mixed content: convert to $template with Stepflow reference syntax
  let converted = template;
  converted = converted.replace(
    /\{\{\s*nodes\.(\w+)\.output\s*\}\}/g,
    (match, nodeId) => {
      const sanitizedId = idMapping.originalToSanitized.get(nodeId) || nodeId;
      return `{{$step.${sanitizedId}}}`;
    }
  );
  converted = converted.replace(
    /\{\{\s*input\s*\}\}/g,
    '{{$input}}'
  );
  converted = converted.replace(
    /\{\{\s*variable\.(\w+)\s*\}\}/g,
    '{{$variable.$1}}'
  );

  // Restore escaped braces
  converted = converted
    .replace(/ESCAPED_OPEN/g, '{{')
    .replace(/ESCAPED_CLOSE/g, '}}');

  // If no conversions happened and there are still incoming edges,
  // prepend the first upstream step reference
  if (incomingEdges.length > 0 && !converted.includes('{{$')) {
    const sourceId = idMapping.originalToSanitized.get(incomingEdges[0].source)!;
    converted = `{{$step.${sourceId}}} ${converted}`;
  }

  return { $template: converted } as any;
}

// ==================== Import from Stepflow ====================

/**
 * Converts a Stepflow workflow to MaestroAI format
 */
export function convertFromStepflow(stepflowWorkflow: StepflowWorkflow): Partial<Workflow> {
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  
  // Build reverse ID mapping from sanitized to safe original IDs
  const sanitizedToOriginal = new Map<string, string>();
  
  // Track node positions (simple layout algorithm)
  let yPosition = 50;
  const xPosition = 250;
  const yIncrement = 150;
  
  for (const step of stepflowWorkflow.steps) {
    // Create a safe original ID from the sanitized one
    let originalId = step.id;
    
    // If the sanitized ID starts with underscore (was numeric), try to find better name
    if (step.id.startsWith('_') && step.id.length > 1) {
      // Keep it but track the mapping
      originalId = step.id;
    }
    
    sanitizedToOriginal.set(step.id, originalId);
    
    const node = convertStepToNode(step, { x: xPosition, y: yPosition }, originalId);
    nodes.push(node);
    yPosition += yIncrement;
  }
  
  // Create edges based on $step references in inputs
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  
  for (const step of stepflowWorkflow.steps) {
    const targetId = sanitizedToOriginal.get(step.id) || step.id;
    const references = extractStepReferences(step.input);
    
    for (const sourceId of references) {
      // Try to find the node with the original or sanitized ID
      const originalSourceId = sanitizedToOriginal.get(sourceId) || sourceId;
      
      if (nodeMap.has(originalSourceId)) {
        edges.push({
          id: `edge-${originalSourceId}-${targetId}`,
          source: originalSourceId,
          target: targetId
        });
      }
    }
  }
  
  return {
    name: stepflowWorkflow.name,
    nodes,
    edges,
    variables: {}
  };
}

function convertStepToNode(
  step: StepflowStep, 
  position: { x: number; y: number },
  originalId: string
): WorkflowNode {
  const component = step.component;
  const input = step.input;
  
  // Determine node type from component path
  let type: NodeType = 'prompt';  // Default
  
  if (component.includes('input')) type = 'input';
  else if (component.includes('output')) type = 'output';
  else if (component.includes('conditional')) type = 'branch';
  else if (component.includes('aggregate')) type = 'aggregate';
  else if (component.includes('pause') || component.includes('human')) type = 'human_gate';
  else if (component.includes('parallel')) type = 'model_compare';
  
  // Build config based on type
  const config: any = {};
  
  // Extract must_execute if present
  if (step.must_execute !== undefined) {
    config.mustExecute = step.must_execute;
  }
  
  // Extract metadata if present
  if (step.metadata) {
    config.metadata = step.metadata;
  }
  
  switch (type) {
    case 'prompt':
      config.model = input.model || 'gpt-4';
      config.temperature = input.temperature ?? 0.7;
      config.maxTokens = input.max_tokens ?? 2048;
      config.topP = input.top_p ?? 1.0;
      config.frequencyPenalty = input.frequency_penalty ?? 0;
      config.presencePenalty = input.presence_penalty ?? 0;
      
      // Extract messages
      const messages = input.messages;
      if (Array.isArray(messages)) {
        const systemMsg = messages.find((m: any) => m?.role === 'system');
        const userMsg = messages.find((m: any) => m?.role === 'user');
        
        // Handle $literal in content
        const systemContent = (systemMsg as any)?.content;
        config.systemPrompt = typeof systemContent === 'object' && systemContent?.$literal 
          ? `\\{{${systemContent.$literal}\\}}`
          : (systemContent || '');
          
        const userContent = (userMsg as any)?.content;
        if (typeof userContent === 'object' && userContent?.$literal) {
          config.userPrompt = `\\{{${userContent.$literal}\\}}`;
        } else if (typeof userContent === 'string') {
          config.userPrompt = userContent;
        } else {
          config.userPrompt = '{{$input}}';
        }
      } else {
        config.systemPrompt = 'You are a helpful assistant.';
        config.userPrompt = '{{$input}}';
      }
      break;
      
    case 'input':
      config.inputType = input.input_type || 'text';
      config.required = input.required ?? false;
      config.description = input.description || '';
      break;
      
    case 'branch':
      config.condition = input.condition || 'true';
      config.branches = input.branches || [];
      break;
      
    case 'aggregate':
      config.strategy = input.strategy || 'concat';
      config.separator = input.separator || '\n';
      break;
      
    case 'human_gate':
      config.instructions = input.instructions || 'Please review and approve';
      config.allowEdit = input.allow_edit ?? true;
      config.timeout = input.timeout_seconds;
      break;
      
    case 'model_compare':
      const branches = Array.isArray(input.branches) ? input.branches : [];
      config.models = branches.map((b: any) => (b as any)?.input?.model).filter(Boolean) || ['gpt-4'];
      config.temperature = (branches[0] as any)?.input?.temperature ?? 0.7;
      config.maxTokens = (branches[0] as any)?.input?.max_tokens ?? 2048;
      config.prompt = '{{$input}}';
      break;
  }
  
  return {
    id: originalId,
    type,
    position,
    data: {
      label: step.id,
      config
    }
  };
}

function extractStepReferences(input: Record<string, any>): string[] {
  const refs: string[] = [];
  const inputStr = JSON.stringify(input);
  
  // Match $step references
  const stepMatches = inputStr.match(/"\$step":"([^"]+)"/g);
  if (stepMatches) {
    for (const match of stepMatches) {
      const id = match.match(/"\$step":"([^"]+)"/)?.[1];
      if (id) refs.push(id);
    }
  }
  
  return [...new Set(refs)];  // Deduplicate
}

// ==================== Export Utilities ====================

/**
 * Converts Stepflow workflow to YAML string
 */
export function toStepflowYAML(workflow: Workflow): string {
  const stepflow = convertToStepflow(workflow);
  
  // Simple YAML serialization (in production, use a proper YAML library)
  let yaml = `# Stepflow Workflow\n`;
  yaml += `# Generated by MaestroAI\n`;
  yaml += `schema: ${stepflow.schema}\n`;
  yaml += `name: "${escapeYamlString(stepflow.name)}"\n`;
  yaml += `description: "${escapeYamlString(stepflow.description || '')}"\n\n`;
  
  if (stepflow.schemas?.input) {
    yaml += `schemas:\n`;
    yaml += `  input:\n`;
    yaml += `    type: ${stepflow.schemas.input.type}\n`;
    if (stepflow.schemas.input.properties) {
      yaml += `    properties:\n`;
      for (const [key, prop] of Object.entries(stepflow.schemas.input.properties)) {
        yaml += `      ${key}:\n`;
        yaml += `        type: ${prop.type}\n`;
        if (prop.description) yaml += `        description: "${escapeYamlString(prop.description)}"\n`;
        if (prop.default !== undefined) yaml += `        default: ${JSON.stringify(prop.default)}\n`;
      }
    }
    if (stepflow.schemas.input.required && stepflow.schemas.input.required.length > 0) {
      yaml += `    required: [${stepflow.schemas.input.required.map(r => `"${r}"`).join(', ')}]\n`;
    }
    yaml += `\n`;
  }

  yaml += `steps:\n`;
  for (const step of stepflow.steps) {
    yaml += `  - id: ${step.id}\n`;
    yaml += `    component: ${step.component}\n`;
    
    if (step.must_execute) {
      yaml += `    must_execute: true\n`;
    }
    
    yaml += `    input:\n`;
    yaml += objectToYAML(step.input, 6);
    
    if (step.on_error) {
      yaml += `    on_error:\n`;
      if (step.on_error.type) {
        yaml += `      type: ${step.on_error.type}\n`;
      }
      if (step.on_error.action) {
        yaml += `      action: ${step.on_error.action}\n`;
      }
      if (step.on_error.max_attempts) {
        yaml += `      max_attempts: ${step.on_error.max_attempts}\n`;
      }
      if (step.on_error.max_retries) {
        yaml += `      max_retries: ${step.on_error.max_retries}\n`;
      }
      if (step.on_error.value !== undefined) {
        yaml += `      value: ${JSON.stringify(step.on_error.value)}\n`;
      }
    }
    yaml += `\n`;
  }

  // Emit flow-level output
  if (stepflow.output) {
    yaml += `\n`;
    if (typeof stepflow.output === 'object' && '$step' in (stepflow.output as any)) {
      yaml += `output:\n`;
      yaml += `  $step: ${(stepflow.output as any).$step}\n`;
    } else if (typeof stepflow.output === 'object') {
      yaml += `output:\n`;
      yaml += objectToYAML(stepflow.output as any, 2);
    }
  }

  return yaml;
}

/**
 * Escapes special characters in YAML strings
 */
function escapeYamlString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function objectToYAML(obj: any, indent: number): string {
  const spaces = ' '.repeat(indent);
  let yaml = '';
  
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    
    if (typeof value === 'object' && !Array.isArray(value)) {
      if ('$literal' in value) {
        // $literal - output the literal value
        yaml += `${spaces}${key}:\n`;
        yaml += `${spaces}  $literal: ${JSON.stringify((value as any).$literal)}\n`;
      } else if ('$from' in value || '$step' in value || '$input' in value || '$variable' in value || '$template' in value) {
        // Stepflow reference syntax
        yaml += `${spaces}${key}:\n`;
        for (const [refKey, refVal] of Object.entries(value)) {
          yaml += `${spaces}  ${refKey}: ${JSON.stringify(refVal)}\n`;
        }
      } else {
        yaml += `${spaces}${key}:\n`;
        yaml += objectToYAML(value, indent + 2);
      }
    } else if (Array.isArray(value)) {
      yaml += `${spaces}${key}:\n`;
      for (const item of value) {
        if (typeof item === 'object') {
          yaml += `${spaces}  -\n`;
          yaml += objectToYAML(item, indent + 4).replace(/^ {2}/, '');
        } else {
          yaml += `${spaces}  - ${JSON.stringify(item)}\n`;
        }
      }
    } else {
      yaml += `${spaces}${key}: ${JSON.stringify(value)}\n`;
    }
  }
  
  return yaml;
}

/**
 * Converts Stepflow workflow to JSON string
 */
export function toStepflowJSON(workflow: Workflow): string {
  const stepflow = convertToStepflow(workflow);
  return JSON.stringify(stepflow, null, 2);
}

// ==================== FlowBuilder Python Export ====================

/**
 * Generates FlowBuilder Python code for the workflow.
 * This allows programmatic workflow construction using the Stepflow Python SDK.
 */
export function toFlowBuilderPython(workflow: Workflow): string {
  const stepflow = convertToStepflow(workflow);
  const idMapping = createIdMapping(workflow.nodes);
  
  let code = `# FlowBuilder Python Code
# Generated by MaestroAI from workflow: "${escapePythonString(workflow.name)}"
# 
# This code uses the Stepflow Python SDK (stepflow_py) to programmatically
# construct the workflow. Install with: pip install stepflow-py

from stepflow_py.worker import FlowBuilder, Value

# Create a new FlowBuilder
builder = FlowBuilder(
    name="${escapePythonString(stepflow.name)}",
    description="${escapePythonString(stepflow.description || '')}"
)

`;

  // Generate step variables
  const stepVars: string[] = [];
  for (const step of stepflow.steps) {
    const varName = `step_${step.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    stepVars.push(varName);
    
    code += `# Step: ${step.id} (${step.component})
`;
    code += `${varName} = builder.add_step(\n`;
    code += `    step_id="${step.id}",\n`;
    code += `    component="${step.component}",\n`;
    code += `    input_data=${pythonDictString(step.input, 4)}`;
    
    if (step.must_execute) {
      code += `,\n    must_execute=True`;
    }
    
    if (step.on_error) {
      code += `,\n    on_error=${pythonDictString(step.on_error, 4)}`;
    }
    
    code += `\n)\n\n`;
  }

  // Set output
  if (stepflow.output) {
    code += `# Set flow output\n`;
    code += `builder.set_output(\n`;
    code += `    ${pythonValueString(stepflow.output, 4)}\n`;
    code += `)\n\n`;
  }

  code += `# Build the flow
flow = builder.build()

# Example usage:
# async with StepflowClient.local() as client:
#     response = await client.store_flow(flow)
#     result = await client.run(response.flow_id, {"input": "your input here"})
`;

  return code;
}

function escapePythonString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function pythonValueString(value: any, indent: number): string {
  const spaces = ' '.repeat(indent);
  
  if (value === null) return 'None';
  if (value === undefined) return 'None';
  if (typeof value === 'string') return `"${escapePythonString(value)}"`;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map(v => pythonValueString(v, indent + 2));
    return `[\n${spaces}  ${items.join(`,\n${spaces}  `)}\n${spaces}]`;
  }
  
  if (typeof value === 'object') {
    // Handle Value expressions
    if ('$step' in value) {
      if (value.path) {
        return `Value.step("${value.$step}", "${value.path}")`;
      }
      return `Value.step("${value.$step}")`;
    }
    if ('$input' in value) {
      if (value.$input === '$') {
        return 'Value.input()';
      }
      return `Value.input("${value.$input}")`;
    }
    if ('$variable' in value) {
      if (value.default !== undefined) {
        return `Value.variable("${value.$variable}", default=${pythonValueString(value.default, 0)})`;
      }
      return `Value.variable("${value.$variable}")`;
    }
    if ('$template' in value) {
      return `Value.template("${escapePythonString(value.$template)}")`;
    }
    if ('$literal' in value) {
      return `Value.literal(${pythonValueString(value.$literal, 0)})`;
    }
    
    // Regular dict
    return pythonDictString(value, indent);
  }
  
  return String(value);
}

function pythonDictString(obj: Record<string, any>, indent: number): string {
  const spaces = ' '.repeat(indent);
  const entries = Object.entries(obj);
  
  if (entries.length === 0) return '{}';
  
  let result = '{\n';
  for (const [key, value] of entries) {
    result += `${spaces}    "${key}": ${pythonValueString(value, indent + 4)},\n`;
  }
  result += `${spaces}}`;
  
  return result;
}

// ==================== Configuration Generation ====================

/**
 * Stepflow plugin configuration
 */
export interface StepflowConfig {
  plugins: Record<string, {
    type: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
  }>;
  routes: Record<string, Array<{ plugin: string }>>;
  stateStore?: {
    type: string;
    databaseUrl?: string;
    autoMigrate?: boolean;
  };
}

/**
 * Generates a stepflow-config.yml content for running the workflow.
 */
export function generateStepflowConfig(workflow?: Workflow): string {
  const config: StepflowConfig = {
    plugins: {
      builtin: {
        type: 'builtin'
      }
    },
    routes: {
      "/builtin/{*component}": [
        { plugin: 'builtin' }
      ],
      "/{*component}": [
        { plugin: 'builtin' }
      ]
    },
    stateStore: {
      type: 'sqlite',
      databaseUrl: 'sqlite:workflow_state.db',
      autoMigrate: true
    }
  };
  
  // Detect if workflow uses models that need external plugins
  const usedComponents = new Set<string>();
  if (workflow) {
    for (const node of workflow.nodes) {
      if (node.type === 'prompt') {
        const modelConfig = node.data.config as any;
        if (modelConfig?.model) {
          const component = resolveModelComponent(modelConfig.model);
          usedComponents.add(component);
        }
      }
    }
  }
  
  // Add Anthropic plugin if needed
  if (usedComponents.has('/stepflow-anthropic/anthropic')) {
    config.plugins.anthropic = {
      type: 'stepflow',
      command: 'uv',
      args: ['run', '--package', 'stepflow-anthropic', 'stepflow_anthropic'],
      env: {
        ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY:-}'
      }
    };
    config.routes["/stepflow-anthropic/{*component}"] = [{ plugin: 'anthropic' }];
  }
  
  // Add Cohere plugin if needed
  if (usedComponents.has('/stepflow-cohere/cohere')) {
    config.plugins.cohere = {
      type: 'stepflow',
      command: 'uv',
      args: ['run', '--package', 'stepflow-cohere', 'stepflow_cohere'],
      env: {
        COHERE_API_KEY: '${COHERE_API_KEY:-}'
      }
    };
    config.routes["/stepflow-cohere/{*component}"] = [{ plugin: 'cohere' }];
  }
  
  // Generate YAML
  let yaml = `# Stepflow Configuration
# Generated by MaestroAI
# 
# This configuration file defines plugins and routing for the Stepflow runtime.
# Place this file alongside your workflow YAML and run with:
#   stepflow run --flow=workflow.yaml --config=stepflow-config.yaml

`;

  yaml += `plugins:\n`;
  for (const [name, plugin] of Object.entries(config.plugins)) {
    yaml += `  ${name}:\n`;
    yaml += `    type: ${plugin.type}\n`;
    if (plugin.command) {
      yaml += `    command: ${plugin.command}\n`;
    }
    if (plugin.args) {
      yaml += `    args: [${plugin.args.map(a => `"${a}"`).join(', ')}]\n`;
    }
    if (plugin.env) {
      yaml += `    env:\n`;
      for (const [key, value] of Object.entries(plugin.env)) {
        yaml += `      ${key}: "${value}"\n`;
      }
    }
    if (plugin.url) {
      yaml += `    url: "${plugin.url}"\n`;
    }
  }

  yaml += `\nroutes:\n`;
  for (const [route, handlers] of Object.entries(config.routes)) {
    yaml += `  "${route}":\n`;
    for (const handler of handlers) {
      yaml += `    - plugin: ${handler.plugin}\n`;
    }
  }

  yaml += `\nstateStore:\n`;
  yaml += `  type: ${config.stateStore!.type}\n`;
  if (config.stateStore!.databaseUrl) {
    yaml += `  databaseUrl: "${config.stateStore!.databaseUrl}"\n`;
  }
  if (config.stateStore!.autoMigrate !== undefined) {
    yaml += `  autoMigrate: ${config.stateStore!.autoMigrate}\n`;
  }

  return yaml;
}

// ==================== Batch Execution ====================

/**
 * Generates a batch execution schema for the workflow.
 * This allows running the workflow over multiple inputs in parallel.
 */
export function generateBatchSchema(workflow: Workflow): StepflowBatchSchema {
  const inputNodes = workflow.nodes.filter(n => n.type === 'input');
  
  const properties: Record<string, StepflowSchemaProperty> = {};
  for (const node of inputNodes) {
    const config = node.data.config as any;
    properties[node.id] = {
      type: config.inputType === 'number' ? 'number' : 'string',
      description: config.description || node.data.label
    };
  }
  
  return {
    type: 'array',
    items: {
      type: 'object',
      properties,
      required: inputNodes
        .filter(n => (n.data.config as any)?.required)
        .map(n => n.id)
    }
  };
}

// ==================== Validation ====================

/**
 * Validates that a MaestroAI workflow can be converted to Stepflow
 */
export function validateForStepflow(workflow: Workflow): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // Check for circular dependencies (Stepflow requires DAG)
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  
  function hasCycle(nodeId: string, edges: WorkflowEdge[]): boolean {
    visited.add(nodeId);
    recursionStack.add(nodeId);
    
    const outgoingEdges = edges.filter(e => e.source === nodeId);
    for (const edge of outgoingEdges) {
      if (!visited.has(edge.target)) {
        if (hasCycle(edge.target, edges)) return true;
      } else if (recursionStack.has(edge.target)) {
        return true;
      }
    }
    
    recursionStack.delete(nodeId);
    return false;
  }
  
  for (const node of workflow.nodes) {
    if (!visited.has(node.id)) {
      if (hasCycle(node.id, workflow.edges)) {
        errors.push(`Circular dependency detected involving node: ${node.id}`);
        break;
      }
    }
  }
  
  // Check for unsupported node configurations
  for (const node of workflow.nodes) {
    if (node.type === 'prompt') {
      const config = node.data.config as any;
      if (!config.model) {
        errors.push(`Node ${node.id}: Prompt node missing model configuration`);
      }
      
      // Check for IDs that will be modified during sanitization
      const sanitizedId = sanitizeId(node.id);
      if (sanitizedId !== node.id) {
        warnings.push(`Node ${node.id}: ID will be sanitized to "${sanitizedId}" for Stepflow compatibility`);
      }
    }
    
    // Check for potentially problematic characters in templates
    if (node.data.config?.userPrompt?.includes('\\{{')) {
      warnings.push(`Node ${node.id}: Uses escaped braces (\\{{) which will be converted to $literal`);
    }
  }
  
  // Check for orphaned nodes (no connections)
  const connectedNodes = new Set<string>();
  for (const edge of workflow.edges) {
    connectedNodes.add(edge.source);
    connectedNodes.add(edge.target);
  }
  for (const node of workflow.nodes) {
    if (!connectedNodes.has(node.id) && workflow.nodes.length > 1) {
      warnings.push(`Node ${node.id}: Orphaned node with no connections`);
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}
