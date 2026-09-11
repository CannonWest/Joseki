import DatabaseBetter from 'better-sqlite3';
import type {
  Workflow,
  ExecutionTrace,
  ModelConfig,
  Conversation,
  ChatMessage
} from '@maestroai/shared';
import { createExampleWorkflow, generateId } from '@maestroai/shared';

export type ConversationPatch = Partial<
  Pick<Conversation, 'title' | 'model' | 'systemPrompt' | 'params' | 'activeLeafId'>
>;

export class Database {
  private db: DatabaseBetter.Database;

  constructor(path: string) {
    this.db = new DatabaseBetter(path);
    this.initTables();
  }

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
    // Columns added after the table first shipped
    this.ensureColumn('messages', 'reasoning_details', 'TEXT');

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

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((existing) => existing.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
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
      (id, conversation_id, parent_id, role, content, model, token_usage, cost, latency_ms,
       finish_reason, reasoning, reasoning_details, tool_calls, tool_call_id, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      message.id,
      message.conversationId,
      message.parentId,
      message.role,
      message.content,
      message.model ?? null,
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
