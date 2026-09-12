import OpenAI from 'openai';
import type {
  ChatMessage,
  ChatModel,
  ChatParams,
  ChatTokenUsage,
  ChatToolCall,
  ModelEndpoint,
  ModelEndpoints,
  ModelReasoning,
  OpenRouterReasoning,
  OpenRouterRouting,
  OpenRouterSampling,
  ReasoningEffort
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
/** An assistant history message with OpenRouter's reasoning fields. */
export type AssistantWireMessage = OpenAI.Chat.ChatCompletionAssistantMessageParam & {
  reasoning?: string;
  reasoning_details?: unknown[];
};

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
  /** The provider the gateway routed to, when it says. */
  provider?: string;
  tokenUsage: ChatTokenUsage;
  /** Dollar cost reported by the gateway, when it reports one. */
  cost?: number;
  finishReason?: string;
  reasoning?: string;
  /** OpenRouter's structured reasoning blocks — replayed with tool calls. */
  reasoningDetails?: unknown[];
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
  private readonly endpoints = new Map<string, ModelEndpoints>();

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

  /** The catalog record for one model id; undefined when the catalog does not list it. */
  async findModel(modelId: string): Promise<ChatModel | undefined> {
    const models = await this.listModels();
    return models.find((model) => model.id === modelId);
  }

  /**
   * A model's provider roster — who serves it, at what price and quantization,
   * with recent latency, throughput and uptime. Cached per model for the
   * catalog TTL.
   */
  async getModelEndpoints(
    modelId: string,
    options: { forceRefresh?: boolean } = {}
  ): Promise<ModelEndpoints> {
    const id = modelId.trim();
    const slash = id.indexOf('/');
    if (slash <= 0 || slash === id.length - 1) {
      throw new ProviderError('OpenRouter model ids look like author/slug', 400);
    }
    const now = Date.now();
    const cached = this.endpoints.get(id);
    if (cached && !options.forceRefresh && now - cached.fetchedAt < this.catalogTtlMs) {
      return cached;
    }

    const author = encodeURIComponent(id.slice(0, slash));
    const slug = encodeURIComponent(id.slice(slash + 1));
    const payload = await this.requestJson(`/models/${author}/${slug}/endpoints`, {});
    const roster = normalizeEndpointsPayload(payload, id, now);
    this.endpoints.set(id, roster);
    return roster;
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
    if (typeof response?.provider === 'string' && response.provider) result.provider = response.provider;
    // OpenRouter reports the trace on `reasoning`; `reasoning_content` is the
    // DeepSeek/Kimi spelling some upstreams pass through.
    const reasoning = message.reasoning ?? message.reasoning_content;
    if (typeof reasoning === 'string' && reasoning) result.reasoning = reasoning;
    if (Array.isArray(message.reasoning_details) && message.reasoning_details.length) {
      result.reasoningDetails = message.reasoning_details;
    }
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
    const reasoningDetails: unknown[] = [];
    let model = request.model;
    let provider: string | undefined;
    let finishReason: string | undefined;
    let usage: unknown;
    const toolCalls = new Map<number, ChatToolCall>();

    try {
      const stream: AsyncIterable<any> = await this.client.chat.completions.create(body, {
        signal: options.signal
      });
      for await (const chunk of stream) {
        if (typeof chunk?.model === 'string' && chunk.model) model = chunk.model;
        if (typeof chunk?.provider === 'string' && chunk.provider) provider = chunk.provider;
        if (chunk?.usage) usage = chunk.usage;

        const choice = chunk?.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta ?? {};
        if (delta.tool_calls) accumulateToolCallDeltas(toolCalls, delta.tool_calls);

        if (Array.isArray(delta.reasoning_details)) mergeReasoningDetails(reasoningDetails, delta.reasoning_details);
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
      if (!options.signal?.aborted) throw toProviderError(error);
    }
    // The SDK ends an aborted stream quietly rather than throwing, so the
    // signal — not the catch — is what marks the reply cancelled.
    if (options.signal?.aborted) finishReason = 'cancelled';

    const { tokenUsage, cost } = extractUsage(usage);
    const result: ChatResult = { content, model, tokenUsage, cost, finishReason };
    if (provider) result.provider = provider;
    if (reasoning) result.reasoning = reasoning;
    if (reasoningDetails.length) result.reasoningDetails = reasoningDetails;
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

  // OpenRouter's extensions ride the same body: routing preferences as the
  // `provider` object (and `models` for fallbacks), the extra sampling knobs
  // as top-level keys, `reasoning` as its own object. Empty strings and empty
  // lists mean "unset" — a settings form clears a field by sending one.
  const provider = buildProviderPreferences(params.routing, Boolean(request.tools?.length));
  if (provider) body.provider = provider;
  const fallbacks = cleanStringList(params.routing?.fallbackModels);
  if (fallbacks) body.models = fallbacks;

  const sampling = params.sampling ?? {};
  if (isNumber(sampling.topK)) body.top_k = sampling.topK;
  if (isNumber(sampling.minP)) body.min_p = sampling.minP;
  if (isNumber(sampling.topA)) body.top_a = sampling.topA;
  if (isNumber(sampling.repetitionPenalty)) body.repetition_penalty = sampling.repetitionPenalty;
  if (isNumber(sampling.seed)) body.seed = sampling.seed;

  const reasoning = buildReasoning(params.reasoning);
  if (reasoning) {
    body.reasoning = reasoning;
    // A thinking budget must stay strictly below max_tokens, or the gateway
    // rejects the request for leaving no room to answer. The stored
    // max_tokens is the answer allowance; the budget goes on top of it, so
    // the two settings never fight. Without a max_tokens, the gateway's own
    // default applies and is left alone.
    const budget = reasoning.max_tokens;
    if (isNumber(budget) && isNumber(body.max_tokens) && budget >= body.max_tokens) {
      body.max_tokens = body.max_tokens + budget;
    }
  }
  return body;
}

const REASONING_BUDGET_MIN = 1024;
const REASONING_BUDGET_MAX = 128_000;
const REASONING_EFFORTS: ReadonlySet<string> = new Set<ReasoningEffort>([
  'max',
  'xhigh',
  'high',
  'medium',
  'low',
  'minimal',
  'none'
]);

/** `params.routing` → the request's `provider` object; undefined when nothing is set. */
function buildProviderPreferences(
  routing: OpenRouterRouting | undefined,
  withTools: boolean
): Record<string, unknown> | undefined {
  const source = routing ?? {};
  const prefs: Record<string, unknown> = {};
  const order = cleanStringList(source.order);
  if (order) prefs.order = order;
  const only = cleanStringList(source.only);
  if (only) prefs.only = only;
  const ignore = cleanStringList(source.ignore);
  if (ignore) prefs.ignore = ignore;
  if (typeof source.allowFallbacks === 'boolean') prefs.allow_fallbacks = source.allowFallbacks;
  if (typeof source.requireParameters === 'boolean') prefs.require_parameters = source.requireParameters;
  if (source.dataCollection === 'allow' || source.dataCollection === 'deny') {
    prefs.data_collection = source.dataCollection;
  }
  if (typeof source.zdr === 'boolean') prefs.zdr = source.zdr;
  const quantizations = cleanStringList(source.quantizations);
  if (quantizations) prefs.quantizations = quantizations;
  if (source.sort === 'price' || source.sort === 'throughput' || source.sort === 'latency') {
    prefs.sort = source.sort;
  }
  const maxPrice = cleanMaxPrice(source.maxPrice);
  if (maxPrice) prefs.max_price = maxPrice;
  if (isNumber(source.preferredMinThroughput)) prefs.preferred_min_throughput = source.preferredMinThroughput;
  if (isNumber(source.preferredMaxLatency)) prefs.preferred_max_latency = source.preferredMaxLatency;

  // A provider that ignores parameters it does not support would drop the
  // tools and break the loop; with tools on, route only to those honouring
  // every parameter sent — unless the setting was made explicitly.
  if (withTools && prefs.require_parameters === undefined) prefs.require_parameters = true;
  return Object.keys(prefs).length ? prefs : undefined;
}

/** `params.reasoning` → the request's `reasoning` object; undefined when nothing is set. */
function buildReasoning(
  reasoning: OpenRouterReasoning | undefined
): Record<string, unknown> | undefined {
  if (!reasoning) return undefined;
  const out: Record<string, unknown> = {};
  const budget = isNumber(reasoning.maxTokens) && reasoning.maxTokens > 0 ? reasoning.maxTokens : 0;
  if (budget) {
    // The gateway floors a budget at 1024 and caps it at 128k; clamping here
    // keeps the wire value equal to what will be used. A budget wins over an
    // effort — the two are exclusive.
    out.max_tokens = Math.min(Math.max(Math.round(budget), REASONING_BUDGET_MIN), REASONING_BUDGET_MAX);
  } else if (isReasoningEffort(reasoning.effort)) {
    out.effort = reasoning.effort;
  }
  if (typeof reasoning.enabled === 'boolean') out.enabled = reasoning.enabled;
  if (reasoning.exclude === true) out.exclude = true;
  return Object.keys(out).length ? out : undefined;
}

/**
 * The conversation's reasoning setting with the model's advertised default
 * filled in when the conversation set nothing: a model whose catalog record
 * carries `defaultEffort` reasons at that effort out of the box — for one
 * with `defaultEnabled: false`, this is what turns it on. An explicit setting
 * (on, off, an effort, a budget) is left alone; so is an unknown model.
 */
export function applyReasoningDefault(params: ChatParams, model: ChatModel | undefined): ChatParams {
  const effort = model?.reasoning?.defaultEffort;
  if (!effort || hasReasoningSetting(params.reasoning)) return params;
  return { ...params, reasoning: { ...(params.reasoning ?? {}), effort } };
}

/** ChatParams fields → the names the catalog lists under `supported_parameters` (any one counts). */
const PARAM_WIRE_NAMES: Array<[keyof ChatParams, string[]]> = [
  ['temperature', ['temperature']],
  ['maxTokens', ['max_tokens', 'max_completion_tokens']],
  ['topP', ['top_p']],
  ['frequencyPenalty', ['frequency_penalty']],
  ['presencePenalty', ['presence_penalty']],
  ['stop', ['stop']],
  ['reasoning', ['reasoning']]
];

const SAMPLING_WIRE_NAMES: Array<[keyof OpenRouterSampling, string]> = [
  ['topK', 'top_k'],
  ['minP', 'min_p'],
  ['topA', 'top_a'],
  ['repetitionPenalty', 'repetition_penalty'],
  ['seed', 'seed']
];

/**
 * The turn's params shaped to the model's catalog record. Parameters the
 * model does not list under `supported_parameters` are dropped — the gateway
 * would drop them anyway, and with `require_parameters` forced (tools on) an
 * unsupported one leaves no endpoint to route to: a 404 for every
 * conversation that sends the default `temperature` to a GPT-5-family model.
 * Tools are withheld from a model without tool support, and the default
 * reasoning effort is applied (`applyReasoningDefault`). An unknown model —
 * not in the catalog — is left alone.
 */
export function applyModelCapabilities(params: ChatParams, model: ChatModel | undefined): ChatParams {
  if (!model) return params;
  const supported = new Set(model.supportedParameters);
  const shaped: ChatParams = { ...params };
  for (const [key, names] of PARAM_WIRE_NAMES) {
    if (shaped[key] !== undefined && !names.some((name) => supported.has(name))) delete shaped[key];
  }
  if (shaped.sampling) {
    const sampling: OpenRouterSampling = { ...shaped.sampling };
    for (const [key, name] of SAMPLING_WIRE_NAMES) {
      if (sampling[key] !== undefined && !supported.has(name)) delete sampling[key];
    }
    if (Object.keys(sampling).length) shaped.sampling = sampling;
    else delete shaped.sampling;
  }
  if (shaped.tools !== false && !supported.has('tools')) shaped.tools = false;
  return applyReasoningDefault(shaped, model);
}

function hasReasoningSetting(reasoning: OpenRouterReasoning | undefined): boolean {
  if (!reasoning) return false;
  return (
    isReasoningEffort(reasoning.effort) ||
    (isNumber(reasoning.maxTokens) && reasoning.maxTokens > 0) ||
    typeof reasoning.enabled === 'boolean'
  );
}

/** Trimmed, non-empty strings — from a list or a comma-separated string — or undefined when nothing is left. */
function cleanStringList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const items = raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function cleanMaxPrice(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const key of ['prompt', 'completion', 'request', 'image'] as const) {
    if (isNumber(value[key])) out[key] = value[key];
  }
  return Object.keys(out).length ? out : undefined;
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
        const entry: AssistantWireMessage = {
          role: 'assistant',
          content: message.content
        };
        if (toolCalls.length) {
          entry.tool_calls = toolCalls;
          // A thinking model must see its own reasoning next to the calls it
          // made: OpenRouter replays `reasoning_details`, or the plain text.
          if (message.reasoningDetails?.length) entry.reasoning_details = message.reasoningDetails;
          else if (message.reasoning) entry.reasoning = message.reasoning;
        }
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
    reasoning: normalizeReasoning(raw.reasoning)
  };
}

/** The catalog's per-model `reasoning` object → `ModelReasoning`; undefined when the model cannot reason. */
export function normalizeReasoning(raw: unknown): ModelReasoning | undefined {
  if (!isRecord(raw)) return undefined;
  const reasoning: ModelReasoning = {};
  if (typeof raw.mandatory === 'boolean') reasoning.mandatory = raw.mandatory;
  if (typeof raw.default_enabled === 'boolean') reasoning.defaultEnabled = raw.default_enabled;
  const efforts = stringArray(raw.supported_efforts).filter(isReasoningEffort);
  if (efforts.length) reasoning.supportedEfforts = efforts;
  if (isReasoningEffort(raw.default_effort)) reasoning.defaultEffort = raw.default_effort;
  if (typeof raw.supports_max_tokens === 'boolean') reasoning.supportsMaxTokens = raw.supports_max_tokens;
  return reasoning;
}

/** OpenRouter's `/models/{author}/{slug}/endpoints` payload → a model's roster. */
export function normalizeEndpointsPayload(
  payload: unknown,
  modelId: string,
  fetchedAt: number
): ModelEndpoints {
  const outer = isRecord(payload) ? payload : {};
  const source = isRecord(outer.data) ? outer.data : outer;
  const items = Array.isArray(source.endpoints) ? source.endpoints : [];
  return {
    id: typeof source.id === 'string' && source.id ? source.id : modelId,
    name: typeof source.name === 'string' && source.name ? source.name : modelId,
    endpoints: items.filter(isRecord).map(normalizeEndpointRecord),
    fetchedAt
  };
}

/** One endpoint of the roster. Prices become USD per million tokens, like the catalog's. */
export function normalizeEndpointRecord(raw: Record<string, any>): ModelEndpoint {
  const pricing = isRecord(raw.pricing) ? raw.pricing : {};
  const providerName = typeof raw.provider_name === 'string' ? raw.provider_name : '';
  const endpoint: ModelEndpoint = {
    providerName,
    providerSlug: typeof raw.tag === 'string' && raw.tag ? raw.tag : providerName,
    name: typeof raw.name === 'string' && raw.name ? raw.name : providerName,
    contextLength: numberOrUndefined(raw.context_length),
    maxPromptTokens: numberOrUndefined(raw.max_prompt_tokens),
    maxCompletionTokens: numberOrUndefined(raw.max_completion_tokens),
    pricing: {
      prompt: perMillion(pricing.prompt),
      completion: perMillion(pricing.completion),
      request: numberOrNull(pricing.request),
      image: numberOrNull(pricing.image)
    },
    quantization: typeof raw.quantization === 'string' ? raw.quantization : undefined,
    supportedParameters: stringArray(raw.supported_parameters),
    latencyLast30m: numberOrNull(raw.latency_last_30m),
    throughputLast30m: numberOrNull(raw.throughput_last_30m),
    uptimeLast5m: numberOrNull(raw.uptime_last_5m),
    uptimeLast30m: numberOrNull(raw.uptime_last_30m),
    uptimeLast1d: numberOrNull(raw.uptime_last_1d)
  };
  if (typeof raw.supports_implicit_caching === 'boolean') {
    endpoint.supportsImplicitCaching = raw.supports_implicit_caching;
  }
  const status = numberOrUndefined(raw.status);
  if (status !== undefined) endpoint.status = status;
  return endpoint;
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

/**
 * Fold one chunk's `delta.reasoning_details` into the running list. A text
 * fragment continuing the previous item (same index) is appended to it;
 * everything else is kept as sent, so the array replays intact.
 */
export function mergeReasoningDetails(acc: unknown[], incoming: unknown[]): void {
  for (const item of incoming) {
    if (!isRecord(item)) continue;
    const last = acc[acc.length - 1];
    if (
      isRecord(last) &&
      item.type === 'reasoning.text' &&
      last.type === 'reasoning.text' &&
      (item.index ?? null) === (last.index ?? null) &&
      typeof item.text === 'string' &&
      typeof last.text === 'string'
    ) {
      last.text += item.text;
      if (typeof item.signature === 'string' && item.signature) last.signature = item.signature;
      continue;
    }
    acc.push({ ...item });
  }
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

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && REASONING_EFFORTS.has(value);
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
