import "./brand.css";

/**
 * A whiteboard frame with one open corner. A connector leaves a sticky note
 * through the gap. The frame follows the text color so it works in both themes.
 */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <path
        className="brand-mark-frame"
        d="M19.5 7.5H8a4.5 4.5 0 0 0-4.5 4.5v13a4.5 4.5 0 0 0 4.5 4.5h12.5a4.5 4.5 0 0 0 4.5-4.5V11.5"
      />
      <rect className="brand-mark-note" x="7" y="21" width="7" height="7" rx="1.2" />
      <path className="brand-mark-line" d="M14 23.5C19.5 22 21 14.5 23 11S26 6.5 27.6 5.4" />
      <circle className="brand-mark-dot" cx="28.4" cy="4.6" r="2.3" />
    </svg>
  );
}
