import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

export interface Offset {
  x: number;
  y: number;
}

export const NO_OFFSET: Offset = { x: 0, y: 0 };

/** Keeps this much of a panel on screen, so a dragged one can always be dragged back. */
export const KEEP_VISIBLE = 80;

/** A panel's place in the window with no offset applied, and the window itself. */
interface Frame {
  panel: { left: number; top: number; width: number };
  viewport: { width: number; height: number };
}

/**
 * Where a panel may go: far enough to be cleared out of the way, never so far
 * that the handle leaves the window and strands it.
 *
 * Upward travel is limited to the panel's own top, because a panel dragged
 * above the window has its handle — the header — off screen first, and there
 * would be nothing left to grab.
 */
export function clampOffset(next: Offset, { panel, viewport }: Frame): Offset {
  return {
    x: Math.min(
      Math.max(next.x, KEEP_VISIBLE - panel.left - panel.width),
      viewport.width - panel.left - KEEP_VISIBLE
    ),
    y: Math.min(Math.max(next.y, -panel.top), viewport.height - panel.top - KEEP_VISIBLE)
  };
}

/**
 * Drag a panel around by a handle.
 *
 * The panel keeps its place in the layout and is moved with a transform, so
 * nothing it sits next to reflows while it travels. The offset is held by the
 * caller rather than in here: a human gate's panel is unmounted every time the
 * run moves past it, and a reviewer who pushed it aside to read the canvas
 * should not have to push the next one aside too.
 *
 * Pointer events, not mouse — so a pen or a touch drags it as well — and the
 * pointer is captured, so a fast drag that outruns the handle keeps going
 * instead of being dropped.
 */
export function usePointerDrag(
  offset: Offset,
  onChange: (offset: Offset) => void,
  panel: React.RefObject<HTMLElement | null>
) {
  const from = useRef<{ x: number; y: number; offset: Offset } | null>(null);
  const [dragging, setDragging] = useState(false);

  const clamp = useCallback(
    (next: Offset): Offset => {
      const el = panel.current;
      if (!el) return next;
      const rect = el.getBoundingClientRect();
      return clampOffset(next, {
        // The rect already includes the current offset; measure the
        // untransformed position so the limits do not drift as it moves.
        panel: { left: rect.left - offset.x, top: rect.top - offset.y, width: rect.width },
        viewport: { width: window.innerWidth, height: window.innerHeight }
      });
    },
    [offset.x, offset.y, panel]
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      // A drag on the handle is not a pan of the canvas underneath it.
      event.preventDefault();
      event.stopPropagation();
      from.current = { x: event.clientX, y: event.clientY, offset };
      setDragging(true);
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    },
    [offset]
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent) => {
      const start = from.current;
      if (!start) return;
      onChange(
        clamp({
          x: start.offset.x + (event.clientX - start.x),
          y: start.offset.y + (event.clientY - start.y)
        })
      );
    },
    [clamp, onChange]
  );

  const onPointerUp = useCallback((event: ReactPointerEvent) => {
    from.current = null;
    setDragging(false);
    const el = event.currentTarget as HTMLElement;
    if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
  }, []);

  // A window that shrank can leave a panel that was pushed aside off the edge.
  useEffect(() => {
    const onResize = () => onChange(clamp(offset));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clamp, offset, onChange]);

  return {
    dragging,
    /** Spread onto the element that acts as the drag handle. */
    handleProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
    /** Spread onto the panel itself. */
    panelStyle: {
      transform: offset.x || offset.y ? `translate(${offset.x}px, ${offset.y}px)` : undefined
    }
  };
}
