import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachRightButtonNavigation } from "./right-button-navigation";

class Mouse extends Event {
  constructor(type: string, init: MouseEventInit = {}) {
    super(type, init);
    Object.assign(this, {
      button: init.button,
      clientX: init.clientX,
      clientY: init.clientY,
    });
  }
}
const disposers: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("MouseEvent", Mouse);
});
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});
function fixture() {
  const host = new EventTarget();
  const pan = vi.fn();
  const setPanning = vi.fn();
  const canStart = vi.fn(() => true);
  disposers.push(
    attachRightButtonNavigation(host as HTMLElement, {
      pan,
      setPanning,
      canStart,
    }),
  );
  const send = (
    target: EventTarget,
    type: string,
    overrides: Record<string, unknown> = {},
  ) => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      button: 2,
      buttons: 2,
      pointerId: 1,
      isPrimary: true,
      pointerType: "mouse",
      clientX: 100,
      clientY: 200,
      ...overrides,
    });
    target.dispatchEvent(event);
    return event;
  };
  return { host, pan, setPanning, canStart, send };
}

describe("right-button canvas navigation", () => {
  it("claims the drag before the editor and pans by screen distance, including outside the host", () => {
    const { host, send, pan, setPanning } = fixture();
    const editorDown = vi.fn();
    host.addEventListener("pointerdown", editorDown);
    expect(send(host, "pointerdown").defaultPrevented).toBe(true);
    expect(editorDown).not.toHaveBeenCalled();
    send(window, "pointermove", { clientX: 102 });
    expect(pan).not.toHaveBeenCalled();
    send(window, "pointermove", { clientX: 180, clientY: 240 });
    expect(pan).toHaveBeenLastCalledWith(-80, -40);
    send(window, "pointermove", { clientX: 200, clientY: 220 });
    expect(pan).toHaveBeenLastCalledWith(-20, 20);
    send(window, "pointerup");
    expect(setPanning).toHaveBeenLastCalledWith(false);
    expect(send(host, "contextmenu").defaultPrevented).toBe(true);
    send(window, "pointermove", { clientX: 300 });
    expect(pan).toHaveBeenCalledTimes(2);
  });

  it("preserves a context menu emitted on release without panning for click jitter", () => {
    const { host, send, pan } = fixture();
    send(host, "pointerdown");
    send(window, "pointermove", { clientX: 102, clientY: 201 });
    send(window, "pointerup");
    expect(send(host, "contextmenu").defaultPrevented).toBe(false);
    expect(pan).not.toHaveBeenCalled();
  });

  it("defers a menu emitted on press and replays it after a stationary click", () => {
    const { host, send } = fixture();
    const contextMenu = vi.fn();
    host.addEventListener("contextmenu", contextMenu);
    send(host, "pointerdown");
    expect(send(host, "contextmenu").defaultPrevented).toBe(true);
    expect(contextMenu).not.toHaveBeenCalled();
    send(window, "pointerup");
    expect(contextMenu).toHaveBeenCalledTimes(1);
    expect(contextMenu.mock.calls[0][0].clientX).toBe(100);
  });

  it("does not replay an early menu after panning and clears suppression for the next click", () => {
    const { host, send } = fixture();
    const contextMenu = vi.fn();
    host.addEventListener("contextmenu", contextMenu);
    send(host, "pointerdown");
    send(host, "contextmenu");
    send(window, "pointermove", { clientX: 180 });
    send(window, "pointerup");
    expect(contextMenu).not.toHaveBeenCalled();
    send(host, "pointerdown");
    send(window, "pointerup");
    send(host, "contextmenu");
    expect(contextMenu).toHaveBeenCalledTimes(1);
  });

  it.each([
    { button: 0 },
    { button: 1 },
    { pointerType: "touch" },
    { pointerType: "pen" },
    { isPrimary: false },
    { shiftKey: true },
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
  ])("leaves other gestures alone: %j", (overrides) => {
    const { host, send, pan } = fixture();
    expect(send(host, "pointerdown", overrides).defaultPrevented).toBe(false);
    send(window, "pointermove", { clientX: 180 });
    expect(pan).not.toHaveBeenCalled();
  });

  it("leaves objects and controls with their existing handlers", () => {
    const { host, send, canStart, pan } = fixture();
    canStart.mockReturnValue(false);
    expect(send(host, "pointerdown").defaultPrevented).toBe(false);
    expect(send(host, "contextmenu").defaultPrevented).toBe(false);
    send(window, "pointermove", { clientX: 180 });
    expect(pan).not.toHaveBeenCalled();
  });

  it.each(["blur", "pointercancel", "keydown", "missing button", "dispose"])(
    "ends safely on %s",
    (type) => {
      const { host, send, pan, setPanning } = fixture();
      send(host, "pointerdown");
      send(window, "pointermove", { clientX: 180 });
      if (type === "dispose") disposers.pop()!();
      else
        send(window, type === "missing button" ? "pointermove" : type, {
          key: "Escape",
          buttons: 0,
        });
      expect(setPanning).toHaveBeenLastCalledWith(false);
      send(window, "pointermove", { clientX: 200 });
      expect(pan).toHaveBeenCalledTimes(1);
    },
  );

  it("ignores another pointer and button release during a right drag", () => {
    const { host, send, pan } = fixture();
    send(host, "pointerdown");
    send(window, "pointermove", { pointerId: 2, clientX: 180 });
    send(window, "pointerup", { button: 0 });
    expect(pan).not.toHaveBeenCalled();
    send(window, "pointermove", { clientX: 180 });
    expect(pan).toHaveBeenCalledWith(-80, 0);
  });
});
