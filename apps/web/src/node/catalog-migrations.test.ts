import { describe, it, expect } from "vitest";
import { createPool, type Pool, type PoolConnection } from "mysql2/promise";
import { randomUUID } from "node:crypto";
import {
  installCatalogSchema,
  migrateCatalogSchema,
  type CatalogMigration,
} from "./catalog-schema";
import { migrateNodeDatabase } from "./migrations";
import { MysqlCoordinationStore } from "./database";

const url = process.env.CATALOG_MIGRATIONS_MYSQL_TEST_URL;
describe.skipIf(!url)("append-only catalog upgrades", () => {
  it("adopts the legacy baseline, resumes committed DDL, preserves data, and refuses changed/newer history", async () => {
    const parsed = new URL(url!);
    if (parsed.hostname !== "127.0.0.1" || !parsed.pathname.endsWith("_test"))
      throw new Error("Local disposable *_test database required");
    const pool = createPool(url!);
    const id = randomUUID();
    const now = new Date().toISOString();
    const connection = await pool.getConnection();
    const added =
      "SELECT COUNT(*) AS applied FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='node_upgrade_probe' AND COLUMN_NAME='revision' AND DATA_TYPE='int' AND COLUMN_DEFAULT='1'";
    const upgrade: CatalogMigration = {
      id: "0002_test_revision",
      steps: [
        {
          id: "0001_add_revision",
          sql: "ALTER TABLE node_upgrade_probe ADD COLUMN revision INT NOT NULL DEFAULT 1",
          applied: added,
        },
      ],
    };
    try {
      await installCatalogSchema(connection); // Previous release wrote only this marker.
      await migrateNodeDatabase(pool);
      await connection.query(
        "CREATE TABLE node_upgrade_probe(id INT PRIMARY KEY,value VARCHAR(64))",
      );
      await connection.query("INSERT INTO node_upgrade_probe VALUES(1,'keep')");
      await connection.execute(
        "INSERT INTO auth_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)",
        [id, "Existing user", id + "@test.invalid", now, now],
      );
      await connection.execute(
        "INSERT INTO workbooks(id,title,created_at) VALUES(?,?,?)",
        [id, "Existing workbook", now],
      );
      await connection.execute(
        "INSERT INTO boards(id,workbook_id,title,created_at,updated_at) VALUES(?,?,?,?,?)",
        [id, id, "Existing board", now, now],
      );
      const keys = new MysqlCoordinationStore(pool);
      const secret = await keys.getOrCreateSecret("migration-test-key", 32);
      let interrupted = false;
      const interruptedPool = {
        getConnection: async () => {
          const raw = await pool.getConnection();
          return new Proxy(raw, {
            get(target, key) {
              if (key === "execute")
                return async (sql: string, parameters?: unknown[]) => {
                  if (
                    sql.startsWith("INSERT INTO hl_catalog_migration_steps") &&
                    !interrupted
                  ) {
                    interrupted = true;
                    throw new Error("Simulated exit after DDL commit");
                  }
                  return target.execute(sql, parameters);
                };
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }) as PoolConnection;
        },
      } as Pool;
      await expect(
        migrateCatalogSchema(interruptedPool, [upgrade]),
      ).rejects.toThrow("Simulated exit");
      expect((await connection.query(added))[0]).toEqual([{ applied: 1 }]);
      await expect(migrateCatalogSchema(pool, [])).rejects.toThrow(
        "pending catalog migration",
      );
      await migrateCatalogSchema(pool, [upgrade]);
      await migrateCatalogSchema(pool, [upgrade]);
      expect(
        (await connection.query("SELECT * FROM node_upgrade_probe"))[0],
      ).toEqual([{ id: 1, value: "keep", revision: 1 }]);
      expect(
        (
          await connection.execute("SELECT name FROM auth_users WHERE id=?", [
            id,
          ])
        )[0],
      ).toEqual([{ name: "Existing user" }]);
      expect(
        (
          await connection.execute("SELECT title FROM boards WHERE id=?", [id])
        )[0],
      ).toEqual([{ title: "Existing board" }]);
      expect(await keys.readSecret("migration-test-key", 32)).toEqual(secret);
      await expect(
        migrateCatalogSchema(pool, [
          {
            ...upgrade,
            steps: [{ ...upgrade.steps[0], sql: upgrade.steps[0].sql + " " }],
          },
        ]),
      ).rejects.toThrow("altered");
      const next: CatalogMigration = {
        id: "0003_remove_test_revision",
        steps: [
          {
            id: "0001_remove_revision",
            sql: "ALTER TABLE node_upgrade_probe DROP COLUMN revision",
            applied:
              "SELECT NOT EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='node_upgrade_probe' AND COLUMN_NAME='revision') AS applied",
          },
        ],
      };
      await migrateCatalogSchema(pool, [upgrade, next]);
      await migrateCatalogSchema(pool, [upgrade, next]);
      await expect(migrateCatalogSchema(pool, [upgrade])).rejects.toThrow(
        "newer",
      );
    } finally {
      await connection.execute("DELETE FROM boards WHERE id=?", [id]);
      await connection.execute("DELETE FROM workbooks WHERE id=?", [id]);
      await connection.execute("DELETE FROM auth_users WHERE id=?", [id]);
      await connection.query("DROP TABLE IF EXISTS node_upgrade_probe");
      for (const table of [
        "hl_catalog_migration_steps",
        "hl_catalog_migration_intents",
        "hl_catalog_migrations",
      ]) {
        const column =
          table === "hl_catalog_migration_steps" ? "migration_id" : "id";
        await connection.execute(
          `DELETE FROM ${table} WHERE ${column} IN (?,?)`,
          ["0002_test_revision", "0003_remove_test_revision"],
        );
      }
      connection.release();
      await pool.end();
    }
  }, 30000);
});
