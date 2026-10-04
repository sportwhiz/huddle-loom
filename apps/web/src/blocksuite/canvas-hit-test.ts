const CHROME =
  '.canvas-chrome, .collaboration-panel, .history-panel, .share-backdrop, .modal-backdrop, .follow-banner, .recovery-banner, affine-toolbar-widget, [role="dialog"]';

/** The chrome wrapper is pointer-transparent; only its interactive descendants
 * are hit targets. Excluding the wrapper covers every product overlay while
 * leaving the native canvas beneath empty chrome regions available. */
export function canvasPointAt(
  host: HTMLElement,
  point: { x: number; y: number },
) {
  const bounds = host.getBoundingClientRect();
  const target = document.elementFromPoint(point.x, point.y);
  if (
    !target ||
    point.x < bounds.left ||
    point.x > bounds.right ||
    point.y < bounds.top ||
    point.y > bounds.bottom ||
    target.closest(CHROME)
  )
    return null;
  return { x: point.x - bounds.left, y: point.y - bounds.top };
}
