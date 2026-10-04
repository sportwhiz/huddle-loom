import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteCatalog } from "../node/sqlite-catalog";
import {
  TOTP_FAILURE_LIMIT,
  TOTP_LOCK_SECONDS,
  clearTotpFailures,
  rejectedWrongCode,
  releaseTotpAttempt,
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
  it("never reserves more attempts than the budget", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: TOTP_FAILURE_LIMIT * 3 }, () => reserve()),
    );
    const reserved = results.filter((item) => item.status === "fulfilled").length;
    expect(reserved).toBeGreaterThan(0);
    expect(reserved).toBeLessThanOrEqual(TOTP_FAILURE_LIMIT);
    expect((await state())?.failedVerificationCount).toBe(reserved);
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
  it("honors a lock written by the MySQL driver", async () => {
    const later = new Date(now + 5 * 60 * 1000);
    const pad = (value: number) => String(value).padStart(2, "0");
    const local = `${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())} ${pad(later.getHours())}:${pad(later.getMinutes())}:${pad(later.getSeconds())}`;
    await db.exec(
      `UPDATE auth_two_factors SET failedVerificationCount = ${TOTP_FAILURE_LIMIT}, lockedUntil = '${local}'`,
    );
    await expect(reserve()).rejects.toMatchObject({ code: "MFA_LOCKED" });
    await expect(reserve(now + 6 * 60 * 1000)).resolves.toBeUndefined();
  });
  it("treats an unreadable lock time as expired", async () => {
    await db.exec(
      `UPDATE auth_two_factors SET failedVerificationCount = ${TOTP_FAILURE_LIMIT}, lockedUntil = 'not a date'`,
    );
    await expect(reserve()).resolves.toBeUndefined();
    expect(await state()).toEqual({ failedVerificationCount: 1, lockedUntil: null });
  });
  it("gives back an attempt and the lock it set", async () => {
    for (let attempt = 0; attempt < TOTP_FAILURE_LIMIT; attempt++)
      await reserve();
    await releaseTotpAttempt(database(), "owner");
    expect(await state()).toEqual({
      failedVerificationCount: TOTP_FAILURE_LIMIT - 1,
      lockedUntil: null,
    });
    await expect(reserve()).resolves.toBeUndefined();
  });
  it("counts only wrong-code rejections", async () => {
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status });
    expect(await rejectedWrongCode(reply(401, { code: "INVALID_CODE" }))).toBe(true);
    expect(await rejectedWrongCode(reply(401, { code: "INVALID_BACKUP_CODE" }))).toBe(true);
    expect(await rejectedWrongCode(reply(429, { message: "Too many requests" }))).toBe(false);
    expect(await rejectedWrongCode(reply(400, { code: "TOTP_NOT_ENABLED" }))).toBe(false);
    expect(await rejectedWrongCode(new Response("busy", { status: 503 }))).toBe(false);
  });
});
