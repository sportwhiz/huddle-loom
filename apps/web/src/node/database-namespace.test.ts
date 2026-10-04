import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "mysql2/promise";
import { randomUUID } from "node:crypto";
import {
  logicalDatabaseTable,
  namespaceMysqlPool,
  namespaceSql,
  validateDatabaseNamespace,
} from "./database-namespace";
import { migrateCatalogSchema } from "./catalog-schema";
import { migrateNodeDatabase } from "./migrations";
import { acquireNodeOwnership, type NodeOwnership } from "./rooms";
import { MysqlCoordinationStore } from "./database";
import { createNativeAuthDatabase } from "./auth-database";
import { MysqlCatalog } from "./mysql-catalog";
import { createMysqlBlobBucket } from "./blobs";

describe("deployment database namespaces", () => {
  it("preserves the legacy schema and rejects unsafe namespace settings", () => {
    expect(validateDatabaseNamespace(undefined)).toBe("");
    expect(namespaceSql("")("SELECT * FROM users", ["users"])).toEqual({
      sql: "SELECT * FROM users",
      values: ["users"],
    });
    for (const value of ["UPPER", "../live", "live;DROP", "x".repeat(17)])
      expect(() => validateDatabaseNamespace(value)).toThrow(
        "HUDDLE_DATABASE_NAMESPACE",
      );
  });
  it("scopes schema objects without changing user data, literals or comments", () => {
    const scope = namespaceSql("preview");
    const query = scope(
      "SELECT `users`.id FROM `users` WHERE display_name='users' AND email=? /* users */ -- boards\n",
      ["users"],
    );
    expect(query.sql).toBe(
      "SELECT `hn_preview_users`.id FROM `hn_preview_users` WHERE display_name='users' AND email=? /* users */ -- boards\n",
    );
    expect(query.values).toEqual(["users"]);
    expect(
      scope(
        "CREATE TABLE guest_board_links (id VARCHAR(32), CONSTRAINT fk_guest_links_board FOREIGN KEY(id) REFERENCES boards(id))",
      ).sql,
    ).toContain("CONSTRAINT hn_preview_fk_guest_links_board");
  });
  it("scopes metadata comparisons and keeps advisory locks isolated", () => {
    const preview = namespaceSql("preview"),
      live = namespaceSql("live");
    const metadata = preview(
      "SELECT 1 FROM information_schema.TABLES WHERE TABLE_NAME='boards' AND TABLE_NAME=?",
      ["users"],
    );
    expect(metadata.sql).toContain("TABLE_NAME='hn_preview_boards'");
    expect(metadata.values).toEqual(["hn_preview_users"]);
    const lock = "huddle-rooms:database";
    const acquire = preview("SELECT GET_LOCK(?, 0)", [lock]).values;
    expect(preview("SELECT IS_USED_LOCK(?)", [lock]).values).toEqual(acquire);
    expect(live("SELECT GET_LOCK(?, 0)", [lock]).values).not.toEqual(acquire);
  });
});

describe.skipIf(!process.env.HUDDLE_NAMESPACE_MYSQL_TEST_URL)(
  "two installations sharing a managed database",
  () => {
    let preview: Pool, live: Pool;
    let previewOwner: NodeOwnership | undefined,
      liveOwner: NodeOwnership | undefined;
    beforeAll(async () => {
      const url = new URL(process.env.HUDDLE_NAMESPACE_MYSQL_TEST_URL!);
      if (!url.pathname.endsWith("_test") || url.hostname !== "127.0.0.1")
        throw new Error("Only a disposable local *_test database is permitted");
      preview = namespaceMysqlPool(createPool(url.toString()), "preview");
      live = namespaceMysqlPool(createPool(url.toString()), "live");
      previewOwner = await acquireNodeOwnership(preview);
      liveOwner = await acquireNodeOwnership(live);
      for (const pool of [preview, live]) {
        await migrateNodeDatabase(pool);
        await migrateCatalogSchema(pool);
      }
    }, 60_000);
    afterAll(async () => {
      await previewOwner?.close();
      await liveOwner?.close();
      await preview?.end();
      await live?.end();
    });
    it("allows one owner in each namespace while rejecting duplicate owners", async () => {
      expect(previewOwner?.healthy).toBe(true);
      expect(liveOwner?.healthy).toBe(true);
      await expect(acquireNodeOwnership(preview)).rejects.toThrow(
        "Another Open Whiteboard",
      );
    });
    it("keeps catalog data, installation keys and uploaded assets separate", async () => {
      const id = randomUUID();
      await preview.execute(
        "INSERT INTO users(id,issuer,subject,email,display_name,color,created_at,updated_at) VALUES (?,'test',?,?,'users','#000000','2026-10-04','2026-10-04')",
        [id, id, `${id}@example.invalid`],
      );
      const [rows] = await live.execute("SELECT * FROM users WHERE id=?", [id]);
      expect(rows).toEqual([]);
      const a = await new MysqlCoordinationStore(preview).getOrCreateSecret(
        "same-name",
        32,
      );
      const b = await new MysqlCoordinationStore(live).getOrCreateSecret(
        "same-name",
        32,
      );
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
      const previewBlobs = await createMysqlBlobBucket(preview),
        liveBlobs = await createMysqlBlobBucket(live);
      await previewBlobs.put("same-key", new TextEncoder().encode("preview"));
      expect(await liveBlobs.get("same-key")).toBeNull();
      expect(await (await previewBlobs.get("same-key"))!.text()).toBe(
        "preview",
      );
    });
    it("executes catalog inserts, updates, upserts and deletes using logical metadata", async () => {
      const a = new MysqlCatalog(
        preview,
        undefined,
        logicalDatabaseTable("preview"),
      );
      const b = new MysqlCatalog(live, undefined, logicalDatabaseTable("live"));
      await a.initializeMetadata();
      await b.initializeMetadata();
      const id = randomUUID();
      const insert =
        "INSERT INTO users(id,issuer,subject,email,display_name,color,created_at,updated_at) VALUES (?,'test',?,?,'users','#000000','2026-10-04','2026-10-04')";
      await a.prepare(insert).bind(id, id, `${id}@example.invalid`).run();
      await a
        .prepare("UPDATE users SET display_name=? WHERE id=?")
        .bind("Changed", id)
        .run();
      expect(
        await a
          .prepare("SELECT display_name FROM users WHERE id=?")
          .bind(id)
          .first(),
      ).toEqual({ display_name: "Changed" });
      expect(
        await b.prepare("SELECT id FROM users WHERE id=?").bind(id).first(),
      ).toBeNull();
      await a
        .prepare(
          insert +
            " ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name",
        )
        .bind(id, id, `${id}@example.invalid`)
        .run();
      expect(
        await a
          .prepare("SELECT display_name FROM users WHERE id=?")
          .bind(id)
          .first(),
      ).toEqual({ display_name: "users" });
      await a.prepare("DELETE FROM users WHERE id=?").bind(id).run();
      expect(
        await a.prepare("SELECT id FROM users WHERE id=?").bind(id).first(),
      ).toBeNull();
    });
    it("exposes logical authentication schema metadata without other installations", async () => {
      const auth = createNativeAuthDatabase(
        preview,
        undefined,
        logicalDatabaseTable("preview"),
      );
      try {
        const tables = await auth.db.introspection.getTables();
        expect(tables.some((table) => table.name === "auth_users")).toBe(true);
        expect(tables.some((table) => table.name.startsWith("hn_"))).toBe(
          false,
        );
        expect(
          tables.filter((table) => table.name === "auth_users"),
        ).toHaveLength(1);
      } finally {
        await auth.db.destroy();
      }
    });
    it("restarts migrations independently without changing released checksums", async () => {
      for (const pool of [preview, live]) {
        await migrateNodeDatabase(pool);
        await migrateCatalogSchema(pool);
      }
    });
  },
);
