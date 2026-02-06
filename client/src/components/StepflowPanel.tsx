/**
 * Stepflow Integration Panel
 * 
 * Provides UI for:
 * - Exporting workflows to Stepflow YAML/JSON/Python format
 * - Generating stepflow-config.yml
 * - Importing Stepflow workflows
 * - Validating workflows
 * - Running with Stepflow CLI
 * - Batch execution schema
 */

import { useState, useEffect, useCallback } from 'react';
import { useWorkflowStore } from '../stores/workflowStore';
import type { Workflow } from '@maestroai/shared';
import {
  convertToStepflow,
  toStepflowYAML,
  toStepflowJSON,
  toFlowBuilderPython,
  generateStepflowConfig,
  generateBatchSchema,
  validateForStepflow,
  type StepflowWorkflow
} from '@maestroai/shared';

interface StepflowStatus {
  available: boolean;
  version: string | null;
  installCommand: string;
  documentation: string;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  canRunWithStepflow: boolean;
}

interface CompatibilityInfo {
  supportedFeatures: string[];
  unsupportedFeatures: string[];
  recommendations: string[];
}

interface PreviewResult {
  workflow: any;
  yaml: string;
  validation: ValidationResult;
  compatibility: CompatibilityInfo;
  canRunWithStepflow: boolean;
}

type ExportFormat = 'yaml' | 'json' | 'python' | 'config';
type ActiveTab = 'export' | 'import' | 'validate' | 'run' | 'batch';

export function StepflowPanel({ onClose }: { onClose: () => void }) {
  const { currentWorkflow } = useWorkflowStore();
  const [activeTab, setActiveTab] = useState<ActiveTab>('export');
  const [status, setStatus] = useState<StepflowStatus | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [yamlInput, setYamlInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<any>(null);
  const [isSaved, setIsSaved] = useState<boolean | null>(null);
  const [batchSchema, setBatchSchema] = useState<any>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('yaml');

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
  
  // Load batch schema when batch tab is selected
  useEffect(() => {
    if (currentWorkflow && activeTab === 'batch') {
      loadBatchSchema();
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
          warnings: result.warnings,
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
      setValidation({
        valid: data.valid,
        errors: data.errors,
        warnings: data.warnings,
        canRunWithStepflow: data.canRunWithStepflow
      });
    } catch (err) {
      // Fallback to client-side validation
      try {
        const result = validateForStepflow(currentWorkflow);
        setValidation({
          valid: result.valid,
          errors: result.errors,
          warnings: result.warnings,
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
            warnings: validation.warnings,
            canRunWithStepflow: false
          },
          compatibility: {
            supportedFeatures: [],
            unsupportedFeatures: [],
            recommendations: []
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
            warnings: validation.warnings,
            canRunWithStepflow: false
          },
          compatibility: {
            supportedFeatures: [],
            unsupportedFeatures: [],
            recommendations: []
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
  
  const loadBatchSchema = useCallback(async () => {
    if (!currentWorkflow) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      const checkRes = await fetch(`/api/workflows/${currentWorkflow.id}`);
      
      if (!checkRes.ok) {
        // Client-side generation
        const schema = generateBatchSchema(currentWorkflow);
        setBatchSchema({
          schema,
          example: [Object.fromEntries(
            currentWorkflow.nodes
              .filter(n => n.type === 'input')
              .map(n => [n.id, 'example_value'])
          )]
        });
        setIsLoading(false);
        return;
      }
      
      const res = await fetch(`/api/workflows/${currentWorkflow.id}/stepflow/batch-schema`);
      const data = await res.json();
      
      if (res.ok) {
        setBatchSchema(data);
      } else {
        setError(data.error || 'Failed to load batch schema');
      }
    } catch (err) {
      // Client-side fallback
      const schema = generateBatchSchema(currentWorkflow);
      setBatchSchema({
        schema,
        example: [Object.fromEntries(
          currentWorkflow.nodes
            .filter(n => n.type === 'input')
            .map(n => [n.id, 'example_value'])
        )]
      });
    } finally {
      setIsLoading(false);
    }
  }, [currentWorkflow]);

  const handleExport = async (format: ExportFormat) => {
    if (!currentWorkflow) return;
    
    // Check if workflow is saved
    const checkRes = await fetch(`/api/workflows/${currentWorkflow.id}`);
    
    if (!checkRes.ok) {
      // Client-side generation for unsaved workflows
      let content: string;
      let filename: string;
      let mimeType: string;
      
      switch (format) {
        case 'yaml':
          content = toStepflowYAML(currentWorkflow);
          filename = `${currentWorkflow.name.replace(/\s+/g, '_')}.yaml`;
          mimeType = 'text/yaml';
          break;
        case 'json':
          content = toStepflowJSON(currentWorkflow);
          filename = `${currentWorkflow.name.replace(/\s+/g, '_')}.json`;
          mimeType = 'application/json';
          break;
        case 'python':
          content = toFlowBuilderPython(currentWorkflow);
          filename = `${currentWorkflow.name.replace(/\s+/g, '_')}_flow.py`;
          mimeType = 'text/x-python';
          break;
        case 'config':
          content = generateStepflowConfig(currentWorkflow);
          filename = 'stepflow-config.yaml';
          mimeType = 'text/yaml';
          break;
      }
      
      downloadClientSide(content, filename, mimeType);
      setSuccess(`${format.toUpperCase()} downloaded! (Workflow not saved to database)`);
      return;
    }
    
    // Server-side export for saved workflows
    let endpoint: string;
    switch (format) {
      case 'yaml':
        endpoint = 'yaml';
        break;
      case 'json':
        endpoint = 'json';
        break;
      case 'python':
        endpoint = 'python';
        break;
      case 'config':
        endpoint = 'config';
        break;
    }
    
    window.open(`/api/workflows/${currentWorkflow.id}/stepflow/${endpoint}`, '_blank');
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
        setSuccess(`Imported workflow: ${data.workflow.name}`);
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

  const getExportPreview = () => {
    if (!currentWorkflow) return '';
    
    try {
      switch (exportFormat) {
        case 'yaml':
          return toStepflowYAML(currentWorkflow);
        case 'json':
          return toStepflowJSON(currentWorkflow);
        case 'python':
          return toFlowBuilderPython(currentWorkflow);
        case 'config':
          return generateStepflowConfig(currentWorkflow);
        default:
          return '';
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-slate-900 border border-slate-700 rounded-lg w-[900px] max-h-[85vh] flex flex-col">
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
          {(['export', 'import', 'validate', 'run', 'batch'] as const).map(tab => (
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
                    This workflow exists only in memory. Downloads will work but use
                    client-side generation. Save to database for server-side features.
                  </p>
                </div>
              )}
              
              {/* Format Selector */}
              <div className="flex gap-2 mb-4">
                {(['yaml', 'json', 'python', 'config'] as ExportFormat[]).map(format => (
                  <button
                    key={format}
                    onClick={() => setExportFormat(format)}
                    className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                      exportFormat === format
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    {format === 'config' ? 'Config' : format.toUpperCase()}
                  </button>
                ))}
              </div>
              
              <div className="flex gap-3">
                <button
                  onClick={() => handleExport(exportFormat)}
                  disabled={!currentWorkflow || isLoading}
                  className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
                >
                  Download {exportFormat === 'config' ? 'Config' : exportFormat.toUpperCase()}
                </button>
              </div>
              
              {/* Format Info */}
              <div className="p-3 bg-slate-800/50 rounded-lg">
                <p className="text-xs text-slate-400">
                  {exportFormat === 'yaml' && (
                    <>
                      <strong className="text-slate-300">YAML:</strong> Standard Stepflow workflow format. 
                      Run with: <code className="text-slate-300">stepflow run --flow=workflow.yaml</code>
                    </>
                  )}
                  {exportFormat === 'json' && (
                    <>
                      <strong className="text-slate-300">JSON:</strong> Machine-readable workflow format.
                      Suitable for API integrations and programmatic processing.
                    </>
                  )}
                  {exportFormat === 'python' && (
                    <>
                      <strong className="text-slate-300">Python:</strong> FlowBuilder code for stepflow-py SDK. 
                      Install with: <code className="text-slate-300">pip install stepflow-py</code>
                    </>
                  )}
                  {exportFormat === 'config' && (
                    <>
                      <strong className="text-slate-300">Config:</strong> stepflow-config.yml with plugin routing.
                      Required for workflows using Anthropic, Cohere, or custom plugins.
                    </>
                  )}
                </p>
              </div>

              {/* Preview */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-slate-300">Preview</h3>
                  <button
                    onClick={() => copyToClipboard(getExportPreview())}
                    className="text-xs text-blue-400 hover:text-blue-300"
                  >
                    Copy
                  </button>
                </div>
                
                <pre className="p-3 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-300 overflow-auto max-h-[400px] font-mono">
                  {getExportPreview()}
                </pre>
              </div>
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
                  The YAML will be validated against the Stepflow schema.
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
                  
                  {validation.warnings.length > 0 && (
                    <div className="p-4 bg-yellow-500/20 border border-yellow-500/50 rounded-lg">
                      <p className="text-sm text-yellow-400 font-medium mb-2">⚠ Warnings:</p>
                      <ul className="text-sm text-yellow-400/80 space-y-1">
                        {validation.warnings.map((warn, i) => (
                          <li key={i}>• {warn}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  
                  {preview?.compatibility && (
                    <div className="p-4 bg-blue-500/10 border border-blue-500/30 rounded-lg">
                      <p className="text-sm text-blue-400 font-medium mb-2">Compatibility Features:</p>
                      {preview.compatibility.supportedFeatures.length > 0 && (
                        <div className="mb-2">
                          <p className="text-xs text-slate-400 mb-1">Supported:</p>
                          <div className="flex flex-wrap gap-1">
                            {preview.compatibility.supportedFeatures.map((feat, i) => (
                              <span key={i} className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded">
                                {feat}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      {preview.compatibility.recommendations.length > 0 && (
                        <div>
                          <p className="text-xs text-slate-400 mb-1">Recommendations:</p>
                          <ul className="text-xs text-slate-400 space-y-1">
                            {preview.compatibility.recommendations.map((rec, i) => (
                              <li key={i}>• {rec}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                  
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
          
          {/* Batch Tab */}
          {activeTab === 'batch' && (
            <div className="space-y-4">
              <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg">
                <p className="text-sm text-blue-400 font-medium mb-1">Batch Execution</p>
                <p className="text-xs text-slate-400">
                  Run this workflow over multiple inputs in parallel. The batch schema defines
                  the expected input format for each item in the batch.
                </p>
              </div>
              
              {batchSchema && (
                <>
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium text-slate-300">Batch Schema</h3>
                    <pre className="p-3 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-300 overflow-auto max-h-[200px] font-mono">
                      {JSON.stringify(batchSchema.schema, null, 2)}
                    </pre>
                  </div>
                  
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-medium text-slate-300">Example Batch File</h3>
                      <button
                        onClick={() => copyToClipboard(JSON.stringify(batchSchema.example, null, 2))}
                        className="text-xs text-blue-400 hover:text-blue-300"
                      >
                        Copy
                      </button>
                    </div>
                    <pre className="p-3 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-300 overflow-auto max-h-[200px] font-mono">
                      {JSON.stringify(batchSchema.example, null, 2)}
                    </pre>
                  </div>
                  
                  <div className="p-3 bg-slate-800/50 rounded-lg">
                    <p className="text-xs text-slate-400">
                      <strong className="text-slate-300">Usage:</strong> Save the example as{' '}
                      <code className="text-slate-300">batch.json</code> and run:
                    </p>
                    <code className="block mt-2 p-2 bg-slate-950 rounded text-xs text-slate-300 font-mono">
                      stepflow run --flow=workflow.yaml --batch=batch.json
                    </code>
                  </div>
                </>
              )}
              
              {isLoading && (
                <div className="text-center py-8">
                  <div className="animate-spin inline-block w-6 h-6 border-2 border-slate-600 border-t-blue-500 rounded-full" />
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
              href={status?.documentation || 'https://stepflow.org'} 
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
