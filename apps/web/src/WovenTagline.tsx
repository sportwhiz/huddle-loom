import { useId } from "react";
import { PRODUCT_TAGLINE } from "./product";

/** Live lettering with a thread alternating in front of and behind the words. */
export function WovenTagline({ className = "", signature = false }: { className?: string; signature?: boolean }) {
  const over = useId().replaceAll(":", "");
  if (signature) return <div className={`woven-signature ${className}`} role="img" aria-label={PRODUCT_TAGLINE}>
    <img src="/brand/signature-threads.webp" alt="" aria-hidden="true" width="1774" height="887" />
    <span aria-hidden="true">Ideas<br />woven together</span>
  </div>;
  const thread = "M5 85 C55 38 117 115 172 68 S264 43 320 82 S410 112 464 65 S548 37 595 74";
  return <svg className={`woven-tagline ${className}`} viewBox="0 0 600 130" role="img" aria-label={PRODUCT_TAGLINE}>
    <defs><clipPath id={over}><rect x="168" y="0" width="55" height="130" /><rect x="386" y="0" width="51" height="130" /><rect x="535" y="0" width="65" height="130" /></clipPath></defs>
    <path className="woven-thread" d={thread} aria-hidden="true" />
    <text x="24" y="83" textLength="548" lengthAdjust="spacingAndGlyphs">{PRODUCT_TAGLINE}</text>
    <g clipPath={`url(#${over})`} aria-hidden="true"><path className="woven-thread-shadow" d={thread} /><path className="woven-thread" d={thread} /></g>
  </svg>;
}
