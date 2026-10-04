import type { PointerEventState } from '@blocksuite/std';
import { BaseTool } from '@blocksuite/std/gfx';
import { attachRightButtonNavigation } from './right-button-navigation';

/** Keep the engine's object selection, editing and handles. Only a plain mouse
 * drag that starts on empty canvas becomes viewport navigation. */
export class CanvasNavigationTool extends BaseTool {
  static override toolName = 'whiteboard:canvas-navigation';
  private origin: { x: number; y: number } | null = null;
  private lastPoint: { x: number; y: number } | null = null;
  private ownsPan = false;

  private setPanning(value: boolean) {
    this.std.host.closest('.editor-canvas')?.classList.toggle('canvas-panning', value);
  }

  private cancelPan = () => {
    this.origin = null;
    this.lastPoint = null;
    this.setPanning(false);
    // Keep consuming this gesture until dragEnd; a cancelled pan must not turn
    // into a selection or object move if the pointer returns to the window.
  };

  override mounted() {
    this.disposable.add(attachRightButtonNavigation(this.std.host, {
      canStart: raw => {
        const bounds = this.std.host.getBoundingClientRect();
        return this.canNavigate(raw, raw.clientX - bounds.left, raw.clientY - bounds.top);
      },
      pan: (dx, dy) => this.gfx.viewport.applyDeltaCenter(dx / this.gfx.viewport.zoom, dy / this.gfx.viewport.zoom),
      setPanning: value => this.setPanning(value),
    }));
    // Hooks run before the active tool. Returning false claims only the empty
    // drag; all object gestures and Shift marquee selection stay native.
    this.addHook('pointerDown', event => this.beginPointer(event));
    this.addHook('pointerUp', () => { this.origin = null; });
    this.addHook('dragStart', event => {
      if (this.controller.currentTool$.peek()?.toolName !== 'default' || !this.origin ||
        event.raw.shiftKey || event.raw.altKey || event.raw.ctrlKey || event.raw.metaKey) return;
      this.ownsPan = true;
      this.lastPoint = this.origin;
      this.setPanning(true);
      event.raw.preventDefault();
      return false;
    });
    this.addHook('dragMove', event => {
      if (!this.ownsPan) return;
      if (this.lastPoint) {
        const { viewport } = this.gfx;
        viewport.applyDeltaCenter((this.lastPoint.x - event.x) / viewport.zoom, (this.lastPoint.y - event.y) / viewport.zoom);
        this.lastPoint = { x: event.x, y: event.y };
        event.raw.preventDefault();
      }
      return false;
    });
    this.addHook('dragEnd', () => {
      if (!this.ownsPan) return;
      this.cancelPan();
      this.ownsPan = false;
      return false;
    });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') this.cancelPan();
    };
    window.addEventListener('blur', this.cancelPan);
    window.addEventListener('pointercancel', this.cancelPan);
    window.addEventListener('keydown', keydown);
    this.disposable.add(() => {
      window.removeEventListener('blur', this.cancelPan);
      window.removeEventListener('pointercancel', this.cancelPan);
      window.removeEventListener('keydown', keydown);
      this.cancelPan();
    });
  }

  private beginPointer(event: PointerEventState) {
    this.cancelPan();
    this.ownsPan = false;
    const { raw } = event;
    if (raw.button === 0 && raw.isPrimary && raw.pointerType === 'mouse' &&
      !raw.shiftKey && !raw.altKey && !raw.ctrlKey && !raw.metaKey &&
      this.canNavigate(raw, event.x, event.y)) {
      this.origin = { x: event.x, y: event.y };
    }
  }

  private canNavigate(raw: PointerEvent, viewX: number, viewY: number) {
    if (this.controller.currentTool$.peek()?.toolName !== 'default') return false;
    const [x, y] = this.gfx.viewport.toModelCoord(viewX, viewY);
    const interactive = raw.composedPath().some(target => target instanceof HTMLElement &&
      target.matches('button, input, textarea, select, [contenteditable="true"], [role="button"], affine-toolbar-widget'));
    return !this.gfx.selection.editing && !interactive &&
      !this.gfx.selection.isInSelectedRect(x, y) && !this.gfx.getElementByPoint(x, y);
  }
}
