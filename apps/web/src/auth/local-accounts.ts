import { starterStatements } from "./content";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { BetterAuthPlugin } from "better-auth";
import type { NativeEnv } from "./types";
import { bootstrapAuthorized } from "./policy";
import { derivePasswordHash, hashPassword, verifyPassword } from "./password";
import { randomToken, sha256 } from "../security/primitives";
import { HttpError } from "../security/errors";

export function normalizeUsername(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/u.test(value)
  )
    throw new HttpError(
      400,
      "Use 3–32 letters, numbers, dots, underscores or hyphens for your username.",
      "INVALID_USERNAME",
    );
  return value.toLowerCase();
}

// Local identities are explicitly separate from email identities. The reserved
// .invalid address satisfies the library schema; it is NEVER marked verified.
export function localAccounts(env: NativeEnv): BetterAuthPlugin {
  return {
    id: "huddle-loom-local-accounts",
    endpoints: {
      createLocalOwner: createAuthEndpoint(
        "/setup/local",
        { method: "POST" },
        async (ctx) => {
          const token = ctx.body?.invitation;
          const invitation =
            typeof token === "string" && /^[A-Za-z0-9_-]{43}$/u.test(token)
              ? await sha256(token)
              : null;
          if (token !== undefined && !invitation)
            throw new APIError("BAD_REQUEST", {
              message: "This invitation is invalid.",
            });
          const setup = !invitation;
          if (setup && !(await bootstrapAuthorized(ctx.request, env)))
            throw new APIError("FORBIDDEN", {
              message: "Enter your setup password first.",
            });
          const condition = setup
            ? "EXISTS(SELECT 1 FROM installation WHERE id='instance' AND state='unclaimed' AND setup_user_id IS NULL)"
            : "EXISTS(SELECT 1 FROM local_invitations l JOIN installation i ON i.id='instance' AND i.state='ready' WHERE EXISTS(SELECT 1 FROM instance_memberships creator JOIN account_security security ON security.user_id=creator.user_id WHERE creator.user_id=l.created_by AND creator.role IN ('owner','admin') AND security.status='active' AND security.recovery_required=0) AND l.token_hash=? AND l.expires_at>? AND l.accepted_by IS NULL AND l.revoked_at IS NULL AND (SELECT COUNT(*) FROM instance_memberships m WHERE (l.role='guest' AND m.role='guest') OR (l.role<>'guest' AND m.role<>'guest')) < CASE WHEN l.role='guest' THEN i.guest_limit ELSE i.member_limit END)";
          const conditionValues = setup ? [] : [invitation!, Date.now()];
          const username = normalizeUsername(ctx.body?.username);
          const name =
            typeof ctx.body?.name === "string" ? ctx.body.name.trim() : "";
          if (
            !name ||
            name.length > 80 ||
            typeof ctx.body?.password !== "string"
          )
            throw new APIError("BAD_REQUEST", {
              message: "Enter your name and a password.",
            });
          if (
            await env.CATALOG.prepare(
              "SELECT 1 FROM local_accounts WHERE username=?",
            )
              .bind(username)
              .first()
          )
            throw new APIError("CONFLICT", {
              message: "That username is already in use. Choose another.",
            });
          const password = await hashPassword(ctx.body.password);
          const id = `user:${crypto.randomUUID()}`,
            at = new Date().toISOString();
          const recoveryCode = randomToken(32);
          // Claim and all identity rows are one transaction. A race or uniqueness
          // conflict rolls back the entire account, including the owner reservation.
          const results = await env.CATALOG.batch([
            env.CATALOG.prepare(
              `INSERT INTO auth_users(id,name,email,emailVerified,createdAt,updatedAt) SELECT ?,?,?,0,?,? WHERE ${condition}`,
            ).bind(
              id,
              name,
              `${crypto.randomUUID()}@local.huddleloom.invalid`,
              at,
              at,
              ...conditionValues,
            ),
            env.CATALOG.prepare(
              "INSERT INTO users(id,issuer,subject,email,display_name,color,created_at,updated_at) SELECT id,'urn:canvas:account',id,email,name,'#3D4A73',?,? FROM auth_users WHERE id = ?",
            ).bind(at, at, id),
            env.CATALOG.prepare(
              "INSERT INTO account_security(user_id,status,auth_version,recovery_required,created_at,updated_at) SELECT id,'pending_verification',1,0,?,? FROM auth_users WHERE id = ?",
            ).bind(at, at, id),
            env.CATALOG.prepare(
              "INSERT INTO local_accounts(user_id,username,recovery_hash) SELECT id,?,? FROM auth_users WHERE id = ?",
            ).bind(username, await sha256(recoveryCode), id),
            env.CATALOG.prepare(
              "INSERT INTO auth_accounts(id,accountId,providerId,userId,password,createdAt,updatedAt) SELECT ?,id,'credential',id,?,?,? FROM auth_users WHERE id = ?",
            ).bind(`account:${crypto.randomUUID()}`, password, at, at, id),
            ...(setup
              ? [
                  env.CATALOG.prepare(
                    "UPDATE installation SET state='configuring',setup_user_id=?,version=version+1 WHERE id='instance' AND state='unclaimed' AND setup_user_id IS NULL AND EXISTS(SELECT 1 FROM auth_users WHERE id=?)",
                  ).bind(id, id),
                ]
              : [
                  env.CATALOG.prepare(
                    "INSERT INTO instance_memberships(user_id,role,created_at) SELECT ?,role,? FROM local_invitations WHERE token_hash=? AND EXISTS(SELECT 1 FROM auth_users WHERE id=?)",
                  ).bind(id, at, invitation, id),
                  env.CATALOG.prepare(
                    "UPDATE account_security SET status='active',admitted_at=? WHERE user_id=?",
                  ).bind(at, id),
                  env.CATALOG.prepare(
                    "UPDATE local_invitations SET accepted_by=? WHERE token_hash=? AND EXISTS(SELECT 1 FROM auth_users WHERE id=?)",
                  ).bind(id, invitation, id),
                  ...starterStatements(env.CATALOG, id),
                ]),
          ]);
          if (!results[0].meta.changes)
            throw new APIError("CONFLICT", {
              message: setup
                ? "An owner account already exists. Sign in to continue setup."
                : "This invitation is unavailable or the Studio has reached its account limit.",
            });
          const user = (await ctx.context.internalAdapter.findUserById(id))!;
          const session = await ctx.context.internalAdapter.createSession(id);
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ created: true, recoveryCode });
        },
      ),
      signInLocal: createAuthEndpoint(
        "/sign-in/local",
        { method: "POST" },
        async (ctx) => {
          const username = normalizeUsername(ctx.body?.username);
          const password = ctx.body?.password;
          if (
            typeof password !== "string" ||
            new TextEncoder().encode(password).length > 512
          )
            throw new APIError("BAD_REQUEST", {
              message: "Enter your password.",
            });
          const row = await env.CATALOG.prepare(
            "SELECT a.userId, a.password FROM auth_accounts a JOIN local_accounts l ON l.user_id = a.userId JOIN account_security s ON s.user_id = a.userId WHERE l.username = ? AND a.providerId = 'credential' AND s.status NOT IN ('suspended','deleted','deletion_pending')",
          )
            .bind(username)
            .first<{ userId: string; password: string }>();
          const valid = row
            ? await verifyPassword({ hash: row.password, password })
            : (await derivePasswordHash(password), false);
          if (!row || !valid)
            throw new APIError("UNAUTHORIZED", {
              message: "The username or password is incorrect.",
            });
          const user = (await ctx.context.internalAdapter.findUserById(
            row.userId,
          ))!;
          const session = await ctx.context.internalAdapter.createSession(
            user.id,
          );
          // This session has weak assurance. The normal admission policy still
          // requires the owner's passkey/TOTP before any board or admin access.
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ success: true });
        },
      ),
      recoverLocal: createAuthEndpoint(
        "/recover/local",
        { method: "POST" },
        async (ctx) => {
          const username = normalizeUsername(ctx.body?.username);
          const code = ctx.body?.code;
          if (typeof code !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(code))
            throw new APIError("BAD_REQUEST", {
              message:
                "Enter the recovery key saved when you created your account.",
            });
          if (typeof ctx.body?.newPassword !== "string")
            throw new APIError("BAD_REQUEST", {
              message: "Choose a new password.",
            });
          const password = await hashPassword(ctx.body.newPassword);
          const recoveryCode = randomToken(32);
          const hash = await sha256(code),
            marker = randomToken(18);
          const at = new Date().toISOString();
          const condition =
            "user_id IN (SELECT user_id FROM local_accounts WHERE recovery_claim = ?)";
          const [claimed] = await env.CATALOG.batch([
            env.CATALOG.prepare(
              "UPDATE local_accounts SET recovery_hash=?,recovery_claim=? WHERE username=? AND recovery_hash=? AND user_id IN (SELECT user_id FROM account_security WHERE status NOT IN ('suspended','deleted','deletion_pending')) RETURNING user_id",
            ).bind(await sha256(recoveryCode), marker, username, hash),
            // A local account may have unlinked its password after adding a
            // different sign-in method. Restore it only for the claimed key,
            // in the same transaction that consumes that key and revokes access.
            env.CATALOG.prepare(
              "INSERT INTO auth_accounts(id,accountId,providerId,userId,password,createdAt,updatedAt) SELECT ?,user_id,'credential',user_id,?,?,? FROM local_accounts WHERE recovery_claim=? ON CONFLICT(providerId,accountId) DO UPDATE SET password=excluded.password,updatedAt=excluded.updatedAt",
            ).bind(`account:${crypto.randomUUID()}`, password, at, at, marker),
            env.CATALOG.prepare(
              `UPDATE account_security SET recovery_required=1,recovery_started_at=?,auth_version=auth_version+1,updated_at=? WHERE ${condition}`,
            ).bind(at, at, marker),
            env.CATALOG.prepare(
              "DELETE FROM auth_sessions WHERE userId IN (SELECT user_id FROM local_accounts WHERE recovery_claim=?)",
            ).bind(marker),
            env.CATALOG.prepare(
              "DELETE FROM auth_two_factors WHERE userId IN (SELECT user_id FROM local_accounts WHERE recovery_claim=?)",
            ).bind(marker),
            env.CATALOG.prepare(
              "DELETE FROM auth_passkeys WHERE userId IN (SELECT user_id FROM local_accounts WHERE recovery_claim=?)",
            ).bind(marker),
            env.CATALOG.prepare(
              "UPDATE auth_users SET twoFactorEnabled=0 WHERE id IN (SELECT user_id FROM local_accounts WHERE recovery_claim=?)",
            ).bind(marker),
            env.CATALOG.prepare(
              `UPDATE oauth_grants SET revoked_at=? WHERE ${condition}`,
            ).bind(at, marker),
            env.CATALOG.prepare(
              `UPDATE oauth_tokens SET revoked_at=? WHERE ${condition}`,
            ).bind(at, marker),
          ]);
          const id = (claimed.results[0] as { user_id?: string } | undefined)
            ?.user_id;
          if (!id)
            throw new APIError("UNAUTHORIZED", {
              message: "The username or recovery key is incorrect.",
            });
          const user = (await ctx.context.internalAdapter.findUserById(id))!;
          const session = await ctx.context.internalAdapter.createSession(id);
          await env.CATALOG.prepare(
            "UPDATE auth_sessions SET assurance='recovery' WHERE id=?",
          )
            .bind(session.id)
            .run();
          await setSessionCookie(ctx, {
            session: { ...session, assurance: "recovery" },
            user,
          });
          return ctx.json({ recoveryRequired: true, recoveryCode });
        },
      ),
    },
  };
}
