import { InlineEditor, type InlineRange } from "@blocksuite/std/inline";
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
export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Characters that can still be added when `replacedLength` are replaced. */
export const stickyInputRoom = (textLength: number, replacedLength: number) =>
  Math.max(0, STICKY_TEXT_LIMIT - (textLength - replacedLength));

export const MARK_SHORTCUTS: Record<TextMark, { key: string; shift: boolean; label: string }> = {
  bold: { key: "b", shift: false, label: "Bold" },
  italic: { key: "i", shift: false, label: "Italic" },
  underline: { key: "u", shift: false, label: "Underline" },
  strike: { key: "x", shift: true, label: "Strikethrough" },
};

/** The style a formatting shortcut toggles, if the key event is one. Mac
 * uses Command; Control keeps its text-navigation meaning there. */
export function markForShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  mac = IS_MAC,
) {
  if (!(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) || event.altKey)
    return null;
  const key = event.key.toLowerCase();
  return (
    (Object.entries(MARK_SHORTCUTS) as [TextMark, (typeof MARK_SHORTCUTS)[TextMark]][]).find(
      ([, shortcut]) => shortcut.key === key && shortcut.shift === event.shiftKey,
    )?.[0] ?? null
  );
}

/** Styles new text takes: those of the replaced text, or of the character
 * before the caret, as in other editors. Links are never continued. */
export function continuedStyle(editor: StickyInlineEditor, range: InlineRange): StickyTextAttributes {
  const { link: _link, ...style } = editor.getFormat(
    range.length ? range : { index: range.index, length: 0 },
  );
  return style;
}

export function createStickyInlineEditor(yText: Y.Text): StickyInlineEditor {
  const editor = new InlineEditor<StickyTextAttributes>(yText, {
    hooks: {
      // Typing, dictation, spell check and line breaks all arrive here, so
      // the sticky limit holds for more than paste.
      beforeinput: (ctx) => {
        const room = stickyInputRoom(ctx.inlineEditor.yTextLength, ctx.inlineRange.length);
        const type = ctx.raw.inputType;
        if (type === "insertParagraph" || type === "insertLineBreak") {
          if (room < 1) {
            ctx.raw = new InputEvent("beforeinput", { inputType: "insertText" });
            ctx.data = "";
          }
          return;
        }
        if (ctx.data) ctx.data = ctx.data.slice(0, room);
        if (type === "insertText") ctx.attributes = continuedStyle(editor, ctx.inlineRange);
      },
      compositionEnd: (ctx) => {
        const room = stickyInputRoom(ctx.inlineEditor.yTextLength, ctx.inlineRange.length);
        if (ctx.data) ctx.data = ctx.data.slice(0, room);
        ctx.attributes = continuedStyle(editor, ctx.inlineRange);
      },
    },
  });
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
  return raw.replace(/\r\n?/g, "\n").slice(0, stickyInputRoom(currentLength, replacedLength));
}
