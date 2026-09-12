import { useEffect, useState, type ReactNode } from 'react';

export const fieldClass =
  'w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500';

export function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex justify-between gap-2 text-xs text-slate-400 mb-1">
      <span>{children}</span>
      {hint && <span className="text-slate-500 truncate">{hint}</span>}
    </label>
  );
}

interface NumberFieldProps {
  label: string;
  /** The stored value; undefined shows the placeholder (the gateway default). */
  value: number | undefined;
  /** Called with the number on blur / Enter, or `null` when the field was emptied. */
  onCommit: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  placeholder?: string;
  hint?: ReactNode;
}

/**
 * A number input that commits on blur / Enter and clears when emptied. The
 * text is local state, so a half-typed value never round-trips to the server.
 */
export function NumberField({
  label,
  value,
  onCommit,
  min,
  max,
  step,
  integer = false,
  placeholder = 'default',
  hint
}: NumberFieldProps) {
  const [text, setText] = useState(value === undefined ? '' : String(value));

  useEffect(() => {
    setText(value === undefined ? '' : String(value));
  }, [value]);

  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === '') {
      if (value !== undefined) onCommit(null);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setText(value === undefined ? '' : String(value));
      return;
    }
    let next = integer ? Math.round(parsed) : parsed;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    setText(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <div>
      <Label hint={hint}>{label}</Label>
      <input
        type="number"
        inputMode="decimal"
        value={text}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        className={fieldClass}
      />
    </div>
  );
}

interface ToggleProps {
  label: string;
  description?: ReactNode;
  /** The effective state — what the gateway will see, defaults included. */
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function Toggle({ label, description, checked, onChange, disabled = false }: ToggleProps) {
  return (
    <label className={`flex items-center justify-between gap-3 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <span className="min-w-0">
        <span className="block text-sm text-slate-200">{label}</span>
        {description && <span className="block text-xs text-slate-500">{description}</span>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-blue-500 shrink-0"
      />
    </label>
  );
}

interface SelectFieldProps {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  hint?: ReactNode;
}

export function SelectField({ label, value, options, onChange, hint }: SelectFieldProps) {
  return (
    <div>
      <Label hint={hint}>{label}</Label>
      <select value={value} onChange={(event) => onChange(event.target.value)} className={fieldClass}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A small toggle chip — for lists picked from a fixed set. */
export function Chip({
  active,
  onClick,
  title,
  tone = 'blue',
  children
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  tone?: 'blue' | 'green' | 'red';
  children: ReactNode;
}) {
  const on = {
    blue: 'border-blue-500 bg-blue-600/30 text-blue-100',
    green: 'border-emerald-500 bg-emerald-600/30 text-emerald-100',
    red: 'border-red-500 bg-red-600/30 text-red-100'
  }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`px-1.5 py-0.5 rounded text-[11px] leading-4 border transition-colors ${
        active ? on : 'border-slate-700 text-slate-500 hover:text-slate-300 hover:border-slate-500'
      }`}
    >
      {children}
    </button>
  );
}

/** How many fields of a params section are set — empty nested objects do not count. */
export function countSet<T extends object>(section: T | undefined): number {
  if (!section) return 0;
  return Object.values(section as Record<string, unknown>).filter((value) => {
    if (value === undefined || value === null) return false;
    if (typeof value === 'object' && !Array.isArray(value)) {
      return Object.values(value as Record<string, unknown>).some((inner) => inner !== undefined && inner !== null);
    }
    return true;
  }).length;
}
