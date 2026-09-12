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
 * What a prompt node talks to: OpenRouter, the gateway and key the chat
 * surface uses — so one catalog names every model, one roster prices each
 * one, and the gateway reports real cost. It is the only provider, by
 * decision: a second path would have to carry every routing, sampling and
 * reasoning setting a node can hold, or silently drop them. Throws at
 * construction when no key is configured, so a run fails with a clear
 * message rather than on its first prompt node.
 */
export class LLMAdapter implements Generator {
  private readonly backend: Generator;

  constructor(backend?: Generator) {
    this.backend = backend ?? LLMAdapter.fromEnv();
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): Generator {
    const openRouter = OpenRouterProvider.fromEnv(env);
    if (openRouter) return new OpenRouterGenerator(openRouter);
    throw new Error('OpenRouter is not configured — set OPENROUTER_API_KEY');
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
