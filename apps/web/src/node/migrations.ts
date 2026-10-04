import { createHash } from "node:crypto";
import type { MysqlPool } from "./database";

export interface MysqlMigration {
  id: string;
  statements: readonly string[];
}
export const NODE_MIGRATIONS: readonly MysqlMigration[] = [
  {
    id: "0001_node_coordination",
    statements: [
      "CREATE TABLE IF NOT EXISTS hl_node_secrets (name VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, value VARBINARY(256) NOT NULL) ENGINE=InnoDB",
      "CREATE TABLE IF NOT EXISTS hl_node_leases (name VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, holder VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, fence BIGINT UNSIGNED NOT NULL, expires_at BIGINT UNSIGNED NOT NULL) ENGINE=InnoDB",
    ],
  },
];
export function migrationChecksum(migration: MysqlMigration): string {
  return createHash("sha256").update(JSON.stringify(migration)).digest("hex");
}

/** MySQL DDL auto-commits. Each statement MUST be safely restartable after interruption. */
export async function migrateNodeDatabase(
  pool: MysqlPool,
  migrations: readonly MysqlMigration[] = NODE_MIGRATIONS,
) {
  const ids = migrations.map((migration) => migration.id);
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[a-z0-9_]{1,128}$/.test(id))
  )
    throw new Error("Invalid migration identifiers.");
  const connection = await pool.getConnection();
  let locked = false;
  let reusable = true;
  // Advisory locks belong to this connection and survive implicit DDL commits.
  try {
    const [databaseRows] = await connection.execute(
      "SELECT DATABASE() AS name",
    );
    const database = (databaseRows as { name: string | null }[])[0]?.name;
    if (!database)
      throw new Error("A database must be selected before migration.");
    const lock = `hl-migrate-${createHash("sha256").update(database).digest("hex").slice(0, 48)}`;
    const [rows] = await connection.execute(
      "SELECT GET_LOCK(?, 30) AS acquired",
      [lock],
    );
    if (Number((rows as { acquired: number | null }[])[0]?.acquired) !== 1)
      throw new Error("Could not acquire the database migration lock.");
    locked = true;
    try {
      await connection.execute(
        "CREATE TABLE IF NOT EXISTS hl_node_migrations (id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, applied_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)) ENGINE=InnoDB",
      );
      const [appliedRows] = await connection.execute(
        "SELECT id, checksum FROM hl_node_migrations ORDER BY id",
      );
      const applied = appliedRows as { id: string; checksum: string }[];
      for (const row of applied) {
        const migration = migrations.find((item) => item.id === row.id);
        if (!migration || row.checksum !== migrationChecksum(migration))
          throw new Error(
            `Migration history mismatch: ${row.id}. Refusing startup.`,
          );
      }
      for (const migration of migrations) {
        if (applied.some((row) => row.id === migration.id)) continue;
        for (const statement of migration.statements)
          await connection.execute(statement);
        await connection.execute(
          "INSERT INTO hl_node_migrations (id, checksum) VALUES (?, ?)",
          [migration.id, migrationChecksum(migration)],
        );
      }
    } finally {
      await connection.execute("SELECT RELEASE_LOCK(?)", [lock]);
      locked = false;
    }
  } catch (error) {
    // Destroy on an uncertain advisory-lock release; never leak that lock into the pool.
    if (locked) reusable = false;
    throw error;
  } finally {
    if (reusable) connection.release();
    else connection.destroy();
  }
}
