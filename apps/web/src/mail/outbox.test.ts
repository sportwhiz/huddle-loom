import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import type { NativeEnv } from "../auth/types";
import { processOutbox, queueMail } from "./outbox";

it("gives later mail deliveries a full lease and skips proofs that expired while waiting", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE security_outbox (
    id TEXT PRIMARY KEY, kind TEXT, payload TEXT, expires_at INTEGER, next_attempt_at INTEGER,
    attempts INTEGER, status TEXT, created_at INTEGER, lease_until INTEGER, lease_key TEXT,
    provider_id TEXT, last_error TEXT);
    CREATE TABLE mail_suppressions (email TEXT PRIMARY KEY);`);
  const start = Date.now();
  let clock = start;
  const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
  const delivered: string[] = [];
  const env = {
    AUTH_ENCRYPTION_KEYS: JSON.stringify([
      { id: "fixture", key: Buffer.alloc(32, 4).toString("base64url") },
    ]),
    MAIL_PROVIDER: "cloudflare",
    MAIL_FROM: "fixture@example.invalid",
    CATALOG: {
      prepare(sql: string) {
        const statement = db.prepare(sql);
        return {
          bind(...values: (string | number | null)[]) {
            return {
              first: async () => statement.get(...values) ?? null,
              all: async () => ({ results: statement.all(...values) }),
              run: async () => ({ meta: statement.run(...values) }),
            };
          },
        };
      },
    },
    EMAIL: {
      async send(message: { to: string }) {
        const active = db
          .prepare(
            "SELECT lease_until FROM security_outbox WHERE status = 'processing'",
          )
          .get()!;
        expect(active.lease_until).toBe(clock + 60_000);
        delivered.push(message.to);
        clock += 45_000;
      },
    },
  } as unknown as NativeEnv;
  try {
    for (let index = 0; index < 4; index++) {
      const id = await queueMail(
        env,
        `person${index}@example.invalid`,
        "Fixture",
        "Verify this fixture",
        undefined,
        index === 3 ? start + 100_000 : start + 600_000,
      );
      db.prepare(
        "UPDATE security_outbox SET next_attempt_at = ? WHERE id = ?",
      ).run(start - 4 + index, id);
    }
    await processOutbox(env);
    expect(delivered).toEqual([
      "person0@example.invalid",
      "person1@example.invalid",
      "person2@example.invalid",
    ]);
    await processOutbox(env);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM security_outbox WHERE status = 'expired' AND payload = ''",
        )
        .get()?.n,
    ).toBe(1);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM security_outbox WHERE status = 'accepted'",
        )
        .get()?.n,
    ).toBe(3);
  } finally {
    now.mockRestore();
    db.close();
  }
});

it("does not reclaim a stale selection after another worker schedules a retry", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE security_outbox (
    id TEXT PRIMARY KEY, kind TEXT, payload TEXT, expires_at INTEGER, next_attempt_at INTEGER,
    attempts INTEGER, status TEXT, created_at INTEGER, lease_until INTEGER, lease_key TEXT,
    provider_id TEXT, last_error TEXT);`);
  const now = Date.now();
  db.prepare(
    "INSERT INTO security_outbox VALUES ('fixture','mail','private-malformed-payload',?,?,0,'pending',?,NULL,NULL,NULL,NULL)",
  ).run(now + 600_000, now - 1, now);
  let selections = 0;
  let release: () => void;
  const retried = new Promise<void>((resolve) => {
    release = resolve;
  });
  const env = {
    CATALOG: {
      prepare(sql: string) {
        const statement = db.prepare(sql);
        return {
          bind(...values: (string | number | null)[]) {
            return {
              first: async () => statement.get(...values) ?? null,
              all: async () => {
                const rows = statement.all(...values);
                if (++selections === 2) await retried;
                return { results: rows };
              },
              run: async () => {
                const result = statement.run(...values);
                if (sql.includes("last_error = ?")) release();
                return { meta: result };
              },
            };
          },
        };
      },
    },
  } as unknown as NativeEnv;
  try {
    await Promise.all([processOutbox(env), processOutbox(env)]);
    const job = db
      .prepare("SELECT * FROM security_outbox WHERE id='fixture'")
      .get()!;
    expect(job.attempts).toBe(1);
    expect(job.status).toBe("pending");
    expect(Number(job.next_attempt_at)).toBeGreaterThan(now);
    expect(String(job.last_error)).not.toContain("private-malformed-payload");
  } finally {
    db.close();
  }
});
