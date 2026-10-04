import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeEnv } from "../src/auth/types";
const { principal, administrator, notice } = vi.hoisted(() => ({
  principal: vi.fn(), administrator: vi.fn(), notice: vi.fn(),
}));
vi.mock("../src/auth/session", () => ({ nativePrincipal: principal }));
vi.mock("../src/auth/policy", () => ({ requireAdministrator: administrator }));
vi.mock("../src/updates/service", () => ({ releaseNotice: notice }));
import { updateRoutes } from "../src/updates/routes";
describe("signed-in update discovery", () => {
  afterEach(() => vi.resetAllMocks());
  it("allows an admitted member to read a notice without granting admin actions", async () => {
    principal.mockResolvedValue({ principal: { id: "member" } });
    notice.mockResolvedValue({ version: "1.2.3" });
    const request = new Request("https://studio.example/api/v1/updates/notice");
    const response = await updateRoutes(request, {} as NativeEnv);
    expect(await response?.json()).toEqual({ notice: { version: "1.2.3" } });
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(principal).toHaveBeenCalledWith(request, {});
    expect(administrator).not.toHaveBeenCalled();
  });
  it("does not disclose notices to an unauthenticated or unadmitted session", async () => {
    principal.mockRejectedValue(new Error("Sign in to continue."));
    await expect(updateRoutes(new Request("https://studio.example/api/v1/updates/notice"), {} as NativeEnv)).rejects.toThrow("Sign in");
    expect(notice).not.toHaveBeenCalled();
  });
  it("rejects mutation methods for the public notice endpoint", async () => {
    await expect(updateRoutes(new Request("https://studio.example/api/v1/updates/notice", { method: "POST" }), {} as NativeEnv)).rejects.toThrow("Method not allowed");
    expect(notice).not.toHaveBeenCalled();
  });
});
