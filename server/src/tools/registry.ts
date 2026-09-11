import type { Database } from '../db/database';
import type { WireTool } from '../providers/openrouter';
import type { WorkflowExecutor } from '../engine/executor';

/**
 * Tools the chat model can call. Definitions use the OpenAI function-calling
 * shape — the same shape OpenRouter consumes and the conversation stores —
 * and each carries its executor, so the registry is the single place a tool
 * exists.
 */

/** What a tool sees when it runs. */
export interface ToolContext {
  db: Database;
  conversationId: string;
  signal?: AbortSignal;
  /** How run_workflow builds its executor; tests inject a fake adapter. */
  createExecutor?: () => WorkflowExecutor;
}

/** The result handed back to the model. Never thrown — failures are content. */
export interface ToolOutcome {
  content: string;
  isError: boolean;
  errorType?: string;
}

export interface ToolDefinition {
  /** OpenAI's rule: letters, digits, underscores and dashes, up to 64 chars. */
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  /** Never offered to the model — an approval gate does not exist yet. */
  destructive?: boolean;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolOutcome>;
}

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): this {
    if (!NAME_PATTERN.test(tool.name)) {
      throw new Error(`Invalid tool name "${tool.name}": letters, digits, _ and - only, up to 64 chars`);
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** The `tools` array for a chat completion — non-destructive tools only. */
  assemble(): WireTool[] {
    return this.list()
      .filter((tool) => !tool.destructive)
      .map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }));
  }
}

export function ok(content: string): ToolOutcome {
  return { content, isError: false };
}

export function fail(content: string, errorType: string): ToolOutcome {
  return { content, isError: true, errorType };
}
