import { describe, expect, it } from "vitest";
import { legacyStickyPaper } from "./sticky-paper";

describe("existing MCP sticky paper", () => {
  it.each([
    ["#fde68a", "#704200"],
    ["#ffc58f", "#843b06"],
    ["#c9f8c1", "#3b5315"],
    ["#ceecff", "#004b7b"],
    ["#ddd6fe", "#312e81"],
  ])(
    "keeps %s pastel when its original dark preset is present",
    (light, dark) => {
      expect(legacyStickyPaper({ light, dark })).toBe(light);
    },
  );
  it("leaves custom colors and native palette references unchanged", () => {
    for (const color of [
      "#fde68a",
      { light: "#fde68a", dark: "#123456" },
      { light: { key: "yellow" }, dark: { key: "yellow" } },
      null,
    ])
      expect(legacyStickyPaper(color)).toBeUndefined();
  });
});
