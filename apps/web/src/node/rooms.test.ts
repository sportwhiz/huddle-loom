import { describe, expect, it, vi } from "vitest";
import {
  createRoomStorage,
  installRoomWebSocketCompatibility,
  NodeRoomClient,
  createNodeRooms,
} from "./rooms";
import type { Pool, PoolConnection } from "mysql2/promise";

function connectionFixture() {
  let values = new Map<string, { key: Buffer; part: number; value: Buffer }>();
  let backup = new Map(values);
  const connection = {
    beginTransaction: vi.fn(async () => {
      backup = new Map(values);
    }),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => {
      values = backup;
    }),
    execute: vi.fn(async (sql: string, args: unknown[]) => {
      const item = (args[1] as Buffer)?.toString();
      if (sql.startsWith("DELETE FROM node_room_values")) {
        let affectedRows = 0;
        for (const [id, row] of values)
          if (row.key.toString() === item) {
            values.delete(id);
            affectedRows++;
          }
        return [{ affectedRows }];
      }
      if (sql.startsWith("INSERT INTO node_room_values")) {
        values.set(`${item}:${args[2]}`, {
          key: args[1] as Buffer,
          part: args[2] as number,
          value: args[3] as Buffer,
        });
        return [{}];
      }
      if (sql.startsWith("SELECT value"))
        return [
          [...values.values()]
            .filter((row) => row.key.toString() === item)
            .sort((a, b) => a.part - b.part),
        ];
      if (sql.startsWith("SELECT DISTINCT")) {
        const prefix = (args[2] as Buffer).toString();
        const keys = [
          ...new Set([...values.values()].map((row) => row.key.toString())),
        ]
          .filter((key) => key.startsWith(prefix))
          .sort();
        if (sql.includes("DESC")) keys.reverse();
        return [
          keys
            .slice(0, Number(sql.split("LIMIT ")[1]))
            .map((key) => ({ item_key: Buffer.from(key) })),
        ];
      }
      throw new Error(`Unexpected query: ${sql}`);
    }),
  };
  return connection;
}
describe("MySQL room storage", () => {
  it("rolls back all snapshot and receipt writes together", async () => {
    const connection = connectionFixture();
    const storage = createRoomStorage(
      connection as unknown as PoolConnection,
      "board:1",
    );
    await storage.put("board", { revision: 1 });
    await expect(
      storage.transaction(async (tx) => {
        await tx.put("board", { revision: 2 });
        await tx.put("receipt:1", { applied: true });
        throw new Error("failure");
      }),
    ).rejects.toThrow("failure");
    expect(await storage.get("board")).toEqual({ revision: 1 });
    expect(await storage.get("receipt:1")).toBeUndefined();
  });
  it("chunks large snapshots and reconstructs them without exposing mutable cached references", async () => {
    const connection = connectionFixture();
    const storage = createRoomStorage(
      connection as unknown as PoolConnection,
      "board:1",
    );
    const original = { revision: 1, data: "a".repeat(1_500_000) };
    await storage.put("board", original);
    const reads = await storage.get<typeof original>("board");
    reads!.revision = 20;
    expect(await storage.get("board")).toEqual(original);
    const inserts = connection.execute.mock.calls.filter(([sql]) =>
      sql.startsWith("INSERT"),
    );
    expect(inserts).toHaveLength(3);
    expect(
      inserts.every(([, args]) => (args[3] as Buffer).length <= 512 * 1024),
    ).toBe(true);
  });
  it("lists ordered versions with prefix and limit", async () => {
    const storage = createRoomStorage(
      connectionFixture() as unknown as PoolConnection,
      "board:1",
    );
    await storage.put("version:001", { revision: 1 });
    await storage.put("version:002", { revision: 2 });
    await storage.put("board", {});
    expect([
      ...(
        await storage.list({ prefix: "version:", reverse: true, limit: 1 })
      ).keys(),
    ]).toEqual(["version:002"]);
  });
  it("rejects a second process before accepting room operations", async () => {
    const connection = {
      query: vi.fn(async () => [[{ db: "test" }]]),
      execute: vi.fn(async () => [[{ acquired: 0 }]]),
      destroy: vi.fn(),
    };
    const pool = { getConnection: async () => connection } as unknown as Pool;
    await expect(createNodeRooms(pool, {} as D1Database)).rejects.toThrow(
      "Another Huddle Loom Node server",
    );
    expect(connection.destroy).toHaveBeenCalledOnce();
  });
});
describe("Node WebSocket upgrade compatibility", () => {
  it("preserves 101 upgrade and buffers initial room messages until transport attaches", () => {
    installRoomWebSocketCompatibility();
    const pair = new WebSocketPair();
    pair[1].serializeAttachment({ user: "alice" });
    const attachment = pair[1].deserializeAttachment() as { user: string };
    attachment.user = "bob";
    expect(pair[1].deserializeAttachment()).toEqual({ user: "alice" });
    pair[1].send("initial");
    const response = new Response(null, { status: 101, webSocket: pair[0] });
    expect(response.status).toBe(101);
    expect(response.ok).toBe(false);
    expect(response.webSocket).toBeInstanceOf(NodeRoomClient);
    const transport = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
      on: vi.fn(),
    };
    (response.webSocket as unknown as NodeRoomClient).attach(transport);
    expect(transport.send).toHaveBeenCalledWith("initial");
    pair[1].close(4003, "Access revoked");
    expect(transport.close).toHaveBeenCalledWith(4003, "Access revoked");
  });
});

describe.skipIf(!process.env.NODE_ADAPTER_MYSQL_TEST_URL)(
  "Real MySQL room conformance",
  () => {
    it("enforces one process, survives restart, and recovers overdue alarms", async () => {
      const { createPool } = await import("mysql2/promise");
      const { emptyCollaborationState } = await import("../room-collaboration");
      const url = process.env.NODE_ADAPTER_MYSQL_TEST_URL!;
      if (!new URL(url).pathname.endsWith("_test"))
        throw new Error("Integration database name must end with _test");
      const pool = createPool(url);
      const roomId = `integration:${crypto.randomUUID()}`;
      let runtime: Awaited<ReturnType<typeof createNodeRooms>> | undefined;
      let storageConnection: PoolConnection | undefined;
      try {
        runtime = await createNodeRooms(pool, {} as D1Database);
        await expect(createNodeRooms(pool, {} as D1Database)).rejects.toThrow(
          "Another Huddle Loom Node server",
        );
        storageConnection = await pool.getConnection();
        const storage = createRoomStorage(storageConnection, roomId);
        await storage.put("large", {
          bytes: "x".repeat(1_500_000),
          revision: 1,
        });
        await expect(
          storage.transaction(async (tx) => {
            await tx.put("large", { revision: 2 });
            await tx.put("receipt:test", { result: true });
            throw new Error("abort");
          }),
        ).rejects.toThrow("abort");
        expect(await storage.get("receipt:test")).toBeUndefined();
        const collaboration = emptyCollaborationState();
        collaboration.timer = {
          status: "running",
          endsAt: new Date(Date.now() - 1000).toISOString(),
          remainingMs: 1000,
          label: "test",
          startedAt: new Date(Date.now() - 2000).toISOString(),
          startedBy: "owner",
        };
        await storage.put("collaboration", collaboration);
        // Simulate a crash before the separate exact-deadline scheduling call.
        // The collaboration write must have persisted its own recovery wake-up.
        await runtime.close();
        runtime = await createNodeRooms(pool, {} as D1Database);
        expect(await storage.get("large")).toEqual({
          bytes: "x".repeat(1_500_000),
          revision: 1,
        });
        await runtime.dispatchAlarms();
        const recovered =
          await storage.get<typeof collaboration>("collaboration");
        expect(recovered!.timer!.status).toBe("ended");
        const [alarms] = await storageConnection.execute(
          "SELECT * FROM node_room_alarms WHERE room_id = ?",
          [Buffer.from(roomId)],
        );
        expect(alarms).toEqual([]);
      } finally {
        await runtime?.close();
        if (storageConnection) {
          await storageConnection.execute(
            "DELETE FROM node_room_values WHERE room_id = ?",
            [Buffer.from(roomId)],
          );
          await storageConnection.execute(
            "DELETE FROM node_room_alarms WHERE room_id = ?",
            [Buffer.from(roomId)],
          );
          storageConnection.release();
        }
        await pool.end();
      }
    });
  },
);
