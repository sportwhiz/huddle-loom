import { describe, it, expect } from "vitest";
import { placeTour } from "./tour-layout";
const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});
describe("coachmark positioning", () => {
  it("points to a left toolbar without covering it", () => {
    const target = rect(20, 250, 44, 44),
      result = placeTour(
        target,
        { width: 1440, height: 900 },
        { width: 360, height: 330 },
      );
    expect(result.side).toBe("right");
    expect(result.left).toBeGreaterThan(target.right);
    expect(result.top + result.arrow).toBe(target.top + target.height / 2);
  });
  it("places top controls underneath on mobile, keeping target clear", () => {
    const target = rect(20, 60, 350, 45),
      result = placeTour(
        target,
        { width: 390, height: 844 },
        { width: 360, height: 350 },
      );
    expect(result.side).toBe("bottom");
    expect(result.top).toBeGreaterThan(target.bottom);
    expect(result.left).toBeGreaterThanOrEqual(12);
    expect(result.left + 360).toBeLessThanOrEqual(378);
  });
  it("places a bottom control above it and clamps its arrow", () => {
    const target = rect(330, 790, 40, 40),
      result = placeTour(
        target,
        { width: 390, height: 844 },
        { width: 360, height: 350 },
      );
    expect(result.side).toBe("top");
    expect(result.top + 350).toBeLessThan(target.top);
    expect(result.arrow).toBeLessThanOrEqual(336);
  });
  it("keeps a small landscape screen clear by allowing a scrolling coachmark", () => {
    const target = rect(175, 210, 40, 40),
      result = placeTour(
        target,
        { width: 390, height: 480 },
        { width: 360, height: 330 },
      );
    expect(result.side).toBe("bottom");
    expect(result.top).toBeGreaterThan(target.bottom);
    expect(result.top + result.maxHeight).toBeLessThanOrEqual(468);
  });
  it("narrows a coachmark to the horizontal space in short landscape", () => {
    const target = rect(70, 168, 410, 54),
      result = placeTour(
        target,
        { width: 844, height: 390 },
        { width: 360, height: 340 },
      );
    expect(result.side).toBe("right");
    expect(result.left).toBeGreaterThan(target.right);
    expect(result.width).toBe(334);
    expect(result.left + result.width).toBe(832);
  });
  it("uses a truthful fallback when a control is absent", () => {
    expect(
      placeTour(
        undefined,
        { width: 390, height: 800 },
        { width: 360, height: 340 },
      ),
    ).toMatchObject({ side: "none", left: 15, top: 230 });
  });
});
