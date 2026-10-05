import { InlineEditor } from "@blocksuite/std/inline";
import { baseTextAttributes } from "@blocksuite/store";
import { html } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import type * as Y from "yjs";
import { z } from "zod";

import type { TextMark } from "./canvas-controller";

/** Character styles a sticky note supports. They match the attributes the
 * board's native paragraph renders, so edited text looks the same on canvas. */
export const stickyTextAttributes = baseTextAttributes.extend({
  color: z.string().optional().nullable().catch(undefined),
});
export type StickyTextAttributes = z.infer<typeof stickyTextAttributes>;
export type StickyInlineEditor = InlineEditor<StickyTextAttributes>;

export const STICKY_TEXT_LIMIT = 10_000;

export const MARK_SHORTCUTS: Record<TextMark, { key: string; shift: boolean; label: string }> = {
  bold: { key: "b", shift: false, label: "Bold" },
  italic: { key: "i", shift: false, label: "Italic" },
  underline: { key: "u", shift: false, label: "Underline" },
  strike: { key: "x", shift: true, label: "Strikethrough" },
};

/** The style a formatting shortcut toggles, if the key event is one. */
export function markForShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  return (
    (Object.entries(MARK_SHORTCUTS) as [TextMark, (typeof MARK_SHORTCUTS)[TextMark]][]).find(
      ([, shortcut]) => shortcut.key === key && shortcut.shift === event.shiftKey,
    )?.[0] ?? null
  );
}

export function createStickyInlineEditor(yText: Y.Text): StickyInlineEditor {
  const editor = new InlineEditor<StickyTextAttributes>(yText);
  editor.setAttributeSchema(stickyTextAttributes);
  editor.setAttributeRenderer(({ delta }) => {
    const attributes = delta.attributes ?? {};
    const decoration = [attributes.underline && "underline", attributes.strike && "line-through"]
      .filter(Boolean)
      .join(" ");
    const style = styleMap({
      "font-weight": attributes.bold ? "700" : null,
      "font-style": attributes.italic ? "italic" : null,
      "text-decoration": decoration || null,
      color: attributes.color ?? null,
    });
    return html`<span style=${style}><v-text .str=${delta.insert}></v-text></span>`;
  });
  return editor;
}

/** Plain text for a paste, with line endings the inline editor accepts and
 * trimmed so the note stays within the sticky limit. */
export function pastedStickyText(raw: string, currentLength: number, replacedLength: number) {
  const text = raw.replace(/\r\n?/g, "\n");
  const room = Math.max(0, STICKY_TEXT_LIMIT - (currentLength - replacedLength));
  return text.slice(0, room);
}
