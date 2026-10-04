import { createHash, randomUUID } from "node:crypto";
import type { Pool, RowDataPacket } from "mysql2/promise";

const MAX_BYTES = 25 * 1024 * 1024;
const CHUNK_BYTES = 512 * 1024;
function keyBytes(key: string) {
  const bytes = Buffer.from(key);
  if (!bytes.length || bytes.length > 1024)
    throw new Error("Invalid asset key");
  return bytes;
}
type BlobRow = RowDataPacket & {
  asset_key: Buffer;
  version: string;
  size: number;
  etag: string;
  uploaded: number;
  metadata: string;
  custom_metadata: string;
};
function metadata(row: BlobRow) {
  const httpMetadata = JSON.parse(row.metadata) as Record<string, string>;
  return {
    key: row.asset_key.toString(),
    version: row.version,
    size: Number(row.size),
    etag: row.etag,
    httpEtag: `"${row.etag}"`,
    uploaded: new Date(Number(row.uploaded)),
    httpMetadata,
    customMetadata: JSON.parse(row.custom_metadata) as Record<string, string>,
    writeHttpMetadata(headers: Headers) {
      const names: Record<string, string> = {
        contentType: "Content-Type",
        contentLanguage: "Content-Language",
        contentDisposition: "Content-Disposition",
        contentEncoding: "Content-Encoding",
        cacheControl: "Cache-Control",
        cacheExpiry: "Expires",
      };
      for (const [key, value] of Object.entries(httpMetadata))
        if (names[key]) headers.set(names[key], value);
    },
  };
}

/** Private database storage. Chunking keeps individual queries below MySQL packet limits. */
export async function createMysqlBlobBucket(pool: Pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS node_blobs (
    asset_key VARBINARY(1024) PRIMARY KEY, version VARCHAR(36) NOT NULL,
    size BIGINT NOT NULL, etag VARCHAR(64) NOT NULL, uploaded BIGINT NOT NULL,
    metadata LONGTEXT NOT NULL, custom_metadata LONGTEXT NOT NULL
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS node_blob_chunks (
    asset_key VARBINARY(1024) NOT NULL, chunk_index INT NOT NULL, data MEDIUMBLOB NOT NULL,
    PRIMARY KEY(asset_key, chunk_index), FOREIGN KEY(asset_key) REFERENCES node_blobs(asset_key) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  return {
    async head(key: string) {
      const [rows] = await pool.execute<BlobRow[]>(
        "SELECT * FROM node_blobs WHERE asset_key = ?",
        [keyBytes(key)],
      );
      return rows[0] ? metadata(rows[0]) : null;
    },
    async get(key: string) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        // A shared lock keeps the metadata and chunks from different replacements from mixing.
        const [rows] = await connection.execute<BlobRow[]>(
          "SELECT * FROM node_blobs WHERE asset_key = ? LOCK IN SHARE MODE",
          [keyBytes(key)],
        );
        if (!rows[0]) {
          await connection.commit();
          return null;
        }
        const [chunks] = await connection.execute<
          (RowDataPacket & { data: Buffer })[]
        >(
          "SELECT data FROM node_blob_chunks WHERE asset_key = ? ORDER BY chunk_index",
          [keyBytes(key)],
        );
        const data = Buffer.concat(chunks.map((row) => row.data));
        if (data.length !== Number(rows[0].size))
          throw new Error("Asset storage is incomplete");
        await connection.commit();
        const bytes = new Uint8Array(data);
        return {
          ...metadata(rows[0]),
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          arrayBuffer: async () => bytes.slice().buffer,
          text: async () => data.toString(),
          json: async () => JSON.parse(data.toString()) as unknown,
        };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    async put(
      key: string,
      value: ArrayBuffer | Uint8Array | string,
      options?: {
        httpMetadata?: Record<string, string>;
        customMetadata?: Record<string, string>;
      },
    ) {
      const keyBuffer = keyBytes(key);
      const bytes =
        typeof value === "string"
          ? Buffer.from(value)
          : Buffer.from(
              value instanceof ArrayBuffer ? new Uint8Array(value) : value,
            );
      if (bytes.length > MAX_BYTES)
        throw new Error("Asset exceeds the 25 MiB storage limit");
      const row = {
        asset_key: keyBuffer,
        version: randomUUID(),
        size: bytes.length,
        etag: createHash("sha256").update(bytes).digest("hex"),
        uploaded: Date.now(),
        metadata: JSON.stringify(options?.httpMetadata ?? {}),
        custom_metadata: JSON.stringify(options?.customMetadata ?? {}),
      } as BlobRow;
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute(
          "INSERT INTO node_blobs(asset_key, version, size, etag, uploaded, metadata, custom_metadata) VALUES(?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE version=VALUES(version), size=VALUES(size), etag=VALUES(etag), uploaded=VALUES(uploaded), metadata=VALUES(metadata), custom_metadata=VALUES(custom_metadata)",
          Object.values(row),
        );
        await connection.execute(
          "DELETE FROM node_blob_chunks WHERE asset_key = ?",
          [keyBuffer],
        );
        for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES)
          await connection.execute(
            "INSERT INTO node_blob_chunks(asset_key, chunk_index, data) VALUES(?, ?, ?)",
            [
              keyBuffer,
              offset / CHUNK_BYTES,
              bytes.subarray(offset, offset + CHUNK_BYTES),
            ],
          );
        await connection.commit();
        return metadata(row);
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    async delete(keys: string | string[]) {
      const values = typeof keys === "string" ? [keys] : keys;
      if (!values.length) return;
      await pool.execute(
        `DELETE FROM node_blobs WHERE asset_key IN (${values.map(() => "?").join(",")})`,
        values.map(keyBytes),
      );
    },
    async list(
      options: {
        limit?: number;
        cursor?: string;
        prefix?: string;
        include?: string[];
      } = {},
    ) {
      const limit = Math.max(
        1,
        Math.min(1000, Math.floor(options.limit ?? 1000)),
      );
      if (!Number.isFinite(limit)) throw new Error("Invalid asset list limit");
      const after = options.cursor
        ? Buffer.from(options.cursor, "base64url")
        : Buffer.alloc(0);
      const prefix = Buffer.from(options.prefix ?? "");
      const [rows] = await pool.execute<BlobRow[]>(
        `SELECT * FROM node_blobs WHERE asset_key > ? AND LEFT(asset_key, ?) = ? ORDER BY asset_key LIMIT ${limit + 1}`,
        [after, prefix.length, prefix],
      );
      const truncated = rows.length > limit;
      const selected = rows.slice(0, limit);
      return {
        objects: selected.map(metadata),
        truncated,
        cursor: truncated
          ? Buffer.from(selected[selected.length - 1].asset_key).toString(
              "base64url",
            )
          : undefined,
        delimitedPrefixes: [],
      };
    },
  };
}
