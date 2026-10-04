import { afterEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../src/collaboration-types";
import type { NativeEnv } from "../src/auth/types";
import { reauthenticationSeconds, requireFresh, requireFreshForInstallation } from "../src/auth/policy";

const now = Date.parse("2026-10-04T12:00:00Z");
function principal(ageSeconds: number, assurance = "strong") {
  return { id: "owner", authentication: "native", assurance, authenticatedAt: new Date(now - ageSeconds * 1000).toISOString() } as Principal;
}
describe("protected action verification window", () => {
  afterEach(() => vi.useRealTimers());
  it("defaults to 30 minutes while rejecting the expiry boundary", () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    expect(() => requireFresh(principal(1799))).not.toThrow();
    expect(() => requireFresh(principal(1800))).toThrow("Confirm your identity");
  });
  it("honors shorter and longer policies without accepting a missing second factor", () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    expect(() => requireFresh(principal(1200), true, 300)).toThrow();
    expect(() => requireFresh(principal(1200), true, 3600)).not.toThrow();
    expect(() => requireFresh(principal(1, "weak"), true, 43200)).toThrow();
    expect(() => requireFresh(principal(1, "backup"), true, 43200)).toThrow();
    expect(() => requireFresh(principal(1, "weak"), false, 300)).not.toThrow();
  });
  it("uses a successful re-verification timestamp and requires another check when it expires", () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const identity = principal(4000);
    expect(() => requireFresh(identity, true, 3600)).toThrow();
    identity.authenticatedAt = new Date(now).toISOString();
    expect(() => requireFresh(identity, true, 3600)).not.toThrow();
    vi.advanceTimersByTime(3600000);
    expect(() => requireFresh(identity, true, 3600)).toThrow();
  });
  it("rejects missing, invalid and future authentication timestamps", () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    for (const authenticatedAt of [undefined, "invalid", new Date(now + 1000).toISOString()])
      expect(() => requireFresh({ ...principal(1), authenticatedAt })).toThrow();
  });
  it("bounds persisted policy and fails conservatively for malformed values", () => {
    expect(reauthenticationSeconds(undefined)).toBe(1800);
    for (const value of [null, 0, -1, 299, 43201, 900.5, "3600", NaN, Infinity])
      expect(reauthenticationSeconds(value)).toBe(300);
    expect(reauthenticationSeconds(43200)).toBe(43200);
  });
  it("applies a policy change immediately to an existing session", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    let window = 3600;
    const first = vi.fn(async () => ({ state: "ready", reauthentication_seconds: window }));
    const statement = { bind: () => ({ first }) };
    const env = { CATALOG: { prepare: () => statement } } as unknown as NativeEnv;
    await expect(requireFreshForInstallation(env, principal(1200))).resolves.toBeUndefined();
    window = 300;
    await expect(requireFreshForInstallation(env, principal(1200))).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
    expect(first).toHaveBeenCalledTimes(2);
  });
});
