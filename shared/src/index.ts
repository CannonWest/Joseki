// Shared types and utilities for MaestroAI

// Export Stepflow compatibility layer
export * from './stepflow';
export * from './stepflowSchema';
export * from './stepflowExpressions';
export * from './stepflowDiscovery';

// Re-export specific types for convenience
export type {
  StepflowWorkflow,
  StepflowStep,
  StepflowInputValue,
  StepflowInputSchema,
  StepflowBatchSchema,
  StepflowSchemaProperty,
  StepflowErrorHandler,
  StepflowFromReference,
  StepflowConfig,
  IdMapping
} from './stepflow';

export type {
  ValidatedStepflowWorkflow,
  ValidatedStepflowConfig,
  ValidatedStepflowStep,
  ValidatedStepflowErrorHandler,
  ValidationResult
} from './stepflowSchema';

// Export expression types
export type {
  StepReference,
  InputReference,
  VariableReference,
  TemplateExpression,
  LiteralExpression,
  FromReference,
  StepflowExpression,
  EvaluationContext
} from './stepflowExpressions';

// Export discovery types
export type {
  ComponentInfo,
  ComponentExample,
  PluginInfo,
  MCPServerConfig,
  DiscoveryOptions,
  ComponentCategory
} from './stepflowDiscovery';

// ==================== Workflow Types ====================

export type NodeType = 
  | 'prompt' 
  | 'branch' 
  | 'aggregate' 
  | 'human_gate' 
  | 'model_compare'
  | 'input'
  | 'output';

export interface Position {
  x: number;
  y: number;
}

export interface NodeData {
  label: string;
  config: NodeConfig;
  lastExecution?: ExecutionTrace;
  averageLatency?: number;
}

export interface WorkflowNode {
  id: string;
  type: NodeType;
  position: Position;
  data: NodeData;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  type?: 'default' | 'conditional';
  data?: {
    condition?: string;
    label?: string;
  };
}

export interface Workflow {
  id: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  variables: Record<string, any>;
  createdAt: number;
  updatedAt: number;
}

// ==================== Node Config Types ====================

export interface ErrorHandlerConfig {
  strategy: 'retry' | 'default' | 'fail';
  maxAttempts?: number;       // for retry
  fallbackValue?: any;        // for default
}

export interface PromptConfig {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  temperature: number;
  maxTokens: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  onError?: ErrorHandlerConfig;
}

export interface BranchConfig {
  condition: string;
  branches: Array<{
    id: string;
    label: string;
    condition: string;
  }>;
}

export interface AggregateConfig {
  strategy: 'concat' | 'vote' | 'merge';
  separator?: string;
}

export interface HumanGateConfig {
  instructions: string;
  allowEdit: boolean;
  timeout?: number;
}

export interface ModelCompareConfig {
  models: string[];
  prompt: string;
  temperature: number;
  maxTokens: number;
}

export type NodeConfig = 
  | PromptConfig 
  | BranchConfig 
  | AggregateConfig 
  | HumanGateConfig 
  | ModelCompareConfig
  | Record<string, never>;

// ==================== Execution Types ====================

export type ExecutionStatus = 
  | 'pending' 
  | 'running' 
  | 'success' 
  | 'error' 
  | 'paused';

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface ExecutionTrace {
  runId: string;
  timestamp: number;
  input: any;
  output: any;
  tokenUsage: TokenUsage;
  cost: number;
  latencyMs: number;
  status: ExecutionStatus;
  error?: string;
  parentBranchId?: string;
  model?: string;
}

export interface ExecutionContext {
  [nodeId: string]: {
    output: any;
    trace: ExecutionTrace;
  };
}

// ==================== Conversation Tree Types ====================

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ConversationNode {
  id: string;
  role: MessageRole;
  content: string;
  workflowNodeId: string;
  executionRunId: string;
  children: string[];
  parent: string | null;
  metadata: {
    model?: string;
    temperature?: number;
    timestamp: number;
    tokenUsage?: TokenUsage;
    cost?: number;
    latencyMs?: number;
  };
}

export interface ConversationTree {
  id: string;
  workflowId: string;
  rootId: string;
  nodes: Map<string, ConversationNode>;
  createdAt: number;
}

// ==================== API Types ====================

export interface StreamChunk {
  type: 'token' | 'error' | 'complete' | 'metadata';
  data: string | TokenUsage | { error: string } | { cost: number; latencyMs: number };
}

export interface EngineWorkflow {
  version: string;
  workflow: Workflow;
  executionPlan: ExecutionStep[];
}

export interface ExecutionStep {
  nodeId: string;
  dependencies: string[];
  parallelGroup?: number;
}

// ==================== Model Config ====================

export interface ModelConfig {
  id: string;
  name: string;
  provider: 'openai' | 'anthropic' | 'cohere' | 'local';
  modelId: string;
  maxTokens: number;
  pricing: {
    input: number;
    output: number;
  };
  capabilities: string[];
}

// ==================== Utility Functions ====================

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function calculateCost(
  tokenUsage: TokenUsage,
  modelPricing: { input: number; output: number }
): number {
  const inputCost = (tokenUsage.prompt / 1000) * modelPricing.input;
  const outputCost = (tokenUsage.completion / 1000) * modelPricing.output;
  return Number((inputCost + outputCost).toFixed(6));
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function createDefaultWorkflow(): Workflow {
  const inputNode: WorkflowNode = {
    id: generateId(),
    type: 'input',
    position: { x: 250, y: 50 },
    data: { label: 'User Input', config: {} }
  };

  const promptNode: WorkflowNode = {
    id: generateId(),
    type: 'prompt',
    position: { x: 250, y: 200 },
    data: {
      label: 'AI Response',
      config: {
        systemPrompt: 'You are a helpful assistant.',
        userPrompt: '{{input}}',
        model: 'gpt-4',
        temperature: 0.7,
        maxTokens: 2048
      } as PromptConfig
    }
  };

  const outputNode: WorkflowNode = {
    id: generateId(),
    type: 'output',
    position: { x: 250, y: 350 },
    data: { label: 'Output', config: {} }
  };

  return {
    id: generateId(),
    name: 'Hello World',
    nodes: [inputNode, promptNode, outputNode],
    edges: [
      { id: generateId(), source: inputNode.id, target: promptNode.id },
      { id: generateId(), source: promptNode.id, target: outputNode.id }
    ],
    variables: {},
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}
