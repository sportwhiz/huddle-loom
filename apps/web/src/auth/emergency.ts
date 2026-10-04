import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { BetterAuthPlugin } from "better-auth";
import type { NativeEnv } from "./types";
import { randomToken, sha256 } from "../security/primitives";
import { invalidationStatement } from "../mail/outbox";
import { auditStatement } from "../security/audit";

// Issuance exists only in the deployment CLI. This endpoint accepts an expiring,
// single-use proof and grants a restricted factor-replacement session.
export function operatorRecovery(env: NativeEnv): BetterAuthPlugin {
  return {
    id: "canvas-operator-recovery",
    endpoints: {
      operatorRecovery: createAuthEndpoint(
        "/operator-recovery",
        { method: "POST" },
        async (ctx) => {
          const token = ctx.body?.token;
          if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(token))
            throw new APIError("BAD_REQUEST", {
              message: "This recovery link is invalid or expired.",
            });
          const hash = await sha256(token),
            claim = randomToken(18),
            at = new Date().toISOString();
          const candidate = await env.CATALOG.prepare(
            "SELECT e.user_id FROM emergency_recovery e JOIN installation i ON i.owner_id = e.user_id AND i.state = 'ready' JOIN auth_users u ON u.id = e.user_id AND (u.emailVerified = 1 OR EXISTS(SELECT 1 FROM local_accounts WHERE user_id=u.id)) JOIN account_security s ON s.user_id = u.id AND s.status = 'active' WHERE e.token_hash = ? AND e.used_at IS NULL AND e.expires_at > ?",
          )
            .bind(hash, Date.now())
            .first<{ user_id: string }>();
          if (!candidate)
            throw new APIError("BAD_REQUEST", {
              message: "This recovery link is invalid or expired.",
            });
          const userId = candidate.user_id;
          const condition =
            "EXISTS(SELECT 1 FROM emergency_recovery WHERE token_hash = ? AND consumption_id = ?)";
          const [consumed] = await env.CATALOG.batch([
            env.CATALOG.prepare(
              "UPDATE emergency_recovery SET used_at = ?, consumption_id = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? AND user_id = (SELECT i.owner_id FROM installation i JOIN auth_users u ON u.id = i.owner_id AND (u.emailVerified = 1 OR EXISTS(SELECT 1 FROM local_accounts WHERE user_id=u.id)) JOIN account_security s ON s.user_id = u.id AND s.status = 'active' WHERE i.state = 'ready') RETURNING user_id",
            ).bind(Date.now(), claim, hash, Date.now()),
            env.CATALOG.prepare(
              `UPDATE account_security SET recovery_required = 1, recovery_started_at = ?, auth_version = auth_version + 1, updated_at = ? WHERE user_id = ? AND ${condition}`,
            ).bind(at, at, userId, hash, claim),
            env.CATALOG.prepare(
              `DELETE FROM auth_sessions WHERE userId = ? AND ${condition}`,
            ).bind(userId, hash, claim),
            env.CATALOG.prepare(
              `UPDATE oauth_grants SET revoked_at = ? WHERE user_id = ? AND ${condition}`,
            ).bind(at, userId, hash, claim),
            env.CATALOG.prepare(
              `UPDATE oauth_tokens SET revoked_at = ? WHERE user_id = ? AND ${condition}`,
            ).bind(at, userId, hash, claim),
          ]);
          if (!consumed.meta.changes)
            throw new APIError("BAD_REQUEST", {
              message:
                "This recovery link was already used. Request a new link from the operator.",
            });
          await env.CATALOG.batch([
            invalidationStatement(env, userId),
            auditStatement(
              env.CATALOG,
              "operator",
              "account.emergency_recovery_started",
              userId,
            ),
          ]);
          const user = await ctx.context.internalAdapter.findUserById(userId);
          if (!user)
            throw new APIError("BAD_REQUEST", {
              message: "The owner account is unavailable.",
            });
          const session =
            await ctx.context.internalAdapter.createSession(userId);
          await env.CATALOG.prepare(
            "UPDATE auth_sessions SET assurance = 'recovery' WHERE id = ?",
          )
            .bind(session.id)
            .run();
          await setSessionCookie(ctx, {
            session: { ...session, assurance: "recovery" },
            user,
          });
          return ctx.json({ recoveryRequired: true });
        },
      ),
    },
  };
}
