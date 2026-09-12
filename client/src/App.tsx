import { useState, useEffect, lazy, Suspense } from 'react';

import { useWorkflowStore } from './stores/workflowStore';
import { createExampleWorkflow } from '@joseki/shared';

// Both heavy surfaces load on demand. The canvas pulls in reactflow, the seven
// node components and the Monaco-backed config panel; the chat view pulls in
// react-markdown and remark-gfm. Neither is needed for the welcome screen, and
// most sessions only ever open one of the two — so keeping them out of the
// entry chunk is what makes the first load small.
const CanvasView = lazy(() => import('./views/CanvasView'));
const ChatView = lazy(() =>
  import('./components/chat/ChatView').then((m) => ({ default: m.ChatView }))
);

function ViewFallback() {
  return (
    <div className="h-screen w-full bg-slate-950 flex items-center justify-center">
      <div className="text-slate-500 text-sm">Loading…</div>
    </div>
  );
}

function App() {
  const { loadWorkflows, workflows, setCurrentWorkflow, currentWorkflow } = useWorkflowStore();
  const [view, setView] = useState<'welcome' | 'canvas' | 'chat'>('welcome');
  const [importOnStart, setImportOnStart] = useState(false);

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
    setView('canvas');
  };

  // Opens the editor on an empty workflow with the import dialog already up;
  // a successful import replaces the placeholder.
  const handleImportWorkflow = () => {
    setImportOnStart(true);
    handleCreateWorkflow();
  };

  const handleLoadWorkflow = (workflow: any) => {
    setCurrentWorkflow(workflow);
    setView('canvas');
  };

  const handleLoadExample = () => {
    const exampleWorkflow = createExampleWorkflow();
    setCurrentWorkflow(exampleWorkflow);
    setView('canvas');
  };

  if (view === 'chat') {
    return (
      <Suspense fallback={<ViewFallback />}>
        <ChatView onOpenWorkflows={() => setView(currentWorkflow ? 'canvas' : 'welcome')} />
      </Suspense>
    );
  }

  if (view === 'welcome') {
    return (
      <div className="h-screen w-full bg-slate-950 flex items-center justify-center">
        <div className="max-w-2xl w-full mx-4">
          <h1 className="text-4xl font-bold text-white mb-2">Joseki</h1>
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
              onClick={handleLoadExample}
              className="p-6 bg-slate-900 border border-slate-800 rounded-lg hover:border-emerald-500 transition-colors text-left"
            >
              <div className="text-2xl mb-2">&#9889;</div>
              <div className="font-semibold text-white">Try Example</div>
              <div className="text-sm text-slate-400">Content Review Pipeline</div>
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

            <button
              onClick={handleImportWorkflow}
              className="p-6 bg-slate-900 border border-slate-800 rounded-lg hover:border-blue-500 transition-colors text-left"
            >
              <div className="text-2xl mb-2">⇪</div>
              <div className="font-semibold text-white">Import Workflow</div>
              <div className="text-sm text-slate-400">From a Joseki JSON export</div>
            </button>

            <button
              onClick={() => setView('chat')}
              className="col-span-2 p-6 bg-slate-900 border border-slate-800 rounded-lg hover:border-purple-500 transition-colors text-left"
            >
              <div className="text-2xl mb-2">💬</div>
              <div className="font-semibold text-white">Chat</div>
              <div className="text-sm text-slate-400">Talk to any model on OpenRouter, outside a workflow</div>
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
    <Suspense fallback={<ViewFallback />}>
      <CanvasView
        openImportOnMount={importOnStart}
        onOpenChat={() => {
          setImportOnStart(false);
          setView('chat');
        }}
      />
    </Suspense>
  );
}

export default App;
