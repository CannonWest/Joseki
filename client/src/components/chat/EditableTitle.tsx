import { useEffect, useState, type KeyboardEvent } from 'react';

interface EditableTitleProps {
  value: string;
  onChange: (value: string) => void;
}

export function EditableTitle({ value, onChange }: EditableTitleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== value) onChange(next);
    else setDraft(value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') commit();
    if (event.key === 'Escape') {
      setDraft(value);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onFocus={(event) => event.target.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        className="w-80 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
      />
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="max-w-md truncate text-left text-sm font-semibold text-slate-200 hover:text-white transition-colors"
      title="Rename"
    >
      {value}
    </button>
  );
}
