import OpenAI from 'openai';
import type {
  ChatMessage,
  ChatModel,
  ChatParams,
  ChatTokenUsage,
  ChatToolCall
} from '@maestroai/shared';
import { accumulateToolCallDeltas, finalizeToolCallDeltas } from './toolCalls';

/**
 * OpenRouter provider for chat.
 *
 * OpenRouter exposes an OpenAI-compatible chat completions endpoint that
 * fronts every major model, plus a live model catalog. Completions go through
 * the `openai` SDK with a swapped base URL; the catalog is a plain GET with a
 * short-lived cache so a model picker can search it without hammering the API.
 */

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_CHAT_MODEL = 'openai/gpt-4o-mini';
const CATALOG_TTL_MS = 5 * 60 * 1000;

/** Query parameters OpenRouter's `GET /models` accepts. */
const CATALOG_FILTER_KEYS = [
  'category',
  'supported_parameters',
  'input_modalities',
  'output_modalities',
  'sort',
  'q',
  'context',
  'min_price',
  'max_price',
  'arch',
  'model_authors',
  'providers',
  'distillable',
  'zdr',
  'region'
] as const;

export type CatalogFilters = Partial<
  Record<(typeof CATALOG_FILTER_KEYS)[number], string | number | boolean>
>;

export class ProviderError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

export type WireMessage = OpenAI.Chat.ChatCompletionMessageParam;
export type WireTool = OpenAI.Chat.ChatCompletionTool;
export type WireToolChoice = OpenAI.Chat.ChatCompletionToolChoiceOption;

export interface ChatRequest {
  model: string;
  messages: WireMessage[];
  params?: ChatParams;
  tools?: WireTool[];
  toolChoice?: WireToolChoice;
}

export interface ChatResult {
  content: string;
  model: string;
  tokenUsage: ChatTokenUsage;
  /** Dollar cost reported by the gateway, when it reports one. */
  cost?: number;
  finishReason?: string;
  reasoning?: string;
  toolCalls?: ChatToolCall[];
}

export type ChatStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'done'; result: ChatResult };

/** The slice of the OpenAI SDK the provider calls — injectable for tests. */
export interface CompletionsClient {
  chat: {
    completions: {
      create(body: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<any>;
    };
  };
}

export interface OpenRouterOptions {
  apiKey: string;
  baseURL?: string;
  /** App attribution headers (HTTP-Referer / X-OpenRouter-Title). */
  referer?: string;
  title?: string;
  catalogTtlMs?: number;
  client?: CompletionsClient;
  fetchImpl?: typeof fetch;
}

export class OpenRouterProvider {
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly headers: Record<string, string>;
  private readonly client: CompletionsClient;
  private readonly fetchImpl: typeof fetch;
  private readonly catalogTtlMs: number;
  private readonly catalog = new Map<string, { fetchedAt: number; models: ChatModel[] }>();

  constructor(options: OpenRouterOptions) {
    if (!options.apiKey) {
      throw new ProviderError('OpenRouter API key is required');
    }
    this.apiKey = options.apiKey;
    this.baseURL = (options.baseURL || OPENROUTER_BASE_URL).replace(/\/+$/, '');
    this.headers = {
      'HTTP-Referer': options.referer || 'http://localhost:5173',
      'X-OpenRouter-Title': options.title || 'MaestroAI'
    };
    this.client =
      options.client ??
      (new OpenAI({
        apiKey: this.apiKey,
        baseURL: this.baseURL,
        defaultHeaders: this.headers
      }) as unknown as CompletionsClient);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.catalogTtlMs = options.catalogTtlMs ?? CATALOG_TTL_MS;
  }

  /** Build from the environment; null when no key is configured. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): OpenRouterProvider | null {
    const apiKey = env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) return null;
    return new OpenRouterProvider({
      apiKey,
      baseURL: env.OPENROUTER_BASE_URL,
      referer: env.OPENROUTER_HTTP_REFERER,
      title: env.OPENROUTER_TITLE
    });
  }

  // ==================== Catalog ====================

  /** The model catalog, cached per filter set for a few minutes. */
  async listModels(
    filters: CatalogFilters = {},
    options: { forceRefresh?: boolean } = {}
  ): Promise<ChatModel[]> {
    const query = cleanCatalogFilters(filters);
    const key = JSON.stringify(query);
    const now = Date.now();
    const cached = this.catalog.get(key);
    if (cached && !options.forceRefresh && now - cached.fetchedAt < this.catalogTtlMs) {
      return cached.models.slice();
    }

    const payload = await this.requestJson('/models', query);
    const data = Array.isArray(payload?.data) ? payload.data : [];
    const models = data.filter(isRecord).map(normalizeModelRecord);
    this.catalog.set(key, { fetchedAt: now, models });
    return models.slice();
  }

  private async requestJson(path: string, query: Record<string, string>): Promise<any> {
    const url = new URL(this.baseURL + path);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { ...this.headers, Authorization: `Bearer ${this.apiKey}` }
      });
    } catch (error) {
      throw new ProviderError(`OpenRouter request failed: ${errorMessage(error)}`);
    }

    if (!response.ok) {
      const body = (await response.text()).slice(0, 500);
      throw new ProviderError(`OpenRouter HTTP ${response.status}: ${body}`, response.status);
    }
    try {
      return await response.json();
    } catch (error) {
      throw new ProviderError(`OpenRouter returned invalid JSON: ${errorMessage(error)}`);
    }
  }

  // ==================== Completions ====================

  async chat(request: ChatRequest, options: { signal?: AbortSignal } = {}): Promise<ChatResult> {
    const body = buildChatCompletionBody(request, false);

    let response: any;
    try {
      response = await this.client.chat.completions.create(body, { signal: options.signal });
    } catch (error) {
      throw toProviderError(error);
    }

    const choice = response?.choices?.[0];
    const message = choice?.message ?? {};
    const { tokenUsage, cost } = extractUsage(response?.usage);
    const result: ChatResult = {
      content: typeof message.content === 'string' ? message.content : '',
      model: typeof response?.model === 'string' ? response.model : request.model,
      tokenUsage,
      cost,
      finishReason: choice?.finish_reason ?? undefined
    };
    // OpenRouter reports the trace on `reasoning`; `reasoning_content` is the
    // DeepSeek/Kimi spelling some upstreams pass through.
    const reasoning = message.reasoning ?? message.reasoning_content;
    if (typeof reasoning === 'string' && reasoning) result.reasoning = reasoning;
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      result.toolCalls = message.tool_calls.map(serializeToolCall);
    }
    return result;
  }

  /**
   * Streaming completion. Yields `token` / `reasoning` deltas as they arrive
   * and a final `done` carrying the assembled result (usage rides on the last
   * chunk). Aborting the signal ends the stream with what was received so far
   * and `finishReason: 'cancelled'` rather than throwing.
   */
  async *chatStream(
    request: ChatRequest,
    options: { signal?: AbortSignal } = {}
  ): AsyncGenerator<ChatStreamEvent> {
    const body = buildChatCompletionBody(request, true);

    let content = '';
    let reasoning = '';
    let model = request.model;
    let finishReason: string | undefined;
    let usage: unknown;
    const toolCalls = new Map<number, ChatToolCall>();

    try {
      const stream: AsyncIterable<any> = await this.client.chat.completions.create(body, {
        signal: options.signal
      });
      for await (const chunk of stream) {
        if (typeof chunk?.model === 'string' && chunk.model) model = chunk.model;
        if (chunk?.usage) usage = chunk.usage;

        const choice = chunk?.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta ?? {};
        if (delta.tool_calls) accumulateToolCallDeltas(toolCalls, delta.tool_calls);

        const reasoningDelta = delta.reasoning ?? delta.reasoning_content;
        if (typeof reasoningDelta === 'string' && reasoningDelta) {
          reasoning += reasoningDelta;
          yield { type: 'reasoning', text: reasoningDelta };
        }
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          yield { type: 'token', text: delta.content };
        }
      }
    } catch (error) {
      if (options.signal?.aborted) {
        finishReason = 'cancelled';
      } else {
        throw toProviderError(error);
      }
    }

    const { tokenUsage, cost } = extractUsage(usage);
    const result: ChatResult = { content, model, tokenUsage, cost, finishReason };
    if (reasoning) result.reasoning = reasoning;
    if (toolCalls.size) result.toolCalls = finalizeToolCallDeltas(toolCalls);
    yield { type: 'done', result };
  }
}

// ==================== Request shaping ====================

/** Chat completion request body for one turn. */
export function buildChatCompletionBody(
  request: ChatRequest,
  stream: boolean
): Record<string, unknown> {
  const params = request.params ?? {};
  const body: Record<string, unknown> = { model: request.model, messages: request.messages };

  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;
  if (params.topP !== undefined) body.top_p = params.topP;
  if (params.frequencyPenalty !== undefined) body.frequency_penalty = params.frequencyPenalty;
  if (params.presencePenalty !== undefined) body.presence_penalty = params.presencePenalty;
  if (params.stop?.length) body.stop = params.stop;
  if (request.tools?.length) body.tools = request.tools;
  if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
  if (stream) body.stream = true;

  // OpenRouter's routing / sampling / reasoning extensions are typed on
  // ChatParams but not forwarded yet — they ride the request body as
  // `provider`, top-level sampling keys and `reasoning` respectively.
  return body;
}

/**
 * Stored messages → the wire history for a completion. Assistant turns that
 * produced nothing (failed generations) are dropped; tool-call turns keep
 * their calls so the model sees its own history.
 */
export function toWireMessages(
  messages: ChatMessage[],
  systemPrompt?: string | null
): WireMessage[] {
  const wire: WireMessage[] = [];
  const system = systemPrompt?.trim();
  if (system) wire.push({ role: 'system', content: system });

  for (const message of messages) {
    switch (message.role) {
      case 'system':
        if (message.content.trim()) wire.push({ role: 'system', content: message.content });
        break;
      case 'user':
        wire.push({ role: 'user', content: message.content });
        break;
      case 'assistant': {
        const toolCalls = message.toolCalls ?? [];
        if (!message.content && toolCalls.length === 0) continue;
        const entry: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: message.content
        };
        if (toolCalls.length) entry.tool_calls = toolCalls;
        wire.push(entry);
        break;
      }
      case 'tool':
        wire.push({
          role: 'tool',
          tool_call_id: message.toolCallId ?? '',
          content: message.content
        });
        break;
    }
  }
  return wire;
}

// ==================== Response shaping ====================

/** OpenRouter `/models` item → catalog record. Prices become USD per million tokens. */
export function normalizeModelRecord(raw: Record<string, any>): ChatModel {
  const architecture = isRecord(raw.architecture) ? raw.architecture : {};
  const topProvider = isRecord(raw.top_provider) ? raw.top_provider : {};
  const perRequestLimits = isRecord(raw.per_request_limits) ? raw.per_request_limits : {};
  const pricing = isRecord(raw.pricing) ? raw.pricing : {};
  const id = String(raw.id ?? raw.canonical_slug ?? '');

  return {
    id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : id,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    created: numberOrUndefined(raw.created),
    contextLength: numberOrUndefined(raw.context_length ?? topProvider.context_length),
    maxCompletionTokens: numberOrUndefined(
      topProvider.max_completion_tokens ?? perRequestLimits.max_completion_tokens
    ),
    inputModalities: stringArray(architecture.input_modalities),
    outputModalities: stringArray(architecture.output_modalities),
    supportedParameters: stringArray(raw.supported_parameters),
    pricing: {
      prompt: perMillion(pricing.prompt),
      completion: perMillion(pricing.completion),
      request: numberOrNull(pricing.request),
      image: numberOrNull(pricing.image)
    },
    reasoning: isRecord(raw.reasoning) ? raw.reasoning : undefined
  };
}

/** Case-insensitive search over id, name and description; every term must match. */
export function filterModels(models: ChatModel[], query: string | undefined): ChatModel[] {
  const terms = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return models;
  return models.filter((model) => {
    const haystack = `${model.id} ${model.name} ${model.description ?? ''}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** Usage object (response or final stream chunk) → token counts + cost. */
export function extractUsage(usage: unknown): { tokenUsage: ChatTokenUsage; cost?: number } {
  const source = isRecord(usage) ? usage : {};
  const prompt = toInt(source.prompt_tokens);
  const completion = toInt(source.completion_tokens);
  const tokenUsage: ChatTokenUsage = {
    prompt,
    completion,
    total: toInt(source.total_tokens) || prompt + completion
  };

  const promptDetails = isRecord(source.prompt_tokens_details) ? source.prompt_tokens_details : {};
  const completionDetails = isRecord(source.completion_tokens_details)
    ? source.completion_tokens_details
    : {};
  const cachedTokens = toInt(promptDetails.cached_tokens);
  if (cachedTokens) tokenUsage.cachedTokens = cachedTokens;
  const cacheWriteTokens = toInt(promptDetails.cache_write_tokens);
  if (cacheWriteTokens) tokenUsage.cacheWriteTokens = cacheWriteTokens;
  const reasoningTokens = toInt(completionDetails.reasoning_tokens);
  if (reasoningTokens) tokenUsage.reasoningTokens = reasoningTokens;

  // BYOK requests are billed by the upstream provider directly: OpenRouter's
  // own charge lands in `cost` and the upstream spend in `cost_details`, so
  // the honest per-message figure is their sum.
  const costDetails = isRecord(source.cost_details) ? source.cost_details : {};
  const gatewayCost = numberOrUndefined(source.cost);
  const upstreamCost = numberOrUndefined(costDetails.upstream_inference_cost);
  if (source.is_byok === true) tokenUsage.byok = true;
  const cost =
    gatewayCost === undefined && upstreamCost === undefined
      ? undefined
      : Math.round(((gatewayCost ?? 0) + (upstreamCost ?? 0)) * 1e10) / 1e10;
  return { tokenUsage, cost };
}

function serializeToolCall(call: any): ChatToolCall {
  const args = call?.function?.arguments;
  return {
    id: String(call?.id ?? ''),
    type: 'function',
    function: {
      name: String(call?.function?.name ?? ''),
      arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {})
    }
  };
}

function cleanCatalogFilters(filters: CatalogFilters): Record<string, string> {
  const query: Record<string, string> = {};
  for (const key of CATALOG_FILTER_KEYS) {
    const value = filters[key];
    if (value === undefined || value === null || value === '') continue;
    query[key] = String(value);
  }
  return query;
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const status = typeof (error as any)?.status === 'number' ? (error as any).status : undefined;
  return new ProviderError(`OpenRouter: ${errorMessage(error)}`, status);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function toInt(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function numberOrNull(value: unknown): number | null {
  return numberOrUndefined(value) ?? null;
}

/** OpenRouter prices are USD per token as strings; per-million reads better. */
function perMillion(value: unknown): number | null {
  const number = numberOrUndefined(value);
  if (number === undefined) return null;
  return Math.round(number * 1_000_000 * 1e9) / 1e9;
}
