import type { ReactNode } from "react";

const paths = {
  menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
  pause: <><path d="M8 5v14M16 5v14" /></>,
  play: <path d="m8 5 11 7-11 7Z" />,
  people: <><circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 4v2"/></>,
  settings: <><path d="m9 3-.6 2.2-2 1.2L4.2 6 2.7 8.6l1.7 1.6v2.4l-1.7 1.6L4.2 17l2.2-.4 2 1.2L9 20h3l.6-2.2 2-1.2 2.2.4 1.5-2.8-1.7-1.6v-2.4l1.7-1.6L16.8 6l-2.2.4-2-1.2L12 3Z"/><circle cx="10.5" cy="11.5" r="3"/></>,
  bold: (
    <>
      <path d="M7 4h6a4 4 0 0 1 0 8H7V4Zm0 8h7a4 4 0 0 1 0 8H7v-8Z" />
    </>
  ),
  italic: <path d="M14 4h-4m4 0-4 16m0 0H6m4 0h4M14 4h4" />,
  underline: <><path d="M7 4v7a5 5 0 0 0 10 0V4" /><path d="M5 20h14" /></>,
  strike: <><path d="M16.5 7.5C16 5.6 14.3 4.5 12 4.5c-2.6 0-4.5 1.4-4.5 3.4 0 1.5 1 2.4 2.6 3.1" /><path d="M4 12h16" /><path d="M8 16.5c.5 1.9 2.2 3 4.5 3 2.6 0 4.5-1.4 4.5-3.4 0-.9-.3-1.5-.9-2.1" /></>,
  textColor: <path d="m6 18 6-14 6 14M8.3 13h7.4" />,
  alignLeft: <path d="M4 6h16M4 10h10M4 14h16M4 18h10" />,
  alignCenter: <path d="M4 6h16M7 10h10M4 14h16M7 18h10" />,
  alignRight: <path d="M4 6h16M10 10h10M4 14h16M10 18h10" />,
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="8" r="5" />
      <path d="m11.5 11.5 9 9M16 16l3-3M19 19l3-3" />
      <circle cx="7" cy="7" r=".5" />
    </>
  ),
  duplicate: (
    <>
      <rect x="8" y="8" width="13" height="13" rx="2" />
      <path d="M16 8V3H3v13h5" />
    </>
  ),
  select: <path d="m5 3 14 10-7 1-4 7Z" />,
  hand: (
    <>
      <path d="M8 12V6a2 2 0 0 1 4 0v5-7a2 2 0 0 1 4 0v7-4a2 2 0 0 1 4 0v7c0 5-3 8-7 8-3 0-5-2-7-5l-3-4a2 2 0 0 1 3-3l2 2Z" />
    </>
  ),
  sticky: (
    <>
      <path d="M4 4h16v11l-5 5H4Z" />
      <path d="M15 20v-5h5" />
    </>
  ),
  text: (
    <>
      <path d="M4 5h16M12 5v15M8 20h8M4 5v3M20 5v3" />
    </>
  ),
  shape: (
    <>
      <rect x="3" y="3" width="11" height="11" rx="2" />
      <circle cx="16" cy="16" r="5" />
    </>
  ),
  connector: (
    <>
      <path d="M4 19v-9h16M16 6l4 4-4 4" />
      <circle cx="4" cy="19" r="1.5" />
    </>
  ),
  pen: (
    <>
      <path d="m4 20 1-5L16 4l4 4L9 19Z" />
      <path d="m14 6 4 4M4 20l5-1" />
    </>
  ),
  eraser: (
    <>
      <path d="m3 14 11-11 7 7-11 11H8Z" />
      <path d="m8 9 7 7M10 21h11" />
    </>
  ),
  frame: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="1" />
      <path d="M8 1v6M16 17v6M1 16h6M17 8h6" />
    </>
  ),
  templates: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  upload: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8" cy="8" r="1.5" />
      <path d="m3 17 5-5 4 4 4-6 5 7" />
    </>
  ),
  undo: (
    <>
      <path d="m8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12" />
    </>
  ),
  redo: (
    <>
      <path d="m16 4 5 5-5 5M21 9H10a6 6 0 0 0 0 12" />
    </>
  ),
  search: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="m15 15 6 6" />
    </>
  ),
  fit: (
    <>
      <path d="M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6" />
    </>
  ),
  minus: <path d="M5 12h14" />,
  plus: <path d="M5 12h14M12 5v14" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 5M12 17h.01" />
    </>
  ),
  map: (
    <>
      <path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2ZM9 3v16M15 5v16" />
    </>
  ),
  arrange: (
    <>
      <rect x="3" y="4" width="6" height="6" rx="1" />
      <rect x="13" y="4" width="8" height="6" rx="1" />
      <rect x="3" y="14" width="8" height="6" rx="1" />
      <rect x="15" y="14" width="6" height="6" rx="1" />
    </>
  ),
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  grid: (
    <>
      <path d="M8 3v18M16 3v18M3 8h18M3 16h18" />
    </>
  ),

  back: <path d="m14 6-6 6 6 6M8 12h12" />,
  comment: <><path d="M20 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3Z" /><path d="M8 8h8M8 12h5" /></>,
  facilitate: <><path d="M4 7h2m6 0h8M4 17h8m6 0h2" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>,
  present: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="m10 8 5 3-5 3ZM12 17v4M8 21h8" /></>,
  activity: <><path d="M3 12h4l2-5 5 10 2-5h5" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  share: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2M18 8v6M15 11h6" /></>,
  apps: <><path d="M8 3v5M16 3v5M6 8h12v3a6 6 0 0 1-12 0ZM12 17v4" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2m-3-7-1.4 1.4M6.4 17.6 5 19M5 5l1.4 1.4M17.6 17.6 19 19" /></>,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  system: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M12 17v4M8 21h8" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  clock: <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></>,
  vote: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8 12 3 3 5-6" /></>,
  notes: <><path d="M4 4h12v12H4ZM16 8h4v12H8v-4" /></>,
  chevron: <path d="m9 6 6 6-6 6" />,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>,
  import: <><path d="M12 15V3m-5 5 5-5 5 5M4 16v5h16v-5" /></>,
  history: <><path d="M3 10a9 9 0 1 1 2 8M3 3v7h7M12 7v5l3 2" /></>,
  trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>,
  folder: <path d="M3 6V4h7l2 3h9v13H3Z" />,
  star: <path d="m12 3 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z" />,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 5 9 7 9-7" /></>,
  bell: <><path d="M5 17V9a7 7 0 0 1 14 0v8l2 2H3ZM9 22h6" /></>,
  left: <><path d="M4 3v18" /><rect x="8" y="5" width="12" height="5" rx="1" /><rect x="8" y="14" width="8" height="5" rx="1" /></>,
  center: <><path d="M12 2v20" /><rect x="3" y="5" width="18" height="5" rx="1" /><rect x="7" y="14" width="10" height="5" rx="1" /></>,
  right: <><path d="M20 3v18" /><rect x="4" y="5" width="12" height="5" rx="1" /><rect x="8" y="14" width="8" height="5" rx="1" /></>,
  top: <><path d="M3 4h18" /><rect x="5" y="8" width="5" height="12" rx="1" /><rect x="14" y="8" width="5" height="8" rx="1" /></>,
  middle: <><path d="M2 12h20" /><rect x="5" y="3" width="5" height="18" rx="1" /><rect x="14" y="7" width="5" height="10" rx="1" /></>,
  bottom: <><path d="M3 20h18" /><rect x="5" y="4" width="5" height="12" rx="1" /><rect x="14" y="8" width="5" height="8" rx="1" /></>,
  horizontal: <><path d="M3 4v16M21 4v16M7 12h10m-7-3-3 3 3 3m4-6 3 3-3 3" /></>,
  vertical: <><path d="M4 3h16M4 21h16M12 7v10m-3-7 3-3 3 3m-6 4 3 3 3-3" /></>,
} satisfies Record<string, ReactNode>;

export type UiIconName = keyof typeof paths;
/** Shared geometry for product controls. The parent supplies the accessible name. */
export function UiIcon({ name, className = "" }: { name: UiIconName; className?: string }) {
  return <svg className={`ui-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
