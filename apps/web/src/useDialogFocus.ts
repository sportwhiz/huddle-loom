import { useEffect, useRef, type RefObject } from 'react';

const dialogs: HTMLElement[] = [];
const hiddenBranches = new Map<HTMLElement, boolean>();

function isolateActiveDialog() {
  for (const [element, wasInert] of hiddenBranches) element.inert = wasInert;
  hiddenBranches.clear();
  let branch = dialogs.at(-1);
  // Hide every sibling along the path to body, including menus and sibling
  // dialogs. Recompute when a nested confirmation opens or closes.
  while (branch && branch !== document.body) {
    const parent = branch.parentElement;
    if (!parent) break;
    for (const sibling of parent.children) {
      if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
      hiddenBranches.set(sibling, sibling.inert);
      sibling.inert = true;
    }
    branch = parent;
  }
}

/** Keep keyboard navigation in the open dialog and restore its trigger on close. */
export function useDialogFocus(ref: RefObject<HTMLElement>, enabled: boolean, onClose: () => void, trigger?: RefObject<HTMLElement>) {
  const lastExternalFocus = useRef<HTMLElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    if (!enabled) {
      const remember = () => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== document.body && !ref.current?.contains(active)) lastExternalFocus.current = active;
      };
      const rememberPointer = (event: PointerEvent) => {
        const trigger = event.target instanceof Element ? event.target.closest<HTMLElement>('button, a[href], summary, input, select') : null;
        if (trigger && !ref.current?.contains(trigger)) lastExternalFocus.current = trigger;
      };
      remember();
      document.addEventListener('focusin', remember);
      document.addEventListener('pointerdown', rememberPointer, true);
      return () => {
        document.removeEventListener('focusin', remember);
        document.removeEventListener('pointerdown', rememberPointer, true);
      };
    }
    if (!dialog) return;
    const active = document.activeElement;
    const previous = trigger?.current ?? (active instanceof HTMLElement && active !== document.body && !dialog.contains(active) ? active : lastExternalFocus.current);
    dialogs.push(dialog);
    isolateActiveDialog();
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')).filter(item => item.getClientRects().length > 0 && !item.closest('[inert]'));
    if (!dialog.contains(document.activeElement)) (controls()[0] ?? dialog).focus();
    const key = (event: KeyboardEvent) => {
      if (dialogs.at(-1) !== dialog) return;
      const focusedDialog = document.activeElement?.closest('[role=dialog]');
      if (focusedDialog && focusedDialog !== dialog) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close.current(); return; }
      if (event.key !== 'Tab') return;
      const items = controls();
      const first = items[0];
      const last = items.at(-1);
      if (!first) { event.preventDefault(); dialog.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      const index = dialogs.lastIndexOf(dialog);
      if (index >= 0) dialogs.splice(index, 1);
      isolateActiveDialog();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [ref, enabled]);
}
