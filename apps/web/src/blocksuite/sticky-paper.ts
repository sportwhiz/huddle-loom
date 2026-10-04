// The initial MCP presets used dark fills. Sticky paper now stays pastel in
// both themes; recognize the complete pair so custom colors remain intact.
const LEGACY_PRESETS: Record<string, string> = {
  "#fde68a": "#704200",
  "#ffc58f": "#843b06",
  "#c9f8c1": "#3b5315",
  "#ceecff": "#004b7b",
  "#ddd6fe": "#312e81",
};

export function legacyStickyPaper(color: unknown): string | undefined {
  if (!color || typeof color !== "object") return;
  const pair = color as { light?: unknown; dark?: unknown };
  if (
    typeof pair.light === "string" &&
    typeof pair.dark === "string" &&
    LEGACY_PRESETS[pair.light] === pair.dark
  )
    return pair.light;
}
