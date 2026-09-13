/**
 * The workflow canvas.
 *
 * Split out of App.tsx so it can sit behind a React.lazy boundary: reactflow,
 * the seven node components and the Monaco-backed config panel are the bulk of
 * the client bundle, and none of it is needed to render the welcome screen or
 * the chat view. App imports this module dynamically, so it becomes its own
 * chunk that is fetched when the editor is first opened.
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  Connection,
  Edge,
  Node,
  ReactFlowProvider,
  Panel,
  MarkerType,
  SelectionMode
} from 'reactflow';
import 'reactflow/dist/style.css';

import { blankWorkflow, useWorkflowStore } from '../stores/workflowStore';
import { useExecutionStore } from '../stores/executionStore';
import { useSocket } from '../hooks/useSocket';
import { NodePalette } from '../components/NodePalette';
import { NodeConfigPanel } from '../components/NodeConfigPanel';
import { ExecutionLogPanel } from '../components/ExecutionLogPanel';
import { RunHistoryPanel } from '../components/RunHistoryPanel';
import { labelsOf, runWhen, statusTone } from '../runs/format';
import { Toolbar } from '../components/Toolbar';
import { ValidationPanel } from '../components/ValidationPanel';
import { ImportModal } from '../components/ImportModal';
import { OpenWorkflowDialog } from '../components/OpenWorkflowDialog';
import { GateDecisionPanel } from '../components/GateDecisionPanel';
import { RunInputsModal, type RunInput } from '../components/RunInputsModal';
import { NO_OFFSET, type Offset } from '../hooks/usePointerDrag';
import { PromptNode } from '../nodes/PromptNode';
import { BranchNode } from '../nodes/BranchNode';
import { InputNode } from '../nodes/InputNode';
import { OutputNode } from '../nodes/OutputNode';
import { AggregateNode } from '../nodes/AggregateNode';
import { HumanGateNode } from '../nodes/HumanGateNode';
import { RoutedEdge } from '../edges/RoutedEdge';
import { validateWorkflow, DEFAULT_BRANCH_CONDITION, DEFAULT_WORKFLOW_MODEL, ROOT_FOLDER } from '@joseki/shared';
import type { NodeType, Workflow, WorkflowValidation } from '@joseki/shared';

const nodeTypes = {
  prompt: PromptNode,
  branch: BranchNode,
  input: InputNode,
  output: OutputNode,
  aggregate: AggregateNode,
  human_gate: HumanGateNode
};

// Every edge routes around nodes; see edges/route.ts.
const edgeTypes = {
  routed: RoutedEdge
};

interface SelectionBox {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  isSelecting: boolean;
}

// Arrows out of a branch or a gate carry the handle they leave from, so the
// canvas shows which way is which.
const HANDLE_COLORS: Record<string, string> = {
  pass: '#22c55e',
  true: '#22c55e',
  fail: '#ef4444',
  false: '#ef4444'
};

function decorateEdge(edge: Edge, nodes: Node[], isSelected: boolean): Edge {
  const sourceType = nodes.find((n) => n.id === edge.source)?.type;
  const handle = edge.sourceHandle ?? undefined;
  const labelled = (sourceType === 'branch' || sourceType === 'human_gate') && handle ? handle : undefined;
  const color = isSelected ? '#3b82f6' : (labelled && HANDLE_COLORS[labelled]) || '#64748b';
  return {
    ...edge,
    label: labelled,
    labelStyle: { fill: color, fontSize: 10, fontWeight: 600 },
    labelBgStyle: { fill: '#0f172a', fillOpacity: 0.9 },
    labelBgPadding: [4, 2],
    labelBgBorderRadius: 3,
    style: { ...edge.style, stroke: color, strokeWidth: isSelected ? 3 : 2 },
    markerEnd: { type: MarkerType.ArrowClosed, color }
  };
}

function Flow({
  openImportOnMount = false,
  onOpenChat
}: {
  openImportOnMount?: boolean;
  onOpenChat: () => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<Edge | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [showRuns, setShowRuns] = useState(false);
  const [validation, setValidation] = useState<WorkflowValidation | null>(null);
  const [showImport, setShowImport] = useState(openImportOnMount);
  const [showOpen, setShowOpen] = useState(false);
  const [runInputs, setRunInputs] = useState<{ workflow: Workflow; inputs: RunInput[] } | null>(null);
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  // Where the reviewer pushed the gate panel. Kept here rather than in the
  // panel, which is unmounted and rebuilt every time the run reaches a gate.
  const [gateOffset, setGateOffset] = useState<Offset>(NO_OFFSET);

  const flowWrapper = useRef<HTMLDivElement>(null);
  const { project } = useReactFlow();
  
  const { currentWorkflow, setCurrentWorkflow, persistWorkflow, workflows } = useWorkflowStore();
  const {
    isExecuting,
    startExecution,
    currentExecutionId,
    pendingGate,
    viewingRun,
    clearExecution,
    setLabelOf
  } = useExecutionStore();
  const { socket, isConnected, resumeGate, cancelExecution } = useSocket();

  // The log names nodes the way the canvas does, so a rename shows up in it
  // at once — including in a run reopened from history.
  useEffect(() => {
    setLabelOf(labelsOf(nodes));
  }, [nodes, setLabelOf]);

  // The canvas takes its graph from the store when a workflow arrives, and
  // not again for the same one: the store's copy is only as fresh as the last
  // save, while the canvas holds the edits since. So a rename or a move
  // written to the store — the Open dialog does that for the workflow on
  // the canvas — updates what the next save sends without touching the
  // graph being edited.
  const loadedId = useRef<string | null>(null);
  useEffect(() => {
    if (currentWorkflow && loadedId.current !== currentWorkflow.id) {
      loadedId.current = currentWorkflow.id;
      setNodes(currentWorkflow.nodes.map(n => ({
        id: n.id,
        type: n.type,
        position: n.position,
        data: n.data,
        selected: false
      })));
      setEdges(currentWorkflow.edges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        type: 'routed',
        animated: false,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#64748b' }
      })));
    }
  }, [currentWorkflow, setNodes, setEdges]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => addEdge({ 
        ...connection, 
        type: 'routed',
        markerEnd: { type: MarkerType.ArrowClosed, color: '#64748b' }
      }, eds));
    },
    [setEdges]
  );

  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    // If clicking without Ctrl, clear other selections
    if (!event.ctrlKey && !event.metaKey) {
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === node.id })));
    } else {
      // Toggle selection with Ctrl
      setNodes((nds) => nds.map((n) => 
        n.id === node.id ? { ...n, selected: !n.selected } : n
      ));
    }
    setSelectedNode(node);
    setSelectedEdge(null);
  }, [setNodes]);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
    setSelectedEdge(null);
    // Clear all node selections
    setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));
  }, [setNodes]);

  // Handle Ctrl key for selection box state tracking

  // Selection box mouse handlers
  const handleMouseDown = useCallback((event: React.MouseEvent) => {
    // Only start selection box on Ctrl+click on the pane (not on nodes)
    if ((event.ctrlKey || event.metaKey) && event.target === event.currentTarget) {
      const bounds = flowWrapper.current?.getBoundingClientRect();
      if (!bounds) return;
      
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      
      setSelectionBox({
        startX: x,
        startY: y,
        endX: x,
        endY: y,
        isSelecting: true
      });
    }
  }, []);

  const handleMouseMove = useCallback((event: React.MouseEvent) => {
    if (!selectionBox?.isSelecting) return;
    
    const bounds = flowWrapper.current?.getBoundingClientRect();
    if (!bounds) return;
    
    setSelectionBox((prev) => ({
      ...prev!,
      endX: event.clientX - bounds.left,
      endY: event.clientY - bounds.top
    }));
  }, [selectionBox?.isSelecting]);

  const handleMouseUp = useCallback(() => {
    if (!selectionBox?.isSelecting) return;

    // Calculate selection box in flow coordinates
    const bounds = flowWrapper.current?.getBoundingClientRect();
    if (!bounds) {
      setSelectionBox(null);
      return;
    }

    const startPos = project({
      x: Math.min(selectionBox.startX, selectionBox.endX),
      y: Math.min(selectionBox.startY, selectionBox.endY) - bounds.top + bounds.top
    });
    
    const endPos = project({
      x: Math.max(selectionBox.startX, selectionBox.endX),
      y: Math.max(selectionBox.startY, selectionBox.endY) - bounds.top + bounds.top
    });

    // Select nodes within the box
    setNodes((nds) => nds.map((node) => {
      const isInBox = 
        node.position.x >= startPos.x &&
        node.position.x <= endPos.x &&
        node.position.y >= startPos.y &&
        node.position.y <= endPos.y;
      
      return { ...node, selected: isInBox };
    }));

    setSelectionBox(null);
  }, [selectionBox, project, setNodes]);

  const onEdgeClick = useCallback((_: React.MouseEvent, edge: Edge) => {
    setSelectedEdge(edge);
    setSelectedNode(null);
  }, []);

  const handleDeleteEdge = useCallback(() => {
    if (selectedEdge) {
      setEdges((eds) => eds.filter((e) => e.id !== selectedEdge.id));
      setSelectedEdge(null);
    }
  }, [selectedEdge, setEdges]);

  // The canvas (React Flow state) is the source of truth for nodes and edges;
  // the store's currentWorkflow only carries identity and metadata.
  const canvasWorkflow = useCallback((): Workflow | null => {
    if (!currentWorkflow) return null;
    return {
      ...currentWorkflow,
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.type as NodeType,
        position: n.position,
        data: n.data
      })),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? undefined,
        targetHandle: e.targetHandle ?? undefined
      })),
      updatedAt: Date.now()
    };
  }, [currentWorkflow, nodes, edges]);

  const showFailure = useCallback((error: unknown) => {
    setValidation({
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
      warnings: []
    });
  }, []);

  const handleValidate = useCallback(() => {
    const workflow = canvasWorkflow();
    if (!workflow) return;
    setValidation(validateWorkflow(workflow));
  }, [canvasWorkflow]);

  const handleExport = useCallback(async () => {
    const workflow = canvasWorkflow();
    if (!workflow) return;
    try {
      const saved = await persistWorkflow(workflow);
      const response = await fetch(`/api/workflows/${saved.id}/export`);
      if (!response.ok) throw new Error(`Export failed (${response.status})`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${saved.name.replace(/[^\w.-]+/g, '_') || 'workflow'}.joseki.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      showFailure(error);
    }
  }, [canvasWorkflow, persistWorkflow, showFailure]);

  const handleImported = useCallback((workflow: Workflow, result: WorkflowValidation) => {
    setShowImport(false);
    setCurrentWorkflow(workflow);
    setValidation(result.errors.length || result.warnings.length ? result : null);
  }, [setCurrentWorkflow]);

  const launch = useCallback(async (workflow: Workflow, inputs: Record<string, unknown>) => {
    if (!socket) return;

    // The server executes its stored copy, so the canvas must be saved first.
    try {
      await persistWorkflow(workflow);
    } catch (error) {
      showFailure(error);
      return;
    }

    const executionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    startExecution(executionId);

    socket.emit('execution:start', {
      workflowId: workflow.id,
      executionId,
      inputs
    });

    setShowLog(true);
  }, [socket, persistWorkflow, showFailure, startExecution]);

  // Run validates the canvas, then asks for each input node's value before
  // launching — unless there is nothing to ask for.
  const handleRun = useCallback(() => {
    const workflow = canvasWorkflow();
    if (!workflow || !socket) return;

    const result = validateWorkflow(workflow);
    if (!result.valid) {
      setValidation(result);
      return;
    }

    const inputs: RunInput[] = workflow.nodes
      .filter((n) => n.type === 'input')
      .map((n) => {
        const config = (n.data.config ?? {}) as Record<string, unknown>;
        return {
          id: n.id,
          label: n.data.label,
          inputType: config.inputType as string | undefined,
          required: Boolean(config.required),
          description: config.description as string | undefined,
          defaultValue: config.defaultValue
        };
      });
    if (inputs.length === 0) {
      void launch(workflow, {});
      return;
    }
    setRunInputs({ workflow, inputs });
  }, [canvasWorkflow, socket, launch]);

  // Hand unsaved canvas edits to the store before leaving for the chat view,
  // so they are still there when the editor comes back.
  const handleOpenChat = useCallback(() => {
    const workflow = canvasWorkflow();
    if (workflow) setCurrentWorkflow(workflow);
    onOpenChat();
  }, [canvasWorkflow, setCurrentWorkflow, onOpenChat]);

  // Leaving this workflow for another saves it first, the way Run and Export
  // do — except a workflow that was never saved and has nothing on it, which
  // would only leave an empty "New Workflow" behind. False when the save
  // failed, in which case the canvas stays where it is with its edits.
  const leaveCanvas = useCallback(async (): Promise<boolean> => {
    const workflow = canvasWorkflow();
    if (!workflow) return true;
    const known = workflows.some((stored) => stored.id === workflow.id);
    if (!known && workflow.nodes.length === 0) return true;
    try {
      await persistWorkflow(workflow);
      return true;
    } catch (error) {
      setShowOpen(false);
      showFailure(error);
      return false;
    }
  }, [canvasWorkflow, workflows, persistWorkflow, showFailure]);

  const handleOpenWorkflow = useCallback(async (workflow: Workflow) => {
    if (!(await leaveCanvas())) return;
    setShowOpen(false);
    clearExecution();
    setCurrentWorkflow(workflow);
  }, [leaveCanvas, clearExecution, setCurrentWorkflow]);

  const handleNewWorkflow = useCallback(async (folder: string) => {
    if (!(await leaveCanvas())) return;
    setShowOpen(false);
    clearExecution();
    setCurrentWorkflow(blankWorkflow(folder));
  }, [leaveCanvas, clearExecution, setCurrentWorkflow]);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      
      const type = event.dataTransfer.getData('application/reactflow');
      if (!type) return;

      const position = {
        x: event.clientX - 250,
        y: event.clientY - 100
      };

      const getDefaultLabel = () => {
        switch (type) {
          case 'prompt': return 'AI Prompt';
          case 'branch': return 'Branch';
          case 'aggregate': return 'Aggregate';
          case 'human_gate': return 'Human Gate';
          case 'input': return 'User Input';
          case 'output': return 'Output';
          default: return type;
        }
      };

      const getDefaultConfig = () => {
        switch (type) {
          case 'prompt':
            return {
              systemPrompt: 'You are a helpful assistant.',
              userPrompt: '{{input}}',
              model: DEFAULT_WORKFLOW_MODEL,
              temperature: 0.7,
              maxTokens: 2048
            };
          case 'input':
            return {
              inputType: 'text',
              required: false,
              description: ''
            };
          case 'aggregate':
            return {
              strategy: 'concat'
            };
          case 'branch':
            // Not `context.input.includes(...)`: that is JavaScript, and a
            // condition is an expression the parser evaluates, so every branch
            // dropped on the canvas used to fail on its first run.
            return {
              condition: DEFAULT_BRANCH_CONDITION
            };
          case 'human_gate':
            return {
              instructions: 'Review the content, then approve it or send it back.',
              allowEdit: false,
              maxRevisions: 3
            };
          case 'output':
            return { format: 'auto' };
          default:
            return {};
        }
      };

      const newNode = {
        id: `${type}-${Date.now()}`,
        type,
        position,
        data: { 
          label: getDefaultLabel(),
          config: getDefaultConfig()
        }
      };

      setNodes((nds) => nds.concat(newNode));
      setSelectedNode(null);
    },
    [setNodes]
  );

  // Handle keyboard shortcuts for deletion
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedEdge) {
          handleDeleteEdge();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedEdge, handleDeleteEdge]);

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  return (
    <div className="flex h-screen w-full overflow-hidden">
      <NodePalette />
      
      <div className="flex-1 flex flex-col overflow-hidden">
        <Toolbar
          onRun={handleRun}
          onStop={() => currentExecutionId && cancelExecution(currentExecutionId)}
          isRunning={isExecuting}
          isConnected={isConnected}
          onToggleLog={() => setShowLog(!showLog)}
          showLog={showLog}
          onToggleRuns={() => setShowRuns(!showRuns)}
          showRuns={showRuns}
          onOpenChat={handleOpenChat}
          onOpen={() => setShowOpen(true)}
          onValidate={handleValidate}
          onExport={handleExport}
          onImport={() => setShowImport(true)}
        />
        
        <div className="flex-1 flex overflow-hidden">
          <div 
            ref={flowWrapper}
            className="flex-1 relative"
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            <ReactFlow
              nodes={nodes}
              edges={edges.map(edge => decorateEdge(edge, nodes, selectedEdge?.id === edge.id))}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={onNodeClick}
              onEdgeClick={onEdgeClick}
              onPaneClick={onPaneClick}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onMouseDown={handleMouseDown}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              snapToGrid
              snapGrid={[15, 15]}
              className="bg-slate-950"
              selectionOnDrag={true}
              selectionMode={SelectionMode.Partial}
              multiSelectionKeyCode="Control"
            >
              <Background color="#475569" gap={20} size={1} />
              <Controls className="bg-slate-800 border-slate-700" />
              <MiniMap 
                className="bg-slate-800 border-slate-700"
                nodeColor={(node) => {
                  switch (node.type) {
                    case 'prompt': return '#3b82f6';
                    case 'branch': return '#f59e0b';
                    case 'aggregate': return '#10b981';
                    case 'human_gate': return '#a855f7';
                    default: return '#64748b';
                  }
                }}
              />
              
              <Panel position="bottom-center" className="mb-4">
                <div className="flex gap-2 text-xs text-slate-400 bg-slate-900/80 px-3 py-2 rounded-lg">
                  <span>Space + Drag to pan</span>
                  <span>•</span>
                  <span>Ctrl + Drag to select</span>
                  <span>•</span>
                  <span>Cmd+Enter to run</span>
                  <span>•</span>
                  <span>Delete to remove</span>
                </div>
              </Panel>

              {/* A run reopened from history: the canvas shows what it produced,
                  and says so, because nothing else distinguishes it from a run
                  that just finished. */}
              {viewingRun && !isExecuting && (
                <Panel position="top-left" className="mt-4 ml-4">
                  <div className="flex items-center gap-3 bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 shadow-lg">
                    <span className="text-xs text-slate-300">
                      Past run · {runWhen(viewingRun.startedAt)} ·{' '}
                      <span className={statusTone(viewingRun.status)}>{viewingRun.status}</span>
                    </span>
                    <div className="h-4 w-px bg-slate-600" />
                    <button
                      onClick={clearExecution}
                      className="text-xs text-slate-400 hover:text-white transition-colors"
                      title="Clear the results from the canvas"
                    >
                      Clear
                    </button>
                  </div>
                </Panel>
              )}

              {selectedEdge && (
                <Panel position="top-center" className="mt-4">
                  <div className="flex items-center gap-3 bg-slate-800 border border-blue-500/50 rounded-lg px-4 py-2 shadow-lg">
                    <span className="text-sm text-slate-300">
                      Connection: <span className="text-blue-400 font-mono">{selectedEdge.source}</span>
                      <span className="text-slate-500 mx-2">→</span>
                      <span className="text-blue-400 font-mono">{selectedEdge.target}</span>
                    </span>
                    <div className="h-4 w-px bg-slate-600" />
                    <button
                      onClick={handleDeleteEdge}
                      className="text-xs bg-red-600/80 hover:bg-red-500 text-white px-3 py-1 rounded transition-colors"
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => setSelectedEdge(null)}
                      className="text-xs text-slate-400 hover:text-white transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </Panel>
              )}
              {pendingGate && currentExecutionId && (
                // `nopan`: dragging the panel moves the panel, not the canvas
                // under it.
                <Panel position="top-right" className="mt-4 mr-4 nopan">
                  <GateDecisionPanel
                    gate={pendingGate}
                    label={nodes.find((n) => n.id === pendingGate.nodeId)?.data?.label ?? pendingGate.nodeId}
                    onDecide={(decision) => resumeGate(currentExecutionId, pendingGate.nodeId, decision)}
                    onCancel={() => cancelExecution(currentExecutionId)}
                    offset={gateOffset}
                    onMove={setGateOffset}
                  />
                </Panel>
              )}
            </ReactFlow>
            
            {/* Selection Box Overlay */}
            {selectionBox?.isSelecting && (
              <div
                className="absolute border-2 border-blue-400 bg-blue-400/10 pointer-events-none z-50"
                style={{
                  left: Math.min(selectionBox.startX, selectionBox.endX),
                  top: Math.min(selectionBox.startY, selectionBox.endY),
                  width: Math.abs(selectionBox.endX - selectionBox.startX),
                  height: Math.abs(selectionBox.endY - selectionBox.startY)
                }}
              />
            )}
          </div>
          
          {selectedNode && (
            <NodeConfigPanel
              key={selectedNode.id}
              node={selectedNode}
              nodes={nodes}
              edges={edges}
              onClose={() => setSelectedNode(null)}
              onUpdate={(updates) => {
                setNodes((nds) =>
                  nds.map((n) =>
                    n.id === selectedNode.id ? { ...n, data: { ...n.data, ...updates } } : n
                  )
                );
              }}
              onDeleteEdge={(edgeId) => {
                setEdges((eds) => eds.filter((e) => e.id !== edgeId));
              }}
            />
          )}
          
          {showLog && (
            <ExecutionLogPanel onClose={() => setShowLog(false)} />
          )}

          {showRuns && (
            <RunHistoryPanel
              workflowId={currentWorkflow?.id}
              onClose={() => setShowRuns(false)}
            />
          )}
        </div>
      </div>

      {validation && (
        <ValidationPanel result={validation} onClose={() => setValidation(null)} />
      )}
      {showImport && (
        <ImportModal onClose={() => setShowImport(false)} onImported={handleImported} />
      )}
      {showOpen && (
        <OpenWorkflowDialog
          initialPath={currentWorkflow?.folder ?? ROOT_FOLDER}
          onCanvas
          onClose={() => setShowOpen(false)}
          onOpen={(workflow) => void handleOpenWorkflow(workflow)}
          onNew={(folder) => void handleNewWorkflow(folder)}
        />
      )}
      {runInputs && (
        <RunInputsModal
          inputs={runInputs.inputs}
          onClose={() => setRunInputs(null)}
          onRun={(values) => {
            const { workflow } = runInputs;
            setRunInputs(null);
            void launch(workflow, values);
          }}
        />
      )}
    </div>
  );
}

// The provider lives here rather than in App so that App never imports
// reactflow itself — that is what keeps it out of the entry chunk.
export default function CanvasView({
  openImportOnMount = false,
  onOpenChat
}: {
  openImportOnMount?: boolean;
  onOpenChat: () => void;
}) {
  return (
    <ReactFlowProvider>
      <Flow openImportOnMount={openImportOnMount} onOpenChat={onOpenChat} />
    </ReactFlowProvider>
  );
}
