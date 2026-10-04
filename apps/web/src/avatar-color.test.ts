import { describe, expect, it } from "vitest";
import { avatarInk } from "./avatar-color";

describe("avatar ink", () => {
  it.each([
    ["#4262ff", "#ffffff"],
    ["#8b6b20", "#ffffff"],
    ["#e25b8f", "#000000"],
    ["#ffd02f", "#000000"],
    ["#808080", "#000000"],
    ["#000000", "#ffffff"],
    ["#FFFFFF", "#000000"],
  ])("keeps initials readable on %s in either appearance", (paper, ink) => {
    expect(avatarInk(paper)).toBe(ink);
  });
  it("keeps a safe fallback for unavailable profile colors", () => {
    expect(avatarInk("")).toBe("#ffffff");
  });
});
