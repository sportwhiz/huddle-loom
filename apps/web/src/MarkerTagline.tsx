import { PRODUCT_TAGLINE } from "./product";

const underline = "M8 112 C120 101 250 99 380 104 S560 112 592 106";

/** The tagline written by hand, with a marker stroke under it. */
export function MarkerTagline({ className = "", signature = false }: { className?: string; signature?: boolean }) {
  if (signature) return <div className={`marker-signature ${className}`}>
    <p>{PRODUCT_TAGLINE}.</p>
    <svg viewBox="0 0 600 30" aria-hidden="true" preserveAspectRatio="none"><path className="marker-underline" d="M6 18 C150 8 330 6 594 14" /></svg>
    <div className="marker-tray" aria-hidden="true"><span /><span /><span /><span /></div>
  </div>;
  return <svg className={`marker-tagline ${className}`} viewBox="0 0 600 130" role="img" aria-label={PRODUCT_TAGLINE}>
    <text x="300" y="82" textAnchor="middle">{PRODUCT_TAGLINE}</text>
    <path className="marker-underline" d={underline} aria-hidden="true" />
  </svg>;
}
