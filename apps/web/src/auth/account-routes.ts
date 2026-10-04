import { nativeAuth } from "./library";
import { updateProfile } from "../collaboration.server";
import { limit } from "../security/limits";
import type { NativeEnv } from "./types";
import { nativePrincipal } from "./session";
import {
  installation,
  needsStrong,
  publicPrincipal,
  requireFresh,
} from "./policy";
import {
  verifyPassword,
  validatePassword,
  rejectCompromisedPassword,
} from "./password";
import { APIError } from "better-auth/api";
import { json, randomToken, sha256 } from "../security/primitives";
import { HttpError } from "../security/errors";
import { auditStatement } from "../security/audit";
import { invalidationStatement } from "../mail/outbox";

export async function revokeIdentity(
  env: NativeEnv,
  userId: string,
  actor: string,
  action: string,
  assistants: boolean,
  currentSession?: string,
) {
  const at = new Date().toISOString();
  await env.CATALOG.batch([
    env.CATALOG.prepare(
      currentSession
        ? "DELETE FROM auth_sessions WHERE userId = ? AND id <> ?"
        : "DELETE FROM auth_sessions WHERE userId = ?",
    ).bind(...(currentSession ? [userId, currentSession] : [userId])),
    ...(!currentSession
      ? [
          env.CATALOG.prepare(
            "UPDATE account_security SET auth_version = auth_version + 1, updated_at = ? WHERE user_id = ?",
          ).bind(at, userId),
        ]
      : []),
    ...(assistants
      ? [
          env.CATALOG.prepare(
            "UPDATE oauth_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
          ).bind(at, userId),
          env.CATALOG.prepare(
            "UPDATE oauth_grants SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
          ).bind(at, userId),
        ]
      : []),
    invalidationStatement(env, userId),
    auditStatement(env.CATALOG, actor, action, userId),
  ]);
}
export async function tombstoneAccount(
  env: NativeEnv,
  actorId: string,
  userId: string,
) {
  const owned = await env.CATALOG.prepare(
    "SELECT COUNT(*) AS n FROM resource_grants WHERE user_id = ? AND role = 'owner' AND ((resource_type = 'board' AND EXISTS(SELECT 1 FROM boards b WHERE b.id = resource_id AND b.deleted_at IS NULL)) OR (resource_type = 'workbook' AND EXISTS(SELECT 1 FROM workbooks w WHERE w.id = resource_id AND w.deleted_at IS NULL)))",
  )
    .bind(userId)
    .first<{ n: number }>();
  const folder = await env.CATALOG.prepare(
    "SELECT 1 FROM folders WHERE owner_id = ? AND deleted_at IS NULL LIMIT 1",
  )
    .bind(userId)
    .first();
  if (owned?.n || folder)
    throw new HttpError(
      409,
      "Transfer or delete your owned folders, workbooks and boards before deleting this account.",
      "CONTENT_TRANSFER_REQUIRED",
    );
  const changed = await env.CATALOG.prepare(
    "UPDATE account_security SET status = 'deletion_pending', auth_version = auth_version + 1, deletion_requested_at = ?, deletion_actor_id = ?, updated_at = ? WHERE user_id = ? AND user_id <> COALESCE((SELECT owner_id FROM installation WHERE id = 'instance'), '') AND status NOT IN ('deleted','deletion_pending') AND NOT EXISTS(SELECT 1 FROM folders WHERE owner_id = account_security.user_id AND deleted_at IS NULL) AND NOT EXISTS(SELECT 1 FROM resource_grants g WHERE g.user_id = account_security.user_id AND g.role = 'owner' AND ((g.resource_type = 'board' AND EXISTS(SELECT 1 FROM boards b WHERE b.id = g.resource_id AND b.deleted_at IS NULL)) OR (g.resource_type = 'workbook' AND EXISTS(SELECT 1 FROM workbooks w WHERE w.id = g.resource_id AND w.deleted_at IS NULL)))) RETURNING user_id",
  )
    .bind(new Date().toISOString(), actorId, new Date().toISOString(), userId)
    .first();
  if (!changed)
    throw new HttpError(
      409,
      "Transfer installation ownership before deleting this account.",
      "LAST_OWNER",
    );
  await finishAccountDeletion(env, userId, actorId);
}

// The status transition revokes access before cleanup. Scheduled maintenance resumes
// this operation if the request stops between the transition and the cleanup batch.
export async function finishAccountDeletion(
  env: NativeEnv,
  userId: string,
  actorId: string,
) {
  const pending = await env.CATALOG.prepare(
    "SELECT 1 FROM account_security WHERE user_id = ? AND status = 'deletion_pending'",
  )
    .bind(userId)
    .first();
  if (!pending) return;
  await env.CATALOG.batch([
    env.CATALOG.prepare("DELETE FROM auth_users WHERE id = ?").bind(userId),
    env.CATALOG.prepare(
      "DELETE FROM instance_memberships WHERE user_id = ?",
    ).bind(userId),
    env.CATALOG.prepare("DELETE FROM resource_grants WHERE user_id = ?").bind(
      userId,
    ),
    env.CATALOG.prepare("DELETE FROM user_profiles WHERE user_id = ?").bind(
      userId,
    ),
    env.CATALOG.prepare("DELETE FROM local_accounts WHERE user_id = ?").bind(
      userId,
    ),
    env.CATALOG.prepare(
      "UPDATE access_identities SET revoked_at = ? WHERE user_id = ?",
    ).bind(new Date().toISOString(), userId),
    env.CATALOG.prepare(
      "UPDATE oauth_tokens SET revoked_at = ? WHERE user_id = ?",
    ).bind(new Date().toISOString(), userId),
    env.CATALOG.prepare(
      "UPDATE oauth_grants SET revoked_at = ? WHERE user_id = ?",
    ).bind(new Date().toISOString(), userId),
    env.CATALOG.prepare(
      "UPDATE users SET email = ?, display_name = 'Deleted account', avatar_url = NULL, updated_at = ? WHERE id = ?",
    ).bind(
      `deleted-${await sha256(userId)}@account.invalid`,
      new Date().toISOString(),
      userId,
    ),
    env.CATALOG.prepare(
      "UPDATE account_security SET status = 'deleted' WHERE user_id = ?",
    ).bind(userId),
    invalidationStatement(env, userId),
    auditStatement(env.CATALOG, actorId, "account.deleted", userId),
  ]);
}
export async function accountRoutes(
  request: Request,
  env: NativeEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/v1/account/")) return null;
  const identity = await nativePrincipal(request, env, true);
  const { principal, user } = identity;
  const settings = await installation(env);
  if (
    url.pathname === "/api/v1/account/onboarding" &&
    request.method === "POST"
  ) {
    if (
      !identity.identityVerified ||
      identity.state.status !== "active" ||
      identity.state.recovery_required
    )
      throw new HttpError(
        403,
        "Finish account verification and admission first.",
        "ADMISSION_REQUIRED",
      );
    const body = await json(request);
    const bits: Record<string, number> = { home: 1, board: 2, admin: 4 };
    if (
      typeof body.journey !== "string" ||
      !bits[body.journey] ||
      !["completed", "skipped", "replay"].includes(String(body.status))
    )
      throw new HttpError(400, "Invalid onboarding action.", "INVALID_INPUT");
    if (
      body.journey === "admin" &&
      !["owner", "admin"].includes(identity.state.role ?? "")
    )
      throw new HttpError(
        403,
        "Administrator access is required.",
        "ADMIN_REQUIRED",
      );
    await env.CATALOG.prepare(
      body.status === "replay"
        ? "UPDATE account_security SET onboarding_version = onboarding_version & ? WHERE user_id = ?"
        : "UPDATE account_security SET onboarding_version = onboarding_version | ?, onboarding_dismissed_at = ? WHERE user_id = ?",
    )
      .bind(
        ...(body.status === "replay"
          ? [~bits[body.journey], user.id]
          : [bits[body.journey], new Date().toISOString(), user.id]),
      )
      .run();
    return Response.json({ saved: true });
  }
  if (
    url.pathname === "/api/v1/account/profile" &&
    request.method === "PATCH"
  ) {
    if (!identity.identityVerified || identity.state.recovery_required)
      throw new HttpError(
        403,
        "Verify your identity first.",
        "VERIFICATION_REQUIRED",
      );
    return Response.json({
      user: publicPrincipal(
        await updateProfile(env.CATALOG, principal, await json(request)),
      ),
    });
  }
  if (
    url.pathname === "/api/v1/account/password" &&
    request.method === "POST"
  ) {
    requireFresh(
      principal,
      needsStrong(settings, identity.state, user.twoFactorEnabled),
    );
    if (!identity.identityVerified || identity.state.recovery_required)
      throw new HttpError(
        403,
        "Verify your identity first.",
        "VERIFICATION_REQUIRED",
      );
    const body = await json(request);
    if (typeof body.newPassword !== "string")
      throw new HttpError(400, "Choose a password.", "INVALID_INPUT");
    // setPassword is a server-only library API, so enforce creation policy at
    // this application boundary as well as the public library-route hooks.
    validatePassword(body.newPassword);
    await rejectCompromisedPassword(body.newPassword);
    try {
      await (
        await nativeAuth(env)
      ).api.setPassword({
        headers: request.headers,
        body: { newPassword: body.newPassword },
      });
    } catch (error) {
      if (error instanceof APIError)
        throw new HttpError(
          error.statusCode,
          error.body?.message ?? "The password could not be added.",
          error.body?.code ?? "PASSWORD_NOT_ADDED",
        );
      throw error;
    }
    return Response.json({ saved: true, reauthenticate: true });
  }
  if (request.method === "GET" && url.pathname === "/api/v1/account/security") {
    const [methods, passkeys, sessions, events] = await env.CATALOG.batch<
      Record<string, unknown>
    >([
      env.CATALOG.prepare(
        "SELECT id, providerId, createdAt FROM auth_accounts WHERE userId = ? ORDER BY createdAt",
      ).bind(user.id),
      env.CATALOG.prepare(
        "SELECT id, name, deviceType, backedUp, createdAt FROM auth_passkeys WHERE userId = ? ORDER BY createdAt",
      ).bind(user.id),
      env.CATALOG.prepare(
        "SELECT id, createdAt, updatedAt, expiresAt, absoluteExpiresAt, userAgent, assurance FROM auth_sessions WHERE userId = ? AND expiresAt > ? AND absoluteExpiresAt > ? ORDER BY updatedAt DESC LIMIT 100",
      ).bind(user.id, new Date().toISOString(), new Date().toISOString()),
      env.CATALOG.prepare(
        "SELECT id, action, outcome, created_at FROM security_audit WHERE actor_id = ? OR target_id = ? ORDER BY created_at DESC LIMIT 30",
      ).bind(user.id, user.id),
    ]);
    return Response.json({
      user: publicPrincipal(principal),
      role: identity.state.role,
      status: identity.state.status,
      verified: identity.identityVerified,
      localUsername: identity.localUsername,
      emailVerified: user.emailVerified,
      twoFactorEnabled: user.twoFactorEnabled,
      recoveryRequired: Boolean(identity.state.recovery_required),
      methods: methods.results,
      passkeys: passkeys.results,
      sessions: sessions.results.map((row) => ({
        ...row,
        current: row.id === principal.sessionId,
      })),
      events: events.results,
    });
  }
  if (url.pathname === "/api/v1/account/step-up" && request.method === "POST") {
    await limit(env, "step-up", user.id, 6, 300);
    const body = await json(request);
    const credential = await env.CATALOG.prepare(
      "SELECT password FROM auth_accounts WHERE userId = ? AND providerId = 'credential'",
    )
      .bind(user.id)
      .first<{ password: string }>();
    if (
      typeof body.password !== "string" ||
      !credential ||
      !(await verifyPassword({
        hash: credential.password,
        password: body.password,
      }))
    )
      throw new HttpError(
        401,
        "The password could not be confirmed.",
        "INVALID_PASSWORD",
      );
    await env.CATALOG.prepare(
      "UPDATE auth_sessions SET authenticatedAt = ?, assurance = ? WHERE id = ?",
    )
      .bind(
        new Date().toISOString(),
        needsStrong(settings, identity.state, user.twoFactorEnabled)
          ? "weak"
          : identity.policy.assurance,
        principal.sessionId,
      )
      .run();
    return Response.json({
      confirmed: true,
      needsMfa: needsStrong(settings, identity.state, user.twoFactorEnabled),
    });
  }
  const sessionMatch = url.pathname.match(
    /^\/api\/v1\/account\/sessions\/([^/]+)$/u,
  );
  if (sessionMatch && request.method === "DELETE") {
    if (decodeURIComponent(sessionMatch[1]) !== principal.sessionId)
      requireFresh(
        principal,
        needsStrong(settings, identity.state, user.twoFactorEnabled),
      );
    await env.CATALOG.batch([
      env.CATALOG.prepare(
        "DELETE FROM auth_sessions WHERE id = ? AND userId = ?",
      ).bind(decodeURIComponent(sessionMatch[1]), user.id),
      invalidationStatement(env, user.id),
      auditStatement(
        env.CATALOG,
        user.id,
        "session.revoked",
        decodeURIComponent(sessionMatch[1]),
      ),
    ]);
    return Response.json({ revoked: true });
  }
  if (
    request.method === "POST" &&
    ["/api/v1/account/logout-all", "/api/v1/account/secure"].includes(
      url.pathname,
    )
  ) {
    requireFresh(
      principal,
      needsStrong(settings, identity.state, user.twoFactorEnabled),
    );
    await revokeIdentity(
      env,
      user.id,
      user.id,
      url.pathname.endsWith("/secure")
        ? "account.secured"
        : "session.all_revoked",
      url.pathname.endsWith("/secure"),
    );
    return Response.json({ revoked: true });
  }
  if (
    url.pathname === "/api/v1/account/recovery-complete" &&
    request.method === "POST"
  ) {
    requireFresh(principal, false);
    if (!identity.state.recovery_required)
      throw new HttpError(
        409,
        "No factor recovery is in progress.",
        "RECOVERY_NOT_REQUIRED",
      );
    const replaced = await env.CATALOG.prepare(
      `SELECT 1 FROM account_security s WHERE s.user_id = ? AND (EXISTS(SELECT 1 FROM auth_passkeys p WHERE p.userId = s.user_id AND p.createdAt > s.recovery_started_at) OR EXISTS(SELECT 1 FROM auth_two_factors t WHERE t.userId = s.user_id AND t.verified = 1 AND t.enrolled_at > s.recovery_started_at))`,
    )
      .bind(user.id)
      .first();
    if (!replaced)
      throw new HttpError(
        409,
        "Enroll and verify a replacement factor first.",
        "REPLACEMENT_FACTOR_REQUIRED",
      );
    const at = new Date().toISOString();
    await env.CATALOG.batch([
      env.CATALOG.prepare(
        "DELETE FROM auth_passkeys WHERE userId = ? AND createdAt <= (SELECT recovery_started_at FROM account_security WHERE user_id = ? AND recovery_required = 1)",
      ).bind(user.id, user.id),
      env.CATALOG.prepare(
        "DELETE FROM auth_two_factors WHERE userId = ? AND (enrolled_at IS NULL OR enrolled_at <= (SELECT recovery_started_at FROM account_security WHERE user_id = ? AND recovery_required = 1))",
      ).bind(user.id, user.id),
      env.CATALOG.prepare(
        "UPDATE auth_users SET twoFactorEnabled = EXISTS(SELECT 1 FROM auth_two_factors WHERE userId = ? AND verified = 1) WHERE id = ?",
      ).bind(user.id, user.id),
      env.CATALOG.prepare("DELETE FROM auth_sessions WHERE userId = ?").bind(
        user.id,
      ),
      env.CATALOG.prepare(
        "UPDATE oauth_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
      ).bind(at, user.id),
      env.CATALOG.prepare(
        "UPDATE oauth_grants SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
      ).bind(at, user.id),
      env.CATALOG.prepare(
        "UPDATE account_security SET recovery_required = 0, recovery_started_at = NULL, auth_version = auth_version + 1, updated_at = ? WHERE user_id = ? AND recovery_required = 1",
      ).bind(at, user.id),
      invalidationStatement(env, user.id),
      auditStatement(env.CATALOG, user.id, "account.factor_recovered", user.id),
    ]);
    return Response.json({ recovered: true, signInAgain: true });
  }
  if (url.pathname === "/api/v1/account/export" && request.method === "GET") {
    requireFresh(
      principal,
      needsStrong(settings, identity.state, user.twoFactorEnabled),
    );
    const grants = await env.CATALOG.prepare(
      "SELECT resource_type, resource_id, role, expires_at FROM resource_grants WHERE user_id = ? ORDER BY resource_type, resource_id LIMIT 10001",
    )
      .bind(user.id)
      .all();
    if (grants.results.length > 10000)
      throw new HttpError(
        413,
        "Ask the operator for a full export of this large account.",
        "EXPORT_LIMIT",
      );
    return Response.json(
      {
        format: "canvas/account-export",
        version: 1,
        createdAt: new Date().toISOString(),
        user: publicPrincipal(principal),
        grants: grants.results,
      },
      {
        headers: {
          "Content-Disposition": 'attachment; filename="canvas-account.json"',
        },
      },
    );
  }
  if (
    url.pathname === "/api/v1/account/local-recovery-key" &&
    request.method === "POST"
  ) {
    if (
      !identity.localUsername ||
      identity.state.status !== "active" ||
      identity.state.recovery_required
    )
      throw new HttpError(
        403,
        "Finish account recovery before replacing your key.",
        "ADMISSION_REQUIRED",
      );
    requireFresh(
      principal,
      needsStrong(settings, identity.state, user.twoFactorEnabled),
    );
    await limit(env, "local-recovery-key", user.id, 5, 3600);
    const recoveryCode = randomToken(32);
    await env.CATALOG.batch([
      env.CATALOG.prepare(
        "UPDATE local_accounts SET recovery_hash=?,recovery_claim=NULL WHERE user_id=?",
      ).bind(await sha256(recoveryCode), user.id),
      auditStatement(
        env.CATALOG,
        user.id,
        "account.recovery_key_replaced",
        user.id,
      ),
    ]);
    return Response.json(
      { recoveryCode },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (url.pathname === "/api/v1/account/delete" && request.method === "POST") {
    requireFresh(
      principal,
      needsStrong(settings, identity.state, user.twoFactorEnabled),
    );
    const body = await json(request);
    if (body.confirm !== (identity.localUsername ?? user.email))
      throw new HttpError(
        400,
        "Type your username or email to confirm account deletion.",
        "CONFIRMATION_REQUIRED",
      );
    await tombstoneAccount(env, user.id, user.id);
    return Response.json({ deleted: true });
  }
  throw new HttpError(404, "Account action not found.", "NOT_FOUND");
}
