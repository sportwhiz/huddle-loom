import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
// @ts-expect-error Deployment scripts are tested directly as Node modules.
import {
  beginSourceDeployment,
  liveInstallation,
  managedDeployment,
  preserveInstallation,
  verifyDeployment,
} from "../scripts/update-runner.mjs";
// @ts-expect-error Node build utility.
import { schemaDigest } from "../../../scripts/releases/build-info.mjs";
const installed = {
  name: "my-studio",
  vars: { AUTH_MODE: "native", AUTH_ORIGIN: "https://studio.example.com" },
  d1_databases: [
    {
      binding: "CATALOG",
      database_id: "installation-database",
      migrations_dir: "old",
    },
  ],
  r2_buckets: [{ binding: "BLOBS", bucket_name: "private-assets" }],
  durable_objects: {
    bindings: [{ name: "BOARD_ROOMS", class_name: "BoardRoom" }],
  },
};
const target = {
  version: "1.2.1",
  commit: "a".repeat(40),
  schema: "b".repeat(64),
  protocol: 1,
  dataFormat: 1,
  notes: "",
  security: false,
};
describe("release deployment runner", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("preserves the pinned installation account when the build account differs", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "fixture-build-token");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "2".repeat(32));
    const fetcher = vi.fn(async () =>
      Response.json({
        success: true,
        result: {
          bindings: [
            { name: "CATALOG", type: "d1", id: "installation-database" },
          ],
        },
      }),
    );
    await liveInstallation(
      { ...installed, account_id: "1".repeat(32) },
      fetcher,
    );
    expect(fetcher.mock.calls[0][0]).toContain(
      `/accounts/${"1".repeat(32)}/workers/scripts/`,
    );
  });
  it("preserves live variables and bucket identity without exposing runtime secrets", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "fixture-build-token");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "1".repeat(32));
    const fetcher = vi.fn(async () =>
      Response.json({
        success: true,
        result: {
          bindings: [
            {
              name: "AUTH_ORIGIN",
              type: "plain_text",
              text: "https://custom.example.com",
            },
            { name: "AUTH_SECRET", type: "secret_text" },
            { name: "CATALOG", type: "d1", id: "installation-database" },
            {
              name: "BLOBS",
              type: "r2_bucket",
              bucket_name: "live-private-assets",
            },
          ],
        },
      }),
    );
    const result = await liveInstallation(installed, fetcher);
    expect(result.vars.AUTH_ORIGIN).toBe("https://custom.example.com");
    expect(result.vars.AUTH_SECRET).toBeUndefined();
    expect(result.r2_buckets[0].bucket_name).toBe("live-private-assets");
    await expect(
      liveInstallation(installed, async () =>
        Response.json({
          success: true,
          result: {
            bindings: [{ name: "CATALOG", type: "d1", id: "wrong-database" }],
          },
        }),
      ),
    ).rejects.toThrow("identity differs");
  });

  it("preserves installation identity while taking code and migrations from the release", () => {
    const next = {
      ...installed,
      name: "template",
      vars: { AUTH_ORIGIN: "https://template.test" },
      main: "new-worker.js",
      d1_databases: [
        {
          binding: "CATALOG",
          database_name: "template",
          migrations_dir: "new-migrations",
        },
      ],
    };
    const result = preserveInstallation(next, installed);
    expect(result.name).toBe("my-studio");
    expect(result.main).toBe("new-worker.js");
    expect(result.vars.AUTH_ORIGIN).toBe("https://studio.example.com");
    expect(result.d1_databases[0]).toMatchObject({
      database_id: "installation-database",
      migrations_dir: "new-migrations",
    });
    expect(result.r2_buckets[0].bucket_name).toBe("private-assets");
    expect(result.keep_vars).toBe(true);
    expect(() =>
      preserveInstallation(
        { ...next, durable_objects: { bindings: [] } },
        installed,
      ),
    ).toThrow("storage bindings");
  });
  it("does not treat an old healthy deployment as a successful update", async () => {
    expect(
      await verifyDeployment("https://studio.example.com", target, async () =>
        Response.json({
          ok: true,
          release: { ...target, commit: "c".repeat(40) },
        }),
      ),
    ).toBe(false);
    expect(
      await verifyDeployment("https://studio.example.com", target, async () =>
        Response.json({ ok: true, release: target }),
      ),
    ).toBe(true);
  });
  it.each([
    "success",
    "build-failure",
    "deploy-failure",
    "wrong-version",
    "cancelled",
    "retry-build-failure",
    "late-verifier",
  ])("rehearses update lifecycle: %s", async (mode) => {
    const directory = mkdtempSync(resolve(tmpdir(), "update-runner-test-"));
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE auth_users(id TEXT PRIMARY KEY)");
    sqlite.exec(
      readFileSync(
        new URL("../migrations/0026_software_updates.sql", import.meta.url),
        "utf8",
      ),
    );
    const configPath = resolve(directory, "installed.json");
    writeFileSync(configPath, JSON.stringify(installed));
    sqlite
      .prepare("UPDATE software_update_settings SET runner_origin=?")
      .run(installed.vars.AUTH_ORIGIN);
    const db = (sql: string) => sqlite.prepare(sql).all();
    const commands: string[] = [];
    let resolved = { ...target };
    const source = resolve(directory, "source");
    mkdirSync(resolve(source, "apps/web/migrations"), { recursive: true });
    writeFileSync(
      resolve(source, "apps/web/migrations/0001.sql"),
      "CREATE TABLE example(id TEXT);",
    );
    resolved.schema = schemaDigest(source);
    sqlite
      .prepare(
        "INSERT INTO software_updates(id,release,previous_release,version,status,created_at,updated_at) VALUES('job',?,?,'1.2.1','queued',0,0)",
      )
      .run(JSON.stringify(resolved), JSON.stringify(target));
    if (mode === "retry-build-failure")
      sqlite.exec(
        "UPDATE software_updates SET checkpoint='original-checkpoint'",
      );
    const command = (name: string, args: string[], options: any = {}) => {
      commands.push(`${name} ${args.join(" ")}`);
      if (name === "git" && args[0] === "init") {
        const dir = args[1];
        mkdirSync(resolve(dir, "apps/web/migrations"), { recursive: true });
        writeFileSync(
          resolve(dir, "apps/web/migrations/0001.sql"),
          "CREATE TABLE example(id TEXT);",
        );
        writeFileSync(
          resolve(dir, "package.json"),
          JSON.stringify({ version: "1.2.1" }),
        );
        writeFileSync(
          resolve(dir, "wrangler.jsonc"),
          JSON.stringify(installed),
        );
      }
      if (args.includes("rev-parse")) return resolved.commit;
      if (name === "wrangler") {
        if (mode === "cancelled")
          sqlite.exec(
            "UPDATE software_updates SET status='failed',runner_id=NULL",
          );
        return JSON.stringify({ bookmark: "bookmark-before-upgrade" });
      }
      if (
        args.includes("build") &&
        ["build-failure", "retry-build-failure"].includes(mode)
      )
        throw new Error("Build failed");
      if (args.includes("deploy") && mode === "deploy-failure")
        throw new Error("Deployment timed out");
      return "";
    };
    try {
      const invoke = managedDeployment(configPath, installed, {
        db,
        command,
        liveInstallation: async (x: any) => x,
        verify: async () => {
          if (mode === "late-verifier") {
            sqlite.exec("UPDATE software_updates SET status='succeeded'");
            sqlite
              .prepare("UPDATE software_update_settings SET active_release=?")
              .run(
                JSON.stringify({
                  ...resolved,
                  version: "1.2.2",
                  commit: "c".repeat(40),
                }),
              );
          }
          return mode !== "wrong-version";
        },
        sleep: async () => {},
      });
      if (["success", "late-verifier"].includes(mode))
        await expect(invoke).resolves.toBe(true);
      else await expect(invoke).rejects.toThrow();
      if (mode === "late-verifier")
        expect(
          JSON.parse(
            sqlite
              .prepare("SELECT active_release FROM software_update_settings")
              .get()!.active_release as string,
          ).commit,
        ).toBe("c".repeat(40));
      const job = sqlite.prepare("SELECT * FROM software_updates").get()!;
      expect(job.status).toBe(
        ["success", "late-verifier"].includes(mode)
          ? "succeeded"
          : ["build-failure", "cancelled"].includes(mode)
            ? "failed"
            : "uncertain",
      );
      if (["build-failure", "cancelled", "retry-build-failure"].includes(mode))
        expect(commands.some((c) => c === "pnpm run deploy")).toBe(false);
      else expect(job.checkpoint).toBe("bookmark-before-upgrade");
      expect(
        sqlite
          .prepare("SELECT active_release FROM software_update_settings")
          .get()!.active_release !== null,
      ).toBe(["success", "late-verifier"].includes(mode));
    } finally {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("locks pinned rebuilds before asynchronous preparation and rejects stale release pointers", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "update-overlap-test-"));
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE auth_users(id TEXT PRIMARY KEY)");
    sqlite.exec(
      readFileSync(
        new URL("../migrations/0026_software_updates.sql", import.meta.url),
        "utf8",
      ),
    );
    const configPath = resolve(directory, "installed.json");
    writeFileSync(configPath, JSON.stringify(installed));
    mkdirSync(resolve(directory, "apps/web/migrations"), { recursive: true });
    writeFileSync(
      resolve(directory, "apps/web/migrations/0001.sql"),
      "SELECT 1;",
    );
    const release = { ...target, schema: schemaDigest(directory) };
    const next = { ...release, version: "1.2.2", commit: "c".repeat(40) };
    sqlite
      .prepare(
        "UPDATE software_update_settings SET active_release=?,runner_origin=?",
      )
      .run(JSON.stringify(release), installed.vars.AUTH_ORIGIN);
    const db = (sql: string) => sqlite.prepare(sql).all();
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const command = (name: string, args: string[]) => {
      if (name === "git" && args[0] === "init") {
        mkdirSync(resolve(args[1], "apps/web/migrations"), { recursive: true });
        writeFileSync(
          resolve(args[1], "apps/web/migrations/0001.sql"),
          "SELECT 1;",
        );
        writeFileSync(
          resolve(args[1], "package.json"),
          JSON.stringify({ version: release.version }),
        );
        writeFileSync(
          resolve(args[1], "wrangler.jsonc"),
          JSON.stringify(installed),
        );
      }
      if (args.includes("rev-parse")) return release.commit;
      if (name === "wrangler")
        return JSON.stringify({ bookmark: "checkpoint" });
      return "";
    };
    try {
      const original = managedDeployment(configPath, installed, {
        db,
        command,
        liveInstallation: async (x: any) => {
          await gate;
          return {
            ...structuredClone(x),
            vars: { ...x.vars, AUTH_ORIGIN: "https://new-login.example.com" },
          };
        },
        verify: async (origin: string) => {
          expect(origin).toBe("https://new-login.example.com");
          return true;
        },
      });
      expect(
        sqlite.prepare("SELECT status FROM software_updates").get()!.status,
      ).toBe("building");
      await expect(
        managedDeployment(configPath, installed, { db }),
      ).rejects.toThrow("Another build owns");
      expect(() =>
        sqlite
          .prepare(
            "INSERT INTO software_updates(id,release,previous_release,version,status,created_at,updated_at) VALUES('next',?,?,'1.2.2','queued',0,0)",
          )
          .run(JSON.stringify(next), JSON.stringify(release)),
      ).toThrow("UNIQUE");
      resume();
      await original;
      expect(
        sqlite.prepare("SELECT status FROM software_updates").get()!.status,
      ).toBe("succeeded");
      sqlite.exec("UPDATE software_updates SET status='deploying'");
      const health = vi.fn(async () => true);
      await expect(
        managedDeployment(configPath, installed, { db, verify: health }),
      ).rejects.toThrow("still publishing");
      expect(health).not.toHaveBeenCalled();
      expect(
        sqlite.prepare("SELECT status FROM software_updates").get()!.status,
      ).toBe("deploying");
      sqlite.exec("UPDATE software_updates SET status='succeeded'");
      // A deployment may finish between reading the pointer and claiming it.
      let switched = false;
      const staleDb = (sql: string) => {
        if (!switched && sql.startsWith("INSERT INTO software_updates")) {
          switched = true;
          sqlite
            .prepare("UPDATE software_update_settings SET active_release=?")
            .run(JSON.stringify(next));
        }
        return db(sql);
      };
      await expect(
        managedDeployment(configPath, installed, { db: staleDb, command }),
      ).rejects.toThrow("Another deployment owns");
      expect(
        JSON.parse(
          sqlite
            .prepare("SELECT active_release FROM software_update_settings")
            .get()!.active_release as string,
        ).commit,
      ).toBe(next.commit);
    } finally {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("serializes source publication and fences stopped runners from publishing or completing", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE auth_users(id TEXT PRIMARY KEY)");
    sqlite.exec(
      readFileSync(
        new URL("../migrations/0026_software_updates.sql", import.meta.url),
        "utf8",
      ),
    );
    sqlite.exec("INSERT INTO auth_users VALUES('owner')");
    sqlite.exec("UPDATE software_update_settings SET runner_seen_at=1");
    const db = (sql: string) => sqlite.prepare(sql).all();
    const deps = {
      db,
      release: target,
      command: () => JSON.stringify({ bookmark: "source-checkpoint" }),
    };
    try {
      const original = beginSourceDeployment("unused", installed, deps)!;
      expect(() => beginSourceDeployment("unused", installed, deps)).toThrow(
        "Another deployment owns",
      );
      original.beginPublication();
      original.assertOwned();
      original.fail();
      expect(
        sqlite.prepare("SELECT status FROM software_updates").get()!.status,
      ).toBe("uncertain");
      sqlite.exec("UPDATE software_updates SET status='queued',runner_id=NULL");
      expect(() =>
        beginSourceDeployment("unused", installed, {
          ...deps,
          release: { ...target, commit: "c".repeat(40) },
        }),
      ).toThrow("original revision");
      const retry = beginSourceDeployment("unused", installed, deps)!;
      expect(() => original.assertOwned()).toThrow("ownership changed");
      expect(() => original.beginPublication()).toThrow("ownership changed");
      original.finish();
      expect(
        sqlite.prepare("SELECT status FROM software_updates").get()!.status,
      ).toBe("building");
      retry.beginPublication();
      retry.finish();
      expect(
        sqlite.prepare("SELECT status FROM software_updates").get()!.status,
      ).toBe("succeeded");
      expect(
        sqlite
          .prepare("SELECT active_release FROM software_update_settings")
          .get()!.active_release,
      ).toBeNull();
    } finally {
      sqlite.close();
    }
  });
  it("resumes a caught first-rollout failure without a recovery UI or registered hook", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE auth_users(id TEXT PRIMARY KEY)");
    sqlite.exec(readFileSync(new URL("../migrations/0026_software_updates.sql", import.meta.url), "utf8"));
    sqlite.exec("INSERT INTO auth_users VALUES('existing-owner')");
    const db = (sql: string) => sqlite.prepare(sql).all();
    const deps = { db, release: target, command: () => JSON.stringify({ bookmark: "original-checkpoint" }) };
    try {
      const original = beginSourceDeployment("unused", installed, deps)!;
      original.beginPublication();
      // An interrupted build keeps ownership; no second publisher may take it.
      await expect(managedDeployment("unused", installed, { db })).rejects.toThrow("Another deployment owns");
      original.fail(); // Called only after the failed publishing child has exited.
      const pending = sqlite.prepare("SELECT * FROM software_updates").get()!;
      expect(pending.status).toBe("queued");
      expect(pending.runner_id).toBeNull();
      expect(pending.checkpoint).toBe("original-checkpoint");
      expect(() => beginSourceDeployment("unused", installed, { ...deps, release: { ...target, commit: "c".repeat(40) } })).toThrow("original revision");
      expect(() => beginSourceDeployment("unused", installed, { ...deps, release: { ...target, schema: "c".repeat(64) } })).toThrow("original revision");
      const retry = beginSourceDeployment("unused", installed, deps)!;
      original.fail();
      expect(() => original.assertOwned()).toThrow("ownership changed");
      retry.beginPublication();
      retry.finish();
      const done = sqlite.prepare("SELECT * FROM software_updates").get()!;
      expect(done.id).toBe(pending.id);
      expect(done.status).toBe("succeeded");
      expect(done.checkpoint).toBe("original-checkpoint");
    } finally { sqlite.close(); }
  });
  it("requires explicit hosting recovery for an interrupted bootstrap and fences its former publisher", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE auth_users(id TEXT PRIMARY KEY)");
    sqlite.exec(readFileSync(new URL("../migrations/0026_software_updates.sql", import.meta.url), "utf8"));
    const db = (sql: string) => sqlite.prepare(sql).all();
    const deps = { db, release: target, command: () => JSON.stringify({ bookmark: "interrupted-checkpoint" }) };
    try {
      const old = beginSourceDeployment("unused", installed, deps)!;
      old.beginPublication();
      expect(() => beginSourceDeployment("unused", installed, deps)).toThrow("original revision");
      expect(() => beginSourceDeployment("unused", installed, { ...deps, recoverBootstrap: true, release: { ...target, commit: "c".repeat(40) } })).toThrow("original revision");
      const recovery = beginSourceDeployment("unused", installed, { ...deps, recoverBootstrap: true })!;
      expect(() => old.assertOwned()).toThrow("ownership changed");
      old.fail();
      expect(sqlite.prepare("SELECT status FROM software_updates").get()!.status).toBe("building");
      recovery.beginPublication();
      recovery.finish();
      expect(sqlite.prepare("SELECT checkpoint FROM software_updates").get()!.checkpoint).toBe("interrupted-checkpoint");
      sqlite.exec("UPDATE software_update_settings SET runner_seen_at=1");
      const registered = beginSourceDeployment("unused", installed, deps)!;
      registered.beginPublication();
      expect(() => beginSourceDeployment("unused", installed, { ...deps, recoverBootstrap: true })).toThrow("original revision");
    } finally { sqlite.close(); }
  });
  it("retains a dashboard login address and the registered updater identity on a source rebuild", async () => {
    const sqlite = new DatabaseSync(":memory:");
    const directory = mkdtempSync(resolve(tmpdir(), "update-origin-test-"));
    sqlite.exec("CREATE TABLE auth_users(id TEXT PRIMARY KEY)");
    sqlite.exec(readFileSync(new URL("../migrations/0026_software_updates.sql", import.meta.url), "utf8"));
    const configuration = structuredClone(installed) as any;
    const configPath = resolve(directory, "installed.json");
    writeFileSync(configPath, JSON.stringify(configuration));
    sqlite.prepare("UPDATE software_update_settings SET runner_seen_at=1,runner_origin=?").run(configuration.vars.AUTH_ORIGIN);
    try {
      const result = await managedDeployment(configPath, configuration, {
        db: (sql: string) => sqlite.prepare(sql).all(),
        liveInstallation: async (value: any) => ({ ...structuredClone(value), vars: { AUTH_MODE: "native", AUTH_ORIGIN: "https://custom.example.com", MAIL_FROM: "notes@example.com" } }),
      });
      expect(result).toBe(false);
      const prepared = JSON.parse(readFileSync(configPath, "utf8"));
      expect(prepared.vars.AUTH_ORIGIN).toBe("https://custom.example.com");
      expect(prepared.vars.SOFTWARE_UPDATE_RUNNER_ORIGIN).toBe(installed.vars.AUTH_ORIGIN);
      expect(configuration.vars).toEqual(prepared.vars);
      expect(prepared.d1_databases[0].database_id).toBe("installation-database");
      expect(prepared.vars.MAIL_FROM).toBe("notes@example.com");
      // A legacy registration using the live custom address also migrates.
      sqlite.prepare("UPDATE software_update_settings SET runner_origin=?").run("https://custom.example.com");
      const legacy = structuredClone(installed) as any;
      delete legacy.vars.SOFTWARE_UPDATE_RUNNER_ORIGIN;
      writeFileSync(configPath, JSON.stringify(legacy));
      await managedDeployment(configPath, legacy, {
        db: (sql: string) => sqlite.prepare(sql).all(),
        liveInstallation: async (value: any) => ({ ...structuredClone(value), vars: { AUTH_MODE: "native", AUTH_ORIGIN: "https://custom.example.com" } }),
      });
      expect(legacy.vars.SOFTWARE_UPDATE_RUNNER_ORIGIN).toBe("https://custom.example.com");
      const wrongWorker = { ...structuredClone(installed), vars: { AUTH_MODE: "native", AUTH_ORIGIN: "https://unrelated.example.com" } };
      writeFileSync(configPath, JSON.stringify(wrongWorker));
      await expect(managedDeployment(configPath, wrongWorker, {
        db: (sql: string) => sqlite.prepare(sql).all(),
        liveInstallation: async (value: any) => value,
      })).rejects.toThrow("different installation origin");
    } finally { sqlite.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it("fails closed on catalog access errors", async () => {
    await expect(
      managedDeployment("unused", installed, {
        db: () => {
          throw new Error("Permission denied");
        },
      }),
    ).rejects.toThrow("Permission denied");
  });
});
