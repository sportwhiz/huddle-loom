export type TourRect = {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
};
export type TourPlacement = {
  left: number;
  top: number;
  side: "left" | "right" | "top" | "bottom" | "none";
  arrow: number;
  maxHeight: number;
  width: number;
};
const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));
/** Place beside the actual control, choosing the side with room and keeping the card on screen. */
export function placeTour(
  target: TourRect | undefined,
  viewport: { width: number; height: number },
  card: { width: number; height: number },
): TourPlacement {
  const margin = 12,
    gap = 18;
  const width = Math.min(card.width, viewport.width - margin * 2);
  const height = Math.min(card.height, viewport.height - margin * 2);
  if (!target)
    return {
      left: (viewport.width - width) / 2,
      top: (viewport.height - height) / 2,
      side: "none",
      arrow: 0,
      maxHeight: viewport.height - margin * 2,
      width,
    };
  const options = [
    {
      side: "right" as const,
      room: viewport.width - target.right - gap - margin,
      need: width,
      left: target.right + gap,
      top: target.top + target.height / 2 - height / 2,
    },
    {
      side: "left" as const,
      room: target.left - gap - margin,
      need: width,
      left: target.left - gap - width,
      top: target.top + target.height / 2 - height / 2,
    },
    {
      side: "bottom" as const,
      room: viewport.height - target.bottom - gap - margin,
      need: height,
      left: target.left + target.width / 2 - width / 2,
      top: target.bottom + gap,
    },
    {
      side: "top" as const,
      room: target.top - gap - margin,
      need: height,
      left: target.left + target.width / 2 - width / 2,
      top: target.top - gap - height,
    },
  ];
  const best =
    options.find((option) => option.room >= option.need) ??
    options
      .filter(
        (option) =>
          option.side === "top" ||
          option.side === "bottom" ||
          option.room >= 240,
      )
      .sort((a, b) => b.room / b.need - a.room / a.need)[0];
  const maxHeight =
    best.side === "top" || best.side === "bottom"
      ? Math.max(72, best.room)
      : viewport.height - margin * 2;
  const actualWidth =
    best.side === "left" || best.side === "right"
      ? Math.min(width, Math.max(240, best.room))
      : width;
  const actualHeight = Math.min(height, maxHeight);
  const left = clamp(
    best.side === "left" ? target.left - gap - actualWidth : best.left,
    margin,
    viewport.width - actualWidth - margin,
  );
  const top = clamp(
    best.side === "top" ? target.top - gap - actualHeight : best.top,
    margin,
    viewport.height - actualHeight - margin,
  );
  const arrow =
    best.side === "left" || best.side === "right"
      ? clamp(target.top + target.height / 2 - top, 24, actualHeight - 24)
      : clamp(target.left + target.width / 2 - left, 24, actualWidth - 24);
  return { left, top, side: best.side, arrow, maxHeight, width: actualWidth };
}
