export type LayoutBox = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
};
export type Arrangement =
  | "left"
  | "center"
  | "right"
  | "top"
  | "middle"
  | "bottom"
  | "horizontal"
  | "vertical"
  | "grid";

export type Direction = "right" | "down" | "left" | "up";
export const CONNECTION_PORTS: Record<
  Direction,
  { source: [number, number]; target: [number, number] }
> = {
  right: { source: [1, 0.5], target: [0, 0.5] },
  down: { source: [0.5, 1], target: [0.5, 0] },
  left: { source: [0, 0.5], target: [1, 0.5] },
  up: { source: [0.5, 0], target: [0.5, 1] },
};
/** Keep branches on the requested side, even when another node occupies it. */
export function connectedPosition(
  source: LayoutBox,
  direction: Direction,
  obstacles: LayoutBox[],
): LayoutBox {
  const horizontal = direction === "right" || direction === "left";
  const sign = direction === "right" || direction === "down" ? 1 : -1;
  let next = { ...source, id: "new", x: source.x, y: source.y };
  if (horizontal) next.x += sign * (source.w + 96);
  else next.y += sign * (source.h + 96);
  for (let attempt = 0; attempt <= obstacles.length; attempt++) {
    const collisions = obstacles.filter(
      (b) =>
        next.x < b.x + b.w + 24 &&
        next.x + next.w + 24 > b.x &&
        next.y < b.y + b.h + 24 &&
        next.y + next.h + 24 > b.y,
    );
    if (!collisions.length) return next;
    if (horizontal) next.y = Math.max(...collisions.map((b) => b.y + b.h + 32));
    else next.x = Math.max(...collisions.map((b) => b.x + b.w + 32));
  }
  return next;
}

/** Keep quick-created notes in the requested column, clear of existing objects. */
export function findOpenPosition(
  box: LayoutBox,
  obstacles: LayoutBox[],
  gap = 32,
): LayoutBox {
  let result = { ...box };
  // Every collision advances past at least one obstacle's bottom edge.
  for (let attempt = 0; attempt <= obstacles.length; attempt++) {
    const collisions = obstacles.filter(
      (other) =>
        result.x < other.x + other.w + gap &&
        result.x + result.w + gap > other.x &&
        result.y < other.y + other.h + gap &&
        result.y + result.h + gap > other.y,
    );
    if (!collisions.length) return result;
    result = {
      ...result,
      y: Math.max(...collisions.map((other) => other.y + other.h + gap)),
    };
  }
  return result;
}

/** Compute positions without mutating objects; sorting is deterministic. */
export function arrangeBoxes(
  boxes: LayoutBox[],
  action: Arrangement,
): LayoutBox[] {
  if (boxes.length < 2) return boxes;
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  if (action === "grid") {
    const columns = Math.ceil(Math.sqrt(boxes.length));
    const width = Math.max(...boxes.map((b) => b.w)) + 32;
    const height = Math.max(...boxes.map((b) => b.h)) + 32;
    return [...boxes]
      .sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id))
      .map((b, index) => ({
        ...b,
        x: left + (index % columns) * width,
        y: top + Math.floor(index / columns) * height,
      }));
  }
  if (action === "horizontal" || action === "vertical") {
    if (boxes.length < 3) return boxes;
    const horizontal = action === "horizontal";
    const position = horizontal ? "x" : "y";
    const size = horizontal ? "w" : "h";
    const sorted = [...boxes].sort(
      (a, b) => a[position] - b[position] || a.id.localeCompare(b.id),
    );
    const first = sorted[0][position];
    const last = sorted[sorted.length - 1];
    const span = last[position] + last[size] - first;
    const gap =
      (span - sorted.reduce((sum, box) => sum + box[size], 0)) /
      (sorted.length - 1);
    let cursor = first;
    return sorted.map((box) => {
      const result = { ...box, [position]: cursor };
      cursor += box[size] + gap;
      return result;
    });
  }
  return boxes.map((b) => ({
    ...b,
    x:
      action === "left"
        ? left
        : action === "center"
          ? (left + right - b.w) / 2
          : action === "right"
            ? right - b.w
            : b.x,
    y:
      action === "top"
        ? top
        : action === "middle"
          ? (top + bottom - b.h) / 2
          : action === "bottom"
            ? bottom - b.h
            : b.y,
  }));
}
