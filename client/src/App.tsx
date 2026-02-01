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

import { useWorkflowStore } from './stores/workflowStore';
import { useExecutionStore } from './stores/executionStore';
import { useSocket } from './hooks/useSocket';
import { NodePalette } from './components/NodePalette';
import { NodeConfigPanel } from './components/NodeConfigPanel';
import { ChatPanel } from './components/ChatPanel';
import { Toolbar } from './components/Toolbar';
import { StepflowPanel } from './components/StepflowPanel';
import { PromptNode } from './nodes/PromptNode';
import { BranchNode } from './nodes/BranchNode';
import { InputNode } from './nodes/InputNode';
import { OutputNode } from './nodes/OutputNode';
import { AggregateNode } from './nodes/AggregateNode';
import { HumanGateNode } from './nodes/HumanGateNode';
import { ModelCompareNode } from './nodes/ModelCompareNode';

const nodeTypes = {
  prompt: PromptNode,
  branch: BranchNode,
  input: InputNode,
  output: OutputNode,
  aggregate: AggregateNode,
  human_gate: HumanGateNode,
  model_compare: ModelCompareNode
};

interface SelectionBox {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  isSelecting: boolean;
}

function Flow() {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<Edge | null>(null);
  const [showChat, setShowChat] = useState(false);
  const [showStepflow, setShowStepflow] = useState(false);
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  
  const flowWrapper = useRef<HTMLDivElement>(null);
  const { project } = useReactFlow();
  
  const { currentWorkflow } = useWorkflowStore();
  const { isExecuting, startExecution } = useExecutionStore();
  const { socket, isConnected } = useSocket();

  useEffect(() => {
    if (currentWorkflow) {
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
        type: 'smoothstep',
        animated: false,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#64748b' }
      })));
    }
  }, [currentWorkflow, setNodes, setEdges]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => addEdge({ 
        ...connection, 
        type: 'smoothstep',
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

  const handleRun = useCallback(() => {
    if (!currentWorkflow || !socket) return;
    
    const executionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    startExecution(executionId);
    
    socket.emit('execution:start', {
      workflowId: currentWorkflow.id,
      executionId
    });
    
    setShowChat(true);
  }, [currentWorkflow, socket, startExecution]);

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
          case 'model_compare': return 'Compare Models';
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
              model: 'gpt-4',
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
            return {
              condition: 'context.input.includes("yes")'
            };
          case 'human_gate':
            return {
              approvalPrompt: 'Please review and approve to continue.'
            };
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
          isRunning={isExecuting}
          isConnected={isConnected}
          onToggleChat={() => setShowChat(!showChat)}
          showChat={showChat}
          onOpenStepflow={() => setShowStepflow(true)}
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
              edges={edges.map(edge => ({
                ...edge,
                style: {
                  ...edge.style,
                  stroke: selectedEdge?.id === edge.id ? '#3b82f6' : '#64748b',
                  strokeWidth: selectedEdge?.id === edge.id ? 3 : 2
                },
                markerEnd: {
                  type: MarkerType.ArrowClosed,
                  color: selectedEdge?.id === edge.id ? '#3b82f6' : '#64748b'
                }
              }))}
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
                    case 'model_compare': return '#ec4899';
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
          
          {showChat && (
            <ChatPanel onClose={() => setShowChat(false)} />
          )}
          
          {showStepflow && (
            <StepflowPanel onClose={() => setShowStepflow(false)} />
          )}
        </div>
      </div>
    </div>
  );
}

function App() {
  const { loadWorkflows, workflows, setCurrentWorkflow } = useWorkflowStore();
  const [showWelcome, setShowWelcome] = useState(true);

  useEffect(() => {
    loadWorkflows();
  }, [loadWorkflows]);

  const handleCreateWorkflow = () => {
    const newWorkflow = {
      id: `${Date.now()}`,
      name: 'New Workflow',
      nodes: [],
      edges: [],
      variables: {},
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    setCurrentWorkflow(newWorkflow);
    setShowWelcome(false);
  };

  const handleLoadWorkflow = (workflow: any) => {
    setCurrentWorkflow(workflow);
    setShowWelcome(false);
  };

  if (showWelcome) {
    return (
      <div className="h-screen w-full bg-slate-950 flex items-center justify-center">
        <div className="max-w-2xl w-full mx-4">
          <h1 className="text-4xl font-bold text-white mb-2">ConvChain Studio</h1>
          <p className="text-slate-400 mb-8">Visual IDE for conversational AI workflows</p>
          
          <div className="grid grid-cols-2 gap-4 mb-8">
            <button
              onClick={handleCreateWorkflow}
              className="p-6 bg-slate-900 border border-slate-800 rounded-lg hover:border-blue-500 transition-colors text-left"
            >
              <div className="text-2xl mb-2">+</div>
              <div className="font-semibold text-white">Create New Workflow</div>
              <div className="text-sm text-slate-400">Start from scratch</div>
            </button>
            
            <button
              onClick={() => handleLoadWorkflow(workflows[0])}
              disabled={workflows.length === 0}
              className="p-6 bg-slate-900 border border-slate-800 rounded-lg hover:border-blue-500 transition-colors text-left disabled:opacity-50"
            >
              <div className="text-2xl mb-2">📂</div>
              <div className="font-semibold text-white">Open Existing</div>
              <div className="text-sm text-slate-400">
                {workflows.length} workflow{workflows.length !== 1 ? 's' : ''}
              </div>
            </button>
          </div>
          
          <div className="bg-slate-900/50 border border-slate-800 rounded-lg p-4">
            <h3 className="font-semibold text-white mb-2">Quick Start</h3>
            <ol className="text-sm text-slate-400 space-y-1">
              <li>1. Drag nodes from the palette to the canvas</li>
              <li>2. Connect nodes by dragging from handles</li>
              <li>3. Configure prompts by clicking on nodes</li>
              <li>4. Press Cmd+Enter to run your workflow</li>
            </ol>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <Flow />
    </ReactFlowProvider>
  );
}

export default App;
