import { describe, expect, it } from "vitest";

import {
  markForShortcut,
  pastedStickyText,
  STICKY_TEXT_LIMIT,
  stickyInputRoom,
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
  it("uses Command on Mac and Control elsewhere", () => {
    expect(markForShortcut(key("b", { metaKey: true }), true)).toBe("bold");
    expect(markForShortcut(key("u", { metaKey: true }), true)).toBe("underline");
    expect(markForShortcut(key("x", { metaKey: true, shiftKey: true }), true)).toBe("strike");
    expect(markForShortcut(key("I", { ctrlKey: true }), false)).toBe("italic");
    // Control+B moves the caret back on a Mac, and Command is not a modifier elsewhere.
    expect(markForShortcut(key("b", { ctrlKey: true }), true)).toBeNull();
    expect(markForShortcut(key("b", { metaKey: true }), false)).toBeNull();
  });

  it("ignores keys that are not formatting shortcuts", () => {
    expect(markForShortcut(key("b"), true)).toBeNull();
    expect(markForShortcut(key("x", { metaKey: true }), true)).toBeNull();
    expect(markForShortcut(key("b", { metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(markForShortcut(key("b", { metaKey: true, altKey: true }), true)).toBeNull();
  });

  it("measures the room left under the sticky limit", () => {
    expect(stickyInputRoom(0, 0)).toBe(STICKY_TEXT_LIMIT);
    expect(stickyInputRoom(STICKY_TEXT_LIMIT, 0)).toBe(0);
    expect(stickyInputRoom(STICKY_TEXT_LIMIT, 5)).toBe(5);
    expect(stickyInputRoom(STICKY_TEXT_LIMIT + 3, 0)).toBe(0);
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
