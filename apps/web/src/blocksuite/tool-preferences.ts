import { ConnectorMode, type ShapeName } from "@blocksuite/affine/model";
import {
  DEFAULT_OPTIONS,
  STICKY_COLORS,
  type CanvasOptions,
} from "./canvas-controller";
const KEY = "whiteboard-tool-preferences-v1";
export function validateToolPreferences(value: unknown): CanvasOptions {
  const v =
    value && typeof value === "object" ? (value as Partial<CanvasOptions>) : {};
  return {
    color: STICKY_COLORS.some((c) => c.value === v.color)
      ? v.color!
      : DEFAULT_OPTIONS.color,
    shape: ["rect", "roundedRect", "ellipse", "diamond", "triangle"].includes(
      v.shape ?? "",
    )
      ? (v.shape as ShapeName)
      : DEFAULT_OPTIONS.shape,
    line: [
      ConnectorMode.Straight,
      ConnectorMode.Orthogonal,
      ConnectorMode.Curve,
    ].includes(v.line!)
      ? v.line!
      : DEFAULT_OPTIONS.line,
    penColor: ["#27334b", "#4262ff", "#ef6476", "#16a080", "#eead26"].includes(
      v.penColor ?? "",
    )
      ? v.penColor!
      : DEFAULT_OPTIONS.penColor,
    penWidth: [2, 4, 6, 12].includes(v.penWidth!)
      ? v.penWidth!
      : DEFAULT_OPTIONS.penWidth,
  };
}
export function loadToolPreferences() {
  try {
    return validateToolPreferences(
      JSON.parse(localStorage.getItem(KEY) ?? "null"),
    );
  } catch {
    return { ...DEFAULT_OPTIONS };
  }
}
export function saveToolPreferences(value: CanvasOptions) {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* Private browsing can disable storage. */
  }
}
