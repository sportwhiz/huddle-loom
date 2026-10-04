import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SqliteCatalog } from "./sqlite-catalog";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe("persistent SQLite catalog for Node qualification", () => {
  it("applies actual migrations, preserves security guards and survives restart", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "huddle-catalog-"));
    directories.push(directory);
    const file = resolve(directory, "catalog.sqlite");
    let db = await SqliteCatalog.open(file);
    await db.migrate(resolve("migrations"));
    await db.migrate(resolve("migrations"));
    expect(
      (await db
        .prepare(
          "SELECT COUNT(*) count FROM sqlite_master WHERE type='trigger'",
        )
        .first<{ count: number }>())!.count,
    ).toBeGreaterThan(20);
    await db
      .prepare(
        "INSERT INTO users(id,issuer,subject,email,display_name,color,created_at,updated_at) VALUES('test','local','test','test@local.invalid','Test','#000','2026-01-01','2026-01-01')",
      )
      .run();
    db.close();
    db = await SqliteCatalog.open(file);
    expect(
      await db
        .prepare("SELECT display_name FROM users WHERE id=?")
        .bind("test")
        .first("display_name"),
    ).toBe("Test");
    await expect(
      db.batch([
        db.prepare("UPDATE users SET display_name='Changed' WHERE id='test'"),
        db.prepare(
          "INSERT INTO users(id,issuer,subject,email,display_name,color,created_at,updated_at) VALUES('test','local','test','test@local.invalid','Duplicate','#000','2026-01-01','2026-01-01')",
        ),
      ]),
    ).rejects.toThrow();
    expect(
      await db
        .prepare("SELECT display_name FROM users WHERE id='test'")
        .first("display_name"),
    ).toBe("Test");
    await db
      .prepare(
        "INSERT INTO node_schema_migrations(name,digest) VALUES('9999_future.sql','future')",
      )
      .run();
    await expect(db.migrate(resolve("migrations"))).rejects.toThrow(
      "older than",
    );
    db.close();
  });
});
