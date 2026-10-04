import { createHash } from "node:crypto";
import { serialize, deserialize } from "node:v8";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { BoardRoom } from "../board-room";

export interface NodeWebSocketTransport {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(
    event: "message",
    listener: (data: Buffer, isBinary: boolean) => void,
  ): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}
const MAX_BUFFER = 8 * 1024 * 1024;
class RoomSocket {
  attachment: unknown;
  transport?: NodeWebSocketTransport;
  pending: (string | Uint8Array)[] = [];
  buffered = 0;
  closed = false;
  queuedMessages = 0;
  queuedBytes = 0;
  onMessage?: (value: string | ArrayBuffer) => Promise<void>;
  onClose?: () => Promise<void>;
  serializeAttachment(value: unknown) {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
  send(value: string | ArrayBuffer | Uint8Array) {
    if (this.closed) return;
    const data = typeof value === "string" ? value : new Uint8Array(value);
    const size =
      typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    if ((this.transport?.bufferedAmount ?? this.buffered) + size > MAX_BUFFER) {
      this.close(1013, "Client is too slow");
      return;
    }
    if (this.transport) {
      try {
        this.transport.send(data);
      } catch {
        this.close(1011, "Connection failed");
      }
    } else {
      this.pending.push(data);
      this.buffered += size;
    }
  }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    this.pending = [];
    this.buffered = 0;
    this.transport?.close(code, reason);
    void this.onClose?.().catch(() => undefined);
  }
  terminate() {
    this.transport?.terminate();
    this.close(1012, "Server restarting");
  }
}
/** Returned as Response.webSocket; the HTTP upgrade bridge supplies the real ws transport. */
export class NodeRoomClient {
  private readonly attachDeadline: ReturnType<typeof setTimeout>;
  constructor(private readonly server: RoomSocket) {
    this.attachDeadline = setTimeout(
      () => server.close(1013, "Upgrade timed out"),
      15_000,
    );
    this.attachDeadline.unref();
  }
  attach(transport: NodeWebSocketTransport) {
    const server = this.server;
    if (server.transport) throw new Error("WebSocket is already attached");
    server.transport = transport;
    clearTimeout(this.attachDeadline);
    transport.on("message", (data, binary) => {
      if (server.closed) return;
      if (
        data.byteLength > 2_000_000 ||
        server.queuedMessages >= 32 ||
        server.queuedBytes + data.byteLength > 4_000_000
      ) {
        server.close(1009, "Message queue limit exceeded");
        return;
      }
      server.queuedMessages++;
      server.queuedBytes += data.byteLength;
      const message = binary ? new Uint8Array(data).buffer : data.toString();
      void server
        .onMessage?.(message)
        .catch(() => server.close(1011, "Room unavailable"))
        .finally(() => {
          server.queuedMessages--;
          server.queuedBytes -= data.byteLength;
        });
    });
    transport.on("close", () => server.close());
    transport.on("error", () => server.close(1011, "Connection failed"));
    if (server.closed) {
      transport.close(1012, "Room unavailable");
      return;
    }
    for (const data of server.pending) transport.send(data);
    server.pending = [];
    server.buffered = 0;
  }
  close() {
    clearTimeout(this.attachDeadline);
    this.server.close(1012, "Upgrade cancelled");
  }
}
let installed = false;
/** Node only: Cloudflare's 101 Response and WebSocketPair APIs are absent from Undici. */
export function installRoomWebSocketCompatibility() {
  if (installed) return;
  installed = true;
  const NativeResponse = globalThis.Response;
  class UpgradeCompatibleResponse extends NativeResponse {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      const upgrade = init?.status === 101;
      super(body, upgrade ? { ...init, status: 200 } : init);
      if (upgrade) {
        if (!(init?.webSocket instanceof NodeRoomClient))
          throw new Error("Invalid WebSocket upgrade");
        Object.defineProperties(this, {
          status: { value: 101 },
          ok: { value: false },
          webSocket: { value: init.webSocket },
        });
      }
    }
  }
  class Pair {
    0: NodeRoomClient;
    1: RoomSocket;
    constructor() {
      this[1] = new RoomSocket();
      this[0] = new NodeRoomClient(this[1]);
    }
  }
  Object.assign(globalThis, {
    Response: UpgradeCompatibleResponse,
    WebSocketPair: Pair,
  });
}

const CHUNK = 512 * 1024;
function bytes(value: string, max: number) {
  const result = Buffer.from(value);
  if (!result.length || result.length > max)
    throw new Error("Invalid room storage key");
  return result;
}
type ValueRow = RowDataPacket & { value: Buffer; item_key: Buffer };
/** All access runs on the same connection that owns the process lock. Losing it fences writes. */
export function createRoomStorage(connection: PoolConnection, roomId: string) {
  const room = bytes(roomId, 1024);
  const raw = {
    async get<T>(key: string): Promise<T | undefined> {
      const [rows] = await connection.execute<ValueRow[]>(
        "SELECT value FROM node_room_values WHERE room_id = ? AND item_key = ? ORDER BY part",
        [room, bytes(key, 512)],
      );
      return rows.length
        ? (deserialize(Buffer.concat(rows.map((row) => row.value))) as T)
        : undefined;
    },
    async put(key: string, value: unknown) {
      const item = bytes(key, 512);
      const data = serialize(value);
      await connection.execute(
        "DELETE FROM node_room_values WHERE room_id = ? AND item_key = ?",
        [room, item],
      );
      for (let offset = 0; offset < data.length; offset += CHUNK)
        await connection.execute(
          "INSERT INTO node_room_values(room_id, item_key, part, value) VALUES(?, ?, ?, ?)",
          [room, item, offset / CHUNK, data.subarray(offset, offset + CHUNK)],
        );
      // Persist a wake-up in the same transaction as timer/voting state. A
      // process exit before BoardRoom schedules its exact deadline cannot strand it.
      if (key === "collaboration")
        await connection.execute(
          "INSERT INTO node_room_alarms(room_id,due_at) VALUES(?,?) ON DUPLICATE KEY UPDATE due_at=LEAST(due_at,VALUES(due_at))",
          [room, Date.now()],
        );
    },
    async delete(keys: string | string[]) {
      const values = typeof keys === "string" ? [keys] : keys;
      let count = 0;
      for (const key of values) {
        const [result] = await connection.execute(
          "DELETE FROM node_room_values WHERE room_id = ? AND item_key = ?",
          [room, bytes(key, 512)],
        );
        if ((result as { affectedRows: number }).affectedRows) count++;
      }
      return typeof keys === "string" ? count > 0 : count;
    },
    async list<T>(
      options: { prefix?: string; reverse?: boolean; limit?: number } = {},
    ) {
      const prefix = Buffer.from(options.prefix ?? "");
      const limit = options.limit ?? 10000;
      if (!Number.isInteger(limit) || limit < 1 || limit > 10000)
        throw new Error("Invalid room storage limit");
      const [keys] = await connection.execute<ValueRow[]>(
        `SELECT DISTINCT item_key FROM node_room_values WHERE room_id = ? AND LEFT(item_key, ?) = ? ORDER BY item_key ${options.reverse ? "DESC" : "ASC"} LIMIT ${limit}`,
        [room, prefix.length, prefix],
      );
      const values = new Map<string, T>();
      for (const row of keys) {
        const key = row.item_key.toString();
        const value = await raw.get<T>(key);
        if (value !== undefined) values.set(key, value);
      }
      return values;
    },
  };
  async function transaction<T>(callback: (value: typeof raw) => Promise<T>) {
    await connection.beginTransaction();
    try {
      const result = await callback(raw);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    }
  }
  return {
    get: raw.get,
    list: raw.list,
    put: (key: string, value: unknown) =>
      transaction((tx) => tx.put(key, value)),
    delete: (keys: string | string[]) => transaction((tx) => tx.delete(keys)),
    transaction,
    async setAlarm(time: number | Date) {
      const timestamp = Number(time);
      if (!Number.isFinite(timestamp)) throw new Error("Invalid alarm time");
      await connection.execute(
        "INSERT INTO node_room_alarms(room_id, due_at) VALUES(?, ?) ON DUPLICATE KEY UPDATE due_at=VALUES(due_at)",
        [room, timestamp],
      );
    },
    async deleteAlarm() {
      await connection.execute(
        "DELETE FROM node_room_alarms WHERE room_id = ?",
        [room],
      );
    },
  };
}

/** Acquire before migrations; the same connection fences the installation for its lifetime. */
export async function acquireNodeOwnership(pool: Pool) {
  const connection = await pool.getConnection();
  let lockName: string;
  try {
    const [dbRows] = await connection.query<(RowDataPacket & { db: string })[]>(
      "SELECT DATABASE() AS db",
    );
    if (!dbRows[0]?.db)
      throw new Error("A database must be selected for room storage");
    lockName = `huddle-rooms:${createHash("sha256").update(dbRows[0].db).digest("hex").slice(0, 48)}`;
    const [lockRows] = await connection.execute<
      (RowDataPacket & { acquired: number })[]
    >("SELECT GET_LOCK(?, 0) AS acquired", [lockName]);
    if (Number(lockRows[0]?.acquired) !== 1)
      throw new Error(
        "Another Open Whiteboard Node server is active for this database. Stop it before starting this server.",
      );
  } catch (error) {
    connection.destroy();
    throw error;
  }
  let lost = false;
  let released = false;
  const listeners = new Set<() => void>();
  const fail = () => {
    if (released || lost) return;
    lost = true;
    for (const listener of listeners) listener();
  };
  connection.on("error", fail);
  connection.on("end", fail);
  return {
    connection,
    lockName,
    async assertCatalogConnection(candidate: PoolConnection) {
      if (lost || released)
        throw new Error("Installation ownership is no longer valid");
      const [rows] = await candidate.execute<
        (RowDataPacket & { owned: number })[]
      >("SELECT IS_USED_LOCK(?) = ? AS owned", [lockName, connection.threadId]);
      if (Number(rows[0]?.owned) !== 1) {
        fail();
        throw new Error("Installation ownership is no longer valid");
      }
    },
    async drainCatalog() {
      const [tables] = await connection.query<RowDataPacket[]>(
        "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='hl_catalog_mutex'",
      );
      if (!tables.length) return;
      await connection.beginTransaction();
      try {
        // Existing pre-loss transactions finish/roll back before any new DDL.
        // Their subsequent transactions fail the catalog ownership guard.
        await connection.query(
          "SELECT id FROM hl_catalog_mutex WHERE id=1 FOR UPDATE",
        );
        if (lost || released)
          throw new Error("Installation ownership is no longer valid");
        await connection.commit();
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      }
    },
    get healthy() {
      return !lost && !released;
    },
    onLoss(listener: () => void) {
      listeners.add(listener);
      if (lost) listener();
      return () => listeners.delete(listener);
    },
    fail,
    close() {
      if (released) return;
      released = true;
      connection.destroy();
      listeners.clear();
    },
  };
}
export type NodeOwnership = Awaited<ReturnType<typeof acquireNodeOwnership>>;

/** Standalone callers acquire ownership here; runtime supplies its pre-migration owner. */
export async function createNodeRooms(
  pool: Pool,
  catalog: D1Database,
  suppliedOwnership?: NodeOwnership,
) {
  installRoomWebSocketCompatibility();
  const ownership = suppliedOwnership ?? (await acquireNodeOwnership(pool));
  const { connection, lockName } = ownership;
  if (!ownership.healthy) throw new Error("Installation ownership was lost");
  const entries = new Map<
    string,
    { room: BoardRoom; sockets: Set<RoomSocket>; usedAt: number }
  >();
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  const stop = () => {
    closed = true;
    for (const entry of entries.values())
      for (const socket of entry.sockets) socket.terminate();
  };
  const removeLossListener = ownership.onLoss(stop);
  try {
    await connection.query(
      "CREATE TABLE IF NOT EXISTS node_room_values(room_id VARBINARY(1024) NOT NULL, item_key VARBINARY(512) NOT NULL, part INT NOT NULL, value MEDIUMBLOB NOT NULL, PRIMARY KEY(room_id, item_key, part)) ENGINE=InnoDB",
    );
    await connection.query(
      "CREATE TABLE IF NOT EXISTS node_room_alarms(room_id VARBINARY(1024) PRIMARY KEY, due_at BIGINT NOT NULL, INDEX(due_at)) ENGINE=InnoDB",
    );
  } catch (error) {
    connection.destroy();
    throw error;
  }
  function enqueue<T>(callback: () => Promise<T>): Promise<T> {
    if (closed || pending >= 64)
      return Promise.reject(new Error("Room runtime is busy or unavailable"));
    pending++;
    const result = tail
      .then(async () => {
        if (closed) throw new Error("Room runtime is unavailable");
        // This query also detects connection loss before accepting any new work.
        const [rows] = await connection.execute<
          (RowDataPacket & { owned: number })[]
        >("SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS owned", [lockName]);
        if (Number(rows[0]?.owned) !== 1) {
          ownership.fail();
          throw new Error("Room runtime lost its process lock");
        }
        return callback();
      })
      .finally(() => {
        pending--;
      });
    tail = result.catch(() => undefined);
    return result;
  }
  function getEntry(id: string) {
    bytes(id, 1024);
    let entry = entries.get(id);
    if (!entry) {
      const sockets = new Set<RoomSocket>();
      const state = {
        storage: createRoomStorage(connection, id),
        getWebSockets: () => [...sockets].filter((socket) => !socket.closed),
        acceptWebSocket(socket: RoomSocket) {
          if (socket.closed) throw new Error("WebSocket upgrade expired");
          sockets.add(socket);
          socket.onMessage = (value) =>
            enqueue(async () => {
              await entry!.room.webSocketMessage(
                socket as unknown as WebSocket,
                value,
              );
              entry!.usedAt = Date.now();
            });
          socket.onClose = async () => {
            sockets.delete(socket);
            if (!closed)
              await enqueue(() =>
                entry!.room.webSocketClose(socket as unknown as WebSocket),
              );
          };
        },
      };
      entry = {
        room: new BoardRoom(state as unknown as DurableObjectState, {
          CATALOG: catalog,
        }),
        sockets,
        usedAt: Date.now(),
      };
      entries.set(id, entry);
    }
    entry.usedAt = Date.now();
    return entry;
  }
  async function dispatchAlarms() {
    return enqueue(async () => {
      const [rows] = await connection.execute<
        (RowDataPacket & { room_id: Buffer })[]
      >(
        "SELECT room_id FROM node_room_alarms WHERE due_at <= ? ORDER BY due_at LIMIT 100",
        [Date.now()],
      );
      for (const row of rows) {
        // BoardRoom reschedules or deletes its alarm only after successful processing.
        await getEntry(row.room_id.toString()).room.alarm();
      }
      for (const [id, entry] of entries)
        if (!entry.sockets.size && entry.usedAt < Date.now() - 600_000)
          entries.delete(id);
    });
  }
  let ticking = false;
  const timer = setInterval(() => {
    if (ticking || closed) return;
    ticking = true;
    void dispatchAlarms()
      .catch(() => undefined)
      .finally(() => {
        ticking = false;
      });
  }, 1000);
  timer.unref();
  function stub(id: string) {
    return {
      fetch: (input: Request | string | URL, init?: RequestInit) =>
        enqueue(async () => {
          const entry = getEntry(id);
          const previous = new Set(entry.sockets);
          try {
            return await entry.room.fetch(
              input instanceof Request && !init
                ? input
                : new Request(
                    input,
                    init?.body
                      ? ({ ...init, duplex: "half" } as RequestInit)
                      : init,
                  ),
            );
          } catch (error) {
            for (const socket of entry.sockets)
              if (!previous.has(socket)) socket.close(1011, "Upgrade failed");
            throw error;
          }
        }),
    };
  }
  return {
    idFromName: (name: string) => {
      bytes(name, 1024);
      return name;
    },
    get(id: string | { toString(): string }) {
      return stub(id.toString());
    },
    getByName(name: string) {
      return stub(name);
    },
    dispatchAlarms,
    async close() {
      clearInterval(timer);
      stop();
      await tail;
      // Destroy, rather than return a connection with a named lock to the pool.
      removeLossListener();
      if (!suppliedOwnership) ownership.close();
      entries.clear();
    },
  };
}
