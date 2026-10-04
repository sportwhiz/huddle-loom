/** Keep fitted content clear of the floating header and any desktop side panel. */
export function canvasFitPadding(host: HTMLElement): [number, number, number, number] {
  if (host.clientWidth <= 600) return [164, 24, 150, 24];
  const panels = host.closest('.app-shell')?.querySelectorAll<HTMLElement>('.collaboration-panel, .history-panel');
  const right = panels?.length && host.clientWidth > 760
    ? Math.max(...Array.from(panels, panel => panel.offsetWidth + 48))
    : 88;
  return [96, right, 80, 88];
}
