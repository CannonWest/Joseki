/**
 * End-to-end smoke for the human gate against a running server, with no
 * model involved: store a workflow whose gate can send work back, run it
 * over socket.io, reject once with a note, approve on the second pass, and
 * check the run completes with the approved content. The workflow is
 * deleted afterwards.
 *
 *   npm run smoke:gate -- --url http://localhost:3001
 */
import { io, type Socket } from 'socket.io-client';
import type { ExecutionPausedEvent, ExecutionTrace, Workflow } from '@joseki/shared';

const args = parseArgs(process.argv.slice(2));
const url = (args.url ?? 'http://localhost:3001').replace(/\/+$/, '');
const EVENT_TIMEOUT_MS = 10_000;

// article → combine (aggregate) → gate ─pass─→ final
//              ↑                        └fail─┘
const draft: Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'> = {
  name: `gate smoke ${new Date().toISOString()}`,
  nodes: [
    { id: 'article', type: 'input', position: { x: 0, y: 0 }, data: { label: 'Article', config: { inputType: 'text', required: true } } },
    { id: 'combine', type: 'aggregate', position: { x: 0, y: 100 }, data: { label: 'Combine', config: { strategy: 'concat' } } },
    { id: 'review', type: 'human_gate', position: { x: 0, y: 200 }, data: { label: 'Review', config: { instructions: 'Approve or send back', allowEdit: true, maxRevisions: 2 } } },
    { id: 'final', type: 'output', position: { x: 0, y: 300 }, data: { label: 'Final', config: {} } }
  ],
  edges: [
    { id: 'e1', source: 'article', target: 'combine' },
    { id: 'e2', source: 'combine', target: 'review' },
    { id: 'e3', source: 'review', target: 'final', sourceHandle: 'pass' },
    { id: 'e4', source: 'review', target: 'combine', sourceHandle: 'fail' }
  ],
  variables: {},
  folder: ''
};

async function main() {
  const workflow = await postJson<Workflow>(`${url}/api/workflows`, draft);
  console.log(`workflow ${workflow.id}`);

  const socket = io(url, { transports: ['websocket'] });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (error) => reject(error));
  });

  const log: string[] = [];
  socket.onAny((event, payload) => {
    if (typeof event === 'string' && event.startsWith('execution:')) {
      log.push(`${event}${payload?.nodeId ? ` ${payload.nodeId}` : ''}`);
    }
  });

  try {
    const executionId = `smoke-${Date.now()}`;
    const completed = new Map<string, ExecutionTrace>();
    socket.on('execution:nodeComplete', (data: { nodeId: string; trace: ExecutionTrace }) => {
      completed.set(data.nodeId, data.trace);
    });

    const firstPause = waitFor<ExecutionPausedEvent>(socket, 'execution:paused');
    socket.emit('execution:start', { workflowId: workflow.id, executionId, inputs: { article: 'first draft' } });

    const pause1 = await firstPause;
    check(pause1.nodeId === 'review', 'the run paused at the gate');
    check(pause1.content === 'first draft', `the gate holds the content under review (${JSON.stringify(pause1.content)})`);
    check(pause1.revision === 0 && pause1.maxRevisions === 2, 'first pass, two revisions allowed');
    check(pause1.allowEdit === true, 'the gate reports it allows edits');

    const secondPause = waitFor<ExecutionPausedEvent>(socket, 'execution:paused');
    const resumed1 = waitFor<{ ok: boolean }>(socket, 'execution:resumed');
    socket.emit('execution:resume', { executionId, nodeId: 'review', decision: { verdict: 'fail', note: 'tighter' } });
    check((await resumed1).ok === true, 'the server accepted the rejection');

    const pause2 = await secondPause;
    check(pause2.revision === 1, 'the gate asks again on revision 1 after the work went back');
    check(completed.get('combine')?.status === 'success', 'Combine re-ran');

    const done = waitFor<{ executionId: string }>(socket, 'execution:complete');
    socket.emit('execution:resume', { executionId, nodeId: 'review', decision: { verdict: 'pass', edited: 'final draft' } });
    await done;
    check(completed.get('final')?.output === 'final draft', `Final carries the approved edit (${JSON.stringify(completed.get('final')?.output)})`);
    check(completed.get('review')?.input?.decision?.verdict === 'pass', 'the persisted gate trace carries the decision');

    const stray = waitFor<{ ok: boolean; error?: string }>(socket, 'execution:resumed');
    socket.emit('execution:resume', { executionId, nodeId: 'review', decision: { verdict: 'pass' } });
    const late = await stray;
    check(late.ok === false && /Nothing is waiting/.test(late.error ?? ''), 'a decision for a gate that is not waiting is refused');

    console.log('\nevents:\n  ' + log.join('\n  '));
    console.log('\nPASS');
  } finally {
    socket.disconnect();
    await fetch(`${url}/api/workflows/${workflow.id}`, { method: 'DELETE' });
  }
}

function waitFor<T>(socket: Socket, event: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${event} within ${EVENT_TIMEOUT_MS}ms`)), EVENT_TIMEOUT_MS);
    const onError = (data: { error: string }) => {
      clearTimeout(timer);
      socket.off(event, onEvent);
      reject(new Error(`execution:error while waiting for ${event}: ${data.error}`));
    };
    const onEvent = (data: T) => {
      clearTimeout(timer);
      socket.off('execution:error', onError);
      resolve(data);
    };
    socket.once(event, onEvent);
    socket.once('execution:error', onError);
  });
}

function check(condition: boolean, label: string) {
  if (!condition) throw new Error(`check failed: ${label}`);
  console.log(`ok  ${label}`);
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
