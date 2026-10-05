import { BaseTool } from '@blocksuite/std/gfx';
import { attachRightButtonNavigation } from './right-button-navigation';

/** Right-drag on empty canvas, including inside a frame, moves the viewport.
 * Left-drag stays with the engine, so it selects an area as it does in other
 * whiteboards; trackpad scrolling, Space + drag and the Hand tool still pan. */
export class CanvasNavigationTool extends BaseTool {
  static override toolName = 'whiteboard:canvas-navigation';

  private setPanning(value: boolean) {
    this.std.host.closest('.editor-canvas')?.classList.toggle('canvas-panning', value);
  }

  override mounted() {
    this.disposable.add(attachRightButtonNavigation(this.std.host, {
      canStart: raw => {
        const bounds = this.std.host.getBoundingClientRect();
        return this.canNavigate(raw, raw.clientX - bounds.left, raw.clientY - bounds.top);
      },
      pan: (dx, dy) => this.gfx.viewport.applyDeltaCenter(dx / this.gfx.viewport.zoom, dy / this.gfx.viewport.zoom),
      setPanning: value => this.setPanning(value),
    }));
  }

  private canNavigate(raw: PointerEvent, viewX: number, viewY: number) {
    if (this.controller.currentTool$.peek()?.toolName !== 'default') return false;
    const [x, y] = this.gfx.viewport.toModelCoord(viewX, viewY);
    const interactive = raw.composedPath().some(target => target instanceof HTMLElement &&
      target.matches('button, input, textarea, select, [contenteditable="true"], [role="button"], affine-toolbar-widget'));
    // A frame's interior is background for navigation; anything drawn on top
    // of it keeps its own right-click.
    const onObject = this.gfx.getElementByPoint(x, y, { all: true })
      .some(element => !('flavour' in element && element.flavour === 'affine:frame'));
    return !this.gfx.selection.editing && !interactive &&
      !this.gfx.selection.isInSelectedRect(x, y) && !onObject;
  }
}
