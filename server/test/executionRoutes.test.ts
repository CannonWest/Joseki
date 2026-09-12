import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { ExecutionDetail, ExecutionSummary } from '@joseki/shared';
import { Database } from '../src/db/database';
import { executionRoutes } from '../src/handlers/executions';

/**
 * The router on an ephemeral port, wired to an in-memory database the same way
 * the server wires the real one. Returns a `get` that reads the JSON body, and
 * the `db` to seed.
 */
async function serve() {
  const db = new Database(':memory:');
  const app = express();
  app.use((req, _res, next) => {
    (req as any).db = db;
    next();
  });
  app.use('/api/executions', executionRoutes);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    db,
    async get(path: string) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: response.status, body: await response.json() };
    },
    async post(path: string) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST' });
      return { status: response.status };
    },
    async close() {
      db.close();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    }
  };
}

function seed(db: Database, id: string, startedAt: number, workflowId: string) {
  db.createExecution({ id, workflowId, status: 'success', context: {}, startedAt });
  db.updateExecutionStatus(id, 'success', undefined, startedAt + 500);
  db.createExecutionTrace({
    executionId: id,
    nodeId: 'a',
    runId: id,
    timestamp: startedAt + 100,
    input: null,
    output: 'done',
    tokenUsage: { prompt: 1, completion: 1, total: 2 },
    cost: 0.5,
    latencyMs: 10,
    status: 'success'
  });
}

test('GET /api/executions lists past runs, most recent first', async () => {
  const api = await serve();
  const [workflow] = api.db.getAllWorkflows();
  seed(api.db, 'run-old', 1000, workflow.id);
  seed(api.db, 'run-new', 2000, workflow.id);

  const { status, body } = await api.get('/api/executions');
  assert.equal(status, 200);
  assert.deepEqual((body as ExecutionSummary[]).map((r) => r.id), ['run-new', 'run-old']);
  await api.close();
});

test('GET /api/executions narrows by workflowId and honours limit', async () => {
  const api = await serve();
  const [workflow] = api.db.getAllWorkflows();
  seed(api.db, 'run-old', 1000, workflow.id);
  seed(api.db, 'run-new', 2000, workflow.id);

  const narrowed = await api.get('/api/executions?workflowId=nothing-by-that-name');
  assert.deepEqual(narrowed.body, []);

  const capped = await api.get('/api/executions?limit=1');
  assert.deepEqual((capped.body as ExecutionSummary[]).map((r) => r.id), ['run-new']);
  await api.close();
});

test('a nonsense limit falls back to the default rather than returning nothing', async () => {
  const api = await serve();
  const [workflow] = api.db.getAllWorkflows();
  seed(api.db, 'run-1', 1000, workflow.id);

  for (const query of ['?limit=0', '?limit=-5', '?limit=abc', '?limit=']) {
    const { body } = await api.get(`/api/executions${query}`);
    assert.equal((body as ExecutionSummary[]).length, 1, `limit${query} returned nothing`);
  }
  await api.close();
});

test('GET /api/executions/:id returns the run with its traces in order', async () => {
  const api = await serve();
  const [workflow] = api.db.getAllWorkflows();
  seed(api.db, 'run-1', 1000, workflow.id);
  api.db.createExecutionTrace({
    executionId: 'run-1',
    nodeId: 'b',
    runId: 'run-1',
    timestamp: 1200,
    input: null,
    output: 'second',
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    cost: 0,
    latencyMs: 1,
    status: 'success'
  });

  const { status, body } = await api.get('/api/executions/run-1');
  const detail = body as ExecutionDetail;
  assert.equal(status, 200);
  assert.equal(detail.id, 'run-1');
  assert.equal(detail.workflowName, workflow.name);
  assert.equal(detail.traceCount, 2);
  assert.deepEqual(detail.traces.map((t) => t.nodeId), ['a', 'b']);
  await api.close();
});

test('GET /api/executions/:id 404s for a run that does not exist', async () => {
  const api = await serve();

  const { status, body } = await api.get('/api/executions/never-ran');
  assert.equal(status, 404);
  assert.deepEqual(body, { error: 'Execution not found' });
  await api.close();
});

test('the routes no longer offer a way to start or branch a run', async () => {
  const api = await serve();
  const [workflow] = api.db.getAllWorkflows();
  seed(api.db, 'run-1', 1000, workflow.id);

  // Runs start over socket.io only, which is the path that streams node events
  // and pauses at human gates. The REST starter that did neither is gone, and
  // a POST to it must not quietly create an execution.
  assert.equal((await api.post(`/api/executions/${workflow.id}`)).status, 404);
  assert.equal((await api.post('/api/executions/run-1/branch')).status, 404);

  assert.deepEqual(api.db.listExecutions().map((r) => r.id), ['run-1']);
  await api.close();
});
