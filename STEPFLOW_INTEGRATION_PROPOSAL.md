# MaestroAI Stepflow Integration: Core Code Change Proposals

## Executive Summary

This document proposes specific code changes to bridge the disconnect between Stepflow's backend capabilities and MaestroAI's current implementation. The proposals address the deferred items identified in `STEPFLOW_INTEGRATION_STATUS.md` with concrete, implementable solutions.

---

## 1. Streaming Execution Bridge (High Priority)

### Problem
The current implementation in `server/src/handlers/stepflow.ts` spawns the Stepflow CLI and waits for completion. Users get no real-time feedback during execution - the UI simply shows "Running with Stepflow..." until the entire workflow completes or fails.

### Stepflow Capability
Stepflow CLI outputs JSON lines (JSONL) to stdout as each step completes:
```jsonl
{"step":"step1","status":"completed","output":"...","timestamp":"2025-01-15T10:30:00Z"}
{"step":"step2","status":"completed","output":"...","timestamp":"2025-01-15T10:30:05Z"}
```

### Proposed Changes

#### 1.1 Add WebSocket-Based Streaming Infrastructure

**File: `server/src/websocket/stepflowStream.ts` (NEW)**

```typescript
/**
 * Stepflow Streaming Execution Manager
 * 
 * Bridges Stepflow CLI's JSONL output to WebSocket events for real-time
 * execution feedback in the UI.
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { WebSocketServer, WebSocket } from 'ws';

export interface StepflowStepEvent {
  type: 'step_start' | 'step_complete' | 'step_error' | 'execution_complete' | 'execution_error';
  stepId?: string;
  output?: any;
  error?: string;
  timestamp: string;
  executionId: string;
}

export class StepflowStreamManager extends EventEmitter {
  private activeExecutions = new Map<string, ChildProcess>();
  private wss: WebSocketServer;

  constructor(port: number = 3002) {
    super();
    this.wss = new WebSocketServer({ port });
    this.setupWebSocketServer();
  }

  private setupWebSocketServer(): void {
    this.wss.on('connection', (ws: WebSocket, req: Request) => {
      const executionId = new URL(req.url!, 'http://localhost').searchParams.get('executionId');
      
      if (!executionId) {
        ws.close(1008, 'Execution ID required');
        return;
      }

      // Subscribe client to execution events
      const listener = (event: StepflowStepEvent) => {
        if (event.executionId === executionId) {
          ws.send(JSON.stringify(event));
        }
      };

      this.on('stepflow:event', listener);

      ws.on('close', () => {
        this.off('stepflow:event', listener);
      });

      // Send initial connection confirmation
      ws.send(JSON.stringify({ type: 'connected', executionId }));
    });
  }

  async executeWithStreaming(
    workflowPath: string,
    inputPath: string,
    executionId: string
  ): Promise<void> {
    const stepflowProcess = spawn('stepflow', [
      'run',
      `--flow=${workflowPath}`,
      `--input=${inputPath}`,
      '--jsonl'  // Request JSON lines output format
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.activeExecutions.set(executionId, stepflowProcess);

    // Parse JSONL output stream
    let buffer = '';
    stepflowProcess.stdout!.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          this.parseAndEmit(line, executionId);
        }
      }
    });

    stepflowProcess.stderr!.on('data', (data: Buffer) => {
      this.emit('stepflow:event', {
        type: 'execution_error',
        error: data.toString(),
        timestamp: new Date().toISOString(),
        executionId
      } as StepflowStepEvent);
    });

    stepflowProcess.on('close', (code: number) => {
      this.activeExecutions.delete(executionId);
      this.emit('stepflow:event', {
        type: code === 0 ? 'execution_complete' : 'execution_error',
        timestamp: new Date().toISOString(),
        executionId
      } as StepflowStepEvent);
    });

    // Handle cancellation
    stepflowProcess.on('error', (error: Error) => {
      this.activeExecutions.delete(executionId);
      this.emit('stepflow:event', {
        type: 'execution_error',
        error: error.message,
        timestamp: new Date().toISOString(),
        executionId
      } as StepflowStepEvent);
    });
  }

  cancelExecution(executionId: string): boolean {
    const process = this.activeExecutions.get(executionId);
    if (process) {
      process.kill('SIGTERM');
      this.activeExecutions.delete(executionId);
      return true;
    }
    return false;
  }

  private parseAndEmit(line: string, executionId: string): void {
    try {
      const parsed = JSON.parse(line);
      const event: StepflowStepEvent = {
        type: parsed.status === 'completed' ? 'step_complete' : 'step_start',
        stepId: parsed.step,
        output: parsed.output,
        timestamp: parsed.timestamp || new Date().toISOString(),
        executionId
      };
      this.emit('stepflow:event', event);
    } catch {
      // Non-JSON output - treat as log message
      this.emit('stepflow:event', {
        type: 'step_start',
        output: line,
        timestamp: new Date().toISOString(),
        executionId
      } as StepflowStepEvent);
    }
  }
}

// Singleton instance
export const stepflowStreamManager = new StepflowStreamManager();
```

#### 1.2 Modify Run Endpoint to Support Streaming

**File: `server/src/handlers/stepflow.ts`** - Replace lines 289-399

```typescript
import { stepflowStreamManager } from '../websocket/stepflowStream';

/**
 * POST /api/workflows/:id/stepflow/run
 * Run workflow using Stepflow CLI with optional WebSocket streaming
 */
router.post('/workflows/:id/stepflow/run', async (req, res) => {
  if (!stepflowCliAvailable) {
    return res.status(503).json({
      error: 'Stepflow CLI not available',
      message: 'Install Stepflow CLI to run workflows: cargo install stepflow'
    });
  }
  
  const db = (req as any).db as Database;
  const workflow = db.getWorkflow(req.params.id);
  
  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found' });
  }
  
  // Validate workflow
  const validation = validateForStepflow(workflow);
  if (!validation.valid) {
    return res.status(400).json({
      error: 'Workflow validation failed',
      details: validation.errors
    });
  }
  
  const executionId = `exec-${Date.now()}`;
  const tempDir = join(tmpdir(), 'maestroai-stepflow');
  const workflowPath = join(tempDir, `${executionId}.yaml`);
  const inputPath = join(tempDir, `${executionId}-input.json`);
  
  // Check if client wants streaming
  const acceptStreaming = req.headers.accept === 'text/event-stream';
  
  try {
    // Create temp directory
    await mkdir(tempDir, { recursive: true });
    
    // Export workflow to temp file
    const yaml = toStepflowYAML(workflow);
    await writeFile(workflowPath, yaml, 'utf-8');
    
    // Write input if provided
    const input = req.body.input || {};
    await writeFile(inputPath, JSON.stringify(input, null, 2), 'utf-8');
    
    if (acceptStreaming) {
      // Set up SSE (Server-Sent Events) for streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      // Send initial event with execution ID and WebSocket URL
      res.write(`data: ${JSON.stringify({
        type: 'execution_started',
        executionId,
        websocketUrl: `ws://localhost:3002?executionId=${executionId}`
      })}\n\n`);
      
      // Subscribe to events and forward to SSE
      const listener = (event: any) => {
        if (event.executionId === executionId) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
          
          if (event.type === 'execution_complete' || event.type === 'execution_error') {
            cleanup();
          }
        }
      };
      
      const cleanup = () => {
        stepflowStreamManager.off('stepflow:event', listener);
        res.end();
        
        // Clean up temp files
        Promise.all([
          unlink(workflowPath).catch(() => {}),
          unlink(inputPath).catch(() => {})
        ]);
      };
      
      stepflowStreamManager.on('stepflow:event', listener);
      
      // Start execution
      await stepflowStreamManager.executeWithStreaming(
        workflowPath,
        inputPath,
        executionId
      );
    } else {
      // Non-streaming mode (original behavior)
      const stepflowProcess = spawn('stepflow', [
        'run',
        `--flow=${workflowPath}`,
        `--input=${inputPath}`
      ], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let stdout = '';
      let stderr = '';
      
      stepflowProcess.stdout!.on('data', (data) => {
        stdout += data.toString();
      });
      
      stepflowProcess.stderr!.on('data', (data) => {
        stderr += data.toString();
      });
      
      stepflowProcess.on('close', async (code) => {
        // Clean up temp files
        try {
          await unlink(workflowPath);
          await unlink(inputPath);
        } catch {
          // Ignore cleanup errors
        }
        
        if (code === 0) {
          try {
            const result = JSON.parse(stdout);
            res.json({
              executionId,
              status: 'success',
              result
            });
          } catch {
            res.json({
              executionId,
              status: 'success',
              output: stdout
            });
          }
        } else {
          res.status(500).json({
            executionId,
            status: 'error',
            exitCode: code,
            error: stderr || 'Stepflow execution failed'
          });
        }
      });
    }
  } catch (error) {
    // Clean up on error
    try {
      await unlink(workflowPath);
      await unlink(inputPath);
    } catch {
      // Ignore cleanup errors
    }
    
    res.status(500).json({
      error: 'Failed to run workflow',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});
```

#### 1.3 Add Client-Side WebSocket Hook

**File: `client/src/hooks/useStepflowStream.ts` (NEW)**

```typescript
/**
 * Hook for connecting to Stepflow execution WebSocket stream
 */

import { useEffect, useRef, useState, useCallback } from 'react';

export interface StepflowStreamEvent {
  type: 'connected' | 'step_start' | 'step_complete' | 'step_error' | 'execution_complete' | 'execution_error';
  stepId?: string;
  output?: any;
  error?: string;
  timestamp: string;
  executionId: string;
}

interface UseStepflowStreamOptions {
  onStepStart?: (stepId: string) => void;
  onStepComplete?: (stepId: string, output: any) => void;
  onStepError?: (stepId: string, error: string) => void;
  onComplete?: () => void;
  onError?: (error: string) => void;
}

export function useStepflowStream(
  websocketUrl: string | null,
  options: UseStepflowStreamOptions = {}
) {
  const [isConnected, setIsConnected] = useState(false);
  const [events, setEvents] = useState<StepflowStreamEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!websocketUrl) return;

    const ws = new WebSocket(websocketUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
    };

    ws.onmessage = (event) => {
      const data: StepflowStreamEvent = JSON.parse(event.data);
      setEvents(prev => [...prev, data]);

      // Trigger callbacks
      switch (data.type) {
        case 'step_start':
          if (data.stepId) options.onStepStart?.(data.stepId);
          break;
        case 'step_complete':
          if (data.stepId) options.onStepComplete?.(data.stepId, data.output);
          break;
        case 'step_error':
          if (data.stepId) options.onStepError?.(data.stepId, data.error || 'Unknown error');
          break;
        case 'execution_complete':
          options.onComplete?.();
          break;
        case 'execution_error':
          options.onError?.(data.error || 'Execution failed');
          break;
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      options.onError?.('WebSocket connection error');
    };

    return () => {
      ws.close();
    };
  }, [websocketUrl]);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
  }, []);

  return {
    isConnected,
    events,
    disconnect
  };
}
```

---

## 2. DAG Auto-Layout on Import (High Priority)

### Problem
Currently, `convertFromStepflow()` in `shared/src/stepflow.ts` lays out imported workflows as a simple vertical stack (lines 599-608). This makes complex workflows with multiple branches difficult to read and edit.

### Proposed Changes

#### 2.1 Add DAG Layout Engine

**File: `shared/src/layout/dagLayout.ts` (NEW)**

```typescript
/**
 * DAG Auto-Layout Engine for Stepflow Workflow Import
 * 
 * Uses a layered graph drawing algorithm (Sugiyama-style) to produce
 * readable layouts for imported Stepflow workflows.
 */

import type { WorkflowNode, WorkflowEdge } from '../index';

export interface LayoutConfig {
  nodeWidth: number;
  nodeHeight: number;
  levelSeparation: number;
  siblingSeparation: number;
}

const DEFAULT_CONFIG: LayoutConfig = {
  nodeWidth: 250,
  nodeHeight: 100,
  levelSeparation: 200,  // Vertical space between layers
  siblingSeparation: 300 // Horizontal space between nodes
};

interface LayoutNode {
  id: string;
  level: number;
  position: number; // Within level
  x: number;
  y: number;
}

/**
 * Compute a layered layout for a DAG
 */
export function computeDagLayout(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  config: Partial<LayoutConfig> = {}
): Map<string, { x: number; y: number }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  
  // Build adjacency lists
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  
  for (const edge of edges) {
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
    if (!incoming.has(edge.target)) incoming.set(edge.target, []);
    outgoing.get(edge.source)!.push(edge.target);
    incoming.get(edge.target)!.push(edge.source);
  }

  // Step 1: Assign levels using longest path layering
  const levels = assignLevels(nodes.map(n => n.id), incoming, outgoing);
  
  // Step 2: Create level buckets
  const levelBuckets = new Map<number, string[]>();
  for (const [nodeId, level] of levels) {
    if (!levelBuckets.has(level)) levelBuckets.set(level, []);
    levelBuckets.get(level)!.push(nodeId);
  }

  // Step 3: Order nodes within levels to minimize crossings
  const orderedLevels = minimizeCrossings(levelBuckets, incoming, outgoing);
  
  // Step 4: Assign coordinates
  const positions = new Map<string, { x: number; y: number }>();
  const maxLevel = Math.max(...Array.from(levels.values()));
  
  for (let level = 0; level <= maxLevel; level++) {
    const levelNodes = orderedLevels.get(level) || [];
    const levelWidth = (levelNodes.length - 1) * cfg.siblingSeparation;
    const startX = -levelWidth / 2;
    
    for (let i = 0; i < levelNodes.length; i++) {
      const nodeId = levelNodes[i];
      positions.set(nodeId, {
        x: startX + i * cfg.siblingSeparation + cfg.nodeWidth / 2,
        y: level * cfg.levelSeparation + 50
      });
    }
  }

  return positions;
}

/**
 * Assign levels to nodes using longest path from sources
 */
function assignLevels(
  nodeIds: string[],
  incoming: Map<string, string[]>,
  outgoing: Map<string, string[]>
): Map<string, number> {
  const levels = new Map<string, number>();
  const visited = new Set<string>();
  
  // Find source nodes (no incoming edges)
  const sources = nodeIds.filter(id => !incoming.has(id) || incoming.get(id)!.length === 0);
  
  function dfs(nodeId: string, level: number): void {
    if (visited.has(nodeId)) {
      // Update level if this path is longer
      levels.set(nodeId, Math.max(levels.get(nodeId)!, level));
      return;
    }
    
    visited.add(nodeId);
    levels.set(nodeId, level);
    
    const children = outgoing.get(nodeId) || [];
    for (const child of children) {
      dfs(child, level + 1);
    }
  }
  
  for (const source of sources) {
    dfs(source, 0);
  }
  
  // Handle any remaining nodes (shouldn't happen in a DAG, but for safety)
  for (const nodeId of nodeIds) {
    if (!levels.has(nodeId)) {
      levels.set(nodeId, 0);
    }
  }
  
  return levels;
}

/**
 * Simple crossing minimization using barycenter heuristic
 */
function minimizeCrossings(
  levelBuckets: Map<number, string[]>,
  incoming: Map<string, string[]>,
  outgoing: Map<string, string[]>
): Map<number, string[]> {
  const ordered = new Map<number, string[]>();
  const maxLevel = Math.max(...Array.from(levelBuckets.keys()));
  
  // Initialize with original order
  for (let level = 0; level <= maxLevel; level++) {
    ordered.set(level, [...(levelBuckets.get(level) || [])]);
  }
  
  // Iteratively improve (3 passes)
  for (let pass = 0; pass < 3; pass++) {
    // Top-down pass
    for (let level = 1; level <= maxLevel; level++) {
      const nodes = ordered.get(level)!;
      const sorted = sortByBarycenter(nodes, incoming, ordered.get(level - 1)!);
      ordered.set(level, sorted);
    }
    
    // Bottom-up pass
    for (let level = maxLevel - 1; level >= 0; level--) {
      const nodes = ordered.get(level)!;
      const sorted = sortByBarycenter(nodes, outgoing, ordered.get(level + 1)!, true);
      ordered.set(level, sorted);
    }
  }
  
  return ordered;
}

/**
 * Sort nodes by barycenter of their connections
 */
function sortByBarycenter(
  nodes: string[],
  connections: Map<string, string[]>,
  referenceLevel: string[],
  reverse: boolean = false
): string[] {
  const positionMap = new Map<string, number>();
  referenceLevel.forEach((id, idx) => positionMap.set(id, idx));
  
  return [...nodes].sort((a, b) => {
    const aConns = connections.get(a) || [];
    const bConns = connections.get(b) || [];
    
    const aBary = aConns.length > 0
      ? aConns.reduce((sum, id) => sum + (positionMap.get(id) || 0), 0) / aConns.length
      : 0;
    const bBary = bConns.length > 0
      ? bConns.reduce((sum, id) => sum + (positionMap.get(id) || 0), 0) / bConns.length
      : 0;
    
    return reverse ? bBary - aBary : aBary - bBary;
  });
}
```

#### 2.2 Modify Import Function to Use Layout

**File: `shared/src/stepflow.ts`** - Replace lines 595-635

```typescript
import { computeDagLayout } from './layout/dagLayout';

/**
 * Converts a Stepflow workflow to MaestroAI format with proper DAG layout
 */
export function convertFromStepflow(
  stepflowWorkflow: StepflowWorkflow,
  options: { autoLayout?: boolean } = {}
): Partial<Workflow> {
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  
  // First pass: create nodes without positions
  for (const step of stepflowWorkflow.steps) {
    const node = convertStepToNode(step, { x: 0, y: 0 });
    nodes.push(node);
  }
  
  // Create edges based on $step references
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  
  for (const step of stepflowWorkflow.steps) {
    const targetId = step.id.replace(/^_/, '');
    const references = extractStepReferences(step.input);
    
    for (const sourceId of references) {
      const sanitizedSource = sourceId.replace(/^_/, '');
      if (nodeMap.has(sanitizedSource) || nodeMap.has(sourceId)) {
        edges.push({
          id: `edge-${sanitizedSource}-${targetId}`,
          source: sanitizedSource,
          target: targetId
        });
      }
    }
  }
  
  // Apply DAG auto-layout if enabled (default: true)
  if (options.autoLayout !== false) {
    const positions = computeDagLayout(nodes, edges);
    
    for (const node of nodes) {
      const pos = positions.get(node.id);
      if (pos) {
        node.position = pos;
      }
    }
  } else {
    // Fallback to simple vertical stack
    let yPosition = 50;
    const xPosition = 250;
    const yIncrement = 150;
    
    for (const node of nodes) {
      node.position = { x: xPosition, y: yPosition };
      yPosition += yIncrement;
    }
  }
  
  return {
    name: stepflowWorkflow.name,
    nodes,
    edges,
    variables: {}
  };
}
```

---

## 3. Round-Trip Integration Test Framework (Medium Priority)

### Problem
No test framework exists to verify that workflows exported from MaestroAI can actually execute correctly in Stepflow, or that exported-then-imported workflows maintain their semantic integrity.

### Proposed Changes

#### 3.1 Add Test Infrastructure

**File: `shared/src/testing/roundTrip.ts` (NEW)**

```typescript
/**
 * Round-Trip Integration Testing for Stepflow
 * 
 * Validates that workflows maintain semantic integrity through:
 * MaestroAI -> Stepflow Export -> Stepflow Execution -> Import -> MaestroAI
 */

import type { Workflow } from '../index';
import { convertToStepflow, convertFromStepflow, toStepflowYAML } from '../stepflow';
import { validateStepflowImport } from '../stepflowSchema';

export interface RoundTripResult {
  success: boolean;
  stage: 'export' | 'validation' | 'execution' | 'import' | 'comparison';
  errors: string[];
  original?: Workflow;
  exported?: any;
  executionResult?: any;
  reimported?: Partial<Workflow>;
  differences?: string[];
}

export interface RoundTripOptions {
  // Mock execution (for testing without Stepflow CLI)
  mockExecution?: boolean;
  // Skip execution phase, only test export/import
  skipExecution?: boolean;
  // Compare node count
  validateNodeCount?: boolean;
  // Compare edge connectivity
  validateConnectivity?: boolean;
  // Compare prompt content
  validatePromptContent?: boolean;
}

/**
 * Perform a full round-trip test on a workflow
 */
export async function testRoundTrip(
  original: Workflow,
  options: RoundTripOptions = {}
): Promise<RoundTripResult> {
  const result: RoundTripResult = {
    success: false,
    stage: 'export',
    errors: []
  };

  try {
    // Stage 1: Export to Stepflow
    const exported = convertToStepflow(original);
    result.exported = exported;
    
    // Stage 2: Validate exported format
    result.stage = 'validation';
    const validation = validateStepflowImport(exported);
    if (!validation.valid) {
      result.errors.push(...validation.errors);
      return result;
    }
    
    // Stage 3: Execute (or mock)
    if (!options.skipExecution) {
      result.stage = 'execution';
      
      if (options.mockExecution) {
        // Simulate execution with mock results
        result.executionResult = mockExecute(exported);
      } else {
        // Requires actual Stepflow CLI
        result.executionResult = await executeWithStepflow(exported);
      }
    }
    
    // Stage 4: Re-import
    result.stage = 'import';
    const reimported = convertFromStepflow(exported, { autoLayout: false });
    result.reimported = reimported;
    
    // Stage 5: Compare
    result.stage = 'comparison';
    const differences = compareWorkflows(original, reimported, options);
    result.differences = differences;
    
    if (differences.length > 0) {
      result.errors.push(...differences);
      return result;
    }
    
    result.success = true;
    return result;
    
  } catch (error) {
    result.errors.push(`Unexpected error at ${result.stage}: ${error}`);
    return result;
  }
}

/**
 * Compare original and re-imported workflows
 */
function compareWorkflows(
  original: Workflow,
  reimported: Partial<Workflow>,
  options: RoundTripOptions
): string[] {
  const differences: string[] = [];
  
  // Compare node counts
  if (options.validateNodeCount !== false) {
    if (original.nodes.length !== (reimported.nodes?.length || 0)) {
      differences.push(
        `Node count mismatch: ${original.nodes.length} vs ${reimported.nodes?.length || 0}`
      );
    }
  }
  
  // Compare edge counts
  if (original.edges.length !== (reimported.edges?.length || 0)) {
    differences.push(
      `Edge count mismatch: ${original.edges.length} vs ${reimported.edges?.length || 0}`
    );
  }
  
  // Compare connectivity
  if (options.validateConnectivity !== false) {
    const origConnections = extractConnectivity(original);
    const reimpConnections = extractConnectivity(reimported as Workflow);
    
    for (const conn of origConnections) {
      if (!reimpConnections.has(conn)) {
        differences.push(`Missing connection: ${conn}`);
      }
    }
  }
  
  // Compare prompt content
  if (options.validatePromptContent !== false) {
    const origPrompts = extractPrompts(original);
    const reimpPrompts = extractPrompts(reimported as Workflow);
    
    for (let i = 0; i < origPrompts.length; i++) {
      if (i >= reimpPrompts.length) {
        differences.push(`Missing prompt node ${i}`);
        continue;
      }
      
      const orig = origPrompts[i];
      const reimp = reimpPrompts[i];
      
      if (orig.systemPrompt !== reimp.systemPrompt) {
        differences.push(`System prompt mismatch in node ${orig.nodeId}`);
      }
      if (orig.userPrompt !== reimp.userPrompt) {
        differences.push(`User prompt mismatch in node ${orig.nodeId}`);
      }
    }
  }
  
  return differences;
}

function extractConnectivity(workflow: Workflow): Set<string> {
  const connections = new Set<string>();
  for (const edge of workflow.edges) {
    connections.add(`${edge.source}->${edge.target}`);
  }
  return connections;
}

function extractPrompts(workflow: Workflow): Array<{
  nodeId: string;
  systemPrompt: string;
  userPrompt: string;
}> {
  return workflow.nodes
    .filter(n => n.type === 'prompt')
    .map(n => ({
      nodeId: n.id,
      systemPrompt: (n.data.config as any).systemPrompt || '',
      userPrompt: (n.data.config as any).userPrompt || ''
    }));
}

function mockExecute(stepflowWorkflow: any): any {
  // Return mock execution results for testing
  return {
    status: 'success',
    steps: stepflowWorkflow.steps.map((s: any) => ({
      id: s.id,
      output: `Mock output for ${s.id}`
    }))
  };
}

async function executeWithStepflow(stepflowWorkflow: any): Promise<any> {
  // Would spawn stepflow CLI and return results
  throw new Error('Real execution not implemented in shared package');
}
```

#### 3.2 Add Jest Test Suite

**File: `shared/src/__tests__/roundTrip.test.ts` (NEW)**

```typescript
/**
 * Round-trip integration tests
 */

import { testRoundTrip } from '../testing/roundTrip';
import { createDefaultWorkflow, generateId } from '../index';

describe('Stepflow Round-Trip Integration', () => {
  it('should round-trip the default workflow', async () => {
    const original = createDefaultWorkflow();
    
    const result = await testRoundTrip(original, {
      mockExecution: true,
      skipExecution: false
    });
    
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should preserve prompt content through round-trip', async () => {
    const original = createDefaultWorkflow();
    original.nodes[1].data.config.systemPrompt = 'Custom system prompt';
    original.nodes[1].data.config.userPrompt = 'Custom user prompt with {{input}}';
    
    const result = await testRoundTrip(original, {
      mockExecution: true,
      validatePromptContent: true
    });
    
    expect(result.success).toBe(true);
  });

  it('should preserve branch node configuration', async () => {
    const original = createDefaultWorkflow();
    
    // Add a branch node
    const branchNode = {
      id: generateId(),
      type: 'branch' as const,
      position: { x: 250, y: 400 },
      data: {
        label: 'Decision',
        config: {
          condition: 'input == "yes"',
          branches: [
            { id: 'true', label: 'Yes', condition: 'input == "yes"' },
            { id: 'false', label: 'No', condition: 'input != "yes"' }
          ]
        }
      }
    };
    
    original.nodes.push(branchNode);
    original.edges.push({
      id: generateId(),
      source: original.nodes[1].id,
      target: branchNode.id
    });
    
    const result = await testRoundTrip(original, {
      mockExecution: true,
      validateConnectivity: true
    });
    
    expect(result.success).toBe(true);
    expect(result.reimported?.nodes?.some(n => n.type === 'branch')).toBe(true);
  });
});
```

---

## 4. Enhanced Error Handler Configuration (Medium Priority)

### Problem
The current `ErrorHandlerConfig` interface only supports basic strategies. Stepflow supports more sophisticated error handling including exponential backoff, conditional retries, and custom error matchers.

### Proposed Changes

**File: `shared/src/index.ts`** - Replace lines 62-66

```typescript
export interface ErrorHandlerConfig {
  strategy: 'retry' | 'default' | 'fail' | 'retry_with_backoff' | 'circuit_breaker';
  maxAttempts?: number;           // for retry strategies
  fallbackValue?: any;            // for default strategy
  retryDelayMs?: number;          // initial delay for backoff
  maxRetryDelayMs?: number;       // maximum delay cap
  backoffMultiplier?: number;     // exponential multiplier (default: 2)
  retryOn?: string[];             // error types to retry (e.g., ['rate_limit', 'timeout'])
  failOn?: string[];              // error types to fail fast
}
```

**File: `shared/src/stepflow.ts`** - Update `buildOnError()` function

```typescript
function buildOnError(config: any): StepflowErrorHandler | undefined {
  const errorConfig = config?.onError as ErrorHandlerConfig | undefined;
  if (!errorConfig) return undefined;

  switch (errorConfig.strategy) {
    case 'retry':
      return {
        type: 'retry',
        max_attempts: errorConfig.maxAttempts ?? 3,
        retry_delay_ms: errorConfig.retryDelayMs
      };
      
    case 'retry_with_backoff':
      return {
        type: 'retry',
        max_attempts: errorConfig.maxAttempts ?? 3,
        retry_delay_ms: errorConfig.retryDelayMs ?? 1000,
        max_retry_delay_ms: errorConfig.maxRetryDelayMs ?? 60000,
        backoff_multiplier: errorConfig.backoffMultiplier ?? 2
      };
      
    case 'circuit_breaker':
      return {
        type: 'default',
        value: errorConfig.fallbackValue ?? null,
        circuit_breaker: {
          failure_threshold: errorConfig.maxAttempts ?? 5,
          recovery_timeout_ms: errorConfig.retryDelayMs ?? 30000
        }
      };
      
    case 'default':
      return {
        type: 'default',
        value: errorConfig.fallbackValue ?? null
      };
      
    case 'fail':
      return { type: 'fail' };
      
    default:
      return undefined;
  }
}
```

---

## 5. File Upload for Import UI (Low Priority)

### Problem
Users can only paste YAML content; there's no drag-and-drop file upload support.

### Proposed Changes

**File: `client/src/components/FileUploadZone.tsx` (NEW)**

```typescript
/**
 * Drag-and-drop file upload component for Stepflow YAML/JSON import
 */

import { useCallback, useState } from 'react';

interface FileUploadZoneProps {
  onFileContent: (content: string, filename: string) => void;
  accept?: string;
  maxSizeMB?: number;
}

export function FileUploadZone({
  onFileContent,
  accept = '.yaml,.yml,.json',
  maxSizeMB = 5
}: FileUploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    setError(null);

    const file = e.dataTransfer.files[0];
    if (!file) return;

    // Validate file type
    const validExtensions = accept.split(',').map(ext => ext.trim().toLowerCase());
    const fileExtension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    
    if (!validExtensions.includes(fileExtension)) {
      setError(`Invalid file type. Please upload: ${accept}`);
      return;
    }

    // Validate file size
    if (file.size > maxSizeMB * 1024 * 1024) {
      setError(`File too large. Maximum size: ${maxSizeMB}MB`);
      return;
    }

    // Read file
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      onFileContent(content, file.name);
    };
    reader.onerror = () => {
      setError('Failed to read file');
    };
    reader.readAsText(file);
  }, [accept, maxSizeMB, onFileContent]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const content = event.target?.result as string;
        onFileContent(content, file.name);
      };
      reader.readAsText(file);
    }
  }, [onFileContent]);

  return (
    <div className="space-y-2">
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`
          border-2 border-dashed rounded-lg p-8 text-center transition-colors
          ${isDragging 
            ? 'border-blue-500 bg-blue-500/10' 
            : 'border-slate-600 hover:border-slate-500 hover:bg-slate-800/50'
          }
        `}
      >
        <div className="text-3xl mb-2">📁</div>
        <p className="text-sm text-slate-300 mb-1">
          Drag and drop your Stepflow file here
        </p>
        <p className="text-xs text-slate-500">
          or click to browse
        </p>
        <input
          type="file"
          accept={accept}
          onChange={handleFileInput}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        />
      </div>
      
      {error && (
        <p className="text-xs text-red-400">{error}</p>
      )}
      
      <p className="text-xs text-slate-500 text-center">
        Supported formats: YAML, JSON (max {maxSizeMB}MB)
      </p>
    </div>
  );
}
```

---

## Implementation Priority

| Priority | Feature | Effort | Impact |
|----------|---------|--------|--------|
| P0 | Streaming Execution Bridge | Medium | High - Real-time feedback |
| P1 | DAG Auto-Layout | Medium | High - UX improvement |
| P2 | Round-Trip Test Framework | Low | Medium - Quality assurance |
| P3 | Enhanced Error Handlers | Low | Low - Feature parity |
| P4 | File Upload UI | Low | Low - Convenience |

---

## Dependencies to Add

```json
{
  "server": {
    "ws": "^8.16.0"
  },
  "shared": {
    "jest": "^29.7.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.10"
  }
}
```
