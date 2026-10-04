import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ principal: vi.fn(), installation: vi.fn() }));
vi.mock("../src/auth/session", () => ({ nativePrincipal: mock.principal }));
vi.mock("../src/auth/policy", () => ({
  installation: mock.installation,
  needsStrong: vi.fn(),
  publicPrincipal: vi.fn(),
  requireFresh: vi.fn(),
}));
vi.mock("../src/auth/library", () => ({ nativeAuth: vi.fn() }));
vi.mock("../src/collaboration.server", () => ({ updateProfile: vi.fn() }));
import { accountRoutes } from "../src/auth/account-routes";
import type { NativeEnv } from "../src/auth/types";
describe("tour preferences preserve account admission and permissions", () => {
  const run = vi.fn(),
    bind = vi.fn(() => ({ run })),
    prepare = vi.fn(() => ({ bind }));
  const env = { CATALOG: { prepare } } as unknown as NativeEnv;
  const identity = {
    identityVerified: true,
    user: { id: "reader" },
    principal: { id: "reader" },
    state: { status: "active", role: "member", recovery_required: 0 },
  };
  beforeEach(() => {
    vi.clearAllMocks();
    mock.principal.mockResolvedValue(identity);
    mock.installation.mockResolvedValue({});
    run.mockResolvedValue({});
  });
  const request = (journey: string, status = "completed") =>
    new Request("https://studio.test/api/v1/account/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ journey, status }),
    });
  it.each([
    ["home", 1],
    ["board", 2],
    ["account", 8],
    ["connections", 16],
  ])("saves the %s guide to the signed-in account", async (journey, bit) => {
    expect((await accountRoutes(request(String(journey)), env))?.status).toBe(
      200,
    );
    expect(bind.mock.calls[0][0]).toBe(bit);
    expect(bind.mock.calls[0].at(-1)).toBe("reader");
  });
  it("clears only the requested journey for replay", async () => {
    await accountRoutes(request("connections", "replay"), env);
    expect(bind).toHaveBeenCalledWith(~16, "reader");
  });
  it("does not let a member save an administrator journey", async () => {
    await expect(accountRoutes(request("admin"), env)).rejects.toMatchObject({
      status: 403,
    });
    expect(run).not.toHaveBeenCalled();
  });
  it("rejects unverified and suspended identities before saving", async () => {
    for (const value of [
      { ...identity, identityVerified: false },
      { ...identity, state: { ...identity.state, status: "suspended" } },
    ]) {
      mock.principal.mockResolvedValue(value);
      await expect(
        accountRoutes(request("account"), env),
      ).rejects.toMatchObject({ status: 403 });
    }
    expect(run).not.toHaveBeenCalled();
  });
  it("rejects unknown guide names and actions", async () => {
    await expect(
      accountRoutes(request("constructor"), env),
    ).rejects.toMatchObject({ status: 400 });
    await expect(accountRoutes(request("unknown"), env)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      accountRoutes(request("home", "delete"), env),
    ).rejects.toMatchObject({ status: 400 });
    expect(run).not.toHaveBeenCalled();
  });
});
