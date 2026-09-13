import { useRef, useState } from 'react';
import type { ExecutionPausedEvent, GateDecision } from '@joseki/shared';
import { usePointerDrag, type Offset } from '../hooks/usePointerDrag';

interface GateDecisionPanelProps {
  gate: ExecutionPausedEvent;
  /** The gate node's label on the canvas. */
  label: string;
  onDecide: (decision: GateDecision) => void;
  onCancel: () => void;
  /**
   * Where the reviewer has pushed the panel. Held above this component so it
   * survives the panel being unmounted each time the run moves past the gate
   * — a gate that sends work back comes round again, and it should come round
   * where it was left.
   */
  offset: Offset;
  onMove: (offset: Offset) => void;
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/**
 * The reviewer's side of a human gate: what arrived, the gate's
 * instructions, and the two ways out. Approve carries the content on (or
 * the reviewer's edit, when the gate allows it); Send back takes the fail
 * arrows with an optional note the next pass can read.
 */
export function GateDecisionPanel({
  gate,
  label,
  onDecide,
  onCancel,
  offset,
  onMove
}: GateDecisionPanelProps) {
  const original = asText(gate.content);
  const [text, setText] = useState(original);
  const [note, setNote] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  const { dragging, handleProps, panelStyle } = usePointerDrag(offset, onMove, panel);

  const atLimit = gate.revision >= gate.maxRevisions;
  const edited = gate.allowEdit && text !== original;

  const approve = () => {
    const decision: GateDecision = { verdict: 'pass' };
    if (note.trim()) decision.note = note.trim();
    if (edited) decision.edited = text;
    onDecide(decision);
  };

  const sendBack = () => {
    const decision: GateDecision = { verdict: 'fail' };
    if (note.trim()) decision.note = note.trim();
    onDecide(decision);
  };

  return (
    <div
      ref={panel}
      style={panelStyle}
      className={`w-[28rem] max-w-[90vw] bg-slate-900 border border-purple-500/60 rounded-lg shadow-xl flex flex-col ${
        dragging ? 'select-none' : ''
      }`}
      data-testid="gate-decision-panel"
    >
      {/* The header is the handle: the panel covers the canvas it is asking
          about, so it has to be possible to push it aside and look. */}
      <div
        {...handleProps}
        title="Drag to move"
        className={`h-12 border-b border-slate-800 flex items-center justify-between px-4 touch-none ${
          dragging ? 'cursor-grabbing' : 'cursor-grab'
        }`}
      >
        <h3 className="font-semibold text-slate-200">
          <span className="text-purple-400 mr-2">👤</span>
          {label} is waiting
        </h3>
        <span className="text-xs text-slate-500">
          sent back {gate.revision} of {gate.maxRevisions}
        </span>
      </div>

      <div className="p-4 space-y-3">
        {gate.instructions && (
          <p className="text-sm text-slate-300">{gate.instructions}</p>
        )}

        <label className="block">
          <span className="text-xs text-slate-400">
            {gate.allowEdit ? 'Content under review — edit if needed' : 'Content under review'}
          </span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            readOnly={!gate.allowEdit}
            rows={8}
            className={`mt-1 w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200 font-mono ${
              gate.allowEdit ? '' : 'opacity-80'
            }`}
          />
        </label>

        <label className="block">
          <span className="text-xs text-slate-400">Note (optional) — travels with the decision</span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. too long; keep to two paragraphs"
            className="mt-1 w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200"
          />
        </label>

        {atLimit && (
          <p className="text-xs text-amber-400">
            This gate has used all {gate.maxRevisions} revisions — sending back again ends the run.
          </p>
        )}
      </div>

      <div className="border-t border-slate-800 px-4 py-3 flex items-center gap-2">
        <button
          onClick={onCancel}
          className="text-xs text-slate-400 hover:text-white transition-colors"
        >
          Cancel run
        </button>
        <div className="flex-1" />
        <button
          onClick={sendBack}
          className="px-3 py-1.5 text-sm rounded-md border border-red-500/60 text-red-300 hover:bg-red-900/40 transition-colors"
        >
          ↩ Send back
        </button>
        <button
          onClick={approve}
          className="px-4 py-1.5 text-sm rounded-md bg-green-600 hover:bg-green-500 text-white font-medium transition-colors"
        >
          ✓ Approve{edited ? ' with edits' : ''}
        </button>
      </div>
    </div>
  );
}
