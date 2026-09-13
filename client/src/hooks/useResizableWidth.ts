import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

interface Bounds {
  min: number;
  max: number;
}

/** A width the viewer picked, remembered per browser. Never read anywhere else. */
function remembered(key: string, fallback: number, bounds: Bounds): number {
  try {
    const stored = Number(window.localStorage.getItem(key));
    if (Number.isFinite(stored) && stored > 0) {
      return Math.min(Math.max(stored, bounds.min), bounds.max);
    }
  } catch {
    // Private windows and blocked site data both throw on read. A panel that
    // opens at its default width is a fine outcome; a panel that fails to
    // render is not.
  }
  return fallback;
}

function remember(key: string, width: number): void {
  try {
    window.localStorage.setItem(key, String(width));
  } catch {
    // Same again: worth trying, never worth failing over.
  }
}

/**
 * Drag a right-hand panel's left edge to widen it.
 *
 * The panel grows leftwards, so travel and width run opposite ways — pulling
 * the edge left makes it wider. The width outlives the panel being closed and
 * the page being reloaded, because the one thing worse than a panel too narrow
 * to read is having to widen it again every time.
 */
export function useResizableWidth(storageKey: string, initial: number, bounds: Bounds) {
  const [width, setWidth] = useState(() => remembered(storageKey, initial, bounds));
  const from = useRef<{ x: number; width: number } | null>(null);
  const [resizing, setResizing] = useState(false);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      from.current = { x: event.clientX, width };
      setResizing(true);
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    },
    [width]
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent) => {
      const start = from.current;
      if (!start) return;
      const next = Math.min(Math.max(start.width - (event.clientX - start.x), bounds.min), bounds.max);
      setWidth(next);
    },
    [bounds.max, bounds.min]
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent) => {
      if (from.current) remember(storageKey, width);
      from.current = null;
      setResizing(false);
      const el = event.currentTarget as HTMLElement;
      if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
    },
    [storageKey, width]
  );

  return {
    width,
    resizing,
    /** Spread onto the strip along the panel's left edge. */
    handleProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp }
  };
}
