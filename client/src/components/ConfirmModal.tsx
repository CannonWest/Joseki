interface ConfirmModalProps {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * A yes/no question over the canvas. Cancel holds focus and the confirm
 * button is red, because what asks here is about to take work away.
 */
export function ConfirmModal({ title, body, confirmLabel, onConfirm, onClose }: ConfirmModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"
      onClick={onClose}
      data-testid="confirm-modal"
    >
      <div
        className="w-[32rem] max-w-[90vw] bg-slate-900 border border-slate-800 rounded-lg shadow-xl flex flex-col"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <div className="h-12 border-b border-slate-800 flex items-center justify-between px-4">
          <h3 className="font-semibold text-slate-200">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors" aria-label="Close">
            ✕
          </button>
        </div>

        <p className="p-4 text-sm text-slate-300">{body}</p>

        <div className="h-14 border-t border-slate-800 flex items-center justify-end gap-2 px-4">
          <button
            autoFocus
            onClick={onClose}
            className="px-3 py-1.5 text-sm bg-slate-800 text-slate-300 hover:bg-slate-700 rounded-md transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-1.5 bg-red-600/80 hover:bg-red-500 text-white text-sm font-medium rounded-md transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
