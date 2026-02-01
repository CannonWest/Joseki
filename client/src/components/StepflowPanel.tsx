/**
 * Stepflow Integration Panel
 * 
 * Provides UI for:
 * - Exporting workflows to Stepflow YAML/JSON
 * - Importing Stepflow workflows
 * - Validating workflows
 * - Running with Stepflow CLI
 */

import { useState, useEffect, useCallback } from 'react';
import { useWorkflowStore } from '../stores/workflowStore';
import type { Workflow, WorkflowEdge } from '@maestroai/shared';

// Inline Stepflow conversion utilities to avoid build issues
// These are simplified versions from shared/src/stepflow.ts

interface StepflowWorkflow {
  schema: 'https://stepflow.org/schemas/v1/flow.json';
  name: string;
  description?: string;
  steps: any[];
}

function convertToStepflow(workflow: Workflow): StepflowWorkflow {
  const steps: any[] = [];
  
  for (const node of workflow.nodes) {
    const config = node.data.config as Record<string, any>;
    let step: any = { id: sanitizeId(node.id), input: {} };
    
    switch (node.type) {
      case 'input':
        step.component = '/builtin/input';
        step.input = { input_type: config.inputType || 'text' };
        break;
      case 'output':
        step.component = '/builtin/output';
        break;
      case 'prompt':
        step.component = '/builtin/openai';
        step.input = {
          model: config.model || 'gpt-4',
          messages: [
            ...(config.systemPrompt ? [{ role: 'system', content: config.systemPrompt }] : []),
            { role: 'user', content: config.userPrompt || '{{input}}' }
          ],
          temperature: config.temperature ?? 0.7,
          max_tokens: config.maxTokens ?? 2048
        };
        break;
      case 'branch':
        step.component = '/builtin/conditional';
        step.input = { condition: config.condition || 'true' };
        break;
      case 'aggregate':
        step.component = '/builtin/aggregate';
        step.input = { strategy: config.strategy || 'concat' };
        break;
      case 'human_gate':
        step.component = '/builtin/pause';
        step.input = { instructions: config.instructions || 'Please review' };
        break;
      default:
        step.component = '/builtin/noop';
    }
    
    steps.push(step);
  }
  
  return {
    schema: 'https://stepflow.org/schemas/v1/flow.json',
    name: workflow.name,
    description: `Generated from MaestroAI: ${workflow.name}`,
    steps
  };
}

function toStepflowYAML(workflow: Workflow): string {
  const stepflow = convertToStepflow(workflow);
  
  let yaml = `# Stepflow Workflow\n`;
  yaml += `schema: ${stepflow.schema}\n`;
  yaml += `name: "${stepflow.name}"\n\n`;
  yaml += `steps:\n`;
  
  for (const step of stepflow.steps) {
    yaml += `  - id: ${step.id}\n`;
    yaml += `    component: ${step.component}\n`;
    yaml += `    input:\n`;
    for (const [key, value] of Object.entries(step.input)) {
      if (Array.isArray(value)) {
        yaml += `      ${key}:\n`;
        for (const item of value) {
          if (typeof item === 'object') {
            yaml += `        - role: ${(item as any).role}\n`;
            yaml += `          content: "${(item as any).content}"\n`;
          }
        }
      } else {
        yaml += `      ${key}: ${JSON.stringify(value)}\n`;
      }
    }
    yaml += `\n`;
  }
  
  return yaml;
}

function validateForStepflow(workflow: Workflow): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Check for circular dependencies
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  
  function hasCycle(nodeId: string, edges: WorkflowEdge[]): boolean {
    visited.add(nodeId);
    recursionStack.add(nodeId);
    
    const outgoingEdges = edges.filter(e => e.source === nodeId);
    for (const edge of outgoingEdges) {
      if (!visited.has(edge.target)) {
        if (hasCycle(edge.target, edges)) return true;
      } else if (recursionStack.has(edge.target)) {
        return true;
      }
    }
    
    recursionStack.delete(nodeId);
    return false;
  }
  
  for (const node of workflow.nodes) {
    if (!visited.has(node.id)) {
      if (hasCycle(node.id, workflow.edges)) {
        errors.push(`Circular dependency detected involving node: ${node.id}`);
        break;
      }
    }
  }
  
  // Check prompt nodes have models
  for (const node of workflow.nodes) {
    if (node.type === 'prompt') {
      const config = node.data.config as any;
      if (!config.model) {
        errors.push(`Node ${node.id}: Prompt node missing model`);
      }
    }
  }
  
  return { valid: errors.length === 0, errors };
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[0-9]/, '_$&');
}

interface StepflowStatus {
  available: boolean;
  version: string | null;
  installCommand: string;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  canRunWithStepflow: boolean;
}

interface PreviewResult {
  workflow: any;
  yaml: string;
  validation: ValidationResult;
  canRunWithStepflow: boolean;
}

export function StepflowPanel({ onClose }: { onClose: () => void }) {
  const { currentWorkflow } = useWorkflowStore();
  const [activeTab, setActiveTab] = useState<'export' | 'import' | 'validate' | 'run'>('export');
  const [status, setStatus] = useState<StepflowStatus | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [yamlInput, setYamlInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<any>(null);
  const [isSaved, setIsSaved] = useState<boolean | null>(null);

  // Fetch Stepflow CLI status and check if workflow is saved on mount
  useEffect(() => {
    fetch('/api/stepflow/status')
      .then(res => res.json())
      .then(setStatus)
      .catch(console.error);
    
    // Check if current workflow is saved
    if (currentWorkflow) {
      fetch(`/api/workflows/${currentWorkflow.id}`)
        .then(res => setIsSaved(res.ok))
        .catch(() => setIsSaved(false));
    }
  }, [currentWorkflow]);

  // Validate workflow when tab changes or workflow updates
  useEffect(() => {
    if (currentWorkflow && (activeTab === 'validate' || activeTab === 'run')) {
      validateWorkflow();
    }
  }, [currentWorkflow, activeTab]);

  // Load preview when export tab is selected
  useEffect(() => {
    if (currentWorkflow && activeTab === 'export') {
      loadPreview();
    }
  }, [currentWorkflow, activeTab]);

  const validateWorkflow = useCallback(async () => {
    if (!currentWorkflow) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      // Check if workflow is saved
      const checkRes = await fetch(`/api/workflows/${currentWorkflow.id}`);
      
      if (!checkRes.ok) {
        // Client-side validation for unsaved workflows
        const result = validateForStepflow(currentWorkflow);
        setValidation({
          valid: result.valid,
          errors: result.errors,
          canRunWithStepflow: false
        });
        setIsLoading(false);
        return;
      }
      
      // Server-side validation for saved workflows
      const res = await fetch(`/api/workflows/${currentWorkflow.id}/stepflow/validate`, {
        method: 'POST'
      });
      const data = await res.json();
      setValidation(data);
    } catch (err) {
      // Fallback to client-side validation
      try {
        const result = validateForStepflow(currentWorkflow);
        setValidation({
          valid: result.valid,
          errors: result.errors,
          canRunWithStepflow: false
        });
      } catch {
        setError(err instanceof Error ? err.message : 'Validation failed');
      }
    } finally {
      setIsLoading(false);
    }
  }, [currentWorkflow]);

  const loadPreview = useCallback(async () => {
    if (!currentWorkflow) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      // First, check if workflow exists in database
      const checkRes = await fetch(`/api/workflows/${currentWorkflow.id}`);
      
      if (!checkRes.ok) {
        // Workflow not saved yet - generate preview client-side
        const stepflow = convertToStepflow(currentWorkflow);
        const yaml = toStepflowYAML(currentWorkflow);
        const validation = validateForStepflow(currentWorkflow);
        
        setPreview({
          workflow: stepflow,
          yaml,
          validation: {
            valid: validation.valid,
            errors: validation.errors,
            canRunWithStepflow: false // Can't run unsaved workflows
          },
          canRunWithStepflow: false
        });
        setIsLoading(false);
        return;
      }
      
      // Workflow exists - fetch from server
      const res = await fetch(`/api/workflows/${currentWorkflow.id}/stepflow/preview`);
      const data = await res.json();
      
      if (res.ok) {
        setPreview(data);
      } else {
        setError(data.error || 'Failed to load preview');
      }
    } catch (err) {
      // Fallback to client-side generation on error
      try {
        const stepflow = convertToStepflow(currentWorkflow);
        const yaml = toStepflowYAML(currentWorkflow);
        const validation = validateForStepflow(currentWorkflow);
        
        setPreview({
          workflow: stepflow,
          yaml,
          validation: {
            valid: validation.valid,
            errors: validation.errors,
            canRunWithStepflow: false
          },
          canRunWithStepflow: false
        });
      } catch (fallbackErr) {
        setError(err instanceof Error ? err.message : 'Preview failed');
      }
    } finally {
      setIsLoading(false);
    }
  }, [currentWorkflow]);

  const handleExportYAML = async () => {
    if (!currentWorkflow) return;
    
    // Check if workflow is saved
    const checkRes = await fetch(`/api/workflows/${currentWorkflow.id}`);
    
    if (!checkRes.ok) {
      // Client-side generation for unsaved workflows
      const yaml = toStepflowYAML(currentWorkflow);
      downloadClientSide(yaml, `${currentWorkflow.name.replace(/\s+/g, '_')}.yaml`, 'text/yaml');
      setSuccess('YAML downloaded! (Workflow not saved to database)');
      return;
    }
    
    window.open(`/api/workflows/${currentWorkflow.id}/stepflow/yaml`, '_blank');
  };

  const handleExportJSON = async () => {
    if (!currentWorkflow) return;
    
    // Check if workflow is saved
    const checkRes = await fetch(`/api/workflows/${currentWorkflow.id}`);
    
    if (!checkRes.ok) {
      // Client-side generation for unsaved workflows
      const stepflow = convertToStepflow(currentWorkflow);
      const json = JSON.stringify(stepflow, null, 2);
      downloadClientSide(json, `${currentWorkflow.name.replace(/\s+/g, '_')}.json`, 'application/json');
      setSuccess('JSON downloaded! (Workflow not saved to database)');
      return;
    }
    
    window.open(`/api/workflows/${currentWorkflow.id}/stepflow/json`, '_blank');
  };
  
  const saveAndExport = async (format: 'yaml' | 'json' = 'yaml') => {
    if (!currentWorkflow) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      // Save the workflow
      const saveRes = await fetch('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentWorkflow)
      });
      
      if (!saveRes.ok) {
        throw new Error('Failed to save workflow');
      }
      
      const saved = await saveRes.json();
      setIsSaved(true);
      
      // Update the current workflow with saved ID
      useWorkflowStore.getState().setCurrentWorkflow(saved);
      
      // Refresh workflows list
      await useWorkflowStore.getState().loadWorkflows();
      
      // Now export
      window.open(`/api/workflows/${saved.id}/stepflow/${format}`, '_blank');
      
      setSuccess('Workflow saved and exported!');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save and export failed');
    } finally {
      setIsLoading(false);
    }
  };
  
  // Client-side download for unsaved workflows
  const downloadClientSide = (content: string, filename: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImportYAML = async () => {
    if (!yamlInput.trim()) {
      setError('Please paste YAML content');
      return;
    }
    
    setIsLoading(true);
    setError(null);
    setSuccess(null);
    
    try {
      const res = await fetch('/api/stepflow/import-yaml', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: yamlInput })
      });
      
      const data = await res.json();
      
      if (res.ok) {
        setSuccess(`Imported workflow: ${data.name}`);
        setYamlInput('');
        // Refresh workflows list
        useWorkflowStore.getState().loadWorkflows();
      } else {
        setError(data.error || data.message || 'Import failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRunWithStepflow = async () => {
    if (!currentWorkflow) return;
    
    setIsLoading(true);
    setError(null);
    setRunResult(null);
    
    try {
      const res = await fetch(`/api/workflows/${currentWorkflow.id}/stepflow/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: {} })
      });
      
      const data = await res.json();
      
      if (res.ok) {
        setRunResult(data);
      } else {
        setError(data.error || data.message || 'Execution failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Execution failed');
    } finally {
      setIsLoading(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setSuccess('Copied to clipboard!');
    setTimeout(() => setSuccess(null), 2000);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-slate-900 border border-slate-700 rounded-lg w-[800px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-700">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-500/20 rounded-lg flex items-center justify-center">
              <span className="text-blue-400 text-lg">⚡</span>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">Stepflow Integration</h2>
              <p className="text-xs text-slate-400">
                {status?.available 
                  ? `Stepflow CLI ${status.version} available` 
                  : 'Stepflow CLI not installed'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-700">
          {(['export', 'import', 'validate', 'run'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === tab
                  ? 'text-blue-400 border-b-2 border-blue-400 bg-blue-500/10'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800'
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {error && (
            <div className="mb-4 p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-400 text-sm">
              {error}
            </div>
          )}
          
          {success && (
            <div className="mb-4 p-3 bg-green-500/20 border border-green-500/50 rounded-lg text-green-400 text-sm">
              {success}
            </div>
          )}

          {/* Export Tab */}
          {activeTab === 'export' && (
            <div className="space-y-4">
              {isSaved === false && (
                <div className="p-3 bg-amber-500/20 border border-amber-500/50 rounded-lg">
                  <p className="text-sm text-amber-400 font-medium mb-1">⚠️ Workflow Not Saved</p>
                  <p className="text-xs text-amber-400/80">
                    This workflow exists only in memory. Click "Download" to save and export, 
                    or use "Copy YAML" to copy the preview without saving.
                  </p>
                </div>
              )}
              
              <div className="flex gap-3">
                <button
                  onClick={handleExportYAML}
                  disabled={!currentWorkflow || isLoading}
                  className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
                >
                  Download YAML
                </button>
                <button
                  onClick={handleExportJSON}
                  disabled={!currentWorkflow || isLoading}
                  className="flex-1 px-4 py-2 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
                >
                  Download JSON
                </button>
              </div>

              {preview && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-slate-300">Preview</h3>
                    <button
                      onClick={() => copyToClipboard(preview.yaml)}
                      className="text-xs text-blue-400 hover:text-blue-300"
                    >
                      Copy YAML
                    </button>
                  </div>
                  
                  {!preview.validation.valid && (
                    <div className="p-3 bg-yellow-500/20 border border-yellow-500/50 rounded-lg">
                      <p className="text-sm text-yellow-400 font-medium mb-1">Validation Warnings:</p>
                      <ul className="text-xs text-yellow-400/80 space-y-1">
                        {preview.validation.errors.map((err, i) => (
                          <li key={i}>• {err}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  
                  <pre className="p-3 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-300 overflow-auto max-h-[400px]">
                    {preview.yaml}
                  </pre>
                </div>
              )}
              
              {isLoading && (
                <div className="text-center py-8 text-slate-400">
                  <div className="animate-spin inline-block w-6 h-6 border-2 border-slate-600 border-t-blue-500 rounded-full mb-2" />
                  <p className="text-sm">
                    {isSaved === false ? 'Saving and exporting...' : 'Loading preview...'}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Import Tab */}
          {activeTab === 'import' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  Paste Stepflow YAML
                </label>
                <textarea
                  value={yamlInput}
                  onChange={(e) => setYamlInput(e.target.value)}
                  placeholder={`schema: https://stepflow.org/schemas/v1/flow.json
name: My Workflow
steps:
  - id: step_1
    component: /builtin/openai
    input:
      model: gpt-4
      messages:
        - role: user
          content: Hello`}
                  className="w-full h-64 p-3 bg-slate-950 border border-slate-700 rounded-lg text-sm text-slate-300 font-mono resize-none focus:outline-none focus:border-blue-500"
                />
              </div>
              
              <button
                onClick={handleImportYAML}
                disabled={!yamlInput.trim() || isLoading}
                className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
              >
                {isLoading ? 'Importing...' : 'Import Workflow'}
              </button>
              
              <div className="p-3 bg-slate-800/50 rounded-lg">
                <p className="text-xs text-slate-400">
                  <strong className="text-slate-300">Note:</strong> Importing will create a new workflow in your library. 
                  Make sure the YAML follows the Stepflow schema format.
                </p>
              </div>
            </div>
          )}

          {/* Validate Tab */}
          {activeTab === 'validate' && (
            <div className="space-y-4">
              {validation && (
                <>
                  <div className={`p-4 rounded-lg ${
                    validation.valid 
                      ? 'bg-green-500/20 border border-green-500/50' 
                      : 'bg-red-500/20 border border-red-500/50'
                  }`}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`text-lg ${validation.valid ? 'text-green-400' : 'text-red-400'}`}>
                        {validation.valid ? '✓' : '✗'}
                      </span>
                      <span className={`font-medium ${validation.valid ? 'text-green-400' : 'text-red-400'}`}>
                        {validation.valid ? 'Workflow is valid' : 'Validation failed'}
                      </span>
                    </div>
                    
                    {!validation.valid && validation.errors.length > 0 && (
                      <ul className="text-sm text-red-400 space-y-1 ml-6">
                        {validation.errors.map((err, i) => (
                          <li key={i}>• {err}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                  
                  {validation.canRunWithStepflow && (
                    <div className="p-3 bg-blue-500/20 border border-blue-500/50 rounded-lg">
                      <p className="text-sm text-blue-400">
                        ✓ This workflow can be executed with Stepflow CLI
                      </p>
                    </div>
                  )}
                </>
              )}
              
              {isLoading && (
                <div className="text-center py-8">
                  <div className="animate-spin inline-block w-6 h-6 border-2 border-slate-600 border-t-blue-500 rounded-full" />
                </div>
              )}
              
              <button
                onClick={validateWorkflow}
                disabled={!currentWorkflow || isLoading}
                className="w-full px-4 py-2 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
              >
                Re-validate
              </button>
            </div>
          )}

          {/* Run Tab */}
          {activeTab === 'run' && (
            <div className="space-y-4">
              {isSaved === false && (
                <div className="p-4 bg-amber-500/20 border border-amber-500/50 rounded-lg">
                  <p className="text-sm text-amber-400 font-medium mb-1">⚠️ Workflow Not Saved</p>
                  <p className="text-xs text-amber-400/80">
                    You must save the workflow before running it with Stepflow CLI.
                    Go to the Export tab to save and export.
                  </p>
                </div>
              )}
              
              {!status?.available && (
                <div className="p-4 bg-blue-500/20 border border-blue-500/50 rounded-lg">
                  <p className="text-sm text-blue-400 font-medium mb-1">ℹ️ Stepflow CLI Not Installed</p>
                  <p className="text-xs text-blue-400/80 mb-2">
                    Stepflow CLI is optional. You can still export workflows and run them manually. 
                    To run directly from this UI, install the CLI:
                  </p>
                  <code className="block p-2 bg-slate-950 rounded text-xs text-slate-300 font-mono">
                    cargo install stepflow
                  </code>
                  <p className="text-xs text-blue-400/60 mt-2">
                    Requires Rust toolchain: <a href="https://rustup.rs" target="_blank" rel="noopener noreferrer" className="underline">rustup.rs</a>
                  </p>
                </div>
              )}
              
              {validation && !validation.valid && (
                <div className="p-4 bg-red-500/20 border border-red-500/50 rounded-lg">
                  <p className="text-sm text-red-400 font-medium">
                    Please fix validation errors before running
                  </p>
                </div>
              )}
              
              <button
                onClick={handleRunWithStepflow}
                disabled={!currentWorkflow || !status?.available || !validation?.valid || isLoading || isSaved === false}
                className="w-full px-4 py-3 bg-green-600 hover:bg-green-500 disabled:bg-slate-700 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <>
                    <div className="animate-spin w-4 h-4 border-2 border-white/30 border-t-white rounded-full" />
                    Running with Stepflow...
                  </>
                ) : (
                  <>
                    <span>▶</span>
                    Run with Stepflow
                  </>
                )}
              </button>
              
              {runResult && (
                <div className="mt-4">
                  <h3 className="text-sm font-medium text-slate-300 mb-2">Execution Result</h3>
                  <div className={`p-3 rounded-lg ${
                    runResult.status === 'success' 
                      ? 'bg-green-500/10 border border-green-500/30' 
                      : 'bg-red-500/10 border border-red-500/30'
                  }`}>
                    <p className="text-xs text-slate-400 mb-1">Execution ID: {runResult.executionId}</p>
                    <pre className="text-xs text-slate-300 overflow-auto max-h-[200px]">
                      {JSON.stringify(runResult.result || runResult, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-700 bg-slate-900/50">
          <p className="text-xs text-slate-500 text-center">
            MaestroAI generates workflows compatible with{' '}
            <a 
              href="https://stepflow.org" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-blue-400 hover:underline"
            >
              Stepflow
            </a>
            {' '}— an open protocol for GenAI workflows
          </p>
        </div>
      </div>
    </div>
  );
}
