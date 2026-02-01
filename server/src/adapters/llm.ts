import OpenAI from 'openai';

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
}

export class LLMAdapter {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  async generate(params: GenerationParams): Promise<GenerationResult> {
    const { model, systemPrompt, userPrompt, temperature, maxTokens, onToken } = params;

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    // If streaming is requested, use streaming API
    if (onToken) {
      return this.generateStreaming(model, messages, temperature, maxTokens, onToken);
    }

    // Non-streaming generation
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
    let promptTokens = 0;
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
    promptTokens = Math.ceil(promptText.length / 4);

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

  // Extend for other providers (Anthropic, Cohere, etc.)
  async generateWithProvider(
    provider: 'openai' | 'anthropic' | 'cohere',
    params: GenerationParams
  ): Promise<GenerationResult> {
    switch (provider) {
      case 'openai':
        return this.generate(params);
      case 'anthropic':
        return this.generateAnthropic(params);
      case 'cohere':
        return this.generateCohere(params);
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  private async generateAnthropic(params: GenerationParams): Promise<GenerationResult> {
    // Placeholder for Anthropic integration
    throw new Error('Anthropic integration not yet implemented');
  }

  private async generateCohere(params: GenerationParams): Promise<GenerationResult> {
    // Placeholder for Cohere integration
    throw new Error('Cohere integration not yet implemented');
  }
}
