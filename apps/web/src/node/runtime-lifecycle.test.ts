import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, type Pool } from "mysql2/promise";
import { createServer } from "node:net";
import { mkdtemp, writeFile, rm, stat, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { startNodeRuntime } from "./runtime";
import { acquireNodeOwnership } from "./rooms";
import { MysqlCatalog } from "./mysql-catalog";
import { createNativeAuthDatabase } from "./auth-database";
import { DatabaseSync } from "node:sqlite";
import { namespaceMysqlPool } from "./database-namespace";
import { MysqlCoordinationStore } from "./database";
import { sql } from "kysely";

const url = process.env.NODE_LIFECYCLE_MYSQL_TEST_URL;
describe.skipIf(!url)("Node ownership lifecycle against MySQL", () => {
  let pool: Pool, assets: string, config: Record<string, string>;
  const lockName = (database: string) =>
    `huddle-rooms:${createHash("sha256").update(database).digest("hex").slice(0, 48)}`;
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!parsed.pathname.endsWith("_test") || parsed.hostname !== "127.0.0.1")
      throw new Error("Explicit local disposable database required");
    pool = createPool(url!);
    assets = await mkdtemp(resolve(tmpdir(), "huddle-lifecycle-"));
    await writeFile(resolve(assets, "index.html"), "test");
    config = {
      DB_HOST: parsed.hostname,
      DB_PORT: parsed.port,
      DB_USER: decodeURIComponent(parsed.username),
      DB_PASSWORD: decodeURIComponent(parsed.password),
      DB_NAME: parsed.pathname.slice(1),
      DB_TLS: "disabled",
      HUDDLE_PLATFORM: "node-mysql",
      HUDDLE_ASSETS_DIRECTORY: assets,
      AUTH_ORIGIN: "http://127.0.0.1:5291",
      PORT: "5291",
      ENVIRONMENT: "test",
      SETUP_PASSWORD: "local-lifecycle-private-setup-password",
    };
  });
  afterAll(async () => {
    await pool?.end();
    if (assets) await rm(assets, { recursive: true, force: true });
  });
  it.each(["node-mysql", "node-private-volume"])(
    "isolates simultaneous preview/live %s runtimes and preserves them across restart",
    async (platform) => {
      const parent = await mkdtemp(resolve(tmpdir(), "huddle-variants-"));
      const runtimes: Awaited<ReturnType<typeof startNodeRuntime>>[] = [];
      const pools: Pool[] = [];
      async function freePort() {
        const server = createServer();
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        const port = (server.address() as { port: number }).port;
        await new Promise<void>((resolve) => server.close(() => resolve()));
        return port;
      }
      const variants: Record<string, string>[] = [];
      try {
        for (const namespace of [
          `preview_${randomUUID().slice(0, 6)}`,
          `live_${randomUUID().slice(0, 6)}`,
        ]) {
          const port = await freePort();
          const settings = {
            ...config,
            HUDDLE_PLATFORM: platform,
            HUDDLE_DATABASE_NAMESPACE: namespace,
            HUDDLE_DATA_DIRECTORY: parent,
            PORT: String(port),
            AUTH_ORIGIN: `http://127.0.0.1:${port}`,
          };
          variants.push(settings);
          runtimes.push(await startNodeRuntime(settings));
          pools.push(namespaceMysqlPool(createPool(url!), namespace));
        }
        for (let index = 0; index < 2; index++) {
          expect(runtimes[index].isReady()).toBe(true);
          expect(
            (await fetch(variants[index].AUTH_ORIGIN + "/healthz")).status,
          ).toBe(200);
          const title = `Isolated ${variants[index].HUDDLE_DATABASE_NAMESPACE}`;
          if (platform === "node-private-volume") {
            const database = new DatabaseSync(
              resolve(
                parent,
                variants[index].HUDDLE_DATABASE_NAMESPACE,
                "catalog.sqlite",
              ),
            );
            try {
              database
                .prepare("UPDATE installation SET title=? WHERE id='instance'")
                .run(title);
            } finally {
              database.close();
            }
          } else {
            await pools[index].execute(
              "UPDATE installation SET title=? WHERE id='instance'",
              [title],
            );
          }
        }
        const keys = await Promise.all(
          pools.map((pool) =>
            new MysqlCoordinationStore(pool).readSecret(
              "installation-auth-v1",
              48,
            ),
          ),
        );
        expect(Buffer.from(keys[0]).equals(Buffer.from(keys[1]))).toBe(false);
        for (let index = 0; index < 2; index++) {
          const response = await fetch(
            variants[index].AUTH_ORIGIN + "/api/v1/auth/bootstrap",
          );
          expect(response.status).toBe(200);
          expect(((await response.json()) as { title: string }).title).toBe(
            `Isolated ${variants[index].HUDDLE_DATABASE_NAMESPACE}`,
          );
        }
        if (platform === "node-private-volume")
          await expect(
            stat(resolve(parent, "catalog.sqlite")),
          ).rejects.toMatchObject({ code: "ENOENT" });
        await runtimes[0].close();
        runtimes[0] = await startNodeRuntime(variants[0]);
        expect(runtimes[1].isReady()).toBe(true);
        expect(
          (
            (await (
              await fetch(variants[0].AUTH_ORIGIN + "/api/v1/auth/bootstrap")
            ).json()) as { title: string }
          ).title,
        ).toBe(`Isolated ${variants[0].HUDDLE_DATABASE_NAMESPACE}`);
        expect(
          Buffer.from(
            await new MysqlCoordinationStore(pools[0]).readSecret(
              "installation-auth-v1",
              48,
            ),
          ).equals(Buffer.from(keys[0])),
        ).toBe(true);
      } finally {
        await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
        await Promise.allSettled(pools.map((pool) => pool.end()));
        await rm(parent, { recursive: true, force: true });
      }
    },
    60000,
  );
  it.each(["node-mysql", "node-private-volume"])(
    "rejects changing %s backend or private directory before catalog migration",
    async (platform) => {
      const directory = await mkdtemp(resolve(tmpdir(), "huddle-pin-"));
      const namespace = `pin_${randomUUID().slice(0, 6)}`;
      const selected = {
        ...config,
        HUDDLE_PLATFORM: platform,
        HUDDLE_DATA_DIRECTORY: directory,
        HUDDLE_DATABASE_NAMESPACE: namespace,
      };
      let runtime: Awaited<ReturnType<typeof startNodeRuntime>> | undefined;
      try {
        runtime = await startNodeRuntime(selected);
        await runtime.close();
        runtime = undefined;
        const [before] = await pool.query("SHOW TABLES");
        const opposite =
          platform === "node-mysql" ? "node-private-volume" : "node-mysql";
        await expect(
          startNodeRuntime({ ...selected, HUDDLE_PLATFORM: opposite }),
        ).rejects.toMatchObject({ phase: "schema" });
        expect((await pool.query("SHOW TABLES"))[0]).toEqual(before);
        if (platform === "node-mysql") {
          await expect(
            stat(resolve(directory, namespace, "catalog.sqlite")),
          ).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          const changed = resolve(directory, "replacement");
          await expect(
            startNodeRuntime({ ...selected, HUDDLE_DATA_DIRECTORY: changed }),
          ).rejects.toMatchObject({ phase: "schema" });
          await expect(
            stat(resolve(changed, namespace, "catalog.sqlite")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          const database = new DatabaseSync(
            resolve(directory, namespace, "catalog.sqlite"),
          );
          try {
            expect(database.prepare("PRAGMA integrity_check").get()).toEqual({
              integrity_check: "ok",
            });
          } finally {
            database.close();
          }
        }
        runtime = await startNodeRuntime(selected);
        expect(
          (await fetch(config.AUTH_ORIGIN + "/api/v1/auth/bootstrap")).status,
        ).toBe(200);
      } finally {
        await runtime?.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    60000,
  );
  it("refuses missing or replacement SQLite catalogs and resumes after restoring the original", async () => {
    const parent = await mkdtemp(resolve(tmpdir(), "huddle-missing-"));
    const namespace = `lost_${randomUUID().slice(0, 6)}`;
    const selected = {
      ...config,
      HUDDLE_PLATFORM: "node-private-volume",
      HUDDLE_DATA_DIRECTORY: parent,
      HUDDLE_DATABASE_NAMESPACE: namespace,
    };
    const path = resolve(parent, namespace, "catalog.sqlite"),
      backup = path + ".backup";
    let runtime: Awaited<ReturnType<typeof startNodeRuntime>> | undefined;
    try {
      runtime = await startNodeRuntime(selected);
      await runtime.close();
      runtime = undefined;
      const original = new DatabaseSync(path);
      try {
        original
          .prepare(
            "UPDATE installation SET title='Original installation' WHERE id='instance'",
          )
          .run();
      } finally {
        original.close();
      }
      await rename(path, backup);
      await expect(startNodeRuntime(selected)).rejects.toMatchObject({
        phase: "schema",
      });
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(path, "");
      await expect(startNodeRuntime(selected)).rejects.toMatchObject({
        phase: "schema",
      });
      const replacement = new DatabaseSync(path);
      try {
        expect(
          replacement
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all(),
        ).toEqual([]);
      } finally {
        await replacement.close();
      }
      await rm(path);
      await rename(backup, path);
      runtime = await startNodeRuntime(selected);
      const response = await fetch(
        config.AUTH_ORIGIN + "/api/v1/auth/bootstrap",
      );
      expect(response.status).toBe(200);
      expect(((await response.json()) as { title: string }).title).toBe(
        "Original installation",
      );
    } finally {
      await runtime?.close();
      await rm(parent, { recursive: true, force: true });
    }
  }, 60000);
  it("refuses a missing MySQL identity table without rebuilding it and resumes after restoration", async () => {
    const namespace = `lost_${randomUUID().slice(0, 6)}`;
    const selected = { ...config, HUDDLE_DATABASE_NAMESPACE: namespace };
    const table = `hn_${namespace}_installation_key_identity`,
      backup = `${table}_backup`;
    let runtime: Awaited<ReturnType<typeof startNodeRuntime>> | undefined;
    let moved = false;
    try {
      runtime = await startNodeRuntime(selected);
      await runtime.close();
      runtime = undefined;
      await pool.query(`RENAME TABLE \`${table}\` TO \`${backup}\``);
      moved = true;
      await expect(startNodeRuntime(selected)).rejects.toMatchObject({
        phase: "schema",
      });
      const [tables] = await pool.execute(
        "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?",
        [table],
      );
      expect(tables).toEqual([]);
      await pool.query(`RENAME TABLE \`${backup}\` TO \`${table}\``);
      moved = false;
      runtime = await startNodeRuntime(selected);
      expect(
        (await fetch(config.AUTH_ORIGIN + "/api/v1/auth/bootstrap")).status,
      ).toBe(200);
    } finally {
      await runtime?.close();
      if (moved) await pool.query(`RENAME TABLE \`${backup}\` TO \`${table}\``);
    }
  }, 60000);
  it.each(["node-mysql", "node-private-volume"])(
    "resumes interrupted %s key provisioning without replacing keys or catalog",
    async (platform) => {
      const parent = await mkdtemp(resolve(tmpdir(), "huddle-incomplete-"));
      const namespace = `boot_${randomUUID().slice(0, 6)}`;
      const selected = {
        ...config,
        HUDDLE_PLATFORM: platform,
        HUDDLE_DATABASE_NAMESPACE: namespace,
        HUDDLE_DATA_DIRECTORY: parent,
      };
      const scoped = namespaceMysqlPool(createPool(url!), namespace);
      let runtime: Awaited<ReturnType<typeof startNodeRuntime>> | undefined;
      try {
        runtime = await startNodeRuntime(selected);
        await runtime.close();
        runtime = undefined;
        const store = new MysqlCoordinationStore(scoped);
        const originalKey = await store.readSecret("installation-auth-v1", 48);
        // Reproduce the persisted state between key creation and fingerprint /
        // completion-marker writes, retaining the original migrated catalog.
        await scoped.execute(
          "DELETE FROM hl_node_secrets WHERE name='catalog-provisioned-v1'",
        );
        if (platform === "node-private-volume") {
          const database = new DatabaseSync(
            resolve(parent, namespace, "catalog.sqlite"),
          );
          try {
            database.exec(
              "DELETE FROM installation_key_identity WHERE id='automatic-v1'",
            );
            database.exec(
              "UPDATE installation SET title='Interrupted installation' WHERE id='instance'",
            );
          } finally {
            database.close();
          }
        } else {
          await scoped.execute(
            "DELETE FROM installation_key_identity WHERE id='automatic-v1'",
          );
          await scoped.execute(
            "UPDATE installation SET title='Interrupted installation' WHERE id='instance'",
          );
        }
        runtime = await startNodeRuntime(selected);
        const response = await fetch(
          config.AUTH_ORIGIN + "/api/v1/auth/bootstrap",
        );
        expect(response.status).toBe(200);
        expect(((await response.json()) as { title: string }).title).toBe(
          "Interrupted installation",
        );
        expect(
          Buffer.from(
            await store.readSecret("installation-auth-v1", 48),
          ).equals(Buffer.from(originalKey)),
        ).toBe(true);
        const [marker] = await scoped.execute(
          "SELECT name FROM hl_node_secrets WHERE name='catalog-provisioned-v1'",
        );
        expect(marker).toEqual([{ name: "catalog-provisioned-v1" }]);
        await runtime.close();
        runtime = undefined;
        runtime = await startNodeRuntime(selected);
        expect(runtime.isReady()).toBe(true);
      } finally {
        await runtime?.close();
        await scoped.end();
        await rm(parent, { recursive: true, force: true });
      }
    },
    60000,
  );
  it("refuses a competing runtime before performing schema initialization", async () => {
    const owner = await acquireNodeOwnership(pool);
    const [before] = await pool.query("SHOW TABLES");
    try {
      await expect(startNodeRuntime(config)).rejects.toMatchObject({
        code: "OWNERSHIP_UNAVAILABLE",
      });
      expect((await pool.query("SHOW TABLES"))[0]).toEqual(before);
    } finally {
      await owner.close();
    }
  });
  it("releases exclusive ownership after a listener startup failure", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) =>
      occupied.listen(0, "0.0.0.0", resolve),
    );
    const port = (occupied.address() as { port: number }).port;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(
          startNodeRuntime({
            ...config,
            PORT: String(port),
            AUTH_ORIGIN: `http://127.0.0.1:${port}`,
          }),
        ).rejects.toMatchObject({ code: "PORT_IN_USE" });
        const replacement = await acquireNodeOwnership(pool);
        await replacement.close();
      }
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  }, 30000);
  it("makes readiness fail and shuts down on loss of the ownership connection", async () => {
    const runtime = await startNodeRuntime(config);
    try {
      expect(runtime.isReady()).toBe(true);
      expect((await fetch(config.AUTH_ORIGIN + "/healthz")).status).toBe(200);
      const [rows] = await pool.query("SELECT IS_USED_LOCK(?) AS id", [
        lockName(config.DB_NAME),
      ]);
      const id = Number((rows as { id: number }[])[0].id);
      expect(Number.isSafeInteger(id)).toBe(true);
      await pool.query(`KILL CONNECTION ${id}`);
      await Promise.race([
        runtime.failure,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Failure was not signalled")),
            3000,
          ),
        ),
      ]);
      expect(runtime.isReady()).toBe(false);
      await runtime.close();
      const replacement = await acquireNodeOwnership(pool);
      await replacement.close();
    } finally {
      await runtime.close();
    }
  }, 30000);
  it("drains pre-loss transactions before DDL and rejects stale catalog/auth writers", async () => {
    await pool.query(
      "CREATE TABLE node_fence_probe(id INT PRIMARY KEY,value INT NOT NULL)",
    );
    const previous = await acquireNodeOwnership(pool);
    const catalog = new MysqlCatalog(pool, previous.assertCatalogConnection);
    await catalog.initializeMetadata();
    const auth = createNativeAuthDatabase(
      pool,
      previous.assertCatalogConnection,
    );
    let signalEntered!: () => void, releaseWriter!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const pause = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let successor: Awaited<ReturnType<typeof acquireNodeOwnership>> | undefined;
    const writing = catalog.transaction(async (connection) => {
      await connection.execute("INSERT INTO node_fence_probe VALUES(1,1)");
      signalEntered();
      await pause;
    });
    try {
      await entered;
      await pool.query(
        `KILL CONNECTION ${Number(previous.connection.threadId)}`,
      );
      successor = await acquireNodeOwnership(pool);
      let drained = false;
      const draining = successor.drainCatalog().then(() => {
        drained = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(drained).toBe(false);
      releaseWriter();
      await writing;
      await draining;
      await pool.query(
        "ALTER TABLE node_fence_probe ADD COLUMN upgraded INT DEFAULT 1",
      );
      await expect(
        catalog
          .prepare("INSERT INTO node_fence_probe(id,value) VALUES(2,2)")
          .run(),
      ).rejects.toThrow("ownership");
      await expect(
        sql`INSERT INTO node_fence_probe(id,value) VALUES(3,3)`.execute(
          auth.db,
        ),
      ).rejects.toThrow("ownership");
      expect((await pool.query("SELECT * FROM node_fence_probe"))[0]).toEqual([
        { id: 1, value: 1, upgraded: 1 },
      ]);
    } finally {
      releaseWriter();
      await writing.catch(() => {});
      await previous.close();
      await successor?.close();
      await auth.db.destroy();
      await pool.query("DROP TABLE node_fence_probe");
    }
  }, 30000);
});
