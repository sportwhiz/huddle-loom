import { createServer } from "node:net";
import { describe, it, expect } from "vitest";
import { needsInstallationGuide, startInstallationGuide } from "./installer";
import type { NodeStartupError } from "./runtime";
const failure = (code = "CANONICAL_ORIGIN", phase = "configuration") =>
  ({ code, phase }) as NodeStartupError;
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
describe("public installation guide", () => {
  it("only handles canonical address and setup credential configuration failures", () => {
    expect(needsInstallationGuide(failure())).toBe(true);
    expect(needsInstallationGuide(failure("SETUP_PASSWORD"))).toBe(true);
    for (const code of [
      "SCHEMA_PERMISSIONS",
      "DATABASE_CREDENTIALS",
      "INSTALLATION_KEYS",
      "OWNERSHIP_UNAVAILABLE",
      "INVALID_CONFIGURATION",
    ])
      expect(needsInstallationGuide(failure(code))).toBe(false);
    expect(needsInstallationGuide(failure("SETUP_PASSWORD", "keys"))).toBe(
      false,
    );
  });
  it("serves instructions without secrets, reflection, application routes, or ownership mutations", async () => {
    const port = await freePort();
    const guide = await startInstallationGuide(failure(), {
      PORT: String(port),
      SETUP_PASSWORD: "never-display-this-secret",
      AUTH_ORIGIN: "https://secret.invalid",
      DB_PASSWORD: "private-db-secret",
    });
    try {
      const origin = `http://127.0.0.1:${port}`;
      const response = await fetch(origin + "/?token=do-not-reflect", {
        headers: {
          Host: "attacker.invalid",
          "X-Forwarded-Host": "other.invalid",
        },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      for (const secret of [
        "never-display-this-secret",
        "secret.invalid",
        "private-db-secret",
        "do-not-reflect",
        "attacker.invalid",
        "other.invalid",
      ])
        expect(html).not.toContain(secret);
      expect(html).toContain("GoDaddy");
      expect(html).toContain("Preview or Publish tab");
      expect(html).not.toContain("shares app settings");
      expect(html).toContain("Your administrator account is created next.");
      expect(html).toContain("HUDDLE_DATABASE_NAMESPACE");
      expect(html).not.toContain("<form");
      expect(html).not.toContain("<input");
      expect(response.headers.get("content-security-policy")).toContain(
        "form-action 'none'",
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      const health = await fetch(origin + "/healthz");
      expect(health.status).toBe(503);
      expect(await health.json()).toEqual({
        ready: false,
        status: "configuration_required",
      });
      for (const path of [
        "/api/v1/auth/bootstrap",
        "/api/v1/setup",
        "/boards/board:home",
        "/mcp",
        "/private/catalog.sqlite",
      ])
        expect((await fetch(origin + path)).status).toBe(404);
      expect(
        (await fetch(origin + "/", { method: "POST", body: "claim=true" }))
          .status,
      ).toBe(405);
      expect(await (await fetch(origin + "/", { method: "HEAD" })).text()).toBe(
        "",
      );
    } finally {
      await guide.close();
    }
  });
  it("refuses invalid ports and non-configuration failures", async () => {
    await expect(
      startInstallationGuide(failure(), { PORT: "0" }),
    ).rejects.toThrow("port");
    await expect(
      startInstallationGuide(failure("OWNERSHIP_UNAVAILABLE")),
    ).rejects.toThrow("unavailable");
  });
});
