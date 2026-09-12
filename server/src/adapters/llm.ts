import OpenAI from 'openai';
import { OpenRouterProvider, type ChatRequest, type ChatResult, type WireMessage } from '../providers/openrouter';

export interface GenerationParams {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
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
  return {
    model: params.model,
    messages,
    params: { temperature: params.temperature, maxTokens: params.maxTokens }
  };
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

/** Prompt nodes straight to OpenAI, for a deployment without OpenRouter. */
export class OpenAIGenerator implements Generator {
  constructor(private readonly openai: OpenAI) {}

  async generate(params: GenerationParams): Promise<GenerationResult> {
    const { model, systemPrompt, userPrompt, temperature, maxTokens, onToken } = params;

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    if (onToken) {
      return this.generateStreaming(model, messages, temperature, maxTokens, onToken);
    }

    const response = await this.openai.chat.completions.create({
      model,
      messages,
      temperature,
      max_tokens: maxTokens
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
    temperature: number,
    maxTokens: number,
    onToken: (token: string) => void
  ): Promise<GenerationResult> {
    const stream = await this.openai.chat.completions.create({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
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
