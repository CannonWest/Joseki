/**
 * Copyright 2025 [Your Name]
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Stepflow Component Discovery & MCP Integration
 * 
 * This module provides:
 * 1. Bidirectional component discovery from Stepflow servers
 * 2. MCP (Model Context Protocol) server integration
 * 3. Component metadata and schema management
 * 4. Auto-completion support for component paths
 * 
 * MCP is a protocol for connecting AI systems to external data sources and tools.
 * See: https://modelcontextprotocol.io
 */

// ==================== Types ====================

export interface ComponentInfo {
  /** Full component path (e.g., /builtin/openai) */
  path: string;
  /** Human-readable name */
  name: string;
  /** Component description */
  description?: string;
  /** Input JSON schema */
  inputSchema?: Record<string, any>;
  /** Output JSON schema */
  outputSchema?: Record<string, any>;
  /** Provider/plugin name */
  provider: string;
  /** Component category */
  category: ComponentCategory;
  /** Whether component supports streaming */
  supportsStreaming?: boolean;
  /** Required environment variables */
  requiredEnv?: string[];
  /** Component version */
  version?: string;
  /** Example usage */
  examples?: ComponentExample[];
  /** Configuration schema for MCP tools */
  configSchema?: Record<string, any>;
}

export interface ComponentExample {
  name: string;
  description?: string;
  input: Record<string, any>;
  output?: any;
}

export type ComponentCategory =
  | 'llm'           // Language models
  | 'tool'          // Tools/functions
  | 'data'          // Data sources
  | 'control'       // Control flow
  | 'utility'       // Utilities
  | 'integration'   // External integrations
  | 'custom';       // Custom/user components

export interface PluginInfo {
  /** Plugin identifier */
  id: string;
  /** Plugin type */
  type: 'builtin' | 'stepflow' | 'mcp';
  /** Plugin display name */
  name: string;
  /** Plugin description */
  description?: string;
  /** Components provided by this plugin */
  components: ComponentInfo[];
  /** Plugin configuration schema */
  configSchema?: Record<string, any>;
  /** Connection info for remote plugins */
  connection?: {
    url?: string;
    command?: string;
    args?: string[];
  };
  /** Health status */
  status: 'connected' | 'disconnected' | 'error';
  /** Last error message if status is 'error' */
  lastError?: string;
}

export interface MCPServerConfig {
  /** Server identifier */
  id: string;
  /** MCP server type */
  type: 'stdio' | 'sse' | 'http';
  /** Server display name */
  name: string;
  /** Server description */
  description?: string;
  /** Command for stdio servers */
  command?: string;
  /** Arguments for stdio servers */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** URL for SSE/HTTP servers */
  url?: string;
  /** Headers for authentication */
  headers?: Record<string, string>;
  /** Auto-connect on startup */
  autoConnect?: boolean;
  /** Timeout in milliseconds */
  timeout?: number;
}

export interface DiscoveryOptions {
  /** Include builtin components */
  includeBuiltin?: boolean;
  /** Include MCP servers */
  includeMCP?: boolean;
  /** Filter by category */
  category?: ComponentCategory;
  /** Search query */
  search?: string;
  /** Include disconnected plugins */
  includeDisconnected?: boolean;
}

// ==================== Built-in Component Registry ====================

/**
 * Built-in Stepflow components registry
 */
export const BUILTIN_COMPONENTS: ComponentInfo[] = [
  {
    path: '/builtin/openai',
    name: 'OpenAI',
    description: 'OpenAI GPT models (GPT-4, GPT-3.5, etc.)',
    provider: 'builtin',
    category: 'llm',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model ID (e.g., gpt-4)' },
        messages: { type: 'array', description: 'Chat messages' },
        temperature: { type: 'number', description: 'Sampling temperature', default: 0.7 },
        max_tokens: { type: 'number', description: 'Maximum tokens to generate', default: 2048 },
        top_p: { type: 'number', description: 'Nucleus sampling', default: 1.0 },
        frequency_penalty: { type: 'number', default: 0 },
        presence_penalty: { type: 'number', default: 0 }
      },
      required: ['model', 'messages']
    },
    supportsStreaming: true,
    requiredEnv: ['OPENAI_API_KEY'],
    examples: [
      {
        name: 'Simple chat',
        input: {
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hello!' }]
        }
      }
    ]
  },
  {
    path: '/builtin/input',
    name: 'Input',
    description: 'Collect user input',
    provider: 'builtin',
    category: 'control',
    inputSchema: {
      type: 'object',
      properties: {
        input_type: { type: 'string', enum: ['text', 'number', 'file'], default: 'text' },
        required: { type: 'boolean', default: false },
        description: { type: 'string' }
      }
    }
  },
  {
    path: '/builtin/output',
    name: 'Output',
    description: 'Output workflow results',
    provider: 'builtin',
    category: 'control',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['json', 'text'], default: 'json' },
        value: { type: 'any' }
      }
    }
  },
  {
    path: '/builtin/conditional',
    name: 'Conditional',
    description: 'Branch execution based on condition',
    provider: 'builtin',
    category: 'control',
    inputSchema: {
      type: 'object',
      properties: {
        condition: { type: 'string', description: 'Expression to evaluate' },
        branches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              condition: { type: 'string' }
            }
          }
        }
      }
    }
  },
  {
    path: '/builtin/aggregate',
    name: 'Aggregate',
    description: 'Aggregate multiple inputs',
    provider: 'builtin',
    category: 'control',
    inputSchema: {
      type: 'object',
      properties: {
        strategy: { type: 'string', enum: ['concat', 'vote', 'merge'], default: 'concat' },
        separator: { type: 'string', default: '\n' },
        inputs: { type: 'array' }
      }
    }
  },
  {
    path: '/builtin/pause',
    name: 'Pause/Human Gate',
    description: 'Pause for human review and approval',
    provider: 'builtin',
    category: 'control',
    inputSchema: {
      type: 'object',
      properties: {
        instructions: { type: 'string' },
        allow_edit: { type: 'boolean', default: true },
        timeout_seconds: { type: 'number' },
        value: { type: 'any' }
      }
    }
  },
  {
    path: '/builtin/parallel',
    name: 'Parallel',
    description: 'Execute branches in parallel',
    provider: 'builtin',
    category: 'control',
    inputSchema: {
      type: 'object',
      properties: {
        branches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              component: { type: 'string' },
              input: { type: 'object' }
            }
          }
        }
      }
    }
  },
  {
    path: '/builtin/eval',
    name: 'Eval',
    description: 'Evaluate JavaScript/JSONata expression',
    provider: 'builtin',
    category: 'utility',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string' },
        context: { type: 'object' }
      },
      required: ['expression']
    }
  },
  {
    path: '/builtin/put_blob',
    name: 'Put Blob',
    description: 'Store data in blob storage',
    provider: 'builtin',
    category: 'data',
    inputSchema: {
      type: 'object',
      properties: {
        data: { type: 'any' }
      },
      required: ['data']
    },
    outputSchema: {
      type: 'object',
      properties: {
        blob_id: { type: 'string' }
      }
    }
  },
  {
    path: '/builtin/get_blob',
    name: 'Get Blob',
    description: 'Retrieve data from blob storage',
    provider: 'builtin',
    category: 'data',
    inputSchema: {
      type: 'object',
      properties: {
        blob_id: { type: 'string' }
      },
      required: ['blob_id']
    }
  },
  {
    path: '/builtin/http',
    name: 'HTTP Request',
    description: 'Make HTTP requests',
    provider: 'builtin',
    category: 'integration',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], default: 'GET' },
        url: { type: 'string' },
        headers: { type: 'object' },
        body: { type: 'any' }
      },
      required: ['url']
    }
  }
];

// ==================== External Plugin Registry ====================

/**
 * External Stepflow plugin components
 */
export const EXTERNAL_COMPONENTS: ComponentInfo[] = [
  {
    path: '/stepflow-anthropic/anthropic',
    name: 'Anthropic Claude',
    description: 'Anthropic Claude models (Claude 3, etc.)',
    provider: 'stepflow-anthropic',
    category: 'llm',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model ID (e.g., claude-3-opus-20240229)' },
        messages: { type: 'array' },
        max_tokens: { type: 'number', default: 4096 },
        temperature: { type: 'number', default: 0.7 }
      },
      required: ['model', 'messages']
    },
    supportsStreaming: true,
    requiredEnv: ['ANTHROPIC_API_KEY']
  },
  {
    path: '/stepflow-cohere/cohere',
    name: 'Cohere',
    description: 'Cohere Command models',
    provider: 'stepflow-cohere',
    category: 'llm',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        message: { type: 'string' },
        temperature: { type: 'number', default: 0.7 }
      },
      required: ['model', 'message']
    },
    supportsStreaming: true,
    requiredEnv: ['COHERE_API_KEY']
  }
];

// ==================== Component Discovery ====================

/**
 * Component registry for discovered components
 */
class ComponentRegistry {
  private components: Map<string, ComponentInfo> = new Map();
  private plugins: Map<string, PluginInfo> = new Map();
  private mcpServers: Map<string, MCPServerConfig> = new Map();

  constructor() {
    // Register built-in components
    this.registerBuiltinComponents();
  }

  private registerBuiltinComponents() {
    for (const component of BUILTIN_COMPONENTS) {
      this.components.set(component.path, component);
    }
    
    this.plugins.set('builtin', {
      id: 'builtin',
      type: 'builtin',
      name: 'Built-in',
      description: 'Core Stepflow components',
      components: [...BUILTIN_COMPONENTS],
      status: 'connected'
    });
  }

  /**
   * Register a component
   */
  registerComponent(component: ComponentInfo): void {
    this.components.set(component.path, component);
  }

  /**
   * Get a component by path
   */
  getComponent(path: string): ComponentInfo | undefined {
    return this.components.get(path);
  }

  /**
   * Check if a component exists
   */
  hasComponent(path: string): boolean {
    return this.components.has(path);
  }

  /**
   * Get all components matching options
   */
  getComponents(options: DiscoveryOptions = {}): ComponentInfo[] {
    let components = Array.from(this.components.values());

    if (!options.includeBuiltin) {
      components = components.filter(c => c.provider !== 'builtin');
    }

    if (options.category) {
      components = components.filter(c => c.category === options.category);
    }

    if (options.search) {
      const query = options.search.toLowerCase();
      components = components.filter(c =>
        c.name.toLowerCase().includes(query) ||
        c.description?.toLowerCase().includes(query) ||
        c.path.toLowerCase().includes(query)
      );
    }

    return components;
  }

  /**
   * Register a plugin
   */
  registerPlugin(plugin: PluginInfo): void {
    this.plugins.set(plugin.id, plugin);
    for (const component of plugin.components) {
      this.registerComponent(component);
    }
  }

  /**
   * Get all plugins
   */
  getPlugins(options: { includeDisconnected?: boolean } = {}): PluginInfo[] {
    const plugins = Array.from(this.plugins.values());
    if (!options.includeDisconnected) {
      return plugins.filter(p => p.status === 'connected');
    }
    return plugins;
  }

  /**
   * Register an MCP server configuration
   */
  registerMCPServer(config: MCPServerConfig): void {
    this.mcpServers.set(config.id, config);
  }

  /**
   * Get all MCP server configurations
   */
  getMCPServers(): MCPServerConfig[] {
    return Array.from(this.mcpServers.values());
  }

  /**
   * Auto-complete component paths
   */
  autocomplete(partial: string, limit: number = 10): ComponentInfo[] {
    const partialLower = partial.toLowerCase();
    const matches: Array<{ component: ComponentInfo; score: number }> = [];

    for (const component of this.components.values()) {
      let score = 0;
      
      // Exact match
      if (component.path === partial) {
        score = 100;
      }
      // Starts with
      else if (component.path.toLowerCase().startsWith(partialLower)) {
        score = 80;
      }
      // Contains
      else if (component.path.toLowerCase().includes(partialLower)) {
        score = 60;
      }
      // Name matches
      else if (component.name.toLowerCase().includes(partialLower)) {
        score = 40;
      }
      // Description matches
      else if (component.description?.toLowerCase().includes(partialLower)) {
        score = 20;
      }

      if (score > 0) {
        matches.push({ component, score });
      }
    }

    // Sort by score descending
    matches.sort((a, b) => b.score - a.score);

    return matches.slice(0, limit).map(m => m.component);
  }

  /**
   * Clear all non-builtin registrations
   */
  clear(): void {
    this.components.clear();
    this.plugins.clear();
    this.mcpServers.clear();
    this.registerBuiltinComponents();
  }
}

// Global registry instance
export const componentRegistry = new ComponentRegistry();

// ==================== MCP Integration ====================

/**
 * Convert MCP tool to Stepflow component
 */
export function convertMCPToolToComponent(
  tool: {
    name: string;
    description?: string;
    inputSchema?: Record<string, any>;
  },
  serverId: string
): ComponentInfo {
  return {
    path: `/mcp/${serverId}/${tool.name}`,
    name: tool.name,
    description: tool.description,
    provider: `mcp-${serverId}`,
    category: 'tool',
    inputSchema: tool.inputSchema,
    supportsStreaming: false
  };
}

/**
 * Generate stepflow-config.yml entry for MCP server
 */
export function generateMCPPluginConfig(
  serverConfig: MCPServerConfig
): { plugin: Record<string, any>; route: Record<string, any> } {
  const pluginId = `mcp-${serverConfig.id}`;
  
  const plugin: Record<string, any> = {
    type: 'mcp',
    command: serverConfig.command,
    args: serverConfig.args || [],
  };

  if (serverConfig.env) {
    plugin.env = serverConfig.env;
  }

  const route: Record<string, any> = {
    [`/mcp/${serverConfig.id}/{*component}`]: [{ plugin: pluginId }]
  };

  return { plugin: { [pluginId]: plugin }, route };
}

// ==================== Utility Functions ====================

/**
 * Get component suggestions for a node type
 */
export function getComponentsForNodeType(nodeType: string): ComponentInfo[] {
  const categoryMap: Record<string, ComponentCategory[]> = {
    'prompt': ['llm'],
    'branch': ['control'],
    'aggregate': ['control'],
    'human_gate': ['control'],
    'input': ['control'],
    'output': ['control'],
    'model_compare': ['llm']
  };

  const categories = categoryMap[nodeType] || [];
  
  return componentRegistry.getComponents({
    includeBuiltin: true
  }).filter(c => categories.includes(c.category));
}

/**
 * Validate a component path
 */
export function validateComponentPath(path: string): {
  valid: boolean;
  component?: ComponentInfo;
  error?: string;
} {
  // Check exact match
  const component = componentRegistry.getComponent(path);
  if (component) {
    return { valid: true, component };
  }

  // Check if pattern matches
  const components = componentRegistry.getComponents({ includeBuiltin: true });
  
  // Check for wildcard patterns like /builtin/{*component}
  for (const c of components) {
    if (c.path.startsWith(path.split('/').slice(0, 3).join('/'))) {
      return {
        valid: false,
        error: `Component "${path}" not found. Did you mean "${c.path}"?`
      };
    }
  }

  // Suggest similar paths
  const suggestions = componentRegistry.autocomplete(path, 3);
  if (suggestions.length > 0) {
    return {
      valid: false,
      error: `Component "${path}" not found. Did you mean: ${suggestions.map(s => s.path).join(', ')}?`
    };
  }

  return {
    valid: false,
    error: `Component "${path}" not found. Available components: ${components.slice(0, 5).map(c => c.path).join(', ')}...`
  };
}

/**
 * Get required environment variables for a workflow
 */
export function getRequiredEnvVars(workflow: {
  nodes: Array<{ type: string; data: { config?: { model?: string } } }>;
}): string[] {
  const required = new Set<string>();

  for (const node of workflow.nodes) {
    if (node.type === 'prompt' && node.data.config?.model) {
      const model = node.data.config.model;
      
      if (model.startsWith('claude-')) {
        required.add('ANTHROPIC_API_KEY');
      } else if (model.startsWith('command-') || model.startsWith('c4ai-')) {
        required.add('COHERE_API_KEY');
      } else {
        required.add('OPENAI_API_KEY');
      }
    }
  }

  return Array.from(required);
}

/**
 * Generate stepflow-config.yml with MCP support
 */
export function generateFullStepflowConfig(workflow?: {
  nodes: Array<{ type: string; data: { config?: { model?: string } } }>;
}, mcpServers?: MCPServerConfig[]): string {
  const plugins: Record<string, any> = {
    builtin: { type: 'builtin' }
  };

  const routes: Record<string, any> = {
    '/builtin/{*component}': [{ plugin: 'builtin' }],
    '/{*component}': [{ plugin: 'builtin' }]
  };

  // Add LLM plugins based on workflow
  if (workflow) {
    const usedComponents = new Set<string>();
    
    for (const node of workflow.nodes) {
      if (node.type === 'prompt' && node.data.config?.model) {
        const model = node.data.config.model;
        
        if (model.startsWith('claude-')) {
          usedComponents.add('anthropic');
        } else if (model.startsWith('command-') || model.startsWith('c4ai-')) {
          usedComponents.add('cohere');
        }
      }
    }

    if (usedComponents.has('anthropic')) {
      plugins.anthropic = {
        type: 'stepflow',
        command: 'uv',
        args: ['run', '--package', 'stepflow-anthropic', 'stepflow_anthropic'],
        env: { ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY:-}' }
      };
      routes['/stepflow-anthropic/{*component}'] = [{ plugin: 'anthropic' }];
    }

    if (usedComponents.has('cohere')) {
      plugins.cohere = {
        type: 'stepflow',
        command: 'uv',
        args: ['run', '--package', 'stepflow-cohere', 'stepflow_cohere'],
        env: { COHERE_API_KEY: '${COHERE_API_KEY:-}' }
      };
      routes['/stepflow-cohere/{*component}'] = [{ plugin: 'cohere' }];
    }
  }

  // Add MCP plugins
  if (mcpServers) {
    for (const server of mcpServers) {
      const { plugin, route } = generateMCPPluginConfig(server);
      Object.assign(plugins, plugin);
      Object.assign(routes, route);
    }
  }

  // Generate YAML
  let yaml = `# Stepflow Configuration with MCP Support\n`;
  yaml += `# Generated by MaestroAI\n\n`;

  yaml += `plugins:\n`;
  for (const [name, config] of Object.entries(plugins)) {
    yaml += `  ${name}:\n`;
    yaml += `    type: ${config.type}\n`;
    if (config.command) {
      yaml += `    command: ${config.command}\n`;
    }
    if (config.args) {
      yaml += `    args: [${config.args.map((a: string) => `"${a}"`).join(', ')}]\n`;
    }
    if (config.env) {
      yaml += `    env:\n`;
      for (const [key, value] of Object.entries(config.env)) {
        yaml += `      ${key}: "${value}"\n`;
      }
    }
  }

  yaml += `\nroutes:\n`;
  for (const [route, handlers] of Object.entries(routes)) {
    yaml += `  "${route}":\n`;
    for (const handler of handlers) {
      yaml += `    - plugin: ${(handler as any).plugin}\n`;
    }
  }

  yaml += `\nstateStore:\n`;
  yaml += `  type: sqlite\n`;
  yaml += `  databaseUrl: "sqlite:workflow_state.db"\n`;
  yaml += `  autoMigrate: true\n`;

  return yaml;
}

/**
 * Get component documentation
 */
export function getComponentDocumentation(path: string): string {
  const component = componentRegistry.getComponent(path);
  
  if (!component) {
    return `Component "${path}" not found.`;
  }

  let doc = `# ${component.name}\n\n`;
  doc += `**Path:** \`${component.path}\`\n\n`;
  
  if (component.description) {
    doc += `${component.description}\n\n`;
  }

  doc += `**Category:** ${component.category}\n\n`;

  if (component.inputSchema) {
    doc += `## Input Schema\n\n`;
    doc += '```json\n';
    doc += JSON.stringify(component.inputSchema, null, 2);
    doc += '\n```\n\n';
  }

  if (component.outputSchema) {
    doc += `## Output Schema\n\n`;
    doc += '```json\n';
    doc += JSON.stringify(component.outputSchema, null, 2);
    doc += '\n```\n\n';
  }

  if (component.requiredEnv) {
    doc += `## Required Environment Variables\n\n`;
    for (const env of component.requiredEnv) {
      doc += `- \`${env}\`\n`;
    }
    doc += '\n';
  }

  if (component.examples) {
    doc += `## Examples\n\n`;
    for (const example of component.examples) {
      doc += `### ${example.name}\n\n`;
      if (example.description) {
        doc += `${example.description}\n\n`;
      }
      doc += '```yaml\n';
      doc += `input:\n${JSON.stringify(example.input, null, 2).split('\n').map(l => '  ' + l).join('\n')}\n`;
      doc += '```\n\n';
    }
  }

  return doc;
}
