/** Handle secondary-button navigation before the editor's drag dispatcher,
 * which rejects right-button drags. A click still reaches its context menu. */
export function attachRightButtonNavigation(
  host: HTMLElement,
  options: {
    canStart: (event: PointerEvent) => boolean;
    pan: (dx: number, dy: number) => void;
    setPanning: (value: boolean) => void;
  },
) {
  let gesture: {
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    moved: boolean;
    menu: MouseEvent | null;
  } | null = null;
  let suppressMenu = false;

  const consume = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const cancel = () => {
    suppressMenu = Boolean(gesture?.moved) || suppressMenu;
    gesture = null;
    options.setPanning(false);
  };
  const down = (event: PointerEvent) => {
    cancel();
    suppressMenu = false;
    if (
      event.button !== 2 ||
      !event.isPrimary ||
      event.pointerType !== "mouse" ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      !options.canStart(event)
    )
      return;
    gesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      menu: null,
    };
    consume(event);
  };
  const move = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (!(event.buttons & 2)) {
      cancel();
      return;
    }
    consume(event);
    if (
      !gesture.moved &&
      Math.hypot(
        event.clientX - gesture.startX,
        event.clientY - gesture.startY,
      ) < 4
    )
      return;
    gesture.moved = true;
    suppressMenu = true;
    options.setPanning(true);
    options.pan(gesture.x - event.clientX, gesture.y - event.clientY);
    gesture.x = event.clientX;
    gesture.y = event.clientY;
  };
  const up = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.pointerId || event.button !== 2)
      return;
    consume(event);
    const { moved, menu } = gesture;
    cancel();
    // Some browsers emit contextmenu on press, others on release. Delay an
    // early menu until release so it cannot interrupt a navigation gesture.
    if (!moved && menu) {
      (menu.target ?? host).dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          composed: true,
          button: 2,
          clientX: menu.clientX,
          clientY: menu.clientY,
        }),
      );
    }
  };
  const menu = (event: MouseEvent) => {
    if (gesture) {
      gesture.menu = event;
      consume(event);
    } else if (suppressMenu && event.button === 2) consume(event);
  };
  const pointerCancel = (event: PointerEvent) => {
    if (gesture?.pointerId === event.pointerId) cancel();
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") cancel();
  };
  host.addEventListener("pointerdown", down, true);
  host.addEventListener("contextmenu", menu, true);
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", pointerCancel, true);
  window.addEventListener("blur", cancel);
  window.addEventListener("keydown", keydown);
  return () => {
    host.removeEventListener("pointerdown", down, true);
    host.removeEventListener("contextmenu", menu, true);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", pointerCancel, true);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("keydown", keydown);
    cancel();
  };
}
