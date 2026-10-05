// Whole-note text settings for sticky notes. The native note schema has no
// font, size or alignment, so they are stored under the note's `edgeless`
// props, which already carry other non-schema keys such as `collapse`, and
// applied with a stylesheet keyed by block id. Installations that predate
// this ignore the key and show the default style.

export const STICKY_FONTS = [
  { id: "sans", name: "Sans", css: null },
  { id: "serif", name: "Serif", css: 'Georgia, "Times New Roman", serif' },
  { id: "mono", name: "Mono", css: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
  { id: "hand", name: "Handwriting", css: 'var(--font-hand, "Whiteboard Hand", cursive)' },
] as const;
export const STICKY_SIZES = [
  { id: "s", name: "Small", px: 16 },
  { id: "m", name: "Medium", px: 20 },
  { id: "l", name: "Large", px: 28 },
  { id: "xl", name: "Extra large", px: 40 },
] as const;
export const STICKY_ALIGNMENTS = [
  { id: "left", name: "Align left" },
  { id: "center", name: "Align center" },
  { id: "right", name: "Align right" },
] as const;
// Text keeps dark ink on the light sticky colors in either app theme.
export const STICKY_TEXT_COLORS = [
  { name: "Default", value: null },
  { name: "Blue", value: "#2554c7" },
  { name: "Red", value: "#c6392d" },
  { name: "Green", value: "#2a7a4c" },
  { name: "Purple", value: "#6b45b8" },
  { name: "Orange", value: "#b75a14" },
] as const;

export type StickyFont = (typeof STICKY_FONTS)[number]["id"];
export type StickySize = (typeof STICKY_SIZES)[number]["id"];
export type StickyAlign = (typeof STICKY_ALIGNMENTS)[number]["id"];
export type StickyTextStyle = { font: StickyFont; size: StickySize; align: StickyAlign };
export const DEFAULT_STICKY_TEXT_STYLE: StickyTextStyle = { font: "sans", size: "m", align: "left" };
export const STICKY_TEXT_STYLE_KEY = "whiteboardText";

const pick = <T extends string>(value: unknown, allowed: readonly { id: T }[], fallback: T): T =>
  allowed.some((option) => option.id === value) ? (value as T) : fallback;

/** Read the stored style, ignoring anything unknown, such as values written by a newer version. */
export function readStickyTextStyle(edgeless: unknown): StickyTextStyle {
  const raw =
    edgeless && typeof edgeless === "object"
      ? (edgeless as Record<string, unknown>)[STICKY_TEXT_STYLE_KEY]
      : undefined;
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    font: pick(value.font, STICKY_FONTS, DEFAULT_STICKY_TEXT_STYLE.font),
    size: pick(value.size, STICKY_SIZES, DEFAULT_STICKY_TEXT_STYLE.size),
    align: pick(value.align, STICKY_ALIGNMENTS, DEFAULT_STICKY_TEXT_STYLE.align),
  };
}

/** Values to store: only settings that differ from the default. */
export function storedStickyTextStyle(style: StickyTextStyle) {
  const stored: Partial<StickyTextStyle> = {};
  for (const key of ["font", "size", "align"] as const)
    if (style[key] !== DEFAULT_STICKY_TEXT_STYLE[key]) Object.assign(stored, { [key]: style[key] });
  return stored;
}

export const stickyFontCss = (font: StickyFont) =>
  STICKY_FONTS.find((option) => option.id === font)?.css ?? null;
export const stickySizePx = (size: StickySize) =>
  STICKY_SIZES.find((option) => option.id === size)?.px ?? 20;

const cssString = (value: string) => `"${value.replace(/["\\]/g, "\\$&")}"`;

/** Stylesheet for notes whose text style differs from the default. */
export function stickyTextCss(notes: { id: string; style: StickyTextStyle }[]) {
  return notes
    .map(({ id, style }) => {
      const declarations: string[] = [];
      const font = stickyFontCss(style.font);
      if (font) declarations.push(`font-family: ${font}`, `--affine-font-family: ${font}`);
      if (style.size !== "m") {
        const px = stickySizePx(style.size);
        declarations.push(`font-size: ${px}px`, `--affine-font-base: ${px}px`);
      }
      if (style.align !== "left") declarations.push(`text-align: ${style.align}`);
      if (!declarations.length) return "";
      const note = `.editor-canvas [data-block-id=${cssString(id)}]`;
      return `${note} [data-testid="edgeless-note-container"], ${note} [data-testid="edgeless-note-container"] .inline-editor { ${declarations.join("; ")} }`;
    })
    .filter(Boolean)
    .join("\n");
}
