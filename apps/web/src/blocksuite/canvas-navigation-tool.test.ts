import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PointerEventState } from '@blocksuite/std';

// Exercise the actual hook implementation without loading the browser-only
// editor. Undefined lets the native tool handle the event; false claims it.
vi.mock('@blocksuite/std/gfx', () => ({
  BaseTool: class {
    hooks = new Map<string, (event: PointerEventState) => boolean | void>();
    disposers: Array<() => void> = [];
    disposable = { add: (fn: () => void) => this.disposers.push(fn) };
    constructor(readonly gfx: any) {}
    get std() { return this.gfx.std; }
    get controller() { return this.gfx.tool; }
    addHook(name: string, fn: (event: PointerEventState) => boolean | void) { this.hooks.set(name, fn); }
  },
}));
import { CanvasNavigationTool } from './canvas-navigation-tool';

const disposers: Array<() => void> = [];
class TestElement { matches() { return true; } }
function fixture() {
  const delta = vi.fn();
  const cursor = vi.fn();
  const host = Object.assign(new EventTarget(), {
    closest: () => ({ classList: { toggle: cursor } }),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  });
  const gfx = {
    std: { host },
    tool: { currentTool$: { peek: () => ({ toolName: 'default' }) } },
    viewport: { zoom: 2, toModelCoord: (x: number, y: number) => [x / 2, y / 2], applyDeltaCenter: delta },
    selection: { editing: false, isInSelectedRect: () => false },
    getElementByPoint: vi.fn((): object[] => []),
  };
  const tool = new CanvasNavigationTool(gfx as never);
  tool.mounted();
  disposers.push(() => (tool as unknown as { disposers: Array<() => void> }).disposers.forEach(dispose => dispose()));
  const hooks = (tool as unknown as { hooks: Map<string, (e: PointerEventState) => boolean | void> }).hooks;
  return { tool, gfx, delta, cursor, host, emit: (name: string, event = pointer()) => hooks.get(name)?.(event) };
}
function pointer(overrides: Record<string, unknown> = {}, x = 200, y = 300): PointerEventState {
  return { x, y, raw: { button: 0, isPrimary: true, pointerType: 'mouse', shiftKey: false, altKey: false,
    ctrlKey: false, metaKey: false, composedPath: () => [], preventDefault: vi.fn(), ...overrides } } as unknown as PointerEventState;
}
beforeEach(() => {
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('HTMLElement', TestElement);
});
afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose());
  vi.unstubAllGlobals();
});

describe('empty canvas navigation', () => {
  it('leaves plain left drags on empty canvas to area selection', () => {
    const { emit, delta, cursor } = fixture();
    expect(emit('pointerDown')).toBeUndefined();
    expect(emit('dragStart')).toBeUndefined();
    expect(emit('dragMove', pointer({}, 280, 340))).toBeUndefined();
    expect(emit('dragEnd')).toBeUndefined();
    expect(delta).not.toHaveBeenCalled();
    expect(cursor).not.toHaveBeenCalledWith('canvas-panning', true);
  });

  it('routes native right dragging through the same blank-canvas hit test and zoom', () => {
    const { host, delta } = fixture();
    const down = Object.assign(new Event('pointerdown', { cancelable: true }), {
      button: 2, isPrimary: true, pointerType: 'mouse', pointerId: 1, clientX: 200, clientY: 300,
    });
    host.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    window.dispatchEvent(Object.assign(new Event('pointermove', { cancelable: true }), {
      buttons: 2, pointerId: 1, clientX: 280, clientY: 340,
    }));
    expect(delta).toHaveBeenLastCalledWith(-40, -20);
  });

  it('pans from inside a frame but not from an object drawn on it', () => {
    for (const [hits, pans] of [[[{ flavour: 'affine:frame' }], true], [[{ flavour: 'affine:frame' }, { flavour: 'affine:note' }], false]] as const) {
      const { host, gfx, delta } = fixture();
      gfx.getElementByPoint.mockReturnValue([...hits]);
      const down = Object.assign(new Event('pointerdown', { cancelable: true }), {
        button: 2, isPrimary: true, pointerType: 'mouse', pointerId: 1, clientX: 200, clientY: 300, composedPath: () => [],
      });
      host.dispatchEvent(down);
      window.dispatchEvent(Object.assign(new Event('pointermove', { cancelable: true }), {
        buttons: 2, pointerId: 1, clientX: 280, clientY: 340,
      }));
      expect(down.defaultPrevented).toBe(pans);
      expect(delta).toHaveBeenCalledTimes(pans ? 1 : 0);
      disposers.pop()!();
    }
  });

  it('preserves right-clicks on objects, selections, controls, and with creation tools', () => {
    for (const kind of ['object', 'selection', 'editing', 'control', 'shape']) {
      const { host, gfx, delta } = fixture();
      if (kind === 'object') gfx.getElementByPoint.mockReturnValue([{ id: 'note' }]);
      if (kind === 'selection') gfx.selection.isInSelectedRect = () => true;
      if (kind === 'editing') gfx.selection.editing = true;
      if (kind === 'shape') gfx.tool.currentTool$.peek = () => ({ toolName: 'shape' });
      const event = Object.assign(new Event('pointerdown', { cancelable: true }), {
        button: 2, isPrimary: true, pointerType: 'mouse', pointerId: 1, clientX: 200, clientY: 300,
        composedPath: () => kind === 'control' ? [new TestElement()] : [],
      });
      host.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(delta).not.toHaveBeenCalled();
      disposers.pop()!();
    }
  });
});
