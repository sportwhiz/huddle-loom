import { HttpError } from "../security/errors";

// The same budget better-auth applies to its sign-in challenge by default.
export const TOTP_FAILURE_LIMIT = 10;
export const TOTP_LOCK_SECONDS = 900;

/**
 * better-auth enforces its consecutive-failure lockout only for the sign-in
 * cookie challenge. Local, magic-link and provider sign-ins upgrade an existing
 * weak session through the same endpoint without it, so each of those attempts
 * is reserved here against the same per-account counter before the code is
 * checked. Reserving first keeps parallel guesses inside the budget.
 */
export async function reserveTotpAttempt(
  database: D1Database,
  userId: string,
  now = Date.now(),
) {
  await database
    .prepare(
      "UPDATE auth_two_factors SET failedVerificationCount = 0, lockedUntil = NULL WHERE userId = ? AND lockedUntil IS NOT NULL AND lockedUntil <= ?",
    )
    .bind(userId, new Date(now).toISOString())
    .run();
  const reserved = await database
    .prepare(
      "UPDATE auth_two_factors SET failedVerificationCount = COALESCE(failedVerificationCount, 0) + 1 WHERE userId = ? AND lockedUntil IS NULL AND COALESCE(failedVerificationCount, 0) < ? RETURNING failedVerificationCount",
    )
    .bind(userId, TOTP_FAILURE_LIMIT)
    .first<{ failedVerificationCount: number }>();
  if (reserved && Number(reserved.failedVerificationCount) < TOTP_FAILURE_LIMIT)
    return;
  // Lock on the last allowed attempt. This also gives a counter that reached
  // the limit without a lock an expiry, so it cannot block the account forever.
  await database
    .prepare(
      "UPDATE auth_two_factors SET lockedUntil = ? WHERE userId = ? AND lockedUntil IS NULL AND COALESCE(failedVerificationCount, 0) >= ?",
    )
    .bind(
      new Date(now + TOTP_LOCK_SECONDS * 1000).toISOString(),
      userId,
      TOTP_FAILURE_LIMIT,
    )
    .run();
  if (reserved) return; // The final attempt still runs; success clears the lock.
  const enrolled = await database
    .prepare("SELECT id FROM auth_two_factors WHERE userId = ?")
    .bind(userId)
    .first();
  // Without an authenticator, better-auth reports that TOTP is not enabled.
  if (enrolled)
    throw new HttpError(
      429,
      "Too many incorrect codes. Try again later.",
      "MFA_LOCKED",
    );
}

export async function clearTotpFailures(database: D1Database, userId: string) {
  await database
    .prepare(
      "UPDATE auth_two_factors SET failedVerificationCount = 0, lockedUntil = NULL WHERE userId = ?",
    )
    .bind(userId)
    .run();
}
