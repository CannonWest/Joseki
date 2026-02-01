import DatabaseBetter from 'better-sqlite3';
import type { Workflow, ExecutionTrace, ConversationTree, ModelConfig } from '@convchain/shared';

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

    // Conversation trees table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_trees (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        root_id TEXT NOT NULL,
        nodes TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (workflow_id) REFERENCES workflows(id),
        FOREIGN KEY (execution_id) REFERENCES executions(id)
      )
    `);

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

  deleteWorkflow(id: string): void {
    this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
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
      trace.runId,
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

  close(): void {
    this.db.close();
  }
}
