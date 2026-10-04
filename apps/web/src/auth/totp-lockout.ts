import { HttpError } from "../security/errors";

// The same budget better-auth applies to its sign-in challenge by default.
export const TOTP_FAILURE_LIMIT = 10;
export const TOTP_LOCK_SECONDS = 900;
// better-auth's error codes for a wrong authenticator or backup code.
const WRONG_CODE = new Set(["INVALID_CODE", "INVALID_BACKUP_CODE"]);

const locked = () =>
  new HttpError(429, "Too many incorrect codes. Try again later.", "MFA_LOCKED");

/**
 * better-auth enforces its consecutive-failure lockout only for the sign-in
 * cookie challenge. Local, magic-link and provider sign-ins upgrade an existing
 * weak session through the same endpoints without it, so each of those
 * attempts is reserved here against the same per-account counter before the
 * code is checked.
 *
 * The reservation is a compare-and-set on the values just read, so parallel
 * guesses cannot all pass the check. Lock times are compared as dates in
 * JavaScript because better-auth stores them as ISO text on D1 but through a
 * MySQL driver on Node, where the text format differs.
 */
export async function reserveTotpAttempt(
  database: D1Database,
  userId: string,
  now = Date.now(),
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await database
      .prepare(
        "SELECT failedVerificationCount, lockedUntil FROM auth_two_factors WHERE userId = ?",
      )
      .bind(userId)
      .first<{ failedVerificationCount: number | null; lockedUntil: unknown }>();
    // Without an authenticator, better-auth reports that TOTP is not enabled.
    if (!row) return;
    const count = Number(row.failedVerificationCount ?? 0);
    const until = row.lockedUntil == null ? null : String(row.lockedUntil);
    // An unreadable lock time is treated as expired rather than permanent.
    if (until !== null && Date.parse(until) > now) throw locked();
    const base = until === null ? count : 0;
    const next = Math.min(base + 1, TOTP_FAILURE_LIMIT);
    // Lock on the last allowed attempt. The attempt still runs, and a correct
    // code clears the lock. A counter already at the limit gets an expiry.
    const lockUntil =
      next >= TOTP_FAILURE_LIMIT
        ? new Date(now + TOTP_LOCK_SECONDS * 1000).toISOString()
        : null;
    const result = await database
      .prepare(
        "UPDATE auth_two_factors SET failedVerificationCount = ?, lockedUntil = ? WHERE userId = ? AND COALESCE(failedVerificationCount, 0) = ? AND COALESCE(lockedUntil, '') = ?",
      )
      .bind(next, lockUntil, userId, count, until ?? "")
      .run();
    if (!result.meta.changes) continue; // Another attempt changed the row.
    if (base >= TOTP_FAILURE_LIMIT) throw locked();
    return;
  }
  // Other attempts kept changing the row. Nothing was reserved.
  throw new HttpError(429, "Too many attempts at once. Try again.", "MFA_BUSY");
}

/** Gives back a reserved attempt when the request failed for another reason. */
export async function releaseTotpAttempt(database: D1Database, userId: string) {
  // lockedUntil is assigned first: MySQL evaluates assignments left to right,
  // so both engines compare against the count before it is decremented.
  await database
    .prepare(
      "UPDATE auth_two_factors SET lockedUntil = CASE WHEN COALESCE(failedVerificationCount, 0) <= ? THEN NULL ELSE lockedUntil END, failedVerificationCount = CASE WHEN COALESCE(failedVerificationCount, 0) > 0 THEN failedVerificationCount - 1 ELSE 0 END WHERE userId = ?",
    )
    .bind(TOTP_FAILURE_LIMIT, userId)
    .run();
}

/** Whether better-auth rejected the request because the code itself was wrong. */
export async function rejectedWrongCode(response: Response) {
  if (response.ok) return false;
  const body = await response
    .clone()
    .json()
    .catch(() => null) as { code?: unknown } | null;
  return typeof body?.code === "string" && WRONG_CODE.has(body.code);
}

export async function clearTotpFailures(database: D1Database, userId: string) {
  await database
    .prepare(
      "UPDATE auth_two_factors SET failedVerificationCount = 0, lockedUntil = NULL WHERE userId = ?",
    )
    .bind(userId)
    .run();
}
