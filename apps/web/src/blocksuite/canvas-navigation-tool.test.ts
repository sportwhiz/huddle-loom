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
    getElementByPoint: vi.fn((): object | null => null),
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
  it('pans by screen distance at the current zoom without claiming a click', () => {
    const { emit, delta, cursor } = fixture();
    expect(emit('pointerDown')).toBeUndefined();
    expect(delta).not.toHaveBeenCalled();
    expect(emit('dragStart')).toBe(false);
    expect(emit('dragMove', pointer({}, 280, 340))).toBe(false);
    expect(delta).toHaveBeenLastCalledWith(-40, -20);
    emit('dragMove', pointer({}, 300, 320));
    expect(delta).toHaveBeenLastCalledWith(-10, 10);
    expect(emit('dragEnd')).toBe(false);
    expect(cursor).toHaveBeenLastCalledWith('canvas-panning', false);
    expect(emit('dragMove')).toBeUndefined();
  });

  it.each(['shiftKey', 'altKey', 'ctrlKey', 'metaKey'])('preserves native modified gestures: %s', key => {
    const { emit, delta } = fixture();
    emit('pointerDown', pointer({ [key]: true }));
    expect(emit('dragStart', pointer({ [key]: true }))).toBeUndefined();
    expect(emit('dragMove')).toBeUndefined();
    expect(delta).not.toHaveBeenCalled();
  });

  it('respects Shift pressed between pointer-down and the drag threshold', () => {
    const { emit } = fixture();
    emit('pointerDown');
    expect(emit('dragStart', pointer({ shiftKey: true }))).toBeUndefined();
  });

  it('leaves objects, selection bounds, editing, and native handles with the editor', () => {
    for (const kind of ['object', 'selection', 'editing', 'control']) {
      const { emit, gfx, delta } = fixture();
      if (kind === 'object') gfx.getElementByPoint.mockReturnValue({ id: 'note' });
      if (kind === 'selection') gfx.selection.isInSelectedRect = () => true;
      if (kind === 'editing') gfx.selection.editing = true;
      emit('pointerDown', pointer(kind === 'control' ? { composedPath: () => [new TestElement()] } : {}));
      expect(emit('dragStart')).toBeUndefined();
      expect(delta).not.toHaveBeenCalled();
      disposers.pop()!();
    }
  });

  it('preserves creation tools, Hand, touch, pen and non-primary buttons', () => {
    for (const toolName of ['shape', 'whiteboard:sticky', 'brush', 'pan']) {
      const { emit, gfx } = fixture();
      gfx.tool.currentTool$.peek = () => ({ toolName });
      emit('pointerDown');
      expect(emit('dragStart')).toBeUndefined();
      disposers.pop()!();
    }
    for (const values of [{ pointerType: 'touch' }, { pointerType: 'pen' }, { button: 1 }, { button: 2 }, { isPrimary: false }]) {
      const { emit } = fixture();
      emit('pointerDown', pointer(values));
      expect(emit('dragStart')).toBeUndefined();
      disposers.pop()!();
    }
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

  it('preserves right-clicks on objects, selections, controls, and with creation tools', () => {
    for (const kind of ['object', 'selection', 'editing', 'control', 'shape']) {
      const { host, gfx, delta } = fixture();
      if (kind === 'object') gfx.getElementByPoint.mockReturnValue({ id: 'note' });
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

  it.each(['blur', 'pointercancel', 'keydown'])('ends navigation cleanly on %s', type => {
    const { emit, delta, cursor } = fixture();
    emit('pointerDown');
    emit('dragStart');
    window.dispatchEvent(Object.assign(new Event(type), { key: 'Escape' }));
    expect(cursor).toHaveBeenLastCalledWith('canvas-panning', false);
    expect(emit('dragMove')).toBe(false);
    expect(delta).not.toHaveBeenCalled();
    emit('dragEnd');
    emit('pointerDown');
    expect(emit('dragStart')).toBe(false);
  });
});
