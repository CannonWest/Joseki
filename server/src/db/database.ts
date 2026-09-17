import DatabaseBetter from 'better-sqlite3';
import fs from 'fs';
import nodePath from 'path';
import type {
  Workflow,
  ExecutionTrace,
  ExecutionRecord,
  ExecutionSummary,
  Conversation,
  ChatMessage,
  Folder,
  FolderEntry,
  FolderListing,
  WorkflowSummary
} from '@joseki/shared';
import {
  generateId,
  shippedExamples,
  ancestorFolders,
  folderName,
  isWithinFolder,
  normalizeFolderPath,
  parentFolder,
  ROOT_FOLDER
} from '@joseki/shared';
import { migrate, type MigrationResult } from './migrations';

export type ConversationPatch = Partial<
  Pick<Conversation, 'title' | 'model' | 'systemPrompt' | 'params' | 'activeLeafId'>
>;

/** A rename or a move: either field left out is left alone. */
export type WorkflowMetaPatch = Partial<Pick<Workflow, 'name' | 'folder'>>;

export type FolderErrorCode =
  /** Not a path a folder can have: blank, a bad segment, or the root where the root cannot go. */
  | 'invalid_path'
  | 'not_found'
  /** A folder is already at that path — or at one that differs only by case. */
  | 'exists'
  /** The folder has something in it and the delete was not recursive. */
  | 'not_empty'
  /** A folder cannot be moved into itself or under one of its own descendants. */
  | 'inside_itself';

/**
 * What a folder operation could not do, and why. The routes turn the code
 * into a status; the message is fit to show.
 */
export class FolderError extends Error {
  constructor(
    readonly code: FolderErrorCode,
    message: string,
    /** For `not_empty`: what a recursive delete would take with it. */
    readonly contents?: { workflows: number; folders: number }
  ) {
    super(message);
    this.name = 'FolderError';
  }
}

/** A path as given, made canonical — or the reason it cannot be one. */
function canonical(path: unknown): string {
  const result = normalizeFolderPath(path);
  if ('error' in result) throw new FolderError('invalid_path', result.error);
  return result.path;
}

/** The `path = X OR path is under X` test, as SQL against a column. */
const under = (column: string) =>
  `(${column} = ? OR substr(${column}, 1, length(?) + 1) = ? || '/')`;

export class Database {
  private db: DatabaseBetter.Database;
  /** What opening this database brought it up to. `db:migrate` reports it. */
  readonly schema: MigrationResult;

  constructor(path: string) {
    // better-sqlite3 will not create the parent directory, and server/data/ is
    // absent from a fresh clone — so db:init threw before touching a table.
    // ':memory:' is not a path and must not be resolved into one (the tests
    // use it throughout).
    if (path !== ':memory:') {
      const dir = nodePath.dirname(nodePath.resolve(path));
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseBetter(path);
    this.initTables();
    // Every way in goes through here — the server, db:init, db:migrate and the
    // tests — so no database is ever a schema behind the code that opens it.
    this.schema = migrate(this.db);
  }

  /**
   * Schema version 0: what a database that does not exist yet is created with.
   * Frozen — a change to an existing table goes in migrations.ts, because an
   * edit here would never reach a database that already exists.
   */
  private initTables() {
    // Workflows table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        nodes TEXT NOT NULL,
        edges TEXT NOT NULL,
        variables TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Executions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        status TEXT NOT NULL,
        context TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        error TEXT,
        parent_execution_id TEXT,
        FOREIGN KEY (workflow_id) REFERENCES workflows(id)
      )
    `);

    // Execution traces table (per-node results)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS execution_traces (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        input TEXT NOT NULL,
        output TEXT NOT NULL,
        token_usage TEXT,
        cost REAL,
        latency_ms INTEGER,
        status TEXT NOT NULL,
        error TEXT,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (execution_id) REFERENCES executions(id)
      )
    `);

    // Chat conversations. Messages form a tree through parent_id — siblings
    // are alternative branches — and the conversation tracks the leaf of the
    // branch in view.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        model TEXT NOT NULL,
        system_prompt TEXT,
        params TEXT NOT NULL,
        active_leaf_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        parent_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT,
        token_usage TEXT,
        cost REAL,
        latency_ms INTEGER,
        finish_reason TEXT,
        reasoning TEXT,
        reasoning_details TEXT,
        tool_calls TEXT,
        tool_call_id TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id),
        FOREIGN KEY (parent_id) REFERENCES messages(id)
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at)
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id)`);

    // The example workflows are not seeded here: the baseline workflows
    // table has no folder column, and they are placed in a folder. The
    // migration that added folders (v4) puts them there, on a fresh database
    // and an old one alike.
  }

  // Workflow operations

  /**
   * Stores the workflow where it says it lives. The folder is made if it is
   * not there yet — every folder a workflow names is a folder that exists,
   * and this is where that is kept true.
   */
  createWorkflow(workflow: Workflow): void {
    this.db.transaction(() => {
      const folder = this.ensureFolder(workflow.folder);
      this.db
        .prepare(
          `INSERT INTO workflows (id, name, nodes, edges, variables, created_at, updated_at, folder)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          workflow.id,
          workflow.name,
          JSON.stringify(workflow.nodes),
          JSON.stringify(workflow.edges),
          JSON.stringify(workflow.variables),
          workflow.createdAt,
          workflow.updatedAt,
          folder
        );
    })();
  }

  getWorkflow(id: string): Workflow | undefined {
    const row = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    return this.parseWorkflow(row);
  }

  getAllWorkflows(): Workflow[] {
    const rows = this.db.prepare('SELECT * FROM workflows ORDER BY updated_at DESC').all() as any[];
    return rows.map(row => this.parseWorkflow(row));
  }

  updateWorkflow(workflow: Workflow): void {
    this.db.transaction(() => {
      const folder = this.ensureFolder(workflow.folder);
      this.db
        .prepare(
          `UPDATE workflows
           SET name = ?, nodes = ?, edges = ?, variables = ?, updated_at = ?, folder = ?
           WHERE id = ?`
        )
        .run(
          workflow.name,
          JSON.stringify(workflow.nodes),
          JSON.stringify(workflow.edges),
          JSON.stringify(workflow.variables),
          Date.now(),
          folder,
          workflow.id
        );
    })();
  }

  /**
   * Renames or moves a workflow without touching its graph. Neither bumps
   * `updatedAt`: the listing orders by when a workflow was last *edited*,
   * and a file moved is not a file changed. Undefined when no workflow has
   * that id.
   */
  updateWorkflowMeta(id: string, patch: WorkflowMetaPatch): Workflow | undefined {
    return this.db.transaction(() => {
      const existing = this.getWorkflow(id);
      if (!existing) return undefined;
      const name = patch.name ?? existing.name;
      const folder = patch.folder === undefined ? existing.folder : this.ensureFolder(patch.folder);
      this.db.prepare('UPDATE workflows SET name = ?, folder = ? WHERE id = ?').run(name, folder, id);
      return { ...existing, name, folder };
    })();
  }

  /**
   * Puts back whichever shipped examples are missing, in the Examples
   * folder, and returns those it added. One that is present — edited or
   * not — is left as it is, so this never overwrites anyone's work.
   */
  restoreExamples(): Workflow[] {
    return this.db.transaction(() => {
      const restored: Workflow[] = [];
      for (const example of shippedExamples()) {
        if (this.getWorkflow(example.id)) continue;
        this.createWorkflow(example);
        restored.push(example);
      }
      return restored;
    })();
  }

  // ==================== Folders ====================
  //
  // A folder is a row keyed by its path — `Examples`, `Clients/Acme` — and
  // the root is the empty path, never stored, always there. A workflow's
  // `folder` column names the folder it is in. Renaming a folder rewrites
  // the paths under it, in one statement each for folders and workflows.

  /** Every folder, in path order. The root is not among them. */
  listFolders(): Folder[] {
    const rows = this.db.prepare('SELECT path, created_at FROM folders ORDER BY path').all() as any[];
    return rows.map((row) => ({ path: row.path, createdAt: row.created_at }));
  }

  hasFolder(path: string): boolean {
    if (path === ROOT_FOLDER) return true;
    return this.db.prepare('SELECT 1 FROM folders WHERE path = ?').get(path) !== undefined;
  }

  /**
   * Makes the folder, and any folder on the way to it that is not there yet
   * — `mkdir -p`. Says whether the folder itself was new. The root cannot be
   * made: it has no name to give it.
   */
  createFolder(path: unknown): { folder: Folder; created: boolean } {
    const target = canonical(path);
    if (target === ROOT_FOLDER) throw new FolderError('invalid_path', 'A folder needs a name');
    return this.db.transaction(() => {
      const created = this.ensureFolder(target, { report: true });
      const row = this.db.prepare('SELECT path, created_at FROM folders WHERE path = ?').get(target) as any;
      return { folder: { path: row.path, createdAt: row.created_at }, created };
    })();
  }

  /**
   * Gives the folder at `from` the path `to`, and everything under it the
   * same change — a rename when only the last segment differs, a move when
   * the parent does. The folders on the way to `to` are made if need be.
   */
  renameFolder(from: unknown, to: unknown): Folder {
    const source = canonical(from);
    const target = canonical(to);
    if (source === ROOT_FOLDER) throw new FolderError('invalid_path', 'The root cannot be renamed or moved');
    if (target === ROOT_FOLDER) throw new FolderError('invalid_path', 'A folder needs a name');
    if (!this.hasFolder(source)) throw new FolderError('not_found', `No folder at "${source}"`);
    if (isWithinFolder(target, source) && target !== source) {
      throw new FolderError('inside_itself', `"${source}" cannot be moved inside itself`);
    }
    return this.db.transaction(() => {
      if (target !== source) this.refuseCollision(target, source);
      for (const ancestor of ancestorFolders(parentFolder(target))) this.insertFolder(ancestor);

      // `substr(path, length(from) + 1)` is the part after the old prefix,
      // '' for the folder itself and '/…' for everything under it.
      this.db
        .prepare(`UPDATE folders SET path = ? || substr(path, length(?) + 1) WHERE ${under('path')}`)
        .run(target, source, source, source, source);
      this.db
        .prepare(`UPDATE workflows SET folder = ? || substr(folder, length(?) + 1) WHERE ${under('folder')}`)
        .run(target, source, source, source, source);

      const row = this.db.prepare('SELECT path, created_at FROM folders WHERE path = ?').get(target) as any;
      return { path: row.path, createdAt: row.created_at };
    })();
  }

  /**
   * Removes the folder. One with anything in it is refused unless the
   * delete is recursive, in which case every folder under it goes, and
   * every workflow in any of them — runs and all, as deleting a workflow
   * always does. Returns what went.
   */
  deleteFolder(path: unknown, options: { recursive?: boolean } = {}): { workflows: number; folders: number } {
    const target = canonical(path);
    if (target === ROOT_FOLDER) throw new FolderError('invalid_path', 'The root cannot be deleted');
    if (!this.hasFolder(target)) throw new FolderError('not_found', `No folder at "${target}"`);

    return this.db.transaction(() => {
      const workflowIds = (
        this.db.prepare(`SELECT id FROM workflows WHERE ${under('folder')}`).all(target, target, target) as any[]
      ).map((row) => row.id as string);
      const folders = (
        this.db.prepare(`SELECT COUNT(*) AS n FROM folders WHERE ${under('path')}`).get(target, target, target) as any
      ).n - 1;

      if (!options.recursive && (workflowIds.length > 0 || folders > 0)) {
        throw new FolderError(
          'not_empty',
          `"${target}" is not empty: it holds ${describeContents(workflowIds.length, folders)}`,
          { workflows: workflowIds.length, folders }
        );
      }

      for (const id of workflowIds) this.deleteWorkflow(id);
      this.db.prepare(`DELETE FROM folders WHERE ${under('path')}`).run(target, target, target);
      return { workflows: workflowIds.length, folders };
    })();
  }

  /**
   * One level of the tree: the folders directly inside `path`, each with
   * what it holds all the way down, and the workflows directly in it, most
   * recently edited first. Undefined when there is no such folder.
   */
  folderListing(path: unknown): FolderListing | undefined {
    const target = canonical(path);
    if (!this.hasFolder(target)) return undefined;

    // Counts come from one pass over every folder and every workflow's
    // folder — the tree is small, and this keeps the listing to three reads.
    const all = this.listFolders();
    const perFolder = new Map<string, number>();
    for (const row of this.db.prepare('SELECT folder, COUNT(*) AS n FROM workflows GROUP BY folder').all() as any[]) {
      perFolder.set(row.folder, row.n);
    }
    const children: FolderEntry[] = all
      .filter((folder) => parentFolder(folder.path) === target)
      .map((folder) => {
        let workflowCount = 0;
        for (const [inFolder, n] of perFolder) if (isWithinFolder(inFolder, folder.path)) workflowCount += n;
        const folderCount = all.filter((f) => f.path !== folder.path && isWithinFolder(f.path, folder.path)).length;
        return { ...folder, name: folderName(folder.path), workflowCount, folderCount };
      });

    const workflows = (
      this.db
        .prepare(
          `SELECT w.id, w.name, w.folder, w.created_at, w.updated_at,
                  json_array_length(w.nodes) AS node_count,
                  (SELECT COUNT(*) FROM executions e WHERE e.workflow_id = w.id) AS run_count
             FROM workflows w
            WHERE w.folder = ?
            ORDER BY w.updated_at DESC`
        )
        .all(target) as any[]
    ).map(
      (row): WorkflowSummary => ({
        id: row.id,
        name: row.name,
        folder: row.folder,
        nodeCount: row.node_count,
        runCount: row.run_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      })
    );

    return { path: target, folders: children, workflows };
  }

  /**
   * The folder made canonical and present, with its ancestors. Returns the
   * canonical path; with `report`, whether the folder itself was inserted.
   */
  private ensureFolder(path: unknown): string;
  private ensureFolder(path: unknown, options: { report: true }): boolean;
  private ensureFolder(path: unknown, options?: { report: true }): string | boolean {
    const target = canonical(path);
    let created = false;
    for (const ancestor of ancestorFolders(target)) created = this.insertFolder(ancestor);
    return options?.report ? created : target;
  }

  /** One folder row, unless it is there already. True when it was inserted. */
  private insertFolder(path: string): boolean {
    if (this.hasFolder(path)) return false;
    this.refuseCollision(path);
    this.db.prepare('INSERT INTO folders (path, created_at) VALUES (?, ?)').run(path, Date.now());
    return true;
  }

  /**
   * Two folders whose paths differ only by case would be one folder to
   * anyone reading a listing, so the second is refused. `except` is the
   * folder being renamed, which may of course collide with itself.
   */
  private refuseCollision(path: string, except?: string): void {
    const clash = this.db
      .prepare('SELECT path FROM folders WHERE lower(path) = lower(?) AND path <> ?')
      .get(path, except ?? '') as { path: string } | undefined;
    if (clash && clash.path !== path) {
      throw new FolderError('exists', `A folder named "${clash.path}" is already there, and names differ only by case`);
    }
    if (clash) throw new FolderError('exists', `A folder is already at "${clash.path}"`);
  }

  // Runs of the workflow go with it: better-sqlite3 enforces foreign keys,
  // so a workflow that has executed cannot be deleted on its own.
  deleteWorkflow(id: string): void {
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM execution_traces WHERE execution_id IN (SELECT id FROM executions WHERE workflow_id = ?)')
        .run(id);
      this.db.prepare('DELETE FROM executions WHERE workflow_id = ?').run(id);
      this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
    })();
  }

  private parseWorkflow(row: any): Workflow {
    return {
      id: row.id,
      name: row.name,
      folder: row.folder ?? ROOT_FOLDER,
      nodes: JSON.parse(row.nodes),
      edges: JSON.parse(row.edges),
      variables: JSON.parse(row.variables),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  // Execution operations
  createExecution(execution: {
    id: string;
    workflowId: string;
    status: string;
    context: Record<string, any>;
    startedAt: number;
    parentExecutionId?: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO executions (id, workflow_id, status, context, started_at, parent_execution_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      execution.id,
      execution.workflowId,
      execution.status,
      JSON.stringify(execution.context),
      execution.startedAt,
      execution.parentExecutionId || null
    );
  }

  updateExecutionStatus(
    id: string,
    status: string,
    error?: string,
    completedAt?: number
  ): void {
    const stmt = this.db.prepare(`
      UPDATE executions SET status = ?, error = ?, completed_at = ? WHERE id = ?
    `);
    stmt.run(status, error || null, completedAt || null, id);
  }

  createExecutionTrace(trace: ExecutionTrace & { executionId: string; nodeId: string }): void {
    const stmt = this.db.prepare(`
      INSERT INTO execution_traces
      (id, execution_id, node_id, input, output, token_usage, cost, latency_ms, status, error, timestamp, detail, model, reasoning)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      // runId is the execution id, shared by every node in the run — it
      // cannot be this row's primary key.
      generateId(),
      trace.executionId,
      trace.nodeId,
      JSON.stringify(trace.input),
      JSON.stringify(trace.output),
      JSON.stringify(trace.tokenUsage),
      trace.cost,
      trace.latencyMs,
      trace.status,
      trace.error || null,
      trace.timestamp,
      // A node with nothing to decide stores null rather than an empty object,
      // so "no detail" and "detail that says nothing" read the same way back.
      trace.detail ? JSON.stringify(trace.detail) : null,
      trace.model || null,
      trace.reasoning || null
    );
  }

  /** One past run, or undefined when no run has that id. */
  getExecution(id: string): ExecutionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM executions WHERE id = ?').get(id) as any;
    return row ? this.parseExecution(row) : undefined;
  }

  /**
   * Past runs with their rollups, most recent first — all of them, one
   * workflow's, or a single run by id. One query serves the runs list and a
   * reopened run, so a total shown in the list is the total shown on the run.
   * The rollups come from the traces by outer join, so a run whose traces
   * were never written still appears, with zeroes.
   */
  listExecutions(
    options: { id?: string; workflowId?: string; limit?: number } = {}
  ): ExecutionSummary[] {
    const { id, workflowId, limit = 50 } = options;
    const rows = this.db
      .prepare(
        `SELECT e.*, w.name AS workflow_name,
                COUNT(t.id) AS trace_count,
                COUNT(DISTINCT t.node_id) AS node_count,
                COALESCE(SUM(t.cost), 0) AS total_cost,
                COALESCE(SUM(json_extract(t.token_usage, '$.total')), 0) AS total_tokens
           FROM executions e
           LEFT JOIN workflows w ON w.id = e.workflow_id
           LEFT JOIN execution_traces t ON t.execution_id = e.id
          WHERE (? IS NULL OR e.id = ?)
            AND (? IS NULL OR e.workflow_id = ?)
          GROUP BY e.id
          ORDER BY e.started_at DESC
          LIMIT ?`
      )
      .all(id ?? null, id ?? null, workflowId ?? null, workflowId ?? null, limit) as any[];
    return rows.map((row) => this.parseExecutionSummary(row));
  }

  /** One past run with its rollups, or undefined when no run has that id. */
  getExecutionSummary(id: string): ExecutionSummary | undefined {
    return this.listExecutions({ id, limit: 1 })[0];
  }

  /**
   * Every trace of a run, in the order it happened. A node a gate sent back
   * appears once per attempt — the sequence is the history, so nothing is
   * collapsed here. `rowid` breaks ties: two traces can share a millisecond.
   */
  getExecutionTraces(executionId: string): Array<ExecutionTrace & { nodeId: string }> {
    const rows = this.db
      .prepare('SELECT * FROM execution_traces WHERE execution_id = ? ORDER BY timestamp, rowid')
      .all(executionId) as any[];
    return rows.map((row) => this.parseExecutionTrace(row));
  }

  private parseExecution(row: any): ExecutionRecord {
    return {
      id: row.id,
      workflowId: row.workflow_id,
      status: row.status,
      context: JSON.parse(row.context),
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      error: row.error ?? undefined,
      parentExecutionId: row.parent_execution_id ?? undefined
    };
  }

  private parseExecutionSummary(row: any): ExecutionSummary {
    return {
      ...this.parseExecution(row),
      workflowName: row.workflow_name ?? undefined,
      traceCount: row.trace_count,
      nodeCount: row.node_count,
      totalCost: row.total_cost,
      totalTokens: row.total_tokens
    };
  }

  private parseExecutionTrace(row: any): ExecutionTrace & { nodeId: string } {
    return {
      runId: row.execution_id,
      nodeId: row.node_id,
      timestamp: row.timestamp,
      input: JSON.parse(row.input),
      output: JSON.parse(row.output),
      tokenUsage: JSON.parse(row.token_usage),
      cost: row.cost,
      latencyMs: row.latency_ms,
      status: row.status,
      error: row.error ?? undefined,
      // Null on a node with nothing to decide, and on every trace recorded
      // before the columns existed.
      detail: row.detail ? JSON.parse(row.detail) : undefined,
      model: row.model ?? undefined,
      reasoning: row.reasoning ?? undefined
    };
  }

  // Conversation operations
  createConversation(conversation: Conversation): void {
    const stmt = this.db.prepare(`
      INSERT INTO conversations
      (id, title, model, system_prompt, params, active_leaf_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      conversation.id,
      conversation.title,
      conversation.model,
      conversation.systemPrompt,
      JSON.stringify(conversation.params),
      conversation.activeLeafId,
      conversation.createdAt,
      conversation.updatedAt
    );
  }

  getConversation(id: string): Conversation | undefined {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    return this.parseConversation(row);
  }

  getAllConversations(): Conversation[] {
    const rows = this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all() as any[];
    return rows.map(row => this.parseConversation(row));
  }

  // Applies the given fields and bumps updated_at
  updateConversation(id: string, patch: ConversationPatch): Conversation | undefined {
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (patch.title !== undefined) {
      assignments.push('title = ?');
      values.push(patch.title);
    }
    if (patch.model !== undefined) {
      assignments.push('model = ?');
      values.push(patch.model);
    }
    if (patch.systemPrompt !== undefined) {
      assignments.push('system_prompt = ?');
      values.push(patch.systemPrompt);
    }
    if (patch.params !== undefined) {
      assignments.push('params = ?');
      values.push(JSON.stringify(patch.params));
    }
    if (patch.activeLeafId !== undefined) {
      assignments.push('active_leaf_id = ?');
      values.push(patch.activeLeafId);
    }
    assignments.push('updated_at = ?');
    values.push(Date.now());

    this.db
      .prepare(`UPDATE conversations SET ${assignments.join(', ')} WHERE id = ?`)
      .run(...values, id);
    return this.getConversation(id);
  }

  deleteConversation(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    })();
  }

  private parseConversation(row: any): Conversation {
    return {
      id: row.id,
      title: row.title,
      model: row.model,
      systemPrompt: row.system_prompt ?? null,
      params: JSON.parse(row.params),
      activeLeafId: row.active_leaf_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  // Message operations
  createMessage(message: ChatMessage): void {
    const stmt = this.db.prepare(`
      INSERT INTO messages
      (id, conversation_id, parent_id, role, content, model, provider, token_usage, cost, latency_ms,
       finish_reason, reasoning, reasoning_details, tool_calls, tool_call_id, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      message.id,
      message.conversationId,
      message.parentId,
      message.role,
      message.content,
      message.model ?? null,
      message.provider ?? null,
      message.tokenUsage ? JSON.stringify(message.tokenUsage) : null,
      message.cost ?? null,
      message.latencyMs ?? null,
      message.finishReason ?? null,
      message.reasoning ?? null,
      message.reasoningDetails ? JSON.stringify(message.reasoningDetails) : null,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      message.toolCallId ?? null,
      message.error ?? null,
      message.createdAt
    );
  }

  getMessage(id: string): ChatMessage | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    return this.parseMessage(row);
  }

  // Every message in the conversation, oldest first
  getMessages(conversationId: string): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid')
      .all(conversationId) as any[];
    return rows.map(row => this.parseMessage(row));
  }

  // The branch in view, root first. Empty when the conversation has no active leaf.
  getActivePath(conversationId: string): ChatMessage[] {
    const rows = this.db.prepare(`
      WITH RECURSIVE path(id, depth) AS (
        SELECT active_leaf_id, 0 FROM conversations
        WHERE id = ? AND active_leaf_id IS NOT NULL
        UNION ALL
        SELECT m.parent_id, path.depth + 1 FROM messages m
        JOIN path ON m.id = path.id
        WHERE m.parent_id IS NOT NULL
      )
      SELECT m.* FROM messages m JOIN path ON m.id = path.id ORDER BY path.depth DESC
    `).all(conversationId) as any[];
    return rows.map(row => this.parseMessage(row));
  }

  private parseMessage(row: any): ChatMessage {
    const message: ChatMessage = {
      id: row.id,
      conversationId: row.conversation_id,
      parentId: row.parent_id ?? null,
      role: row.role,
      content: row.content,
      createdAt: row.created_at
    };
    if (row.model != null) message.model = row.model;
    if (row.provider != null) message.provider = row.provider;
    if (row.token_usage != null) message.tokenUsage = JSON.parse(row.token_usage);
    if (row.cost != null) message.cost = row.cost;
    if (row.latency_ms != null) message.latencyMs = row.latency_ms;
    if (row.finish_reason != null) message.finishReason = row.finish_reason;
    if (row.reasoning != null) message.reasoning = row.reasoning;
    if (row.reasoning_details != null) message.reasoningDetails = JSON.parse(row.reasoning_details);
    if (row.tool_calls != null) message.toolCalls = JSON.parse(row.tool_calls);
    if (row.tool_call_id != null) message.toolCallId = row.tool_call_id;
    if (row.error != null) message.error = row.error;
    return message;
  }

  close(): void {
    this.db.close();
  }
}

/** `2 workflows and 1 folder`, for a folder that could not be deleted. */
function describeContents(workflows: number, folders: number): string {
  const parts: string[] = [];
  if (workflows) parts.push(`${workflows} workflow${workflows === 1 ? '' : 's'}`);
  if (folders) parts.push(`${folders} folder${folders === 1 ? '' : 's'}`);
  return parts.join(' and ');
}
