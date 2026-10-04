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
        d="M19 4H9a5 5 0 0 0-5 5v14a5 5 0 0 0 5 5h14a5 5 0 0 0 5-5V13"
      />
      <rect className="brand-mark-note" x="8.5" y="15.5" width="9" height="9" rx="1.5" />
      <path className="brand-mark-line" d="M17.5 18.5c4 0 5-6.5 8.5-10.5" />
      <circle className="brand-mark-dot" cx="26.6" cy="7.4" r="2.4" />
    </svg>
  );
}
