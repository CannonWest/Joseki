import OpenAI from 'openai';
import type { ChatParams } from '@joseki/shared';
import { OpenRouterProvider, type ChatRequest, type ChatResult, type WireMessage } from '../providers/openrouter';

export interface GenerationParams {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /**
   * Generation settings in the shape a chat turn sends — temperature and
   * max tokens, but also routing, sampling and reasoning. The provider shapes
   * them to the model's catalog record, so a node asks for whatever it likes
   * and the gateway hears only what the model accepts.
   */
  params: ChatParams;
  onToken?: (token: string) => void;
}

export interface GenerationResult {
  content: string;
  tokenUsage: {
    prompt: number;
    completion: number;
    total: number;
  };
  model: string;
  /** USD as the gateway reports it, when it does. */
  cost?: number;
}

/** The one call a prompt node makes. */
export interface Generator {
  generate(params: GenerationParams): Promise<GenerationResult>;
}

/**
 * What a prompt node talks to. Prefers OpenRouter — the gateway and key the
 * chat surface already uses, so one catalog names every model and the
 * gateway reports real cost — and falls back to OpenAI directly when only
 * OPENAI_API_KEY is set. Throws at construction when neither is configured,
 * so a run fails with a clear message rather than on its first prompt node.
 */
export class LLMAdapter implements Generator {
  private readonly backend: Generator;

  constructor(backend?: Generator) {
    this.backend = backend ?? LLMAdapter.fromEnv();
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): Generator {
    const openRouter = OpenRouterProvider.fromEnv(env);
    if (openRouter) return new OpenRouterGenerator(openRouter);
    if (env.OPENAI_API_KEY) return new OpenAIGenerator(new OpenAI({ apiKey: env.OPENAI_API_KEY }));
    throw new Error('No model provider is configured — set OPENROUTER_API_KEY (or OPENAI_API_KEY)');
  }

  generate(params: GenerationParams): Promise<GenerationResult> {
    return this.backend.generate(params);
  }
}

/** Prompt nodes through OpenRouter: two messages in, one completion out. */
export class OpenRouterGenerator implements Generator {
  constructor(private readonly provider: Pick<OpenRouterProvider, 'chat' | 'chatStream'>) {}

  async generate(params: GenerationParams): Promise<GenerationResult> {
    const request = toChatRequest(params);

    if (!params.onToken) {
      return fromChatResult(await this.provider.chat(request));
    }

    for await (const event of this.provider.chatStream(request)) {
      if (event.type === 'token') params.onToken(event.text);
      if (event.type === 'done') return fromChatResult(event.result);
    }
    throw new Error(`The stream from ${params.model} ended without a result`);
  }
}

export function toChatRequest(params: GenerationParams): ChatRequest {
  const messages: WireMessage[] = [];
  if (params.systemPrompt.trim()) messages.push({ role: 'system', content: params.systemPrompt });
  messages.push({ role: 'user', content: params.userPrompt });
  return { model: params.model, messages, params: params.params };
}

function fromChatResult(result: ChatResult): GenerationResult {
  const out: GenerationResult = {
    content: result.content,
    tokenUsage: {
      prompt: result.tokenUsage.prompt,
      completion: result.tokenUsage.completion,
      total: result.tokenUsage.total
    },
    model: result.model
  };
  if (typeof result.cost === 'number') out.cost = result.cost;
  return out;
}

/**
 * The subset OpenAI's own endpoint accepts. Routing, the extra sampling knobs
 * and reasoning are the gateway's extensions and have no home here.
 */
export function toOpenAIParams(params: ChatParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (params.temperature !== undefined) out.temperature = params.temperature;
  if (params.maxTokens !== undefined) out.max_tokens = params.maxTokens;
  if (params.topP !== undefined) out.top_p = params.topP;
  if (params.frequencyPenalty !== undefined) out.frequency_penalty = params.frequencyPenalty;
  if (params.presencePenalty !== undefined) out.presence_penalty = params.presencePenalty;
  if (params.stop?.length) out.stop = params.stop;
  return out;
}

/** Prompt nodes straight to OpenAI, for a deployment without OpenRouter. */
export class OpenAIGenerator implements Generator {
  constructor(private readonly openai: OpenAI) {}

  async generate(params: GenerationParams): Promise<GenerationResult> {
    const { model, systemPrompt, userPrompt, onToken } = params;
    const settings = toOpenAIParams(params.params);

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    if (onToken) {
      return this.generateStreaming(model, messages, settings, onToken);
    }

    const response = await this.openai.chat.completions.create({
      model,
      messages,
      ...settings
    });

    const content = response.choices[0]?.message?.content || '';
    const usage = response.usage;

    return {
      content,
      tokenUsage: {
        prompt: usage?.prompt_tokens || 0,
        completion: usage?.completion_tokens || 0,
        total: usage?.total_tokens || 0
      },
      model: response.model
    };
  }

  private async generateStreaming(
    model: string,
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    settings: Record<string, unknown>,
    onToken: (token: string) => void
  ): Promise<GenerationResult> {
    const stream = await this.openai.chat.completions.create({
      model,
      messages,
      ...settings,
      stream: true
    });

    let content = '';
    let completionTokens = 0;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      content += delta;
      onToken(delta);

      // Estimate tokens for streaming (actual count available at end)
      if (delta) completionTokens++;
    }

    // Rough estimate for prompt tokens
    const promptText = messages.map(m => m.content).join(' ');
    const promptTokens = Math.ceil(promptText.length / 4);

    return {
      content,
      tokenUsage: {
        prompt: promptTokens,
        completion: completionTokens,
        total: promptTokens + completionTokens
      },
      model
    };
  }
}
