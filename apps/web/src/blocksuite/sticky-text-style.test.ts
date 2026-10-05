import { describe, expect, it } from "vitest";

import {
  DEFAULT_STICKY_TEXT_STYLE,
  readStickyTextStyle,
  stickyTextCss,
  storedStickyTextStyle,
} from "./sticky-text-style";

describe("sticky text style", () => {
  it("reads stored settings and falls back to the default for missing or unknown values", () => {
    expect(readStickyTextStyle(undefined)).toEqual(DEFAULT_STICKY_TEXT_STYLE);
    expect(readStickyTextStyle({ style: {} })).toEqual(DEFAULT_STICKY_TEXT_STYLE);
    expect(
      readStickyTextStyle({ whiteboardText: { font: "serif", size: "xl", align: "center" } }),
    ).toEqual({ font: "serif", size: "xl", align: "center" });
    expect(
      readStickyTextStyle({ whiteboardText: { font: "comic", size: 99, align: "justify" } }),
    ).toEqual(DEFAULT_STICKY_TEXT_STYLE);
  });

  it("stores only settings that differ from the default", () => {
    expect(storedStickyTextStyle(DEFAULT_STICKY_TEXT_STYLE)).toEqual({});
    expect(storedStickyTextStyle({ font: "mono", size: "m", align: "right" })).toEqual({
      font: "mono",
      align: "right",
    });
  });

  it("styles only notes that differ from the default, scoped to their block id", () => {
    const css = stickyTextCss([
      { id: "plain", style: DEFAULT_STICKY_TEXT_STYLE },
      { id: "styled", style: { font: "serif", size: "l", align: "center" } },
    ]);
    expect(css).not.toContain('"plain"');
    expect(css).toContain('[data-block-id="styled"]');
    expect(css).toContain("font-size: 28px");
    expect(css).toContain("--affine-font-base: 28px");
    expect(css).toContain("text-align: center");
    expect(css).toContain("Georgia");
    expect(stickyTextCss([{ id: "plain", style: DEFAULT_STICKY_TEXT_STYLE }])).toBe("");
  });

  it("quotes block ids so they cannot break out of the selector", () => {
    const css = stickyTextCss([
      { id: 'a"] body { display:none } [x="', style: { font: "mono", size: "m", align: "left" } },
    ]);
    expect(css).toContain('[data-block-id="a\\"] body { display:none } [x=\\""]');
  });
});
