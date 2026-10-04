import { describe, it, expect, vi } from "vitest";
import { sql } from "kysely";
import type { Pool } from "mysql2/promise";
import { createNativeAuthDatabase } from "./auth-database";

describe("native auth transaction acquisition", () => {
  it("rolls back a failed mutex acquisition before returning its connection", async () => {
    let fail = true;
    const connection = {
      query: vi.fn(async () => [[], []]),
      beginTransaction: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      release: vi.fn(),
      destroy: vi.fn(),
      execute: vi.fn(async (statement: string) => {
        if (statement.includes("FOR UPDATE") && fail) {
          fail = false;
          throw new Error("Lock wait timeout");
        }
        return [[{ value: 1 }], []];
      }),
    };
    const pool = { getConnection: async () => connection } as unknown as Pool;
    const { db } = createNativeAuthDatabase(pool);
    await expect(sql`SELECT 1 AS value`.execute(db)).rejects.toThrow(
      "Lock wait timeout",
    );
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect((await sql`SELECT 1 AS value`.execute(db)).rows).toEqual([
      { value: 1 },
    ]);
    expect(connection.commit).toHaveBeenCalledTimes(1);
    await db.destroy();
  });
  it("discards a connection when failed acquisition cannot roll back", async () => {
    const connection = {
      query: vi.fn(async () => [[], []]),
      beginTransaction: vi.fn(async () => {}),
      rollback: vi.fn(async () => {
        throw new Error("Connection lost");
      }),
      release: vi.fn(),
      destroy: vi.fn(),
      execute: vi.fn(async () => {
        throw new Error("Lock failure");
      }),
    };
    const { db } = createNativeAuthDatabase({
      getConnection: async () => connection,
    } as unknown as Pool);
    await expect(sql`SELECT 1`.execute(db)).rejects.toThrow("Lock failure");
    expect(connection.release).not.toHaveBeenCalled();
    expect(connection.destroy).toHaveBeenCalledTimes(1);
    await db.destroy();
  });
});
