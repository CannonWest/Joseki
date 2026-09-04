import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

interface ComposerProps {
  disabled: boolean;
  /** A reply is in progress — offer Stop instead of Send. */
  busy: boolean;
  placeholder?: string;
  onSend: (content: string) => void;
  onCancel: () => void;
}

export function Composer({ disabled, busy, placeholder, onSend, onCancel }: ComposerProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Grow with the text, up to a few lines
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const submit = () => {
    const content = text.trim();
    if (!content || disabled || busy) return;
    onSend(content);
    setText('');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-t border-slate-800 bg-slate-900 px-4 py-3">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          rows={1}
          placeholder={placeholder ?? 'Send a message — Enter to send, Shift+Enter for a new line'}
          className="flex-1 resize-none bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 disabled:opacity-50"
        />
        {busy ? (
          <button
            onClick={onCancel}
            className="px-4 py-2 bg-red-600/80 hover:bg-red-500 text-white text-sm font-medium rounded-md transition-colors"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={disabled || text.trim() === ''}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 text-white text-sm font-medium rounded-md transition-colors"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
