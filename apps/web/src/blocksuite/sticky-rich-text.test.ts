import { describe, expect, it } from "vitest";

import {
  markForShortcut,
  pastedStickyText,
  STICKY_TEXT_LIMIT,
  stickyTextAttributes,
} from "./sticky-rich-text";

const key = (key: string, modifiers: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...modifiers,
});

describe("sticky rich text", () => {
  it("maps the formatting shortcuts on Mac and other platforms", () => {
    expect(markForShortcut(key("b", { metaKey: true }))).toBe("bold");
    expect(markForShortcut(key("I", { ctrlKey: true }))).toBe("italic");
    expect(markForShortcut(key("u", { metaKey: true }))).toBe("underline");
    expect(markForShortcut(key("x", { metaKey: true, shiftKey: true }))).toBe("strike");
  });

  it("ignores keys that are not formatting shortcuts", () => {
    expect(markForShortcut(key("b"))).toBeNull();
    expect(markForShortcut(key("x", { metaKey: true }))).toBeNull();
    expect(markForShortcut(key("b", { metaKey: true, shiftKey: true }))).toBeNull();
    expect(markForShortcut(key("b", { metaKey: true, altKey: true }))).toBeNull();
  });

  it("pastes plain text with normalized line endings within the note limit", () => {
    expect(pastedStickyText("one\r\ntwo\rthree", 0, 0)).toBe("one\ntwo\nthree");
    expect(pastedStickyText("abcdef", STICKY_TEXT_LIMIT - 3, 0)).toBe("abc");
    expect(pastedStickyText("abcdef", STICKY_TEXT_LIMIT, 4)).toBe("abcd");
    expect(pastedStickyText("abc", STICKY_TEXT_LIMIT, 0)).toBe("");
  });

  it("accepts the styles the toolbar applies and drops the rest", () => {
    expect(
      stickyTextAttributes.parse({ bold: true, italic: null, color: "#2554c7", size: 40 }),
    ).toEqual({ bold: true, italic: null, color: "#2554c7" });
  });
});
