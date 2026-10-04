import { describe, expect, it } from "vitest";
import type { NativeEnv } from "../src/auth/types";
import {
  CONTENT_SECURITY_POLICY,
  consentContentSecurityPolicy,
  csrfBootstrap,
  protectResponse,
  requireCsrf,
} from "../src/security/request";

const env = {
  AUTH_ORIGIN: "https://studio.example",
  AUTH_SECRET: "isolated-csrf-test-secret-with-at-least-32-characters",
} as NativeEnv;

describe("OAuth browser consent security", () => {
  it("preserves the origin of consent POSTs without disclosing cross-origin referrers", () => {
    const response = protectResponse(new Response("consent"), "/oauth/authorize");
    expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(protectResponse(new Response(), "/api/v1/auth/bootstrap").headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(protectResponse(new Response(), "/oauth/token").headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it.each([
    ["https://assistant.example/callback?state=private", "https://assistant.example"],
    ["http://127.0.0.1:3456/callback", "http://127.0.0.1:3456"],
    ["http://[::1]:3456/callback", "http://[::1]:3456"],
  ])("allows only the registered callback origin in form-action: %s", (uri, origin) => {
    const policy = consentContentSecurityPolicy(uri);
    expect(policy).toBe(CONTENT_SECURITY_POLICY.replace("form-action 'self'", `form-action 'self' ${origin}`));
    const response = protectResponse(new Response("consent", { headers: { "Content-Security-Policy": policy } }), "/oauth/authorize");
    expect(response.headers.get("Content-Security-Policy")).toBe(policy);
    expect(protectResponse(new Response(), "/api/v1/catalog").headers.get("Content-Security-Policy")).toBe(CONTENT_SECURITY_POLICY);
  });

  it("keeps origin, fetch-site, cookie and signed token validation for form approval", async () => {
    const csrf = await csrfBootstrap(new Request(`${env.AUTH_ORIGIN}/oauth/authorize`), env);
    const request = (overrides: Record<string, string> = {}, token = csrf.token) => new Request(`${env.AUTH_ORIGIN}/oauth/authorize`, {
      method: "POST",
      headers: {
        Origin: env.AUTH_ORIGIN!,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: csrf.cookie.split(";")[0],
        ...overrides,
      },
      body: new URLSearchParams({ csrf: token }),
    });
    await expect(requireCsrf(request(), env)).resolves.toBeUndefined();
    for (const headers of [
      { Origin: "null" },
      { Origin: "https://attacker.example" },
      { "Sec-Fetch-Site": "cross-site" },
      { Cookie: "" },
    ]) await expect(requireCsrf(request(headers), env)).rejects.toMatchObject({ status: 403, code: "CSRF_REJECTED" });
    await expect(requireCsrf(request({}, ""), env)).rejects.toMatchObject({ status: 403 });
    await expect(requireCsrf(request({}, `${csrf.token}tampered`), env)).rejects.toMatchObject({ status: 403 });
  });
});
