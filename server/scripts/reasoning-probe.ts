/**
 * Live probe for the reasoning default against a running server: does a
 * model that advertises `default_effort` actually reason when the conversation
 * sets nothing, and stay quiet when the conversation says `enabled: false`?
 * Runs one short turn in each of two throwaway conversations over socket.io —
 * the real chat path — and reports reasoning tokens, cost and the resolved
 * model for each, then deletes both.
 *
 *   npm run probe:reasoning -- --model openai/gpt-5.4-nano --url http://localhost:3001
 */
import { io, type Socket } from 'socket.io-client';
import type {
  ChatCompleteEvent,
  ChatErrorEvent,
  ChatMessage,
  ChatModel,
  ChatParams,
  Conversation
} from '@maestroai/shared';

const args = parseArgs(process.argv.slice(2));
const url = (args.url ?? 'http://localhost:3001').replace(/\/+$/, '');
const model = args.model ?? 'openai/gpt-5.4-nano';
const PROMPT = 'A train leaves at 9:40 and the trip takes 2 h 35 min. When does it arrive? Reply with only the time.';
const REPLY_TIMEOUT_MS = 120_000;

// The third case is the control: if an explicit effort also yields no
// reasoning tokens, the model (or its usage reporting) is the reason, not
// the default. OpenAI models return no trace text, so tokens are the signal.
const CASES: Array<{ label: string; params: ChatParams }> = [
  { label: 'the conversation sets nothing — the model default applies', params: {} },
  { label: 'the conversation sets reasoning.enabled = false', params: { reasoning: { enabled: false } } },
  { label: 'the conversation sets reasoning.effort = high (control)', params: { reasoning: { effort: 'high' } } }
];

async function main() {
  const health = await getJson<{ chat?: { configured: boolean } }>(`${url}/health`);
  if (!health.chat?.configured) {
    throw new Error('the server reports chat is not configured (OPENROUTER_API_KEY)');
  }
  const catalog = await getJson<{ models: ChatModel[] }>(`${url}/api/models?q=${encodeURIComponent(model)}`);
  const record = catalog.models.find((entry) => entry.id === model);
  console.log(`${model} — catalog reasoning: ${JSON.stringify(record?.reasoning ?? null)}`);

  const socket = io(url, { transports: ['websocket'] });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (error) => reject(error));
  });

  try {
    for (const { label, params } of CASES) {
      const conversation = await postJson<Conversation>(`${url}/api/conversations`, {
        model,
        title: `reasoning probe ${new Date().toISOString()}`,
        params: { temperature: 0, maxTokens: 2000, tools: false, ...params }
      });
      try {
        const reply = await turn(socket, conversation.id, PROMPT);
        const usage = reply.tokenUsage;
        console.log(`\n${label}`);
        console.log(
          `  model ${reply.model} · finish ${reply.finishReason} · reasoning tokens ${usage?.reasoningTokens ?? 0}` +
            ` · completion ${usage?.completion ?? '?'} · cost ${money(reply.cost)}`
        );
        console.log(
          `  trace ${reply.reasoning ? `${reply.reasoning.length} chars` : 'none'}` +
            ` · reply "${reply.content.trim().slice(0, 120)}"`
        );
      } finally {
        await fetch(`${url}/api/conversations/${conversation.id}`, { method: 'DELETE' });
      }
    }
  } finally {
    socket.disconnect();
  }
}

function turn(socket: Socket, conversationId: string, content: string): Promise<ChatMessage> {
  return new Promise((resolve, reject) => {
    const onComplete = (event: ChatCompleteEvent) => {
      if (event.conversationId !== conversationId) return;
      cleanup();
      resolve(event.message);
    };
    const onError = (event: ChatErrorEvent) => {
      if (event.conversationId !== conversationId) return;
      cleanup();
      reject(new Error(`chat:error — ${event.error}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`no reply within ${REPLY_TIMEOUT_MS / 1000}s`));
    }, REPLY_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('chat:complete', onComplete);
      socket.off('chat:error', onError);
    };

    socket.on('chat:complete', onComplete);
    socket.on('chat:error', onError);
    socket.emit('chat:send', { conversationId, content });
  });
}

function money(value: number | undefined): string {
  return value === undefined ? '?' : `$${value.toFixed(6)}`;
}

async function getJson<T>(target: string): Promise<T> {
  const response = await fetch(target);
  if (!response.ok) throw new Error(`GET ${target} → ${response.status}`);
  return (await response.json()) as T;
}

async function postJson<T>(target: string, body: unknown): Promise<T> {
  const response = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`POST ${target} → ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      parsed[key] = next;
      i++;
    } else {
      parsed[key] = 'true';
    }
  }
  return parsed;
}

main().catch((error) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
