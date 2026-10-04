import { randomBytes } from "node:crypto";

/** Structural mysql2/promise contracts keep this module usable in adapter tests. */
export interface MysqlConnection {
  execute(
    sql: string,
    values?: (string | number | bigint | boolean | Date | Uint8Array | null)[],
  ): Promise<[unknown, unknown]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
  destroy(): void;
}
export interface MysqlPool {
  getConnection(): Promise<MysqlConnection>;
}
export interface MysqlResult {
  affectedRows: number;
}
export type MysqlEnvironment = Record<string, string | undefined>;

export function buildMysqlPoolOptions(env: MysqlEnvironment) {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`Missing ${name}.`);
    return value;
  };
  const integer = (name: string, fallback: number, max: number) => {
    const raw = env[name];
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new Error(`Invalid ${name}.`);
    return value;
  };
  const connectionLimit = integer("DB_POOL_SIZE", 5, 32);
  if (connectionLimit < 2)
    throw new Error(
      "DB_POOL_SIZE must be at least 2: room coordination reserves one connection.",
    );
  return {
    host: required("DB_HOST"),
    port: integer("DB_PORT", 3306, 65535),
    database: required("DB_NAME"),
    user: required("DB_USER"),
    password: required("DB_PASSWORD"),
    connectionLimit,
    waitForConnections: true,
    queueLimit: 100,
    connectTimeout: 10_000,
    enableKeepAlive: true,
    multipleStatements: false,
    charset: "utf8mb4_bin",
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: false,
    // Refuse plaintext by default. A provider requiring plaintext must explicitly opt in.
    ssl:
      env.DB_TLS === "disabled"
        ? undefined
        : { rejectUnauthorized: true, ...(env.DB_CA ? { ca: env.DB_CA } : {}) },
  };
}

/** Never retry callbacks automatically: commit failures may have an unknown outcome. */
export async function withMysqlTransaction<T>(
  pool: MysqlPool,
  work: (connection: MysqlConnection) => Promise<T>,
): Promise<T> {
  const connection = await pool.getConnection();
  let reusable = true;
  try {
    await connection.beginTransaction();
    const value = await work(connection);
    try {
      await connection.commit();
    } catch (error) {
      reusable = false;
      throw error;
    }
    return value;
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      reusable = false;
    }
    throw error;
  } finally {
    if (reusable) connection.release();
    else connection.destroy();
  }
}

export interface MysqlLease {
  name: string;
  holder: string;
  fence: string;
}
function identifier(value: string) {
  if (!/^[a-zA-Z0-9:_.-]{1,128}$/.test(value))
    throw new Error("Invalid coordination identifier.");
}
function ttl(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 3600)
    throw new Error("Lease TTL must be 1–3600 seconds.");
}

/** Node infrastructure only; this does not implement the application D1 catalog. */
export class MysqlCoordinationStore {
  constructor(private readonly pool: MysqlPool) {}

  async hasCatalogIdentity(): Promise<boolean> {
    return withMysqlTransaction(this.pool, async (connection) => {
      const [rows] = await connection.execute(
        "SELECT 1 FROM hl_node_secrets WHERE name IN ('catalog-provisioned-v1','installation-auth-v1','installation-encryption-v1') LIMIT 1",
      );
      return (rows as unknown[]).length > 0;
    });
  }

  async hasCompletedCatalog(): Promise<boolean> {
    return withMysqlTransaction(this.pool, async (connection) => {
      const [rows] = await connection.execute(
        "SELECT 1 FROM hl_node_secrets WHERE name='catalog-provisioned-v1'",
      );
      return (rows as unknown[]).length > 0;
    });
  }

  /** Pin the selected backend before opening/migrating a catalog. A setting
   * change must not silently create a different installation using existing keys. */
  async bindCatalogIdentity(identity: Buffer): Promise<void> {
    if (identity.length !== 32) throw new Error("Invalid catalog identity.");
    await withMysqlTransaction(this.pool, async (connection) => {
      await connection.execute(
        "INSERT INTO hl_node_secrets(name,value) VALUES ('catalog-location-v1',?) ON DUPLICATE KEY UPDATE name=name",
        [identity],
      );
      const [rows] = await connection.execute(
        "SELECT value FROM hl_node_secrets WHERE name='catalog-location-v1' FOR UPDATE",
      );
      const stored = (rows as { value: Buffer }[])[0]?.value;
      if (
        !Buffer.isBuffer(stored) ||
        stored.length !== identity.length ||
        stored.some((byte, index) => byte !== identity[index])
      )
        throw new Error(
          "Catalog backend or private directory changed. Restore the original settings or perform an explicit migration.",
        );
    });
  }

  /** Only for provisioning. Normal startup must use readSecret and fail closed on loss. */
  async getOrCreateSecret(name: string, bytes = 32): Promise<Buffer> {
    identifier(name);
    if (!Number.isInteger(bytes) || bytes < 32 || bytes > 256)
      throw new Error("Invalid secret size.");
    return withMysqlTransaction(this.pool, async (connection) => {
      await connection.execute(
        "INSERT INTO hl_node_secrets (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = name",
        [name, randomBytes(bytes)],
      );
      const [rows] = await connection.execute(
        "SELECT value FROM hl_node_secrets WHERE name = ? FOR UPDATE",
        [name],
      );
      const value = (rows as { value: Buffer }[])[0]?.value;
      if (!Buffer.isBuffer(value) || value.length !== bytes)
        throw new Error(
          "Stored installation key is invalid; restore it from backup.",
        );
      return Buffer.from(value);
    });
  }

  async readSecret(name: string, bytes = 32): Promise<Buffer> {
    identifier(name);
    return withMysqlTransaction(this.pool, async (connection) => {
      const [rows] = await connection.execute(
        "SELECT value FROM hl_node_secrets WHERE name = ?",
        [name],
      );
      const value = (rows as { value: Buffer }[])[0]?.value;
      if (!Buffer.isBuffer(value) || value.length !== bytes)
        throw new Error(
          "Installation key missing or invalid; restore it from backup.",
        );
      return Buffer.from(value);
    });
  }

  async acquireLease(
    name: string,
    holder: string,
    seconds: number,
  ): Promise<MysqlLease | null> {
    identifier(name);
    identifier(holder);
    ttl(seconds);
    return withMysqlTransaction(this.pool, async (connection) => {
      // Retain rows forever: deleting a lease would allow its fencing sequence to reset.
      await connection.execute(
        "INSERT INTO hl_node_leases (name, holder, fence, expires_at) VALUES (?, ?, 0, 0) ON DUPLICATE KEY UPDATE name = name",
        [name, holder],
      );
      const [changed] = await connection.execute(
        "UPDATE hl_node_leases SET holder = ?, fence = fence + 1, expires_at = UNIX_TIMESTAMP() + ? WHERE name = ? AND expires_at <= UNIX_TIMESTAMP()",
        [holder, seconds, name],
      );
      if (!(changed as MysqlResult).affectedRows) return null;
      const [rows] = await connection.execute(
        "SELECT CAST(fence AS CHAR) AS fence FROM hl_node_leases WHERE name = ? FOR UPDATE",
        [name],
      );
      return { name, holder, fence: (rows as { fence: string }[])[0].fence };
    });
  }

  async renewLease(lease: MysqlLease, seconds: number): Promise<boolean> {
    identifier(lease.name);
    identifier(lease.holder);
    ttl(seconds);
    if (!/^\d+$/.test(lease.fence)) throw new Error("Invalid lease fence.");
    return withMysqlTransaction(this.pool, async (connection) => {
      // Row lock avoids CLIENT_FOUND_ROWS / unchanged timestamp affected-row ambiguity.
      const [rows] = await connection.execute(
        "SELECT name FROM hl_node_leases WHERE name = ? AND holder = ? AND fence = ? AND expires_at > UNIX_TIMESTAMP() FOR UPDATE",
        [lease.name, lease.holder, lease.fence],
      );
      if (!(rows as unknown[]).length) return false;
      await connection.execute(
        "UPDATE hl_node_leases SET expires_at = UNIX_TIMESTAMP() + ? WHERE name = ?",
        [seconds, lease.name],
      );
      return true;
    });
  }

  async releaseLease(lease: MysqlLease): Promise<void> {
    identifier(lease.name);
    identifier(lease.holder);
    if (!/^\d+$/.test(lease.fence)) throw new Error("Invalid lease fence.");
    await withMysqlTransaction(this.pool, async (connection) => {
      await connection.execute(
        "UPDATE hl_node_leases SET expires_at = 0 WHERE name = ? AND holder = ? AND fence = ?",
        [lease.name, lease.holder, lease.fence],
      );
    });
  }
}
