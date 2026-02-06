import { useState, useMemo } from 'react';
import type { Node, Edge } from 'reactflow';
import Editor from '@monaco-editor/react';

interface NodeConfigPanelProps {
  node: Node;
  nodes: Node[];
  edges: Edge[];
  onClose: () => void;
  onUpdate: (updates: any) => void;
  onDeleteEdge: (edgeId: string) => void;
}

type TabType = 'config' | 'connections';

interface InputReference {
  nodeId: string;
  nodeLabel: string;
  nodeType: string;
  varName: string;
  description: string;
}

const typeIcons: Record<string, string> = {
  prompt: '🤖',
  branch: '↔',
  aggregate: '∑',
  human_gate: '👤',
  model_compare: '⚖',
  input: '📝',
  output: '✓'
};

export function NodeConfigPanel({ node, nodes, edges, onClose, onUpdate, onDeleteEdge }: NodeConfigPanelProps) {
  const [config, setConfig] = useState(node.data.config || {});
  const [label, setLabel] = useState(node.data.label);
  const [activeTab, setActiveTab] = useState<TabType>('config');

  const handleSave = () => {
    onUpdate({ label, config });
  };

  // Get all edges connected to this node
  const incomingEdges = edges.filter(e => e.target === node.id);
  const outgoingEdges = edges.filter(e => e.source === node.id);

  // Helper to get node label by id
  const getNodeLabel = (nodeId: string) => {
    const n = nodes.find(n => n.id === nodeId);
    return n?.data?.label || n?.id || nodeId;
  };

  // Helper to get node type icon
  const getNodeTypeIcon = (nodeId: string) => {
    const n = nodes.find(n => n.id === nodeId);
    return typeIcons[n?.type as string] || '●';
  };

  // Get available input references for Prompt nodes
  const getAvailableInputs = useMemo(() => {
    if (node.type !== 'prompt') return [];
    
    const inputs: InputReference[] = [];
    
    // Find all nodes that connect to this prompt node
    const sourceEdges = edges.filter(e => e.target === node.id);
    
    sourceEdges.forEach(edge => {
      const sourceNode = nodes.find(n => n.id === edge.source);
      if (!sourceNode) return;
      
      // Generate variable names based on source node type
      let varName = '';
      let description = '';
      
      switch (sourceNode.type) {
        case 'input':
          const inputType = sourceNode.data?.config?.inputType || 'text';
          varName = `nodes.${sourceNode.id}.output`;
          description = `Input (${inputType}): ${sourceNode.data?.label}`;
          break;
        case 'prompt':
          varName = `nodes.${sourceNode.id}.output`;
          description = `AI Response: ${sourceNode.data?.label}`;
          break;
        case 'branch':
          varName = `nodes.${sourceNode.id}.output`;
          description = `Branch Result: ${sourceNode.data?.label}`;
          break;
        case 'aggregate':
          varName = `nodes.${sourceNode.id}.output`;
          description = `Aggregated Output: ${sourceNode.data?.label}`;
          break;
        case 'human_gate':
          varName = `nodes.${sourceNode.id}.output`;
          description = `Approved Content: ${sourceNode.data?.label}`;
          break;
        default:
          varName = `nodes.${sourceNode.id}.output`;
          description = `${sourceNode.data?.label || sourceNode.id}`;
      }
      
      inputs.push({
        nodeId: sourceNode.id,
        nodeLabel: sourceNode.data?.label || sourceNode.id,
        nodeType: sourceNode.type || 'unknown',
        varName,
        description
      });
    });
    
    return inputs;
  }, [node, nodes, edges]);

  const insertInputReference = (varName: string) => {
    const currentPrompt = config.userPrompt || '';
    const templateVar = `{{${varName}}}`;
    setConfig({ ...config, userPrompt: currentPrompt + (currentPrompt ? ' ' : '') + templateVar });
  };

  const renderConfigFields = () => {
    switch (node.type) {
      case 'prompt':
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                Model
              </label>
              <select
                value={config.model || 'gpt-4'}
                onChange={(e) => setConfig({ ...config, model: e.target.value })}
                className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200"
              >
                <option value="gpt-4">GPT-4</option>
                <option value="gpt-4-turbo">GPT-4 Turbo</option>
                <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
                <option value="claude-3-opus">Claude 3 Opus</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                Temperature: {config.temperature || 0.7}
              </label>
              <input
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={config.temperature || 0.7}
                onChange={(e) => setConfig({ ...config, temperature: parseFloat(e.target.value) })}
                className="w-full"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                Max Tokens
              </label>
              <input
                type="number"
                value={config.maxTokens || 2048}
                onChange={(e) => setConfig({ ...config, maxTokens: parseInt(e.target.value) })}
                className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200"
              />
            </div>

            {/* Error Handling */}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                On Error
              </label>
              <select
                value={config.onError?.strategy || 'fail'}
                onChange={(e) => setConfig({
                  ...config,
                  onError: { ...config.onError, strategy: e.target.value }
                })}
                className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200"
              >
                <option value="fail">Fail (stop workflow)</option>
                <option value="retry">Retry (with backoff)</option>
                <option value="default">Default (use fallback value)</option>
              </select>
            </div>

            {config.onError?.strategy === 'retry' && (
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  Max Retry Attempts
                </label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={config.onError?.maxAttempts || 3}
                  onChange={(e) => setConfig({
                    ...config,
                    onError: { ...config.onError, maxAttempts: parseInt(e.target.value) }
                  })}
                  className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200"
                />
              </div>
            )}

            {/* Available Inputs Section */}
            {getAvailableInputs.length > 0 && (
              <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-3">
                <label className="block text-xs font-medium text-slate-400 mb-2">
                  Available Inputs — Click to insert
                </label>
                <div className="space-y-1.5 max-h-32 overflow-y-auto">
                  {getAvailableInputs.map((input) => (
                    <button
                      key={input.nodeId}
                      onClick={() => insertInputReference(input.varName)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs bg-slate-700/50 hover:bg-slate-700 rounded transition-colors group"
                      title={`Insert {{${input.varName}}}`}
                    >
                      <span>{typeIcons[input.nodeType] || '●'}</span>
                      <span className="text-slate-300 truncate flex-1">{input.description}</span>
                      <span className="text-slate-500 font-mono text-[10px] opacity-0 group-hover:opacity-100 transition-opacity">
                        +insert
                      </span>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-slate-500 mt-2">
                  Use {'{{nodes.node_id.output}}'}) to reference any connected node's output
                </p>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                System Prompt
              </label>
              <div className="h-32 border border-slate-700 rounded overflow-hidden">
                <Editor
                  height="100%"
                  defaultLanguage="plaintext"
                  value={config.systemPrompt || ''}
                  onChange={(v) => setConfig({ ...config, systemPrompt: v })}
                  theme="vs-dark"
                  options={{
                    minimap: { enabled: false },
                    lineNumbers: 'off',
                    scrollBeyondLastLine: false,
                    fontSize: 12
                  }}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                User Prompt (Handlebars syntax: {'{{input}}'})
              </label>
              <div className="h-32 border border-slate-700 rounded overflow-hidden">
                <Editor
                  height="100%"
                  defaultLanguage="plaintext"
                  value={config.userPrompt || ''}
                  onChange={(v) => setConfig({ ...config, userPrompt: v })}
                  theme="vs-dark"
                  options={{
                    minimap: { enabled: false },
                    lineNumbers: 'off',
                    scrollBeyondLastLine: false,
                    fontSize: 12
                  }}
                />
              </div>
            </div>
          </div>
        );

      case 'branch':
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                Condition Expression
              </label>
              <div className="h-40 border border-slate-700 rounded overflow-hidden">
                <Editor
                  height="100%"
                  defaultLanguage="plaintext"
                  value={config.condition || 'input == "yes"'}
                  onChange={(v) => setConfig({ ...config, condition: v })}
                  theme="vs-dark"
                  options={{
                    minimap: { enabled: false },
                    lineNumbers: 'on',
                    scrollBeyondLastLine: false,
                    fontSize: 12
                  }}
                />
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Safe expressions only. Available variables: upstream node IDs
                and <code className="text-slate-400">input</code>.
                Examples: <code className="text-slate-400">input == "yes"</code>,
                <code className="text-slate-400"> score {'>'} 0.5</code>
              </p>
            </div>
          </div>
        );

      case 'aggregate':
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                Aggregation Strategy
              </label>
              <select
                value={config.strategy || 'concat'}
                onChange={(e) => setConfig({ ...config, strategy: e.target.value })}
                className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200"
              >
                <option value="concat">Concatenate</option>
                <option value="vote">Voting</option>
                <option value="merge">Merge</option>
              </select>
              <p className="text-xs text-slate-500 mt-1">
                How to combine multiple inputs
              </p>
            </div>
          </div>
        );

      case 'human_gate':
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                Approval Prompt
              </label>
              <div className="h-32 border border-slate-700 rounded overflow-hidden">
                <Editor
                  height="100%"
                  defaultLanguage="plaintext"
                  value={config.approvalPrompt || 'Please review and approve to continue.'}
                  onChange={(v) => setConfig({ ...config, approvalPrompt: v })}
                  theme="vs-dark"
                  options={{
                    minimap: { enabled: false },
                    lineNumbers: 'off',
                    scrollBeyondLastLine: false,
                    fontSize: 12
                  }}
                />
              </div>
            </div>
          </div>
        );

      case 'model_compare':
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                Models to Compare (comma-separated)
              </label>
              <input
                type="text"
                value={config.models || 'gpt-4,gpt-3.5-turbo'}
                onChange={(e) => setConfig({ ...config, models: e.target.value })}
                className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200"
                placeholder="gpt-4,gpt-3.5-turbo,claude-3-opus"
              />
            </div>
          </div>
        );

      case 'input':
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                Input Type
              </label>
              <select
                value={config.inputType || 'text'}
                onChange={(e) => setConfig({ ...config, inputType: e.target.value })}
                className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200"
              >
                <option value="text">📝 Text — Plain text input</option>
                <option value="number">🔢 Number — Numeric value</option>
                <option value="boolean">☑️ Boolean — True/False</option>
                <option value="json">📋 JSON — Structured data</option>
                <option value="chat">💬 Chat — Conversation history</option>
              </select>
              <p className="text-xs text-slate-500 mt-1">
                Determines how downstream nodes receive this input
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                Default Value
              </label>
              {config.inputType === 'boolean' ? (
                <select
                  value={config.defaultValue === true ? 'true' : config.defaultValue === false ? 'false' : ''}
                  onChange={(e) => setConfig({ ...config, defaultValue: e.target.value === 'true' })}
                  className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200"
                >
                  <option value="">No default</option>
                  <option value="true">True</option>
                  <option value="false">False</option>
                </select>
              ) : config.inputType === 'json' ? (
                <div className="h-32 border border-slate-700 rounded overflow-hidden">
                  <Editor
                    height="100%"
                    defaultLanguage="json"
                    value={config.defaultValue ? JSON.stringify(config.defaultValue, null, 2) : ''}
                    onChange={(v) => {
                      try {
                        const parsed = v ? JSON.parse(v) : null;
                        setConfig({ ...config, defaultValue: parsed });
                      } catch {
                        // Allow invalid JSON while typing
                        setConfig({ ...config, defaultValue: v });
                      }
                    }}
                    theme="vs-dark"
                    options={{
                      minimap: { enabled: false },
                      lineNumbers: 'off',
                      scrollBeyondLastLine: false,
                      fontSize: 12
                    }}
                  />
                </div>
              ) : (
                <textarea
                  value={config.defaultValue || ''}
                  onChange={(e) => setConfig({ ...config, defaultValue: e.target.value })}
                  placeholder={config.inputType === 'chat' ? '[{"role": "user", "content": "Hello"}]' : 'Enter default value...'}
                  className="w-full h-20 bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200 resize-none"
                />
              )}
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="required"
                checked={config.required || false}
                onChange={(e) => setConfig({ ...config, required: e.target.checked })}
                className="w-4 h-4 rounded border-slate-700 bg-slate-800 text-blue-600"
              />
              <label htmlFor="required" className="text-sm text-slate-300">
                Required input
              </label>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                Description
              </label>
              <input
                type="text"
                value={config.description || ''}
                onChange={(e) => setConfig({ ...config, description: e.target.value })}
                placeholder="Describe what this input is used for..."
                className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200"
              />
            </div>

            {/* Usage Hint */}
            <div className="bg-slate-800/50 border border-slate-700 rounded p-3">
              <p className="text-xs text-slate-400">
                <span className="text-slate-300">How to use:</span> Connect this Input to a Prompt node. In the Prompt's User Prompt, reference this input with:
              </p>
              <code className="block mt-1 text-xs font-mono text-blue-400 bg-slate-900 rounded px-2 py-1">
                {'{{nodes.'}{node.id}{'.output}}'}
              </code>
            </div>
          </div>
        );

      default:
        return (
          <div className="text-slate-500 text-sm">
            No configuration available for this node type.
          </div>
        );
    }
  };

  const renderConnectionsTab = () => {
    return (
      <div className="space-y-6">
        {/* Incoming Connections */}
        <div>
          <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
            <span className="w-2 h-2 bg-emerald-500 rounded-full" />
            Incoming ({incomingEdges.length})
          </h4>
          {incomingEdges.length === 0 ? (
            <div className="text-sm text-slate-600 italic">
              No incoming connections
            </div>
          ) : (
            <div className="space-y-2">
              {incomingEdges.map((edge) => (
                <div 
                  key={edge.id}
                  className="flex items-center justify-between bg-slate-800/50 border border-slate-700/50 rounded px-3 py-2 group hover:border-slate-600"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm">{getNodeTypeIcon(edge.source)}</span>
                    <span className="text-sm text-slate-300 truncate">
                      {getNodeLabel(edge.source)}
                    </span>
                    {edge.sourceHandle && (
                      <span className="text-xs text-slate-500">
                        ({edge.sourceHandle})
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => onDeleteEdge(edge.id)}
                    className="opacity-0 group-hover:opacity-100 text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-red-500/10 transition-all"
                    title="Delete connection"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Outgoing Connections */}
        <div>
          <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
            <span className="w-2 h-2 bg-blue-500 rounded-full" />
            Outgoing ({outgoingEdges.length})
          </h4>
          {outgoingEdges.length === 0 ? (
            <div className="text-sm text-slate-600 italic">
              No outgoing connections
            </div>
          ) : (
            <div className="space-y-2">
              {outgoingEdges.map((edge) => (
                <div 
                  key={edge.id}
                  className="flex items-center justify-between bg-slate-800/50 border border-slate-700/50 rounded px-3 py-2 group hover:border-slate-600"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm">{getNodeTypeIcon(edge.target)}</span>
                    <span className="text-sm text-slate-300 truncate">
                      {getNodeLabel(edge.target)}
                    </span>
                    {edge.targetHandle && (
                      <span className="text-xs text-slate-500">
                        ({edge.targetHandle})
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => onDeleteEdge(edge.id)}
                    className="opacity-0 group-hover:opacity-100 text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-red-500/10 transition-all"
                    title="Delete connection"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Connection Tips */}
        <div className="pt-4 border-t border-slate-800">
          <p className="text-xs text-slate-500">
            <span className="text-slate-400">Tip:</span> You can also click on any connection line on the canvas to select and delete it.
          </p>
        </div>
      </div>
    );
  };

  return (
    <div 
      className="w-96 h-full bg-slate-900 border-l border-slate-800 flex flex-col overflow-hidden"
      onKeyDown={(e) => {
        // Prevent spacebar and other keys from bubbling to React Flow's canvas pan handlers
        e.stopPropagation();
      }}
    >
      <div className="h-12 border-b border-slate-800 flex items-center justify-between px-4">
        <h3 className="font-semibold text-slate-200">Node Configuration</h3>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-white transition-colors"
        >
          ✕
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-800">
        <button
          onClick={() => setActiveTab('config')}
          className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'config'
              ? 'text-blue-400 border-b-2 border-blue-400 bg-slate-800/50'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/30'
          }`}
        >
          Configuration
        </button>
        <button
          onClick={() => setActiveTab('connections')}
          className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'connections'
              ? 'text-blue-400 border-b-2 border-blue-400 bg-slate-800/50'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/30'
          }`}
        >
          Connections
          {incomingEdges.length + outgoingEdges.length > 0 && (
            <span className="ml-2 text-xs bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded-full">
              {incomingEdges.length + outgoingEdges.length}
            </span>
          )}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {/* Node Info - Always visible */}
        <div className="mb-4">
          <label className="block text-xs font-medium text-slate-400 mb-1">
            Label
          </label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200"
          />
        </div>

        <div className="text-xs text-slate-500 mb-4">
          Type: <span className="text-slate-300 capitalize">{node.type}</span>
          <br />
          ID: <span className="text-slate-300 font-mono">{node.id}</span>
        </div>

        {/* Tab Content */}
        {activeTab === 'config' ? renderConfigFields() : renderConnectionsTab()}
      </div>

      <div className="h-16 border-t border-slate-800 flex items-center justify-end px-4 gap-2">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded transition-colors"
        >
          Save Changes
        </button>
      </div>
    </div>
  );
}
