/**
 * End-to-end smoke for the chat core against a running server: create a
 * conversation, send two messages over socket.io, watch the replies stream,
 * then reload the conversation over REST and check what was stored.
 *
 *   npm run smoke:chat -- --url http://localhost:3001 --model openai/gpt-4o-mini
 */
import { io, type Socket } from 'socket.io-client';
import type {
  ChatCompleteEvent,
  ChatErrorEvent,
  ChatMessage,
  ChatStartEvent,
  ChatTokenEvent,
  Conversation,
  ConversationDetail
} from '@maestroai/shared';

const args = parseArgs(process.argv.slice(2));
const url = (args.url ?? 'http://localhost:3001').replace(/\/+$/, '');
const model = args.model ?? 'openai/gpt-4o-mini';
const REPLY_TIMEOUT_MS = 90_000;

async function main() {
  const health = await getJson<{ chat?: { configured: boolean } }>(`${url}/health`);
  if (!health.chat?.configured) {
    throw new Error('the server reports chat is not configured (OPENROUTER_API_KEY)');
  }

  const conversation = await postJson<Conversation>(`${url}/api/conversations`, {
    model,
    title: `smoke ${new Date().toISOString()}`,
    systemPrompt: 'You are a terse test assistant.',
    params: { temperature: 0, maxTokens: 200 }
  });
  console.log(`conversation ${conversation.id} (${conversation.model})`);

  const socket = io(url, { transports: ['websocket'] });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (error) => reject(error));
  });

  try {
    const first = await turn(socket, conversation.id, 'Reply with exactly one word: pong');
    const second = await turn(
      socket,
      conversation.id,
      'What one word did I ask you to reply with? Answer with just that word.'
    );

    console.log('');
    const detail = await getJson<ConversationDetail>(`${url}/api/conversations/${conversation.id}`);
    check(detail.messages.length === 4, `4 messages stored (got ${detail.messages.length})`);
    check(
      detail.messages.map((m) => m.role).join(',') === 'user,assistant,user,assistant',
      'roles alternate user / assistant'
    );
    check(detail.activeLeafId === second.id, 'active leaf is the last assistant message');
    check(
      detail.messages[1].parentId === detail.messages[0].id &&
        detail.messages[2].parentId === first.id &&
        detail.messages[3].parentId === detail.messages[2].id,
      'parent chain links the turns'
    );
    const storedFirst = detail.messages.find((m) => m.id === first.id);
    check(storedFirst?.content === first.content, 'stored content matches the streamed reply');
    check(typeof storedFirst?.tokenUsage?.total === 'number', 'token usage was recorded');
    check(/pong/i.test(second.content), `second reply recalls the first turn ("${second.content.trim()}")`);

    console.log(
      `\nOK — ${first.model}; tokens ${first.tokenUsage?.total ?? '?'} + ${second.tokenUsage?.total ?? '?'}; ` +
        `cost ${money(first.cost)} + ${money(second.cost)}; latency ${first.latencyMs} + ${second.latencyMs} ms`
    );
    console.log(`reload later with: GET ${url}/api/conversations/${conversation.id}`);
  } finally {
    socket.disconnect();
  }
}

function turn(socket: Socket, conversationId: string, content: string): Promise<ChatMessage> {
  return new Promise((resolve, reject) => {
    let streamed = '';

    const onStart = (event: ChatStartEvent) => {
      if (event.conversationId === conversationId) process.stdout.write(`\n> ${content}\n< `);
    };
    const onToken = (event: ChatTokenEvent) => {
      if (event.conversationId !== conversationId) return;
      streamed += event.token;
      process.stdout.write(event.token);
    };
    const onComplete = (event: ChatCompleteEvent) => {
      if (event.conversationId !== conversationId) return;
      cleanup();
      process.stdout.write('\n');
      if (event.message.content !== streamed) {
        reject(new Error('the streamed text differs from the stored message'));
        return;
      }
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
      socket.off('chat:start', onStart);
      socket.off('chat:token', onToken);
      socket.off('chat:complete', onComplete);
      socket.off('chat:error', onError);
    };

    socket.on('chat:start', onStart);
    socket.on('chat:token', onToken);
    socket.on('chat:complete', onComplete);
    socket.on('chat:error', onError);
    socket.emit('chat:send', { conversationId, content });
  });
}

function check(condition: boolean, label: string) {
  if (!condition) throw new Error(`check failed: ${label}`);
  console.log(`ok  ${label}`);
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
  if (!response.ok) throw new Error(`POST ${target} → ${response.status}`);
  return (await response.json()) as T;
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(argv[i]);
    if (!match) continue;
    parsed[match[1]] = match[2] ?? argv[++i] ?? '';
  }
  return parsed;
}

main().catch((error) => {
  console.error(`\nFAILED — ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
