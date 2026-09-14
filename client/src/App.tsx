import { useEffect, lazy, Suspense, useState } from 'react';

import { blankWorkflow, useWorkflowStore } from './stores/workflowStore';
import { ROOT_FOLDER } from '@joseki/shared';
import { ViewBoundary } from './components/ViewBoundary';

// Both heavy surfaces load on demand. The canvas pulls in reactflow, the seven
// node components and the Monaco-backed config panel; the chat view pulls in
// react-markdown and remark-gfm. The app opens on the canvas, so the entry
// chunk stays small and each surface is fetched the first time it is shown.
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
  const { loadWorkflows, currentWorkflow, setCurrentWorkflow } = useWorkflowStore();
  const [view, setView] = useState<'canvas' | 'chat'>('canvas');

  useEffect(() => {
    loadWorkflows();
  }, [loadWorkflows]);

  // The app opens straight on the canvas, so it needs a workflow to edit.
  useEffect(() => {
    if (!currentWorkflow) {
      setCurrentWorkflow(blankWorkflow(ROOT_FOLDER));
    }
  }, [currentWorkflow, setCurrentWorkflow]);

  if (view === 'chat') {
    return (
      <ViewBoundary>
        <Suspense fallback={<ViewFallback />}>
          <ChatView onOpenWorkflows={() => setView('canvas')} />
        </Suspense>
      </ViewBoundary>
    );
  }

  return (
    <ViewBoundary>
      <Suspense fallback={<ViewFallback />}>
        <CanvasView onOpenChat={() => setView('chat')} />
      </Suspense>
    </ViewBoundary>
  );
}

export default App;
