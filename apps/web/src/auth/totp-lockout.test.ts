import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteCatalog } from "../node/sqlite-catalog";
import {
  TOTP_FAILURE_LIMIT,
  TOTP_LOCK_SECONDS,
  clearTotpFailures,
  reserveTotpAttempt,
} from "./totp-lockout";
let db: SqliteCatalog;
const now = Date.parse("2026-10-04T12:00:00.000Z");
const database = () => db as unknown as D1Database;
const reserve = (at = now) => reserveTotpAttempt(database(), "owner", at);
const state = () =>
  db
    .prepare(
      "SELECT failedVerificationCount, lockedUntil FROM auth_two_factors WHERE userId = 'owner'",
    )
    .first<{ failedVerificationCount: number; lockedUntil: string | null }>();
beforeEach(async () => {
  db = new SqliteCatalog(":memory:");
  await db.exec(`CREATE TABLE auth_two_factors(id TEXT PRIMARY KEY,userId TEXT UNIQUE,failedVerificationCount INTEGER,lockedUntil TEXT);
 INSERT INTO auth_two_factors VALUES('factor','owner',NULL,NULL);`);
});
afterEach(() => db.close());
describe("session TOTP lockout", () => {
  it("locks the account after the failure budget is spent", async () => {
    for (let attempt = 0; attempt < TOTP_FAILURE_LIMIT; attempt++)
      await reserve();
    expect(await state()).toEqual({
      failedVerificationCount: TOTP_FAILURE_LIMIT,
      lockedUntil: new Date(now + TOTP_LOCK_SECONDS * 1000).toISOString(),
    });
    await expect(reserve()).rejects.toMatchObject({
      status: 429,
      code: "MFA_LOCKED",
    });
  });
  it("counts parallel guesses before any code is checked", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: TOTP_FAILURE_LIMIT + 5 }, () => reserve()),
    );
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(
      TOTP_FAILURE_LIMIT,
    );
  });
  it("clears the budget after a successful verification", async () => {
    for (let attempt = 0; attempt < TOTP_FAILURE_LIMIT; attempt++)
      await reserve();
    await clearTotpFailures(database(), "owner");
    await expect(reserve()).resolves.toBeUndefined();
    expect((await state())?.failedVerificationCount).toBe(1);
  });
  it("releases the lock when it expires", async () => {
    for (let attempt = 0; attempt < TOTP_FAILURE_LIMIT; attempt++)
      await reserve();
    await expect(
      reserve(now + TOTP_LOCK_SECONDS * 1000 - 1),
    ).rejects.toMatchObject({ code: "MFA_LOCKED" });
    await expect(reserve(now + TOTP_LOCK_SECONDS * 1000)).resolves.toBeUndefined();
    expect(await state()).toEqual({
      failedVerificationCount: 1,
      lockedUntil: null,
    });
  });
  it("gives a spent counter without a lock an expiry", async () => {
    await db.exec(
      `UPDATE auth_two_factors SET failedVerificationCount = ${TOTP_FAILURE_LIMIT}`,
    );
    await expect(reserve()).rejects.toMatchObject({ code: "MFA_LOCKED" });
    await expect(reserve(now + TOTP_LOCK_SECONDS * 1000)).resolves.toBeUndefined();
  });
  it("leaves accounts without an authenticator to better-auth", async () => {
    await db.exec("DELETE FROM auth_two_factors");
    await expect(reserve()).resolves.toBeUndefined();
  });
});
