// Shared types and utilities for MaestroAI

export { createExampleWorkflow } from './exampleWorkflow';
export * from './validate';

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

export interface InputConfig {
  inputType?: string;
  required?: boolean;
  description?: string;
}

export type NodeConfig =
  | PromptConfig
  | BranchConfig
  | AggregateConfig
  | HumanGateConfig
  | ModelCompareConfig
  | InputConfig
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

// ==================== Chat Types ====================

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/** OpenRouter provider-routing preferences (the request's `provider` object). */
export interface OpenRouterRouting {
  order?: string[];
  only?: string[];
  ignore?: string[];
  allowFallbacks?: boolean;
  requireParameters?: boolean;
  dataCollection?: 'allow' | 'deny';
  zdr?: boolean;
  quantizations?: string[];
  sort?: 'price' | 'throughput' | 'latency';
  /** USD per million tokens (per request / per image for those fields). */
  maxPrice?: { prompt?: number; completion?: number; request?: number; image?: number };
  /** Fallback model slugs, tried in order when the primary model fails. */
  fallbackModels?: string[];
}

/** Sampling controls OpenRouter accepts beyond the OpenAI parameter set. */
export interface OpenRouterSampling {
  topK?: number;
  minP?: number;
  topA?: number;
  repetitionPenalty?: number;
  seed?: number;
}

/** Reasoning-token controls for thinking models. `effort` and `maxTokens` are exclusive. */
export interface OpenRouterReasoning {
  effort?: 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none';
  maxTokens?: number;
  /** Think, but leave the trace out of the response. */
  exclude?: boolean;
  enabled?: boolean;
}

/**
 * Generation settings for a chat turn. The OpenAI-compatible sampling
 * parameters are sent today; `routing`, `sampling` and `reasoning` are the
 * OpenRouter extensions — typed here so the UI and storage agree on their
 * shape, forwarded to the gateway in a later milestone.
 */
export interface ChatParams {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string[];
  routing?: OpenRouterRouting;
  sampling?: OpenRouterSampling;
  reasoning?: OpenRouterReasoning;
}

export interface Conversation {
  id: string;
  title: string;
  /** Default model for new turns. */
  model: string;
  systemPrompt: string | null;
  params: ChatParams;
  /** Tip of the branch in view; null for an empty conversation. */
  activeLeafId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A tool call in OpenAI function-calling shape; `arguments` is a JSON string. */
export interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatTokenUsage extends TokenUsage {
  cachedTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** Billed through a bring-your-own-key upstream account. */
  byok?: boolean;
}

/**
 * One message in a conversation. Messages form a tree through `parentId`:
 * siblings are alternative branches (retries, edits) and the conversation's
 * `activeLeafId` marks the branch in view. The path from the root to the
 * active leaf is the history sent to the model.
 */
export interface ChatMessage {
  id: string;
  conversationId: string;
  parentId: string | null;
  role: MessageRole;
  content: string;
  createdAt: number;
  /** Model that produced an assistant message, as the gateway resolved it. */
  model?: string;
  tokenUsage?: ChatTokenUsage;
  /** USD, as reported by the gateway. */
  cost?: number;
  latencyMs?: number;
  finishReason?: string;
  /** Reasoning trace emitted by a thinking model. */
  reasoning?: string;
  toolCalls?: ChatToolCall[];
  /** For a 'tool' message: the assistant tool call it answers. */
  toolCallId?: string;
  /** Set when the generation failed; `content` holds whatever streamed first. */
  error?: string;
}

export interface ConversationDetail extends Conversation {
  messages: ChatMessage[];
}

/** A model from the OpenRouter catalog. Prices are USD per million tokens. */
export interface ChatModel {
  id: string;
  name: string;
  description?: string;
  created?: number;
  contextLength?: number;
  maxCompletionTokens?: number;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  pricing: {
    prompt: number | null;
    completion: number | null;
    request: number | null;
    image: number | null;
  };
  /** Per-model reasoning capability, as the catalog reports it. */
  reasoning?: Record<string, unknown>;
}

// ==================== Chat Socket Protocol ====================
//
// Client → server: `chat:send` (ChatSendRequest), `chat:cancel`
// ({ conversationId }), `chat:join` / `chat:leave` (conversationId).
// Server → the conversation's room: `chat:message`, `chat:start`,
// `chat:token`, `chat:reasoning`, `chat:complete`, `chat:error`.

export interface ChatSendRequest {
  conversationId: string;
  content: string;
  /** Message to reply under; defaults to the active leaf. */
  parentId?: string | null;
  /** Overrides the conversation's model for this turn. */
  model?: string;
  /** Merged over the conversation's params for this turn. */
  params?: ChatParams;
}

/** The stored user message that opened the turn. */
export interface ChatMessageEvent {
  conversationId: string;
  message: ChatMessage;
}

export interface ChatStartEvent {
  conversationId: string;
  messageId: string;
  parentId: string;
  model: string;
}

export interface ChatTokenEvent {
  conversationId: string;
  messageId: string;
  token: string;
}

export interface ChatReasoningEvent {
  conversationId: string;
  messageId: string;
  text: string;
}

/** The stored assistant message, with usage, cost and latency. */
export interface ChatCompleteEvent {
  conversationId: string;
  message: ChatMessage;
}

export interface ChatErrorEvent {
  conversationId: string;
  error: string;
  messageId?: string;
  /** The stored (failed) assistant message, when the turn got that far. */
  message?: ChatMessage;
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
