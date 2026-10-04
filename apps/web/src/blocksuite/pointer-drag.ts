import {
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";

export type DragPoint = { x: number; y: number };
/** Capture one gesture without handing the pointer stream to the canvas tools. */
export function usePointerDrag(callbacks: {
  preview: (point: DragPoint | null) => void;
  drop: (point: DragPoint) => void;
}) {
  const latest = useRef(callbacks);
  latest.current = callbacks;
  const cleanup = useRef<(() => void) | null>(null);
  const suppressUntil = useRef(0);
  useEffect(() => () => cleanup.current?.(), []);
  return {
    cancel() {
      cleanup.current?.();
    },
    consumeClick() {
      return performance.now() < suppressUntil.current;
    },
    start(event: ReactPointerEvent<HTMLElement>) {
      if (event.button !== 0 || !event.isPrimary) return;
      cleanup.current?.();
      const element = event.currentTarget;
      const id = event.pointerId;
      const origin = { x: event.clientX, y: event.clientY };
      let dragging = false;
      element.setPointerCapture(id);
      const stop = (cancelled = false) => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", cancel, true);
        window.removeEventListener("keydown", key, true);
        window.removeEventListener("blur", cancel);
        element.removeEventListener("lostpointercapture", cancel);
        if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
        latest.current.preview(null);
        cleanup.current = null;
        if (dragging || cancelled)
          suppressUntil.current = performance.now() + 400;
      };
      const move = (next: PointerEvent) => {
        if (next.pointerId !== id) return;
        const point = { x: next.clientX, y: next.clientY };
        dragging ||= Math.hypot(point.x - origin.x, point.y - origin.y) >= 6;
        if (!dragging) return;
        next.preventDefault();
        next.stopPropagation();
        latest.current.preview(point);
      };
      const up = (next: PointerEvent) => {
        if (next.pointerId !== id) return;
        if (dragging) {
          next.preventDefault();
          next.stopPropagation();
        }
        stop();
        if (dragging) latest.current.drop({ x: next.clientX, y: next.clientY });
      };
      const cancel = () => stop(true);
      const key = (next: KeyboardEvent) => {
        if (next.key === "Escape") {
          next.preventDefault();
          next.stopImmediatePropagation();
          stop(true);
        }
      };
      cleanup.current = cancel;
      window.addEventListener("pointermove", move, {
        capture: true,
        passive: false,
      });
      window.addEventListener("pointerup", up, true);
      window.addEventListener("pointercancel", cancel, true);
      window.addEventListener("keydown", key, true);
      window.addEventListener("blur", cancel);
      element.addEventListener("lostpointercapture", cancel);
    },
  };
}
