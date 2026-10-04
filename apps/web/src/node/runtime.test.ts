import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  startNodeRuntime,
  validateNodeConfiguration,
  nodeApplicationSettings,
  closeNodeResources,
  drainNodeTasks,
  startupFailure,
  formatNodeStartupError,
} from "./runtime";
import { buildMysqlPoolOptions } from "./database";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const base = {
  HUDDLE_PLATFORM: "node-private-volume",
  HUDDLE_DATA_DIRECTORY: "/private/data",
  AUTH_ORIGIN: "https://studio.example",
  DB_HOST: "127.0.0.1",
  DB_PORT: "1",
  DB_NAME: "test",
  DB_USER: "test",
  DB_PASSWORD: "test",
  DB_TLS: "disabled",
};
describe("Node deployment gates", () => {
  it("uses the qualified private catalog directory for GoDaddy without extra settings", () => {
    expect(
      validateNodeConfiguration({
        ...base,
        HUDDLE_PLATFORM: "godaddy",
        HUDDLE_DATA_DIRECTORY: undefined,
      }).platform,
    ).toBe("godaddy");
    expect(
      validateNodeConfiguration({
        ...base,
        HUDDLE_PLATFORM: "godaddy",
        HUDDLE_DATA_DIRECTORY: undefined,
      }).directory,
    ).toBe("/private/huddle-loom");
  });
  it("reserves enough connections for room ownership and normal work", () => {
    expect(() => buildMysqlPoolOptions({ ...base, DB_POOL_SIZE: "1" })).toThrow(
      "at least 2",
    );
  });
  it("rejects a catalog inside the public static tree before connecting to MySQL", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "huddle-private-"));
    directories.push(root);
    await mkdir(resolve(root, "data"), { mode: 0o700 });
    await expect(
      startNodeRuntime({
        ...base,
        HUDDLE_ASSETS_DIRECTORY: root,
        HUDDLE_DATA_DIRECTORY: resolve(root, "data"),
      }),
    ).rejects.toMatchObject({ code: "PRIVATE_STORAGE" });
  });
  it("allows removing the setup password after initialization (state checked at startup)", () => {
    expect(validateNodeConfiguration(base).origin).toBe(base.AUTH_ORIGIN);
  });
});

describe("Node lifecycle utilities", () => {
  it("attempts all resource cleanup after one failure", async () => {
    const closed: string[] = [];
    await expect(
      closeNodeResources([
        () => {
          closed.push("http");
          throw new Error("HTTP failed");
        },
        () => {
          closed.push("rooms");
        },
        () => {
          closed.push("ownership");
        },
        () => {
          closed.push("pool");
        },
      ]),
    ).rejects.toThrow("cleanup failed");
    expect(closed).toEqual(["http", "rooms", "ownership", "pool"]);
  });
  it("forwards approved authentication settings without deployment credentials", () => {
    expect(
      nodeApplicationSettings({
        OIDC_ALLOWED_ORIGINS: "https://id.example",
        CIMD_ALLOWED_ORIGINS: "https://client.example",
        AUTH_SECRETS: "[]",
        DB_PASSWORD: "private",
        SOFTWARE_UPDATE_HOOK: "cloudflare-only",
        HTTP_X_FORWARDED_FOR: "forged",
      }),
    ).toEqual({
      OIDC_ALLOWED_ORIGINS: "https://id.example",
      CIMD_ALLOWED_ORIGINS: "https://client.example",
      AUTH_SECRETS: "[]",
    });
  });
});

it("bounds shutdown draining for a task that never resolves", async () => {
  const started = Date.now();
  await drainNodeTasks([new Promise(() => {})], 10);
  expect(Date.now() - started).toBeLessThan(500);
});

describe("sanitized startup diagnostics", () => {
  it.each([
    [
      "configuration",
      new Error("AUTH_ORIGIN contains a bad origin"),
      "CANONICAL_ORIGIN",
    ],
    ["configuration", new Error("Missing setup password"), "SETUP_PASSWORD"],
    [
      "database",
      Object.assign(
        new Error("SQL password=secret https://provider/?token=private"),
        { code: "ER_ACCESS_DENIED_ERROR" },
      ),
      "DATABASE_CREDENTIALS",
    ],
    [
      "database",
      Object.assign(new Error("private TLS context"), {
        code: "HANDSHAKE_SSL_ERROR",
      }),
      "DATABASE_TLS",
    ],
    [
      "schema",
      Object.assign(new Error("CREATE TRIGGER secret-body"), { errno: 1419 }),
      "SCHEMA_PERMISSIONS",
    ],
    ["schema", new Error("Unknown newer schema history"), "SCHEMA_VERSION"],
    ["keys", new Error("secret-key-material"), "INSTALLATION_KEYS"],
    ["ownership", new Error("another private-db-url"), "OWNERSHIP_UNAVAILABLE"],
    [
      "listen",
      Object.assign(new Error("internal address"), { code: "EADDRINUSE" }),
      "PORT_IN_USE",
    ],
  ] as const)("reports a safe category for %s", (phase, error, code) => {
    const report = formatNodeStartupError(startupFailure(phase, error));
    expect(report).toContain(`[${phase}/${code}]`);
    expect(report).not.toContain(error.message);
    expect(report).not.toMatch(
      /password=secret|token=private|CREATE TRIGGER|key-material/,
    );
  });
  it("does not format arbitrary provider errors verbatim", () => {
    expect(
      formatNodeStartupError(new Error("provider payload secret")),
    ).not.toContain("provider payload");
  });
});
