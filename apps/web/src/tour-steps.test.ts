import { describe, it, expect } from "vitest";
import { tourSteps, tourBits } from "./tour-steps";
describe("permission aware page guides", () => {
  it("gives guests and readers their own relevant controls", () => {
    expect(
      tourSteps("home", "guest", true, "/").some((step) =>
        step.target.includes("new-board"),
      ),
    ).toBe(false);
    expect(
      tourSteps("board", "guest", true, "/boards/x").some((step) =>
        step.target.includes("Sticky"),
      ),
    ).toBe(false);
  });
  it("gives each supported administration section its own control guide", () => {
    for (const path of [
      "people",
      "invitations",
      "sign-in",
      "clients",
      "usage",
      "activity",
      "updates",
      "system",
    ]) {
      const steps = tourSteps("admin", "owner", false, `/settings/${path}`);
      expect(steps.length).toBeGreaterThan(1);
      expect(
        steps.slice(1).every((step) => step.target !== ".identity-nav"),
      ).toBe(true);
    }
  });
  it("keeps anonymous editors inside their board permissions", () => {
    const steps = tourSteps("board", "visitor", false, "/guest/example");
    expect(
      steps.some(
        (step) =>
          step.target.includes("share-button") ||
          step.target.includes("More board"),
      ),
    ).toBe(false);
  });
  it("gives Node installations a manual upgrade guide and administrators review-only controls", () => {
    expect(
      tourSteps("admin", "owner", false, "/settings/updates", "godaddy")[0]
        .heading,
    ).toBe("Update through your hosting dashboard");
    expect(
      tourSteps("admin", "admin", false, "/settings/updates").some(
        (step) => step.heading === "Your update preferences",
      ),
    ).toBe(false);
  });
  it("uses unique persistence bits and only actionable controls", () => {
    expect(new Set(Object.values(tourBits)).size).toBe(5);
    for (const journey of Object.keys(tourBits) as (keyof typeof tourBits)[])
      expect(
        tourSteps(journey, "owner", false, "/settings/people").every(
          (step) => !!step.target,
        ),
      ).toBe(true);
  });
});
