/**
 * End-to-end smoke for the tool loop against a running server: store a small
 * workflow with no LLM nodes, ask the model (over socket.io) to run it with a
 * nonce as input, then ask for a calculation — and check the tool events, the
 * stored tool messages and the final replies. Cleans up after itself.
 *
 *   npm run smoke:tools -- --url http://localhost:3001 --model openai/gpt-4o-mini
 */
import { io, type Socket } from 'socket.io-client';
import type {
  ChatCompleteEvent,
  ChatErrorEvent,
  ChatMessage,
  ChatMessageEvent,
  ChatToolEndEvent,
  ChatToolStartEvent,
  Conversation,
  ConversationDetail,
  Workflow
} from '@maestroai/shared';

const args = parseArgs(process.argv.slice(2));
const url = (args.url ?? 'http://localhost:3001').replace(/\/+$/, '');
const model = args.model ?? 'openai/gpt-4o-mini';
const REPLY_TIMEOUT_MS = 120_000;

interface TurnRecord {
  reply: ChatMessage;
  stored: ChatMessage[];
  toolStarts: ChatToolStartEvent[];
  toolEnds: ChatToolEndEvent[];
}

async function main() {
  const health = await getJson<{ chat?: { configured: boolean } }>(`${url}/health`);
  if (!health.chat?.configured) throw new Error('the server reports chat is not configured (OPENROUTER_API_KEY)');

  const nonce = `pong-${Math.random().toString(36).slice(2, 8)}`;
  const workflowName = `Smoke Echo ${nonce}`;
  const workflow = await postJson<Workflow>(`${url}/api/workflows`, {
    name: workflowName,
    nodes: [
      { id: 'q', type: 'input', position: { x: 0, y: 0 }, data: { label: 'Question', config: { inputType: 'text' } } },
      { id: 'agg', type: 'aggregate', position: { x: 0, y: 100 }, data: { label: 'Combine', config: { strategy: 'concat' } } },
      { id: 'out', type: 'output', position: { x: 0, y: 200 }, data: { label: 'Result', config: {} } }
    ],
    edges: [
      { id: 'e1', source: 'q', target: 'agg' },
      { id: 'e2', source: 'agg', target: 'out' }
    ]
  });
  console.log(`workflow ${workflow.id} "${workflow.name}"`);

  const conversation = await postJson<Conversation>(`${url}/api/conversations`, {
    model,
    title: `tools smoke ${new Date().toISOString()}`,
    systemPrompt: 'You have tools. When asked to use one, call it, then report exactly what it returned.',
    params: { temperature: 0, maxTokens: 400 }
  });
  console.log(`conversation ${conversation.id} (${conversation.model})`);

  const socket = io(url, { transports: ['websocket'] });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (error) => reject(error));
  });

  try {
    const first = await turn(
      socket,
      conversation.id,
      `Use the run_workflow tool to run the workflow named "${workflowName}" with its "Question" input set to "${nonce}". Then tell me the exact text the workflow produced as its output.`
    );
    console.log('');
    check(first.toolStarts.some((e) => e.name === 'run_workflow'), 'run_workflow was called');
    check(first.toolEnds.some((e) => e.name === 'run_workflow' && !e.isError), 'run_workflow succeeded');
    const toolMessage = first.stored.find((m) => m.role === 'tool');
    check(Boolean(toolMessage), 'the tool result was stored as a message');
    check(toolMessage?.content.includes(nonce) === true, `the stored tool result carries the nonce ("${nonce}")`);
    check(first.stored.some((m) => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0), 'the assistant tool turn was stored with its calls');
    check(first.reply.content.includes(nonce), `the final reply repeats the workflow output ("${first.reply.content.trim().slice(0, 80)}")`);
    check((first.reply.tokenUsage?.total ?? 0) > 0, 'the final reply carries aggregate token usage');

    const second = await turn(socket, conversation.id, 'Now use the calculate tool to compute 12 * 34 and reply with just the number.');
    console.log('');
    check(second.toolStarts.some((e) => e.name === 'calculate'), 'calculate was called');
    check(/408/.test(second.reply.content), `the reply has the product ("${second.reply.content.trim()}")`);

    const detail = await getJson<ConversationDetail>(`${url}/api/conversations/${conversation.id}`);
    const roles = detail.messages.map((m) => m.role).join(',');
    check(
      roles === 'user,assistant,tool,assistant,user,assistant,tool,assistant',
      `8 messages stored in tool-turn order (got ${roles})`
    );
    check(detail.activeLeafId === second.reply.id, 'the active leaf is the last reply');
    const chain = detail.messages.every((m, i) => i === 0 || m.parentId === detail.messages[i - 1].id);
    check(chain, 'every message parents the one before it');

    console.log(`\nOK — ${first.reply.model}; cost ${money(first.reply.cost)} + ${money(second.reply.cost)}`);
  } finally {
    socket.disconnect();
    await remove(`${url}/api/conversations/${conversation.id}`);
    await remove(`${url}/api/workflows/${workflow.id}`);
    console.log('cleaned up the smoke conversation and workflow');
  }
}

async function remove(target: string) {
  const response = await fetch(target, { method: 'DELETE' });
  if (!response.ok) console.warn(`cleanup: DELETE ${target} → ${response.status}`);
}

function turn(socket: Socket, conversationId: string, content: string): Promise<TurnRecord> {
  return new Promise((resolve, reject) => {
    const record: TurnRecord = { reply: undefined as unknown as ChatMessage, stored: [], toolStarts: [], toolEnds: [] };
    const mine = (event: { conversationId: string }) => event.conversationId === conversationId;

    const onMessage = (event: ChatMessageEvent) => {
      if (!mine(event)) return;
      record.stored.push(event.message);
      if (event.message.role === 'user') process.stdout.write(`\n> ${content}\n`);
      if (event.message.role === 'tool') {
        process.stdout.write(`  [tool result${event.message.error ? ` (${event.message.error})` : ''}] ${event.message.content.split('\n')[0]}\n`);
      }
    };
    const onToolStart = (event: ChatToolStartEvent) => {
      if (!mine(event)) return;
      record.toolStarts.push(event);
      process.stdout.write(`  [tool] ${event.name} ${event.args}\n`);
    };
    const onToolEnd = (event: ChatToolEndEvent) => {
      if (!mine(event)) return;
      record.toolEnds.push(event);
      process.stdout.write(`  [tool] ${event.name} → ${event.isError ? 'error' : 'ok'} in ${event.durationMs}ms\n`);
    };
    const onComplete = (event: ChatCompleteEvent) => {
      if (!mine(event)) return;
      cleanup();
      process.stdout.write(`< ${event.message.content.trim()}\n`);
      record.reply = event.message;
      resolve(record);
    };
    const onError = (event: ChatErrorEvent) => {
      if (!mine(event)) return;
      cleanup();
      reject(new Error(`chat:error — ${event.error}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`no reply within ${REPLY_TIMEOUT_MS / 1000}s`));
    }, REPLY_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('chat:message', onMessage);
      socket.off('chat:tool_start', onToolStart);
      socket.off('chat:tool_end', onToolEnd);
      socket.off('chat:complete', onComplete);
      socket.off('chat:error', onError);
    };

    socket.on('chat:message', onMessage);
    socket.on('chat:tool_start', onToolStart);
    socket.on('chat:tool_end', onToolEnd);
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
