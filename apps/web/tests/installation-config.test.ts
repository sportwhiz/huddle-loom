import { describe, it, expect, vi } from "vitest";
import {
  readFileSync,
  mkdtempSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  deploymentAccount,
  deploymentToken,
  installationConfig,
} from "../scripts/installation-config.mjs";
const account = "a".repeat(32);
const environment = {
  CLOUDFLARE_ACCOUNT_ID: account,
  CLOUDFLARE_API_TOKEN: "fixture-only",
  WRANGLER_CI_OVERRIDE_NAME: "my-studio",
};
const fixture = () => ({
  name: "huddle-loom",
  vars: { AUTH_MODE: "native" },
  d1_databases: [
    {
      binding: "CATALOG",
      database_name: "huddle-loom-native-catalog",
    },
  ],
  r2_buckets: [
    {
      binding: "BLOBS",
      bucket_name: "huddle-loom-native-blobs",
    },
  ],
  previews: {
    vars: { AUTH_MODE: "native" },
    d1_databases: [
      {
        binding: "CATALOG",
        database_name: "huddle-loom-preview-catalog",
      },
    ],
  },
});
describe("Cloudflare installation configuration", () => {
  it("resolves a trusted origin and isolates resources for a renamed installation", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ success: true, result: { subdomain: "my-account" } }),
    );
    const configured = await installationConfig(fixture(), {
      environment,
      fetcher,
    });
    expect(configured.vars.AUTH_ORIGIN).toBe(
      "https://my-studio.my-account.workers.dev",
    );
    expect(configured.previews.vars.AUTH_ORIGIN).toBe(
      "https://staging-my-studio.my-account.workers.dev",
    );
    expect(configured.d1_databases[0].database_name).toBe(
      "my-studio-native-catalog",
    );
    expect(configured.previews.d1_databases[0].database_name).toBe(
      "my-studio-preview-catalog",
    );
    expect(configured.r2_buckets[0].bucket_name).toBe("my-studio-native-blobs");
    expect(fetcher.mock.calls[0][0]).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${account}/workers/subdomain`,
    );
  });
  it("preserves explicitly configured origins without requesting credentials", async () => {
    const config = {
      ...fixture(),
      vars: { AUTH_MODE: "native", AUTH_ORIGIN: "https://studio.example.com" },
    };
    expect(
      await installationConfig(config, {
        environment: {},
        fetcher: () => {
          throw Error("unexpected");
        },
      }),
    ).toEqual(config);
  });
  it("fails safely when the account URL cannot be resolved", async () => {
    await expect(
      installationConfig(fixture(), {
        environment,
        fetcher: async () =>
          Response.json(
            {
              success: false,
              errors: [{ message: "sensitive provider detail" }],
            },
            { status: 403 },
          ),
      }),
    ).rejects.toThrow("could not find the workers.dev address");
  });
  it("discovers the origin using an existing Wrangler login without an API token setting", async () => {
    const token = "private-oauth-fixture";
    const run = vi.fn((_command, args) => ({
      status: 0,
      stdout: JSON.stringify(
        args[0] === "whoami"
          ? { accounts: [{ id: account }] }
          : { type: "oauth", token },
      ),
      stderr: "",
    }));
    const fetcher = vi.fn(async (_url, options) => {
      expect(new Headers(options.headers).get("Authorization")).toBe(
        `Bearer ${token}`,
      );
      return Response.json({
        success: true,
        result: { subdomain: "signed-in-account" },
      });
    });
    const configured = await installationConfig(fixture(), {
      environment: {},
      run,
      fetcher,
    });
    expect(configured.vars.AUTH_ORIGIN).toBe(
      "https://huddle-loom.signed-in-account.workers.dev",
    );
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ["whoami", "--json"],
      ["auth", "token", "--json"],
    ]);
    for (const call of run.mock.calls) {
      expect(call[2].stdio).toBe("pipe");
      expect(call[2].env.CI).toBe("true");
      expect(call[2].env.WRANGLER_WRITE_LOGS).toBe("false");
      expect(call[2].timeout).toBe(30000);
    }
  });
  it.each([false, true])(
    "isolates two copies of the actual terminal template (custom origin: %s)",
    async (custom) => {
      const template = JSON.parse(
        readFileSync(
          new URL("../wrangler.native.jsonc", import.meta.url),
          "utf8",
        ),
      );
      const configs = await Promise.all(
        ["studio-a", "studio-b"].map((name) =>
          installationConfig(
            {
              ...template,
              name,
              vars: {
                ...template.vars,
                ...(custom
                  ? { AUTH_ORIGIN: `https://${name}.example.com` }
                  : {}),
              },
            },
            {
              environment: custom
                ? {}
                : {
                    CLOUDFLARE_ACCOUNT_ID: account,
                    CLOUDFLARE_API_TOKEN: "fixture",
                  },
              run: () => {
                throw new Error("No credential discovery needed");
              },
              fetcher: async () =>
                Response.json({
                  success: true,
                  result: { subdomain: "my-account" },
                }),
            },
          ),
        ),
      );
      for (const [index, configured] of configs.entries()) {
        const name = index === 0 ? "studio-a" : "studio-b";
        expect(configured.d1_databases[0].database_name).toBe(
          `${name}-native-catalog`,
        );
        expect(configured.r2_buckets[0].bucket_name).toBe(
          `${name}-native-blobs`,
        );
        expect(configured.previews.d1_databases[0].database_name).toBe(
          `${name}-preview-catalog`,
        );
        expect(configured.previews.r2_buckets[0].bucket_name).toBe(
          `${name}-preview-blobs`,
        );
        expect(configured.vars.AUTH_ORIGIN).toBe(
          custom
            ? `https://${name}.example.com`
            : `https://${name}.my-account.workers.dev`,
        );
      }
      expect(template.d1_databases[0].database_name).toBe(
        "huddle-loom-native-catalog",
      );
    },
  );
  it("preserves pinned databases and deliberately named buckets during a Worker rename", async () => {
    const config = fixture();
    config.d1_databases[0].database_id = "pinned-db";
    config.r2_buckets[0].bucket_name = "deliberate-shared-assets";
    config.vars.AUTH_ORIGIN = "https://custom.example.com";
    config.previews.vars.AUTH_ORIGIN = "https://custom-preview.example.com";
    const configured = await installationConfig(config, {
      environment: { WRANGLER_CI_OVERRIDE_NAME: "renamed-worker" },
    });
    expect(configured.d1_databases).toEqual(config.d1_databases);
    expect(configured.r2_buckets).toEqual(config.r2_buckets);
    expect(configured.previews.vars).toEqual(config.previews.vars);
    expect(configured.name).toBe("renamed-worker");
  });
  it("keeps long Worker names within storage limits with stable, distinct names", async () => {
    const config = {
      ...fixture(),
      vars: { AUTH_MODE: "native", AUTH_ORIGIN: "https://custom.example.com" },
    };
    const a = await installationConfig(config, {
      environment: { WRANGLER_CI_OVERRIDE_NAME: "a".repeat(63) },
    });
    const b = await installationConfig(config, {
      environment: { WRANGLER_CI_OVERRIDE_NAME: "a".repeat(62) + "b" },
    });
    const again = await installationConfig(config, {
      environment: { WRANGLER_CI_OVERRIDE_NAME: "a".repeat(63) },
    });
    expect(a).toEqual(again);
    expect(a.r2_buckets[0].bucket_name).not.toBe(b.r2_buckets[0].bucket_name);
    for (const name of [
      a.d1_databases[0].database_name,
      a.r2_buckets[0].bucket_name,
      a.previews.d1_databases[0].database_name,
    ]) {
      expect(name.length).toBeLessThanOrEqual(63);
      expect(name).toMatch(/^[a-z0-9-]+$/);
    }
  });
  it("sanitizes malformed provider replies and failed requests", async () => {
    for (const fetcher of [
      async () => new Response("private-provider-payload"),
      async () => {
        throw new Error("private-provider-payload");
      },
    ]) {
      await expect(
        installationConfig(fixture(), { environment, fetcher }),
      ).rejects.toThrow(
        "Cloudflare could not find the workers.dev address for this account.",
      );
    }
  });
});

describe("private Wrangler credential discovery", () => {
  it("keeps the pinned Wrangler credential command out of disk logs even with debug logging enabled", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "huddle-credential-test-"));
    const logs = resolve(directory, "logs");
    try {
      const token = deploymentToken(
        {
          ...process.env,
          CLOUDFLARE_API_TOKEN: undefined,
          CF_API_TOKEN: undefined,
          WRANGLER_LOG: "debug",
          WRANGLER_WRITE_LOGS: "true",
          WRANGLER_LOG_PATH: logs,
        },
        (command, args, options) =>
          spawnSync(command, args, {
            ...options,
            env: {
              ...options.env,
              CLOUDFLARE_API_TOKEN: "non-secret-offline-fixture",
              WRANGLER_SEND_METRICS: "false",
            },
          }),
      );
      expect(token).toBe("non-secret-offline-fixture");
      expect(existsSync(logs) ? readdirSync(logs) : []).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("uses an explicitly configured token without running credential commands", () => {
    expect(
      deploymentToken(environment, () => {
        throw Error("unexpected");
      }),
    ).toBe("fixture-only");
  });
  it.each(["oauth", "api_token"])(
    "accepts Wrangler's %s credential",
    (type) => {
      expect(
        deploymentToken({}, () => ({
          status: 0,
          stdout: JSON.stringify({ type, token: "fixture" }),
        })),
      ).toBe("fixture");
    },
  );
  it.each([
    { status: 1, stdout: "private-output", stderr: "private-error" },
    { status: 0, stdout: "private-output" },
    {
      status: 0,
      stdout: JSON.stringify({
        type: "api_key",
        key: "private-output",
        email: "private-output",
      }),
    },
    { status: 0, stdout: JSON.stringify({ type: "oauth", token: "" }) },
  ])(
    "rejects invalid credentials without reflecting command output",
    (result) => {
      expect(() => deploymentToken({}, () => result)).toThrow(
        "Cloudflare authentication is unavailable.",
      );
    },
  );
  it("sanitizes failed account and credential commands", () => {
    const run = () => {
      throw new Error("private-command-output");
    };
    expect(() => deploymentToken({}, run)).toThrow(
      "Cloudflare authentication is unavailable.",
    );
    expect(() => deploymentAccount({}, {}, run)).toThrow(
      "Cloudflare could not identify the deployment account.",
    );
  });
});
