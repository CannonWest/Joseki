import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import BetterSqlite3 from 'better-sqlite3';
import type { FolderListing, Workflow } from '@joseki/shared';
import {
  CONTENT_REVIEW_PIPELINE_ID,
  EXAMPLES_FOLDER,
  SHIPPED_EXAMPLE_IDS,
  TRANSLATION_ROUND_TRIP_ID
} from '@joseki/shared';
import { Database, FolderError } from '../src/db/database';
import { LATEST_VERSION } from '../src/db/migrations';
import { WorkflowExecutor } from '../src/engine/executor';
import type { LLMAdapter } from '../src/adapters/llm';
import { folderRoutes } from '../src/handlers/folders';
import { workflowRoutes } from '../src/handlers/workflows';
import { listWorkflows, runWorkflow } from '../src/tools/builtins';
import type { ToolContext } from '../src/tools/registry';

/** A bare workflow with nothing in it, at `folder`, edited at `updatedAt`. */
function blank(id: string, folder: string, updatedAt = 1): Workflow {
  return { id, name: id, folder, nodes: [], edges: [], variables: {}, createdAt: 1, updatedAt };
}

function codeOf(fn: () => unknown): FolderError['code'] | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof FolderError) return error.code;
    throw error;
  }
  return undefined;
}

// ==================== what a database starts with ====================

test('a fresh database has the Examples folder with both shipped examples, and nothing at the root', () => {
  const db = new Database(':memory:');

  const root = db.folderListing('')!;
  assert.deepEqual(root.folders.map((f) => f.name), [EXAMPLES_FOLDER]);
  assert.equal(root.folders[0].workflowCount, 2);
  assert.equal(root.folders[0].folderCount, 0);
  assert.deepEqual(root.workflows, [], 'the root is for the workflows people make');

  const examples = db.folderListing(EXAMPLES_FOLDER)!;
  assert.deepEqual(new Set(examples.workflows.map((w) => w.id)), new Set(SHIPPED_EXAMPLE_IDS));
  for (const summary of examples.workflows) {
    assert.equal(summary.folder, EXAMPLES_FOLDER);
    assert.ok(summary.nodeCount > 0, `${summary.name} has nodes`);
    assert.equal(summary.runCount, 0);
  }
  db.close();
});

// ==================== folders ====================

test('making a folder makes the folders above it, and says whether it was new', () => {
  const db = new Database(':memory:');

  const deep = db.createFolder('Clients/Acme/2026');
  assert.equal(deep.created, true);
  assert.equal(deep.folder.path, 'Clients/Acme/2026');
  assert.deepEqual(
    db.listFolders().map((f) => f.path),
    ['Clients', 'Clients/Acme', 'Clients/Acme/2026', EXAMPLES_FOLDER]
  );

  assert.equal(db.createFolder('Clients/Acme').created, false, 'it was already there');
  assert.equal(db.createFolder(' /Clients/ Acme / ').folder.path, 'Clients/Acme', 'a typed path is made canonical');

  assert.equal(codeOf(() => db.createFolder('')), 'invalid_path', 'the root has no name to make');
  assert.equal(codeOf(() => db.createFolder('a/../b')), 'invalid_path');
  db.close();
});

test('a folder that differs only by case from one that exists is refused, wherever it is asked for', () => {
  const db = new Database(':memory:');
  db.createFolder('Clients');

  assert.equal(codeOf(() => db.createFolder('clients')), 'exists');
  assert.equal(codeOf(() => db.createFolder('CLIENTS/Acme')), 'exists', 'the collision is on the way');
  assert.equal(codeOf(() => db.createWorkflow(blank('w', 'clients'))), 'exists');
  assert.throws(() => db.createFolder('clients'), /differ only by case/);
  db.close();
});

test('a workflow saved into a folder that is not there yet brings the folder with it', () => {
  const db = new Database(':memory:');
  db.createWorkflow(blank('w1', 'Drafts/Q3'));

  assert.equal(db.hasFolder('Drafts'), true);
  assert.equal(db.hasFolder('Drafts/Q3'), true);
  assert.deepEqual(db.folderListing('Drafts/Q3')!.workflows.map((w) => w.id), ['w1']);
  assert.equal(db.getWorkflow('w1')!.folder, 'Drafts/Q3');

  // The same on update: moving a workflow by saving it somewhere new.
  db.updateWorkflow({ ...db.getWorkflow('w1')!, folder: 'Sent' });
  assert.equal(db.hasFolder('Sent'), true);
  assert.equal(db.getWorkflow('w1')!.folder, 'Sent');
  db.close();
});

test('a listing is one level deep: folders by name with what they hold, workflows most recently edited first', () => {
  const db = new Database(':memory:');
  db.createFolder('A/B/C');
  db.createWorkflow(blank('older', 'A', 100));
  db.createWorkflow(blank('newer', 'A', 200));
  db.createWorkflow(blank('deep', 'A/B/C'));

  const a = db.folderListing('A')!;
  assert.deepEqual(a.folders.map((f) => f.name), ['B']);
  assert.equal(a.folders[0].workflowCount, 1, 'counts reach all the way down');
  assert.equal(a.folders[0].folderCount, 1, 'C, under B');
  assert.deepEqual(a.workflows.map((w) => w.id), ['newer', 'older']);

  const root = db.folderListing('')!;
  assert.deepEqual(root.folders.map((f) => f.path), ['A', EXAMPLES_FOLDER]);
  assert.equal(root.folders[0].workflowCount, 3);
  assert.equal(root.folders[0].folderCount, 2);

  assert.equal(db.folderListing('nowhere'), undefined);
  assert.equal(codeOf(() => db.folderListing('..')), 'invalid_path');
  db.close();
});

test('renaming a folder carries its subfolders and their workflows along, and leaves a sibling with the same prefix alone', () => {
  const db = new Database(':memory:');
  db.createFolder('A/B/C');
  db.createFolder('AB');
  db.createWorkflow(blank('top', 'A'));
  db.createWorkflow(blank('deep', 'A/B/C'));
  db.createWorkflow(blank('beside', 'AB'));

  assert.equal(db.renameFolder('A', 'Z').path, 'Z');
  assert.deepEqual(
    db.listFolders().map((f) => f.path),
    ['AB', EXAMPLES_FOLDER, 'Z', 'Z/B', 'Z/B/C']
  );
  assert.equal(db.getWorkflow('top')!.folder, 'Z');
  assert.equal(db.getWorkflow('deep')!.folder, 'Z/B/C');
  assert.equal(db.getWorkflow('beside')!.folder, 'AB', '"AB" starts with "A" and is not under it');

  // A move is a rename to a path under another parent, made if need be.
  db.renameFolder('Z/B', 'Q/B');
  assert.equal(db.hasFolder('Q'), true);
  assert.equal(db.hasFolder('Z/B'), false);
  assert.equal(db.getWorkflow('deep')!.folder, 'Q/B/C');

  // A rename that changes only the case is a rename, not a collision.
  assert.equal(db.renameFolder('Z', 'z').path, 'z');
  assert.equal(db.getWorkflow('top')!.folder, 'z');
  db.close();
});

test('a folder cannot be moved into itself, onto another folder, or from nowhere', () => {
  const db = new Database(':memory:');
  db.createFolder('A/B');
  db.createFolder('Other');

  assert.equal(codeOf(() => db.renameFolder('A', 'A/B/A')), 'inside_itself');
  assert.equal(codeOf(() => db.renameFolder('A', 'Other')), 'exists');
  assert.equal(codeOf(() => db.renameFolder('A', 'other')), 'exists');
  assert.equal(codeOf(() => db.renameFolder('ghost', 'X')), 'not_found');
  assert.equal(codeOf(() => db.renameFolder('', 'X')), 'invalid_path', 'the root stays the root');
  assert.equal(codeOf(() => db.renameFolder('A', '')), 'invalid_path');
  assert.equal(db.renameFolder('A', 'A').path, 'A', 'a rename to itself is nothing to refuse');
  db.close();
});

test('deleting a folder refuses one that holds anything, unless told to take it all — runs included', () => {
  const db = new Database(':memory:');
  db.createExecution({ id: 'run-1', workflowId: CONTENT_REVIEW_PIPELINE_ID, status: 'success', context: {}, startedAt: 1 });

  const refused = (() => {
    try {
      db.deleteFolder(EXAMPLES_FOLDER);
    } catch (error) {
      return error as FolderError;
    }
    return undefined;
  })();
  assert.equal(refused?.code, 'not_empty');
  assert.deepEqual(refused?.contents, { workflows: 2, folders: 0 });
  assert.match(refused!.message, /2 workflows/);
  assert.equal(db.hasFolder(EXAMPLES_FOLDER), true, 'a refusal changes nothing');

  assert.deepEqual(db.deleteFolder(EXAMPLES_FOLDER, { recursive: true }), { workflows: 2, folders: 0 });
  assert.equal(db.hasFolder(EXAMPLES_FOLDER), false);
  assert.equal(db.getWorkflow(CONTENT_REVIEW_PIPELINE_ID), undefined);
  assert.equal(db.getExecution('run-1'), undefined, 'the runs went with the workflow');

  db.createFolder('Empty');
  assert.deepEqual(db.deleteFolder('Empty'), { workflows: 0, folders: 0 });
  assert.equal(db.hasFolder('Empty'), false);

  assert.equal(codeOf(() => db.deleteFolder('')), 'invalid_path');
  assert.equal(codeOf(() => db.deleteFolder('ghost')), 'not_found');
  db.close();
});

test('a recursive delete takes the subtree and nothing beside it', () => {
  const db = new Database(':memory:');
  db.createFolder('A/B');
  db.createWorkflow(blank('in-a', 'A'));
  db.createWorkflow(blank('in-b', 'A/B'));
  db.createWorkflow(blank('beside', 'AB'));

  assert.deepEqual(db.deleteFolder('A', { recursive: true }), { workflows: 2, folders: 1 });
  assert.deepEqual(db.listFolders().map((f) => f.path), ['AB', EXAMPLES_FOLDER]);
  assert.equal(db.getWorkflow('beside')!.folder, 'AB');
  assert.equal(db.getWorkflow('in-a'), undefined);
  assert.equal(db.getWorkflow('in-b'), undefined);
  db.close();
});

test('a rename or a move leaves the workflow\'s graph and its edit time alone', () => {
  const db = new Database(':memory:');
  const before = db.getWorkflow(TRANSLATION_ROUND_TRIP_ID)!;

  const renamed = db.updateWorkflowMeta(TRANSLATION_ROUND_TRIP_ID, { name: 'Mine now' })!;
  assert.equal(renamed.name, 'Mine now');
  assert.equal(renamed.folder, EXAMPLES_FOLDER);
  assert.equal(renamed.updatedAt, before.updatedAt, 'a rename is not an edit');
  assert.deepEqual(renamed.nodes, before.nodes);

  const moved = db.updateWorkflowMeta(TRANSLATION_ROUND_TRIP_ID, { folder: 'Mine' })!;
  assert.equal(moved.folder, 'Mine');
  assert.equal(moved.name, 'Mine now');
  assert.equal(db.hasFolder('Mine'), true);
  assert.deepEqual(db.getWorkflow(TRANSLATION_ROUND_TRIP_ID), moved, 'what came back is what is stored');

  assert.equal(db.updateWorkflowMeta('ghost', { name: 'x' }), undefined);
  db.close();
});

test('restoring the examples puts back only the missing ones, and leaves an edited one alone', () => {
  const db = new Database(':memory:');
  db.updateWorkflowMeta(CONTENT_REVIEW_PIPELINE_ID, { name: 'Edited' });
  db.deleteWorkflow(TRANSLATION_ROUND_TRIP_ID);

  assert.deepEqual(db.restoreExamples().map((w) => w.id), [TRANSLATION_ROUND_TRIP_ID]);
  assert.equal(db.getWorkflow(CONTENT_REVIEW_PIPELINE_ID)!.name, 'Edited');
  assert.equal(db.getWorkflow(TRANSLATION_ROUND_TRIP_ID)!.folder, EXAMPLES_FOLDER);
  assert.deepEqual(db.restoreExamples(), [], 'nothing was missing the second time');

  // The whole folder gone comes back with the examples in it.
  db.deleteFolder(EXAMPLES_FOLDER, { recursive: true });
  assert.equal(db.restoreExamples().length, 2);
  assert.equal(db.hasFolder(EXAMPLES_FOLDER), true);
  db.close();
});

// ==================== the migration ====================

/** A database file at schema version 3, with a workflows table that has no folder column. */
function v3Database(seedExample: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joseki-folders-'));
  const file = path.join(dir, 'v3.db');
  const older = new BetterSqlite3(file);
  older.exec(`
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, nodes TEXT NOT NULL, edges TEXT NOT NULL,
      variables TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  if (seedExample) {
    older
      .prepare('INSERT INTO workflows VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(CONTENT_REVIEW_PIPELINE_ID, 'Content Review Pipeline (mine)', '[]', '[]', '{}', 5, 6);
  }
  older.pragma('user_version = 3');
  older.close();
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('v4 moves the example an older database kept at the root into Examples, keeps its edits, and adds the round trip', () => {
  const { file, cleanup } = v3Database(true);

  const db = new Database(file);
  assert.equal(db.schema.from, 3);
  assert.equal(db.schema.to, LATEST_VERSION);

  const example = db.getWorkflow(CONTENT_REVIEW_PIPELINE_ID)!;
  assert.equal(example.folder, EXAMPLES_FOLDER);
  assert.equal(example.name, 'Content Review Pipeline (mine)', 'what was there is untouched');
  assert.deepEqual(example.nodes, []);
  assert.equal(example.updatedAt, 6);

  assert.equal(db.getWorkflow(TRANSLATION_ROUND_TRIP_ID)!.folder, EXAMPLES_FOLDER);
  assert.deepEqual(db.listFolders().map((f) => f.path), [EXAMPLES_FOLDER]);
  assert.equal(db.getAllWorkflows().length, 2);
  db.close();
  cleanup();
});

test('v4 on an older database with no example adds both, and gives the table its folder column and index', () => {
  const { file, cleanup } = v3Database(false);

  const db = new Database(file);
  assert.deepEqual(new Set(db.getAllWorkflows().map((w) => w.id)), new Set(SHIPPED_EXAMPLE_IDS));
  db.close();

  const inspect = new BetterSqlite3(file, { readonly: true });
  const columns = (inspect.prepare('PRAGMA table_info(workflows)').all() as Array<{ name: string }>).map((c) => c.name);
  const indexes = (inspect.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workflows'`).all() as Array<{ name: string }>).map((i) => i.name);
  inspect.close();
  assert.ok(columns.includes('folder'));
  assert.ok(indexes.includes('idx_workflows_folder'));
  cleanup();
});

// ==================== the routes ====================

async function serve() {
  const db = new Database(':memory:');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).db = db;
    next();
  });
  app.use('/api/workflows', workflowRoutes);
  app.use('/api/folders', folderRoutes);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  async function call(method: string, target: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}${target}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  }

  return {
    db,
    get: (target: string) => call('GET', target),
    post: (target: string, body?: unknown) => call('POST', target, body),
    put: (target: string, body?: unknown) => call('PUT', target, body),
    patch: (target: string, body?: unknown) => call('PATCH', target, body),
    delete: (target: string) => call('DELETE', target),
    async close() {
      db.close();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  };
}

test('GET /api/folders lists a folder — the root by default — and 404s for one that is not there', async () => {
  const api = await serve();

  const root = await api.get('/api/folders');
  assert.equal(root.status, 200);
  assert.equal((root.body as FolderListing).path, '');
  assert.deepEqual((root.body as FolderListing).folders.map((f) => f.name), [EXAMPLES_FOLDER]);

  const examples = await api.get(`/api/folders?path=${EXAMPLES_FOLDER}`);
  assert.equal(examples.status, 200);
  assert.equal((examples.body as FolderListing).workflows.length, 2);

  const missing = await api.get('/api/folders?path=ghost');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'not_found');

  const bad = await api.get('/api/folders?path=a/../b');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'invalid_path');

  const all = await api.get('/api/folders/all');
  assert.deepEqual(all.body.map((f: { path: string }) => f.path), [EXAMPLES_FOLDER]);
  await api.close();
});

test('POST /api/folders makes a folder: 201 when new, 200 when it was there, 400 and 409 when it cannot be', async () => {
  const api = await serve();

  const made = await api.post('/api/folders', { path: 'Clients/Acme' });
  assert.equal(made.status, 201);
  assert.equal(made.body.path, 'Clients/Acme');
  assert.equal(made.body.created, true);
  assert.ok(typeof made.body.createdAt === 'number');

  const again = await api.post('/api/folders', { path: 'Clients/Acme' });
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);

  assert.equal((await api.post('/api/folders', { path: '' })).status, 400);
  assert.equal((await api.post('/api/folders', {})).status, 400);

  const clash = await api.post('/api/folders', { path: 'clients' });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.code, 'exists');
  await api.close();
});

test('PATCH /api/folders renames or moves a folder with what is in it', async () => {
  const api = await serve();
  await api.post('/api/workflows', { name: 'Brief', folder: 'Clients/Acme' });

  const renamed = await api.patch('/api/folders', { path: 'Clients', newPath: 'Customers' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.path, 'Customers');
  assert.equal(api.db.getAllWorkflows().find((w) => w.name === 'Brief')!.folder, 'Customers/Acme');

  assert.equal((await api.patch('/api/folders', { path: 'ghost', newPath: 'X' })).status, 404);
  const inside = await api.patch('/api/folders', { path: 'Customers', newPath: 'Customers/Acme/Customers' });
  assert.equal(inside.status, 400);
  assert.equal(inside.body.code, 'inside_itself');
  const onto = await api.patch('/api/folders', { path: 'Customers', newPath: EXAMPLES_FOLDER });
  assert.equal(onto.status, 409);
  await api.close();
});

test('DELETE /api/folders refuses a folder with contents and says what they are, unless recursive', async () => {
  const api = await serve();

  const refused = await api.delete(`/api/folders?path=${EXAMPLES_FOLDER}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'not_empty');
  assert.deepEqual(refused.body.contents, { workflows: 2, folders: 0 });

  const taken = await api.delete(`/api/folders?path=${EXAMPLES_FOLDER}&recursive=true`);
  assert.equal(taken.status, 200);
  assert.deepEqual(taken.body, { deleted: { workflows: 2, folders: 0 } });
  assert.equal(api.db.getAllWorkflows().length, 0);

  assert.equal((await api.delete('/api/folders?path=')).status, 400, 'the root stays');
  assert.equal((await api.delete('/api/folders?path=ghost')).status, 404);
  await api.close();
});

test('a workflow is created where it is told to go, and in the root when it is told nothing', async () => {
  const api = await serve();

  const placed = await api.post('/api/workflows', { name: 'Placed', folder: 'Drafts' });
  assert.equal(placed.status, 201);
  assert.equal(placed.body.folder, 'Drafts');
  assert.equal(api.db.hasFolder('Drafts'), true);

  const loose = await api.post('/api/workflows', { name: 'Loose' });
  assert.equal(loose.body.folder, '');

  const bad = await api.post('/api/workflows', { name: 'Bad', folder: 'a/..' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'invalid_path');

  const fetched = await api.get(`/api/workflows/${placed.body.id}`);
  assert.equal(fetched.body.folder, 'Drafts', 'the folder comes back with the workflow');
  await api.close();
});

test('an imported file lands in the root or in ?folder=, never in the folder the file names', async () => {
  const api = await serve();
  const file = { workflow: { name: 'From elsewhere', folder: 'Elsewhere', nodes: [], edges: [] } };

  const toRoot = await api.post('/api/workflows/import', file);
  assert.equal(toRoot.status, 201);
  assert.equal(toRoot.body.workflow.folder, '');

  const toInbox = await api.post('/api/workflows/import?folder=Inbox', file);
  assert.equal(toInbox.body.workflow.folder, 'Inbox');

  assert.equal(api.db.hasFolder('Elsewhere'), false, 'a folder on another machine is not one here');
  await api.close();
});

test('PUT places a new workflow, and leaves an existing one where it is unless told to move it', async () => {
  const api = await serve();

  const created = await api.put('/api/workflows/fresh-1', { name: 'Fresh', nodes: [], edges: [], folder: 'Drafts' });
  assert.equal(created.status, 201);
  assert.equal(created.body.folder, 'Drafts');

  const saved = await api.put('/api/workflows/fresh-1', { name: 'Fresh, edited', nodes: [], edges: [] });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.folder, 'Drafts', 'no folder in the body means stay put');

  const moved = await api.put('/api/workflows/fresh-1', { nodes: [], edges: [], folder: 'Sent' });
  assert.equal(moved.body.folder, 'Sent');
  assert.equal(moved.body.name, 'Fresh, edited');

  const bare = await api.put('/api/workflows/fresh-2', { name: 'Bare', nodes: [], edges: [] });
  assert.equal(bare.body.folder, '', 'a new workflow told nothing goes in the root');
  await api.close();
});

test('PATCH /api/workflows/:id renames or moves without touching the graph, and never creates one', async () => {
  const api = await serve();
  const before = api.db.getAllWorkflows().length;

  const renamed = await api.patch(`/api/workflows/${TRANSLATION_ROUND_TRIP_ID}`, { name: '  Round trip, mine  ' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, 'Round trip, mine');
  assert.equal(renamed.body.folder, EXAMPLES_FOLDER);
  assert.ok(renamed.body.nodes.length > 0);

  const moved = await api.patch(`/api/workflows/${TRANSLATION_ROUND_TRIP_ID}`, { folder: 'Mine' });
  assert.equal(moved.body.folder, 'Mine');

  assert.equal((await api.patch(`/api/workflows/${TRANSLATION_ROUND_TRIP_ID}`, { name: '   ' })).status, 400);
  assert.equal((await api.patch(`/api/workflows/${TRANSLATION_ROUND_TRIP_ID}`, { folder: '..' })).status, 400);

  const ghost = await api.patch('/api/workflows/ghost', { folder: 'Mine' });
  assert.equal(ghost.status, 404);
  assert.equal(api.db.getAllWorkflows().length, before, 'a move of nothing made nothing');
  await api.close();
});

test('POST /api/workflows/examples/restore puts back what is missing and reports it', async () => {
  const api = await serve();
  api.db.deleteWorkflow(CONTENT_REVIEW_PIPELINE_ID);

  const restored = await api.post('/api/workflows/examples/restore');
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.body.restored.map((w: Workflow) => w.id), [CONTENT_REVIEW_PIPELINE_ID]);
  assert.equal(api.db.getWorkflow(CONTENT_REVIEW_PIPELINE_ID)!.folder, EXAMPLES_FOLDER);

  const again = await api.post('/api/workflows/examples/restore');
  assert.deepEqual(again.body, { restored: [] });
  await api.close();
});

// ==================== the chat tools ====================

/** No model is needed by anything run here; the executor still wants an adapter to exist. */
function toolContext(db: Database): ToolContext {
  const adapter = {
    async generate() {
      throw new Error('no model call was expected');
    }
  } as unknown as LLMAdapter;
  return { db, conversationId: 'c1', createExecutor: () => new WorkflowExecutor(db, adapter) };
}

test('list_workflows says which folder each workflow is in', async () => {
  const db = new Database(':memory:');
  db.createWorkflow({ ...blank('loose', ''), name: 'Loose One' });

  const result = await listWorkflows.execute({}, toolContext(db));
  assert.match(result.content, /"Translation Round-Trip" \(in Examples; id example-translation-round-trip;/);
  assert.match(result.content, /"Loose One" \(id loose;/, 'a root workflow names no folder');
  db.close();
});

test('run_workflow finds a workflow by its folder and name, and names folders when it cannot', async () => {
  const db = new Database(':memory:');
  db.createWorkflow({
    id: 'wf-echo',
    name: 'Echo',
    folder: 'Smoke',
    nodes: [
      { id: 'q', type: 'input', position: { x: 0, y: 0 }, data: { label: 'Question', config: { inputType: 'text' } } },
      { id: 'agg', type: 'aggregate', position: { x: 0, y: 0 }, data: { label: 'Combine', config: { strategy: 'concat' } } },
      { id: 'out', type: 'output', position: { x: 0, y: 0 }, data: { label: 'Result', config: {} } }
    ],
    edges: [
      { id: 'e1', source: 'q', target: 'agg' },
      { id: 'e2', source: 'agg', target: 'out' }
    ],
    variables: {},
    createdAt: 1,
    updatedAt: 1
  });
  const context = toolContext(db);

  const byPath = await runWorkflow.execute({ workflow: 'smoke/echo', inputs: { question: 'pong' } }, context);
  assert.equal(byPath.isError, false, byPath.content);
  assert.match(byPath.content, /Output \(Result\):\npong/);

  const byName = await runWorkflow.execute({ workflow: 'Echo', inputs: { question: 'ping' } }, context);
  assert.equal(byName.isError, false, byName.content);

  const missing = await runWorkflow.execute({ workflow: 'Elsewhere/Echo' }, context);
  assert.equal(missing.errorType, 'not_found');
  assert.match(missing.content, /"Smoke\/Echo"/, 'the stored workflows are listed with their folders');
  db.close();
});
