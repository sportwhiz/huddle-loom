import { describe, expect, it, vi } from "vitest";
import type { Pool } from "mysql2/promise";
import { createMysqlBlobBucket } from "./blobs";
function fixture() {
  let objects = new Map<string, Record<string, unknown>>();
  let chunks = new Map<string, { index: number; data: Buffer }[]>();
  let backup: [typeof objects, typeof chunks];
  let failChunk = false;
  const execute = vi.fn(async (sql: string, args: unknown[]) => {
    const key = (args[0] as Buffer).toString();
    if (sql.startsWith("INSERT INTO node_blobs")) {
      objects.set(
        key,
        Object.fromEntries(
          [
            "asset_key",
            "version",
            "size",
            "etag",
            "uploaded",
            "metadata",
            "custom_metadata",
          ].map((name, index) => [name, args[index]]),
        ),
      );
      return [{}];
    }
    if (sql.startsWith("DELETE FROM node_blob_chunks")) {
      chunks.set(key, []);
      return [{}];
    }
    if (sql.startsWith("INSERT INTO node_blob_chunks")) {
      if (failChunk) throw new Error("Write interrupted");
      chunks
        .get(key)!
        .push({
          index: args[1] as number,
          data: Buffer.from(args[2] as Buffer),
        });
      return [{}];
    }
    if (sql.startsWith("SELECT data"))
      return [(chunks.get(key) ?? []).sort((a, b) => a.index - b.index)];
    if (sql.startsWith("SELECT * FROM node_blobs WHERE asset_key ="))
      return [objects.has(key) ? [objects.get(key)] : []];
    if (sql.startsWith("SELECT * FROM node_blobs WHERE asset_key >")) {
      const prefix = (args[2] as Buffer).toString();
      return [
        [...objects.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .filter(([name]) => name > key && name.startsWith(prefix))
          .slice(0, Number(sql.split("LIMIT ")[1]))
          .map(([, row]) => row),
      ];
    }
    throw new Error(`Unexpected query ${sql}`);
  });
  const connection = {
    execute,
    beginTransaction: vi.fn(async () => {
      backup = [
        new Map(objects),
        new Map([...chunks].map(([key, value]) => [key, [...value]])),
      ];
    }),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => {
      [objects, chunks] = backup;
    }),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(async () => []),
    execute,
    getConnection: async () => connection,
  } as unknown as Pool;
  return {
    pool,
    connection,
    setFail: () => {
      failChunk = true;
    },
  };
}
describe("Private MySQL blob storage", () => {
  it("stores large uploads in bounded chunks and returns exact bytes and metadata", async () => {
    const { pool, connection } = fixture();
    const bucket = await createMysqlBlobBucket(pool);
    const input = new Uint8Array(1_500_000).fill(127);
    await bucket.put("asset:1", input, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { nativeUpload: "reservation:1" },
    });
    const object = await bucket.get("asset:1");
    expect(
      Buffer.from(await object!.arrayBuffer()).equals(Buffer.from(input)),
    ).toBe(true);
    expect(object!.customMetadata.nativeUpload).toBe("reservation:1");
    const headers = new Headers();
    object!.writeHttpMetadata(headers);
    expect(headers.get("Content-Type")).toBe("image/png");
    const calls = connection.execute.mock.calls.filter(([sql]) =>
      sql.startsWith("INSERT INTO node_blob_chunks"),
    );
    expect(calls).toHaveLength(3);
    expect(
      calls.every(([, args]) => (args[2] as Buffer).length <= 512 * 1024),
    ).toBe(true);
  });
  it("preserves previous metadata and bytes if replacing chunks fails", async () => {
    const { pool, setFail } = fixture();
    const bucket = await createMysqlBlobBucket(pool);
    await bucket.put("asset:1", "before");
    setFail();
    await expect(bucket.put("asset:1", "after")).rejects.toThrow(
      "Write interrupted",
    );
    expect(await (await bucket.get("asset:1"))!.text()).toBe("before");
    expect((await bucket.head("asset:1"))!.size).toBe(6);
  });
  it("supports stable keyset pagination for the cleanup scanner", async () => {
    const bucket = await createMysqlBlobBucket(fixture().pool);
    for (const key of ["asset:1", "asset:2", "asset:3"])
      await bucket.put(key, key);
    const first = await bucket.list({ limit: 2 });
    expect(first.objects.map((object) => object.key)).toEqual([
      "asset:1",
      "asset:2",
    ]);
    expect(first.truncated).toBe(true);
    const last = await bucket.list({ limit: 2, cursor: first.cursor });
    expect(last.objects.map((object) => object.key)).toEqual(["asset:3"]);
    expect(last.truncated).toBe(false);
  });
  it("rejects oversized uploads without acquiring a write transaction", async () => {
    const { pool, connection } = fixture();
    const bucket = await createMysqlBlobBucket(pool);
    await expect(
      bucket.put("asset:1", new Uint8Array(25 * 1024 * 1024 + 1)),
    ).rejects.toThrow("25 MiB");
    expect(connection.beginTransaction).not.toHaveBeenCalled();
  });
});

describe.skipIf(!process.env.NODE_ADAPTER_MYSQL_TEST_URL)(
  "Real MySQL asset conformance",
  () => {
    it("round trips chunks and paginates private assets", async () => {
      const { createPool } = await import("mysql2/promise");
      const url = process.env.NODE_ADAPTER_MYSQL_TEST_URL!;
      if (!new URL(url).pathname.endsWith("_test"))
        throw new Error("Integration database name must end with _test");
      const pool = createPool(url);
      const prefix = `integration:${crypto.randomUUID()}:`;
      const bucket = await createMysqlBlobBucket(pool);
      const keys = ["a", "b", "c"].map((key) => prefix + key);
      try {
        const input = new Uint8Array(1_500_000).fill(231);
        await bucket.put(keys[0], input, {
          httpMetadata: { contentType: "image/png" },
          customMetadata: { nativeUpload: "test" },
        });
        await bucket.put(keys[1], "second");
        await bucket.put(keys[2], "third");
        expect(
          Buffer.from(await (await bucket.get(keys[0]))!.arrayBuffer()).equals(
            Buffer.from(input),
          ),
        ).toBe(true);
        const page = await bucket.list({ prefix, limit: 2 });
        expect(page.objects.map((object) => object.key)).toEqual(
          keys.slice(0, 2),
        );
        expect(page.truncated).toBe(true);
        expect(
          (await bucket.list({ prefix, cursor: page.cursor })).objects.map(
            (object) => object.key,
          ),
        ).toEqual([keys[2]]);
        await bucket.put(keys[0], "replacement");
        expect(await (await bucket.get(keys[0]))!.text()).toBe("replacement");
        await bucket.delete(keys[0]);
        expect(await bucket.get(keys[0])).toBeNull();
      } finally {
        await bucket.delete(keys);
        await pool.end();
      }
    });
  },
);
