import { useState, type ReactNode } from 'react';

interface SettingsSectionProps {
  title: string;
  /** Set fields in this section — shown as a badge, and what `onReset` clears. */
  count: number;
  onReset?: () => void;
  /** Controlled open state; the section manages its own when omitted. */
  open?: boolean;
  onToggle?: () => void;
  /** A line under the header, visible open or closed. */
  note?: ReactNode;
  children?: ReactNode;
}

/** A collapsible group of settings with a set-count badge and a reset. */
export function SettingsSection({ title, count, onReset, open, onToggle, note, children }: SettingsSectionProps) {
  const [ownOpen, setOwnOpen] = useState(false);
  const isOpen = open ?? ownOpen;
  const toggle = onToggle ?? (() => setOwnOpen(!ownOpen));

  return (
    <section className="border border-slate-800 rounded">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={isOpen}
          className="flex-1 flex items-center gap-2 text-left text-sm text-slate-200"
        >
          <span className="text-xs text-slate-500 w-3">{isOpen ? '▾' : '▸'}</span>
          <span className="font-medium">{title}</span>
          {count > 0 && (
            <span className="ml-1 px-1.5 rounded-full bg-blue-600/30 text-blue-200 text-[11px] leading-4">
              {count}
            </span>
          )}
        </button>
        {count > 0 && onReset && (
          <button
            type="button"
            onClick={onReset}
            className="text-xs text-slate-500 hover:text-slate-300"
            title="Clear every setting in this section"
          >
            reset
          </button>
        )}
      </div>
      {note && <div className="px-3 pb-2 -mt-1 text-xs text-slate-500">{note}</div>}
      {isOpen && children && (
        <div className="px-3 pt-3 pb-3 space-y-3 border-t border-slate-800">{children}</div>
      )}
    </section>
  );
}
