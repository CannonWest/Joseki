import DatabaseBetter from 'better-sqlite3';
import fs from 'fs';
import nodePath from 'path';
import type {
  Workflow,
  ExecutionTrace,
  ExecutionRecord,
  ExecutionSummary,
  ModelConfig,
  Conversation,
  ChatMessage
} from '@joseki/shared';
import { createExampleWorkflow, generateId } from '@joseki/shared';
import { migrate, type MigrationResult } from './migrations';

export type ConversationPatch = Partial<
  Pick<Conversation, 'title' | 'model' | 'systemPrompt' | 'params' | 'activeLeafId'>
>;

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
    // branch in view. Replaces the never-populated conversation_trees table.
    this.db.exec(`DROP TABLE IF EXISTS conversation_trees`);
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

    // Model configs table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        max_tokens INTEGER NOT NULL,
        pricing TEXT NOT NULL,
        capabilities TEXT NOT NULL
      )
    `);

    // Insert default model configs if empty
    const count = this.db.prepare('SELECT COUNT(*) as count FROM model_configs').get() as { count: number };
    if (count.count === 0) {
      this.insertDefaultModels();
    }

    // Insert example workflow if no workflows exist
    const workflowCount = this.db.prepare('SELECT COUNT(*) as count FROM workflows').get() as { count: number };
    if (workflowCount.count === 0) {
      const example = createExampleWorkflow();
      this.createWorkflow(example);
    }
  }

  private insertDefaultModels() {
    const defaultModels: ModelConfig[] = [
      {
        id: 'gpt-4',
        name: 'GPT-4',
        provider: 'openai',
        modelId: 'gpt-4',
        maxTokens: 8192,
        pricing: { input: 0.03, output: 0.06 },
        capabilities: ['chat', 'function-calling']
      },
      {
        id: 'gpt-4-turbo',
        name: 'GPT-4 Turbo',
        provider: 'openai',
        modelId: 'gpt-4-turbo-preview',
        maxTokens: 128000,
        pricing: { input: 0.01, output: 0.03 },
        capabilities: ['chat', 'function-calling', 'vision']
      },
      {
        id: 'gpt-3.5-turbo',
        name: 'GPT-3.5 Turbo',
        provider: 'openai',
        modelId: 'gpt-3.5-turbo',
        maxTokens: 16385,
        pricing: { input: 0.0005, output: 0.0015 },
        capabilities: ['chat', 'function-calling']
      },
      {
        id: 'claude-3-opus',
        name: 'Claude 3 Opus',
        provider: 'anthropic',
        modelId: 'claude-3-opus-20240229',
        maxTokens: 200000,
        pricing: { input: 0.015, output: 0.075 },
        capabilities: ['chat', 'vision']
      }
    ];

    const insert = this.db.prepare(`
      INSERT INTO model_configs (id, name, provider, model_id, max_tokens, pricing, capabilities)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const model of defaultModels) {
      insert.run(
        model.id,
        model.name,
        model.provider,
        model.modelId,
        model.maxTokens,
        JSON.stringify(model.pricing),
        JSON.stringify(model.capabilities)
      );
    }
  }

  // Workflow operations
  createWorkflow(workflow: Workflow): void {
    const stmt = this.db.prepare(`
      INSERT INTO workflows (id, name, nodes, edges, variables, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      workflow.id,
      workflow.name,
      JSON.stringify(workflow.nodes),
      JSON.stringify(workflow.edges),
      JSON.stringify(workflow.variables),
      workflow.createdAt,
      workflow.updatedAt
    );
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
    const stmt = this.db.prepare(`
      UPDATE workflows 
      SET name = ?, nodes = ?, edges = ?, variables = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(
      workflow.name,
      JSON.stringify(workflow.nodes),
      JSON.stringify(workflow.edges),
      JSON.stringify(workflow.variables),
      Date.now(),
      workflow.id
    );
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
      (id, execution_id, node_id, input, output, token_usage, cost, latency_ms, status, error, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      trace.timestamp
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
      error: row.error ?? undefined
    };
  }

  // Model config operations
  getModelConfigs(): ModelConfig[] {
    const rows = this.db.prepare('SELECT * FROM model_configs').all() as any[];
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      modelId: row.model_id,
      maxTokens: row.max_tokens,
      pricing: JSON.parse(row.pricing),
      capabilities: JSON.parse(row.capabilities)
    }));
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
