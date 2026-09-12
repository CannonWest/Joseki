// Shared types and utilities for Joseki

import type { MergePatch } from './patch';
import { DEFAULT_WORKFLOW_MODEL } from './models';
export { createExampleWorkflow } from './exampleWorkflow';
export * from './validate';
export * from './chat';
export * from './patch';
export * from './models';

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

/**
 * What a node does when it fails.
 *
 * - `fail` — the node fails and the run stops there. What a node with no
 *   strategy does, and what every node did before there were strategies.
 * - `retry` — run it again, up to `maxAttempts` tries in all, waiting longer
 *   before each one. Every attempt is recorded, so the history shows the
 *   failures as well as the try that worked; if the last one still fails the
 *   run stops, as `fail` would.
 * - `default` — the node carries `fallbackValue` instead of failing and the
 *   run goes on. The trace keeps the error, so the record still says what it
 *   recovered from.
 */
export interface ErrorHandlerConfig {
  strategy: 'retry' | 'default' | 'fail';
  /** Tries in all, counting the first. Default DEFAULT_MAX_ATTEMPTS, capped at MAX_ATTEMPTS. */
  maxAttempts?: number;
  /** What the node carries when `default` salvages it. Unset carries null. */
  fallbackValue?: any;
}

/** Tries a retrying node gets in all, counting the first. */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** The most tries a node may be given, however high maxAttempts is set. */
export const MAX_ATTEMPTS = 10;

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
  /** The reviewer may replace the content on pass. */
  allowEdit: boolean;
  /** Seconds to wait for a decision before the run fails. Default DEFAULT_GATE_TIMEOUT_SECONDS. */
  timeout?: number;
  /** How many times a fail arrow may send work back before the run fails. Default DEFAULT_MAX_REVISIONS. */
  maxRevisions?: number;
}

export const DEFAULT_GATE_TIMEOUT_SECONDS = 3600;
export const DEFAULT_MAX_REVISIONS = 3;


export type GateVerdict = 'pass' | 'fail';

/** What the reviewer decided at a human gate. */
export interface GateDecision {
  verdict: GateVerdict;
  /** Optional reason; templates can read it as {{nodes.<gate>.decision.note}}. */
  note?: string;
  /** Replacement content on pass, honoured only when the gate allows edits. */
  edited?: unknown;
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
  /** Used when the run supplies no value for this input. */
  defaultValue?: unknown;
}

/** How an output node's result is shown and downloaded. `auto` picks json for objects and arrays, markdown for text. */
export type OutputFormat = 'auto' | 'text' | 'markdown' | 'json';

export interface OutputConfig {
  format?: OutputFormat;
}

export type NodeConfig =
  | PromptConfig
  | BranchConfig
  | AggregateConfig
  | HumanGateConfig
  | ModelCompareConfig
  | InputConfig
  | OutputConfig
  | Record<string, never>;

// ==================== Execution Types ====================

export type ExecutionStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'error'
  | 'paused'
  /** Never ran: every arrow into the node came from a path that was not taken. */
  | 'skipped';

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
    /** For a human gate: the reviewer's decision, once made. */
    decision?: GateDecision;
  };
}

// ==================== Run History ====================
//
// A run is recorded as it happens: one `executions` row, and one trace per
// node that ran. These are the read shapes for that record — what the runs
// list and a reopened run are built from.

/** One past run, as stored. */
export interface ExecutionRecord {
  id: string;
  workflowId: string;
  status: ExecutionStatus;
  /** Variables the run started with. Input values live in each input node's trace. */
  context: Record<string, any>;
  startedAt: number;
  completedAt?: number;
  error?: string;
  parentExecutionId?: string;
}

/** A row in the runs list: the record plus what the traces add up to. */
export interface ExecutionSummary extends ExecutionRecord {
  workflowName?: string;
  /** Traces written, counting a node that ran more than once each time. */
  traceCount: number;
  /** Distinct nodes the run touched. */
  nodeCount: number;
  totalCost: number;
  totalTokens: number;
}

/**
 * A run reopened. `traces` is the whole sequence in the order it happened —
 * a node sent back by a gate appears once per attempt, so the rework is
 * visible rather than collapsed.
 */
export interface ExecutionDetail extends ExecutionSummary {
  traces: Array<ExecutionTrace & { nodeId: string }>;
}

// ==================== Execution Socket Protocol ====================
//
// Client → server: `execution:start`, `execution:resume`
// (ExecutionResumeRequest), `execution:cancel` (executionId).
// Server → the starting socket: `execution:nodeStart`, `execution:token`,
// `execution:nodeComplete`, `execution:paused` (ExecutionPausedEvent),
// `execution:resumed`, `execution:complete`, `execution:error`.

/** The run stopped at a human gate and is waiting for a decision. */
export interface ExecutionPausedEvent {
  executionId: string;
  nodeId: string;
  /** What the gate received — the thing under review. */
  content: unknown;
  instructions: string;
  allowEdit: boolean;
  /** How many times this gate has already sent work back in this run. */
  revision: number;
  maxRevisions: number;
}

export interface ExecutionResumeRequest {
  executionId: string;
  nodeId: string;
  decision: GateDecision;
}

// ==================== Chat Types ====================

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/** Quantization levels a provider endpoint may report, as OpenRouter names them. */
export type Quantization = 'int4' | 'int8' | 'fp4' | 'fp6' | 'fp8' | 'fp16' | 'bf16' | 'fp32' | 'unknown';

/** OpenRouter provider-routing preferences (the request's `provider` object). */
export interface OpenRouterRouting {
  order?: string[];
  only?: string[];
  ignore?: string[];
  allowFallbacks?: boolean;
  requireParameters?: boolean;
  dataCollection?: 'allow' | 'deny';
  zdr?: boolean;
  quantizations?: Quantization[];
  sort?: 'price' | 'throughput' | 'latency';
  /** USD per million tokens (per request / per image for those fields). */
  maxPrice?: { prompt?: number; completion?: number; request?: number; image?: number };
  /** Tokens per second (p50) below which an endpoint is deprioritized — not excluded. */
  preferredMinThroughput?: number;
  /** Seconds (p50) above which an endpoint is deprioritized — not excluded. */
  preferredMaxLatency?: number;
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

/** Reasoning effort levels; a model advertises the subset it accepts in `ModelReasoning.supportedEfforts`. */
export type ReasoningEffort = 'max' | 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none';

/** Reasoning-token controls for thinking models. `effort` and `maxTokens` are exclusive; a budget wins. */
export interface OpenRouterReasoning {
  effort?: ReasoningEffort;
  /** Token budget for thinking; the gateway clamps it to 1024–128000. */
  maxTokens?: number;
  /** Think, but leave the trace out of the response. */
  exclude?: boolean;
  enabled?: boolean;
}

/**
 * Generation settings for a chat turn: the OpenAI-compatible sampling
 * parameters plus OpenRouter's extensions — `routing` becomes the request's
 * `provider` object (and `models` for fallbacks), `sampling` its top-level
 * sampling keys, `reasoning` its `reasoning` object. A PATCH merges params as
 * a JSON Merge Patch, so a nested field can be set or cleared on its own.
 */
export interface ChatParams {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string[];
  /** Let the model call tools (run_workflow and the builtins). On unless false. */
  tools?: boolean;
  routing?: OpenRouterRouting;
  sampling?: OpenRouterSampling;
  reasoning?: OpenRouterReasoning;
}

/** What a PATCH (or a per-turn override) may send for `params`: a merge patch — set a nested field alone, or clear one with `null`. */
export type ChatParamsPatch = MergePatch<ChatParams>;

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
  /** The provider that served it, as the gateway reports it (e.g. "Azure"). */
  provider?: string;
  tokenUsage?: ChatTokenUsage;
  /** USD, as reported by the gateway. */
  cost?: number;
  latencyMs?: number;
  finishReason?: string;
  /** Reasoning trace emitted by a thinking model. */
  reasoning?: string;
  /** The provider's structured reasoning blocks, replayed with tool calls so a thinking model keeps its thread. */
  reasoningDetails?: unknown[];
  toolCalls?: ChatToolCall[];
  /** For a 'tool' message: the assistant tool call it answers. */
  toolCallId?: string;
  /**
   * Set when the generation failed (`content` holds whatever streamed first)
   * or, on a tool message, when the tool reported an error.
   */
  error?: string;
}

export interface ConversationDetail extends Conversation {
  messages: ChatMessage[];
  /** A reply is being generated right now; socket events will follow. */
  generating?: boolean;
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
  /** Per-model reasoning capability; absent for models that cannot reason. */
  reasoning?: ModelReasoning;
}

/** What the catalog says about a model's reasoning — the gating data for reasoning controls. */
export interface ModelReasoning {
  /** The model always reasons; it cannot be turned off. */
  mandatory?: boolean;
  /** Whether the gateway reasons when a request sets nothing under `reasoning`. */
  defaultEnabled?: boolean;
  supportedEfforts?: ReasoningEffort[];
  /** The effort used when reasoning is on and no effort was given. */
  defaultEffort?: ReasoningEffort;
  /** The model takes a token budget (`reasoning.maxTokens`), not only an effort level. */
  supportsMaxTokens?: boolean;
}

/** One provider endpoint serving a model, from OpenRouter's `/models/{author}/{slug}/endpoints`. */
export interface ModelEndpoint {
  /** Display name, e.g. "Azure". */
  providerName: string;
  /** The slug routing preferences (`order` / `only` / `ignore`) take, e.g. "azure". */
  providerSlug: string;
  /** The endpoint's own label, e.g. "Azure | openai/gpt-4o-mini". */
  name: string;
  contextLength?: number;
  maxPromptTokens?: number;
  maxCompletionTokens?: number;
  /** USD per million tokens, like `ChatModel.pricing`. */
  pricing: ChatModel['pricing'];
  /** As the gateway reports it — one of `Quantization` today, kept open for new levels. */
  quantization?: string;
  supportedParameters: string[];
  supportsImplicitCaching?: boolean;
  /** Seconds, over the last 30 minutes; null when the gateway has no sample. */
  latencyLast30m: number | null;
  /** Tokens per second, over the last 30 minutes; null when the gateway has no sample. */
  throughputLast30m: number | null;
  /** Percent, over the last 5 minutes / 30 minutes / day; null when the gateway has no sample. */
  uptimeLast5m: number | null;
  uptimeLast30m: number | null;
  uptimeLast1d: number | null;
  /** The gateway's status code for the endpoint; 0 is healthy. */
  status?: number;
}

/** A model's provider roster, cached server-side for a few minutes. */
export interface ModelEndpoints {
  id: string;
  name: string;
  endpoints: ModelEndpoint[];
  /** Epoch ms of the fetch behind this response. */
  fetchedAt: number;
}

// ==================== Chat Socket Protocol ====================
//
// Client → server: `chat:send` (ChatSendRequest), `chat:cancel`
// ({ conversationId }), `chat:join` / `chat:leave` (conversationId).
// Server → the conversation's room: `chat:message` (any stored message),
// `chat:start`, `chat:token`, `chat:reasoning`, `chat:tool_start`,
// `chat:tool_end`, `chat:complete`, `chat:error`.

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

/**
 * A message stored during the turn: the user's, an assistant turn that
 * called tools, or a tool result. The final reply arrives as `chat:complete`.
 */
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

/** A tool call is running. */
export interface ChatToolStartEvent {
  conversationId: string;
  /** The assistant message that made the call. */
  messageId: string;
  callId: string;
  name: string;
  /** The call's JSON arguments, trimmed for display. */
  args: string;
  iteration: number;
}

export interface ChatToolEndEvent {
  conversationId: string;
  messageId: string;
  callId: string;
  name: string;
  isError: boolean;
  durationMs: number;
  iteration: number;
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
        model: DEFAULT_WORKFLOW_MODEL,
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
