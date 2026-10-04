import { describe, expect, it, vi } from "vitest";
import {
  buildMysqlPoolOptions,
  MysqlCoordinationStore,
  withMysqlTransaction,
  type MysqlConnection,
} from "./database";
import {
  migrateNodeDatabase,
  migrationChecksum,
  NODE_MIGRATIONS,
} from "./migrations";

function fixture(
  execute: (
    sql: string,
    values?: unknown[],
  ) => Promise<[unknown, unknown]> = async () => [[], []],
) {
  const connection: MysqlConnection = {
    execute: vi.fn(execute),
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(),
    destroy: vi.fn(),
  };
  return { connection, pool: { getConnection: vi.fn(async () => connection) } };
}
describe("Node MySQL infrastructure", () => {
  it("requires injected credentials and defaults to bounded TLS connections", () => {
    const env = {
      DB_HOST: "db",
      DB_NAME: "studio",
      DB_USER: "user",
      DB_PASSWORD: "secret",
    };
    expect(buildMysqlPoolOptions(env)).toMatchObject({
      connectionLimit: 5,
      queueLimit: 100,
      multipleStatements: false,
      ssl: { rejectUnauthorized: true },
    });
    expect(() => buildMysqlPoolOptions({ ...env, DB_PORT: "0" })).toThrow(
      "DB_PORT",
    );
    expect(() =>
      buildMysqlPoolOptions({ ...env, DB_POOL_SIZE: "1000" }),
    ).toThrow("DB_POOL_SIZE");
    expect(() => buildMysqlPoolOptions({})).toThrow("DB_HOST");
  });
  it("rolls back failures without retrying the callback", async () => {
    const { pool, connection } = fixture();
    const work = vi.fn(async () => {
      throw new Error("duplicate");
    });
    await expect(withMysqlTransaction(pool, work)).rejects.toThrow("duplicate");
    expect(work).toHaveBeenCalledTimes(1);
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });
  it("destroys connections after an ambiguous commit", async () => {
    const { pool, connection } = fixture();
    vi.mocked(connection.commit).mockRejectedValue(
      new Error("connection lost"),
    );
    await expect(
      withMysqlTransaction(pool, async () => "saved"),
    ).rejects.toThrow("connection lost");
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(connection.release).not.toHaveBeenCalled();
  });
  it("returns the committed key winner, never the locally generated contender", async () => {
    const saved = Buffer.alloc(32, 4);
    const { pool, connection } = fixture(async (sql) =>
      sql.startsWith("SELECT value")
        ? [[{ value: saved }], []]
        : [{ affectedRows: 0 }, []],
    );
    expect(
      await new MysqlCoordinationStore(pool).getOrCreateSecret("auth"),
    ).toEqual(saved);
    expect(connection.commit).toHaveBeenCalledOnce();
  });
  it("refuses to replace malformed existing key material", async () => {
    const { pool, connection } = fixture(async (sql) =>
      sql.startsWith("SELECT value")
        ? [[{ value: Buffer.alloc(2) }], []]
        : [{ affectedRows: 0 }, []],
    );
    await expect(
      new MysqlCoordinationStore(pool).getOrCreateSecret("auth"),
    ).rejects.toThrow("restore");
    expect(connection.rollback).toHaveBeenCalledOnce();
  });
  it("returns no lease while another holder owns it", async () => {
    const { pool } = fixture(async () => [{ affectedRows: 0 }, []]);
    expect(
      await new MysqlCoordinationStore(pool).acquireLease(
        "room:a",
        "process:b",
        30,
      ),
    ).toBeNull();
  });
  it("keeps the full 64-bit fencing token without number conversion", async () => {
    const { pool } = fixture(async (sql) =>
      sql.startsWith("SELECT CAST")
        ? [[{ fence: "9007199254740993" }], []]
        : [{ affectedRows: 1 }, []],
    );
    expect(
      await new MysqlCoordinationStore(pool).acquireLease(
        "room:a",
        "process:b",
        30,
      ),
    ).toEqual({
      name: "room:a",
      holder: "process:b",
      fence: "9007199254740993",
    });
  });
  it("cannot renew a stale or expired lease", async () => {
    const { pool, connection } = fixture();
    expect(
      await new MysqlCoordinationStore(pool).renewLease(
        { name: "room:a", holder: "p1", fence: "2" },
        30,
      ),
    ).toBe(false);
    expect(
      vi
        .mocked(connection.execute)
        .mock.calls.some(([sql]) => sql.startsWith("UPDATE")),
    ).toBe(false);
  });
  it("refuses changed migration history before executing migration DDL", async () => {
    const { pool, connection } = fixture(async (sql) => {
      if (sql === "SELECT DATABASE() AS name")
        return [[{ name: "studio" }], []];
      if (sql.startsWith("SELECT GET_LOCK")) return [[{ acquired: 1 }], []];
      if (sql.startsWith("SELECT id"))
        return [[{ id: NODE_MIGRATIONS[0].id, checksum: "wrong" }], []];
      return [[], []];
    });
    await expect(migrateNodeDatabase(pool)).rejects.toThrow(
      "Migration history mismatch",
    );
    expect(
      vi
        .mocked(connection.execute)
        .mock.calls.some(([sql]) =>
          sql.includes("CREATE TABLE IF NOT EXISTS hl_node_secrets"),
        ),
    ).toBe(false);
    expect(
      vi
        .mocked(connection.execute)
        .mock.calls.some(([sql]) => sql.startsWith("SELECT RELEASE_LOCK")),
    ).toBe(true);
  });
  it("does not mark a failed migration applied and releases the lock", async () => {
    const { pool, connection } = fixture(async (sql) => {
      if (sql === "SELECT DATABASE() AS name")
        return [[{ name: "studio" }], []];
      if (sql.startsWith("SELECT GET_LOCK")) return [[{ acquired: 1 }], []];
      if (sql.includes("CREATE TABLE IF NOT EXISTS hl_node_leases"))
        throw new Error("DDL failed");
      return [[], []];
    });
    await expect(migrateNodeDatabase(pool)).rejects.toThrow("DDL failed");
    expect(
      vi
        .mocked(connection.execute)
        .mock.calls.some(([sql]) =>
          sql.startsWith("INSERT INTO hl_node_migrations"),
        ),
    ).toBe(false);
    expect(connection.release).toHaveBeenCalledOnce();
  });
  it("skips already applied identical migrations", async () => {
    const { pool, connection } = fixture(async (sql) => {
      if (sql === "SELECT DATABASE() AS name")
        return [[{ name: "studio" }], []];
      if (sql.startsWith("SELECT GET_LOCK")) return [[{ acquired: 1 }], []];
      if (sql.startsWith("SELECT id"))
        return [
          [
            {
              id: NODE_MIGRATIONS[0].id,
              checksum: migrationChecksum(NODE_MIGRATIONS[0]),
            },
          ],
          [],
        ];
      return [[], []];
    });
    await migrateNodeDatabase(pool);
    expect(
      vi
        .mocked(connection.execute)
        .mock.calls.some(([sql]) =>
          sql.includes("CREATE TABLE IF NOT EXISTS hl_node_secrets"),
        ),
    ).toBe(false);
  });
});
