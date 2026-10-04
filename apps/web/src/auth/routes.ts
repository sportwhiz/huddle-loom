import { verifyJWT } from "better-auth/crypto";
import { captureIntent, resolveIntent } from "./intents";
import { mayRegister } from "./policy";
import { queueMail } from "../mail/outbox";
import { text } from "../security/primitives";
import { hashPassword } from "./password";
import { starterStatements } from "./content";
import type { NativeEnv } from "./types";
import { nativeAuth, configuredProviders } from "./library";
import {
  bootstrapAuthorized,
  installation,
  needsStrong,
  publicPrincipal,
  requireFreshForInstallation,
} from "./policy";
import {
  nativePrincipal,
  readNativeSession,
  cookiesFromResponse,
} from "./session";
import {
  canonicalOrigin,
  checkCanonicalRequest,
  nativeConfigured,
} from "../security/config";
import {
  equal,
  json,
  randomToken,
  safeReturnTo,
  sha256,
  boundedBody,
} from "../security/primitives";
import { csrfBootstrap, requireCsrf } from "../security/request";
import { clientIp, limit } from "../security/limits";
import { audit, auditStatement } from "../security/audit";
import { invalidationStatement, mailReady } from "../mail/outbox";
import { currentEmailProof } from "./email-proof";
import {
  clearTotpFailures,
  rejectedWrongCode,
  releaseTotpAttempt,
  reserveTotpAttempt,
} from "./totp-lockout";
import { HttpError } from "../security/errors";
import { methodChangeGuard } from "./method-change";

const publicPaths = new Set([
  "/setup/local",
  "/sign-in/local",
  "/recover/local",
  "/operator-recovery",
  "/sign-up/email",
  "/sign-in/email",
  "/sign-in/social",
  "/sign-in/access",
  "/sign-in/magic-link",
  "/request-password-reset",
  "/reset-password",
  "/send-verification-email",
  "/sign-out",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/passkey/generate-authenticate-options",
  "/passkey/verify-authentication",
]);
const privatePaths = new Set([
  "/change-password",
  "/change-email",
  "/link-social",
  "/unlink-account",
  "/list-accounts",
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/list-user-passkeys",
  "/passkey/update-passkey",
  "/passkey/delete-passkey",
]);

async function libraryRoute(request: Request, env: NativeEnv) {
  const path = new URL(request.url).pathname
    .slice("/api/auth".length)
    .replace(/\/$/u, "");
  const callback = /^\/callback\/[a-zA-Z0-9_-]{1,80}$/u.test(path);
  if (!publicPaths.has(path) && !privatePaths.has(path) && !callback)
    throw new HttpError(404, "Authentication action not found.", "NOT_FOUND");
  if (
    request.method === "GET" &&
    !callback &&
    ![
      "/passkey/generate-authenticate-options",
      "/passkey/generate-register-options",
      "/passkey/list-user-passkeys",
      "/list-accounts",
    ].includes(path)
  )
    throw new HttpError(
      405,
      "Use the confirmation screen for this action.",
      "METHOD_NOT_ALLOWED",
    );
  if (request.method === "POST" && !callback) await requireCsrf(request, env);
  await limit(env, "auth-ip", clientIp(request), 100, 60);
  let body: Record<string, unknown> = {};
  if (request.method === "POST" && !callback) {
    body = await json(request);
    for (const key of [
      "callbackURL",
      "newUserCallbackURL",
      "errorCallbackURL",
      "redirectTo",
    ])
      if (body[key] !== undefined) {
        if (typeof body[key] !== "string")
          throw new HttpError(
            400,
            "Invalid return address.",
            "INVALID_REDIRECT",
          );
        const destination = new URL(body[key] as string, canonicalOrigin(env));
        if (destination.origin !== canonicalOrigin(env))
          throw new HttpError(
            400,
            "Use an application return address.",
            "INVALID_REDIRECT",
          );
        body[key] =
          `${canonicalOrigin(env)}${safeReturnTo(destination.pathname + destination.search + destination.hash)}`;
      }
    if (body.trustDevice === true)
      throw new HttpError(
        400,
        "Separate trusted-device bypasses are disabled.",
        "TRUST_DEVICE_DISABLED",
      );
    if (typeof body.email === "string") {
      const address = body.email.trim().toLowerCase();
      if (path === "/sign-in/email")
        await limit(env, "password-identifier", address, 10, 600);
      if (
        path === "/request-password-reset" ||
        path === "/send-verification-email" ||
        path === "/sign-in/magic-link"
      )
        await limit(env, "mail-identifier", address, 3, 3600);
    }
    if (path === "/sign-in/magic-link" && !(await installation(env)).magic_link)
      throw new HttpError(403, "Magic links are disabled.", "METHOD_DISABLED");
    if (path === "/two-factor/verify-backup-code") {
      if (typeof body.code !== "string" || body.code.length > 128)
        throw new HttpError(400, "Enter a recovery code.", "INVALID_INPUT");
      body.code = `r1:${await sha256(body.code.trim())}`;
      body.disableSession = false;
    }
    const headers = new Headers(request.headers);
    headers.set("Content-Type", "application/json");
    request = new Request(request, { body: JSON.stringify(body), headers });
  }
  if (callback && request.body) {
    const bytes = await boundedBody(request);
    request = new Request(request, { body: bytes });
  }
  if (
    path === "/sign-up/email" &&
    typeof body.email === "string" &&
    !(await mayRegister(env, body.email.trim().toLowerCase(), request))
  ) {
    if (typeof body.password !== "string")
      throw new HttpError(400, "Enter a password.", "INVALID_INPUT");
    // Apply the same screening and KDF work as accepted/duplicate signup. An
    // invitation must not be discoverable by measuring a fast rejection.
    await hashPassword(body.password);
    return Response.json(
      {
        message:
          "If this address can be registered, a verification message will arrive.",
      },
      { status: 202 },
    );
  }
  if (["/setup/local", "/sign-in/local", "/recover/local"].includes(path)) {
    await limit(env, "local-ip", clientIp(request), 10, 900);
    await limit(
      env,
      "local-username",
      String(body.username).toLowerCase().slice(0, 100),
      10,
      900,
    );
  }
  if (
    !mailReady(env) &&
    [
      "/sign-up/email",
      "/request-password-reset",
      "/send-verification-email",
      "/sign-in/magic-link",
    ].includes(path)
  )
    throw new HttpError(
      409,
      "Email delivery is not enabled. Use your username, passkey or recovery key.",
      "MAIL_NOT_CONFIGURED",
    );
  const before = await readNativeSession(request, env);
  if (privatePaths.has(path)) {
    const identity = before ?? (await nativePrincipal(request, env, true));
    const settings = await installation(env);
    if (!identity.identityVerified)
      throw new HttpError(
        403,
        "Verify your email address first.",
        "VERIFICATION_REQUIRED",
      );
    const enrollment = [
      "/two-factor/enable",
      "/passkey/generate-register-options",
      "/passkey/verify-registration",
    ].includes(path);
    const existingFactor =
      identity.user.twoFactorEnabled ||
      (await env.CATALOG.prepare(
        "SELECT id FROM auth_passkeys WHERE userId = ? LIMIT 1",
      )
        .bind(identity.user.id)
        .first());
    if (identity.state.recovery_required && !enrollment)
      throw new HttpError(
        403,
        "Replace your lost factor first.",
        "RECOVERY_REQUIRED",
      );
    // Viewing linked login methods does not change account security.
    if (!["/list-accounts", "/passkey/list-user-passkeys"].includes(path))
      await requireFreshForInstallation(
        env,
        identity.principal,
        Boolean(existingFactor) &&
          !identity.state.recovery_required &&
          needsStrong(settings, identity.state, Boolean(identity.user.twoFactorEnabled)),
      );
    if (path === "/passkey/delete-passkey") {
      const count = await env.CATALOG.prepare(
        "SELECT COUNT(*) AS n FROM auth_passkeys WHERE userId = ?",
      )
        .bind(identity.user.id)
        .first<{ n: number }>();
      if (
        Number(count?.n) <= 1 &&
        !identity.user.twoFactorEnabled &&
        needsStrong(settings, identity.state, false)
      )
        throw new HttpError(
          409,
          "Add another strong sign-in method before removing this passkey.",
          "LAST_FACTOR",
        );
      const methods = await env.CATALOG.prepare(
        "SELECT COUNT(*) AS n FROM auth_accounts WHERE userId = ?",
      )
        .bind(identity.user.id)
        .first<{ n: number }>();
      if (Number(count?.n) <= 1 && !Number(methods?.n))
        throw new HttpError(
          409,
          "Keep at least one sign-in method.",
          "LAST_METHOD",
        );
    }
    if (
      path === "/two-factor/disable" &&
      needsStrong(settings, identity.state, false) &&
      !(await env.CATALOG.prepare(
        "SELECT id FROM auth_passkeys WHERE userId = ? LIMIT 1",
      )
        .bind(identity.user.id)
        .first())
    )
      throw new HttpError(
        409,
        "Add a passkey before disabling your authenticator.",
        "LAST_FACTOR",
      );
    if (path === "/unlink-account" || path === "/passkey/delete-passkey") {
      const account = path === "/unlink-account";
      const requestedId = text(
        account ? body.accountId : body.id,
        account ? "Provider account" : "Passkey",
        200,
      );
      const row = await env.CATALOG.prepare(
        account
          ? "SELECT id FROM auth_accounts WHERE userId = ? AND id = ?"
          : "SELECT id FROM auth_passkeys WHERE userId = ? AND id = ?",
      )
        .bind(identity.user.id, requestedId)
        .first<{ id: string }>();
      if (!row)
        throw new HttpError(404, "Sign-in method not found.", "NOT_FOUND");
      const guard = methodChangeGuard(
        env,
        identity.user.id,
        account ? { account: row.id } : { passkey: row.id },
      );
      await env.CATALOG.batch([
        guard.before,
        env.CATALOG.prepare(
          account
            ? "DELETE FROM auth_accounts WHERE id = ? AND userId = ?"
            : "DELETE FROM auth_passkeys WHERE id = ? AND userId = ?",
        ).bind(row.id, identity.user.id),
        env.CATALOG.prepare(
          "DELETE FROM auth_sessions WHERE userId = ? AND id <> ?",
        ).bind(identity.user.id, identity.session.id),
        invalidationStatement(env, identity.user.id),
        auditStatement(
          env.CATALOG,
          identity.user.id,
          `auth${path.replaceAll("/", ".")}`,
          identity.user.id,
        ),
        guard.after,
      ]);
      return Response.json({ status: true });
    }
  }
  // Codes checked against an existing session share the sign-in lockout.
  const lockoutUser =
    before &&
    (path === "/two-factor/verify-totp" ||
      path === "/two-factor/verify-backup-code")
      ? before.user.id
      : null;
  if (lockoutUser) await reserveTotpAttempt(env.CATALOG, lockoutUser);
  const response = await (await nativeAuth(env)).handler(request);
  // Only a wrong code counts. Rate limits and other rejections give it back.
  if (lockoutUser && !response.ok && !(await rejectedWrongCode(response)))
    await releaseTotpAttempt(env.CATALOG, lockoutUser);
  if (response.ok || response.status === 302) {
    const after = await readNativeSession(
      cookiesFromResponse(request, response),
      env,
    );
    if (after && path === "/two-factor/verify-totp") {
      const digest = await sha256(String(body.code));
      const changed = await env.CATALOG.prepare(
        "INSERT INTO mfa_replay (user_id, code_hash, expires_at) VALUES (?, ?, ?) ON CONFLICT(user_id, code_hash) DO UPDATE SET expires_at = excluded.expires_at WHERE expires_at < ? RETURNING user_id",
      )
        .bind(after.user.id, digest, Date.now() + 90_000, Date.now())
        .first();
      if (!changed) {
        if (!before || after.session.id !== before.session.id)
          await env.CATALOG.prepare("DELETE FROM auth_sessions WHERE id = ?")
            .bind(after.session.id)
            .run();
        throw new HttpError(
          400,
          "This code was already used. Wait for the next code.",
          "MFA_REPLAY",
        );
      }
      await env.CATALOG.prepare(
        "UPDATE auth_sessions SET assurance = 'strong', authenticatedAt = ? WHERE id = ?",
      )
        .bind(new Date().toISOString(), after.session.id)
        .run();
      await clearTotpFailures(env.CATALOG, after.user.id);
    }
    if (after && path === "/passkey/verify-authentication")
      await env.CATALOG.prepare(
        "UPDATE auth_sessions SET assurance = 'strong', authenticatedAt = ? WHERE id = ?",
      )
        .bind(new Date().toISOString(), after.session.id)
        .run();
    if (after && path === "/two-factor/verify-backup-code")
      await env.CATALOG.batch([
        env.CATALOG.prepare(
          "UPDATE account_security SET recovery_required = 1, recovery_started_at = ? WHERE user_id = ?",
        ).bind(new Date().toISOString(), after.user.id),
        env.CATALOG.prepare(
          "UPDATE auth_sessions SET assurance = 'recovery' WHERE id = ?",
        ).bind(after.session.id),
        // A used backup code starts factor replacement. Retire the old factors
        // immediately so enrollment can create a new authenticator safely.
        env.CATALOG.prepare("DELETE FROM auth_two_factors WHERE userId=?").bind(
          after.user.id,
        ),
        env.CATALOG.prepare("DELETE FROM auth_passkeys WHERE userId=?").bind(
          after.user.id,
        ),
        env.CATALOG.prepare(
          "UPDATE auth_users SET twoFactorEnabled=0 WHERE id=?",
        ).bind(after.user.id),
        env.CATALOG.prepare(
          "DELETE FROM auth_sessions WHERE userId = ? AND id <> ?",
        ).bind(after.user.id, after.session.id),
        env.CATALOG.prepare(
          "UPDATE oauth_grants SET revoked_at = ? WHERE user_id = ?",
        ).bind(new Date().toISOString(), after.user.id),
        env.CATALOG.prepare(
          "UPDATE oauth_tokens SET revoked_at = ? WHERE user_id = ?",
        ).bind(new Date().toISOString(), after.user.id),
        invalidationStatement(env, after.user.id),
        auditStatement(
          env.CATALOG,
          after.user.id,
          "account.recovery_code_used",
          after.user.id,
        ),
      ]);
    const actor = after?.user.id ?? before?.user.id ?? null;
    if (actor && path === "/two-factor/enable")
      await env.CATALOG.prepare(
        "UPDATE auth_two_factors SET enrolled_at = ? WHERE userId = ?",
      )
        .bind(new Date().toISOString(), actor)
        .run();
    if (
      after &&
      callback &&
      !new URL(
        response.headers.get("Location") ?? canonicalOrigin(env),
      ).searchParams.has("error")
    )
      await env.CATALOG.prepare(
        "UPDATE auth_provider_config SET callback_verified_at = ? WHERE id = ?",
      )
        .bind(Date.now(), path.split("/").at(-1))
        .run();
    if (actor && request.method === "POST")
      await audit(
        env.CATALOG,
        actor,
        `auth${path.replaceAll("/", ".")}`,
        actor,
      );
  } else if (path.startsWith("/sign-in/"))
    await audit(env.CATALOG, null, "auth.sign_in", null, "failed");
  // Provider callbacks may carry a JSON content type on an empty redirect.
  // Preserve Location and cookies instead of trying to decode that empty body.
  if (response.status >= 300 && response.status < 400) return response;
  if (response.headers.get("Content-Type")?.includes("application/json")) {
    if (
      path === "/sign-up/email" &&
      (await bootstrapAuthorized(request, env))
    ) {
      const reserved = await env.CATALOG.prepare(
        "SELECT u.email FROM installation i JOIN auth_users u ON u.id = i.setup_user_id",
      ).first<{ email: string }>();
      if (
        reserved &&
        reserved.email.toLowerCase() !== String(body.email).trim().toLowerCase()
      )
        throw new HttpError(
          409,
          "Another identity reserved setup. Sign in with that identity to continue.",
          "SETUP_CONFLICT",
        );
    }
    const value = (await response.json()) as Record<string, unknown>;
    delete value.token;
    delete value.session;
    if (
      path === "/sign-up/email" &&
      (response.ok || value.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL")
    )
      return Response.json(
        {
          message:
            "If this address can be registered, a verification message will arrive.",
        },
        { status: 202, headers: response.headers },
      );
    return Response.json(value, {
      status: response.status,
      headers: response.headers,
    });
  }
  return response;
}

export async function identityRoutes(
  request: Request,
  env: NativeEnv,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (
    !path.startsWith("/api/auth/") &&
    !path.startsWith("/api/v1/auth/") &&
    !path.startsWith("/api/v1/setup/")
  )
    return null;
  if (env.AUTH_MODE === "access" || env.AUTH_MODE === "development") {
    if (path === "/api/v1/auth/bootstrap")
      return Response.json({
        mode: env.AUTH_MODE,
        configured: true,
        setup: false,
      });
    throw new HttpError(
      404,
      "Native authentication is not enabled for this deployment.",
      "NOT_FOUND",
    );
  }
  nativeConfigured(env);
  checkCanonicalRequest(request, env);
  if (path.startsWith("/api/auth/")) return libraryRoute(request, env);
  if (path === "/api/v1/auth/bootstrap" && request.method === "GET") {
    const csrf = await csrfBootstrap(request, env);
    const settings = await installation(env);
    const providers = await configuredProviders(env);
    const identity = await readNativeSession(request, env, true);
    const headers = new Headers(identity?.headers);
    headers.append("Set-Cookie", csrf.cookie);
    return Response.json(
      {
        mode: "native",
        configured: true,
        hostingPlatform:
          env.HOSTING_PLATFORM === "godaddy"
            ? "godaddy"
            : env.HOSTING_PLATFORM === "node"
              ? "node"
              : "cloudflare",
        title: settings.title,
        cacheNamespace: settings.cache_namespace,
        setup: settings.state !== "ready",
        setupState: settings.state,
        setupReserved: Boolean(settings.setup_user_id),
        setupReview:
          settings.state !== "ready"
            ? {
                registration: settings.registration,
                memberLimit: settings.member_limit,
                guestLimit: settings.guest_limit,
                boardLimit: settings.board_limit,
              }
            : undefined,
        returnTo: await resolveIntent(request, env, identity?.user),
        unlocked: await bootstrapAuthorized(request, env),
        csrf: csrf.token,
        email: mailReady(env),
        localAccounts: true,
        setupPassword:
          Boolean(env.SETUP_PASSWORD) || !env.AUTH_BOOTSTRAP_SECRET,
        setupCredentialConfigured: Boolean(
          (env.SETUP_PASSWORD?.length ?? 0) >= 15 ||
            (env.AUTH_BOOTSTRAP_SECRET?.length ?? 0) >= 32,
        ),
        registration: settings.registration,
        magicLink: Boolean(settings.magic_link),
        providers: [
          ...(providers.github ? ["github"] : []),
          ...(providers.google ? ["google"] : []),
          ...(providers.oidc ?? []).map((provider) => provider.providerId),
        ],
        access: env.ACCESS_INTEGRATION && env.ACCESS_INTEGRATION !== "off",
        user: identity ? publicPrincipal(identity.principal) : null,
        account: identity
          ? {
              status: identity.state.status,
              authVersion: identity.state.auth_version,
              expiresAt: identity.principal.expiresAt,
              onboarding: identity.state.onboarding_version ?? 0,
              role: identity.state.role,
              verified: identity.identityVerified,
              localUsername: identity.localUsername,
              emailVerified: identity.user.emailVerified,
              assurance: identity.policy.assurance,
              needsMfa:
                needsStrong(
                  settings,
                  identity.state,
                  Boolean(identity.user.twoFactorEnabled),
                ) && identity.policy.assurance !== "strong",
              recoveryRequired: Boolean(identity.state.recovery_required),
              twoFactorEnabled: Boolean(identity.user.twoFactorEnabled),
              setupUser: settings.setup_user_id === identity.user.id,
            }
          : null,
      },
      { headers },
    );
  }
  if (request.method !== "POST")
    throw new HttpError(405, "Method not allowed.", "METHOD_NOT_ALLOWED");
  await requireCsrf(request, env);
  if (path === "/api/v1/auth/intent") return captureIntent(request, env);
  if (path === "/api/v1/auth/confirmation-info") {
    const body = await json(request);
    if (typeof body.token !== "string" || body.token.length > 4096)
      throw new HttpError(400, "Invalid email link.", "INVALID_TOKEN");
    const context = await (await nativeAuth(env)).$context;
    await currentEmailProof(env, body.token);
    const proof = await verifyJWT(body.token, context.secret);
    if (!proof || typeof proof.email !== "string")
      throw new HttpError(
        410,
        "This email link has expired or is invalid. Request a new message.",
        "INVALID_TOKEN",
      );
    if (
      await env.CATALOG.prepare(
        "SELECT 1 FROM auth_confirmation_uses WHERE token_hash = ?",
      )
        .bind(await sha256(body.token))
        .first()
    )
      throw new HttpError(
        409,
        "This email link has already been confirmed.",
        "TOKEN_CONSUMED",
      );
    const credential = !proof.updateTo
      ? await env.CATALOG.prepare(
          "SELECT 1 FROM auth_accounts a JOIN auth_users u ON u.id = a.userId WHERE lower(u.email) = ? AND u.emailVerified = 0 AND a.providerId = 'credential'",
        )
          .bind(proof.email.toLowerCase())
          .first()
      : null;
    return Response.json({
      requiresPassword: Boolean(credential),
      purpose:
        proof.requestType === "change-email-confirmation"
          ? "approve-email-change"
          : proof.updateTo
            ? "verify-new-address"
            : "verify-address",
    });
  }
  if (path === "/api/v1/setup/unlock") {
    await limit(env, "bootstrap", clientIp(request), 5, 900);
    const body = await json(request);
    if (
      typeof body.secret !== "string" ||
      !(
        (env.SETUP_PASSWORD &&
          env.SETUP_PASSWORD.length >= 15 &&
          equal(body.secret, env.SETUP_PASSWORD)) ||
        (env.AUTH_BOOTSTRAP_SECRET &&
          env.AUTH_BOOTSTRAP_SECRET.length >= 32 &&
          equal(body.secret, env.AUTH_BOOTSTRAP_SECRET))
      )
    )
      throw new HttpError(
        403,
        "The setup password is incorrect.",
        "BOOTSTRAP_REQUIRED",
      );
    if ((await installation(env)).state === "ready")
      throw new HttpError(
        409,
        "Setup has already been completed.",
        "SETUP_COMPLETE",
      );
    const token = randomToken();
    await env.CATALOG.prepare(
      "INSERT INTO setup_sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)",
    )
      .bind(await sha256(token), Date.now() + 1800_000, Date.now())
      .run();
    return Response.json(
      { unlocked: true },
      {
        headers: {
          // The provider's top-level GET callback must retain the setup proof.
          // OAuth state/PKCE still binds that callback to this browser; setup
          // mutations separately require our signed CSRF token and exact origin.
          "Set-Cookie": `canvas-setup=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1800${canonicalOrigin(env).startsWith("https:") ? "; Secure" : ""}`,
        },
      },
    );
  }
  if (path === "/api/v1/setup/complete") {
    if (!(await bootstrapAuthorized(request, env)))
      throw new HttpError(
        403,
        "Unlock setup with the bootstrap secret first.",
        "BOOTSTRAP_REQUIRED",
      );
    const identity = await nativePrincipal(request, env, true);
    await requireFreshForInstallation(env, identity.principal);
    if (!identity.identityVerified || identity.state.recovery_required)
      throw new HttpError(
        403,
        "Verify your identity and recovery method first.",
        "VERIFICATION_REQUIRED",
      );
    const settings = await installation(env);
    const body = await json(request);
    const title =
      body.title === undefined
        ? settings.title
        : text(body.title, "Workspace name", 80);
    const at = new Date().toISOString();
    const commit = randomToken(18);
    const results = await env.CATALOG.batch([
      env.CATALOG.prepare(
        "UPDATE installation SET state = 'ready', owner_id = ?, origin = ?, title = ?, version = version + 1, setup_commit = ? WHERE id = 'instance' AND state = 'configuring' AND setup_user_id = ? AND version = ?",
      ).bind(
        identity.user.id,
        canonicalOrigin(env),
        title,
        commit,
        identity.user.id,
        settings.version,
      ),
      env.CATALOG.prepare(
        "INSERT INTO instance_memberships (user_id, role, created_at) SELECT ?, 'owner', ? WHERE EXISTS (SELECT 1 FROM installation WHERE setup_commit = ?) ON CONFLICT(user_id) DO UPDATE SET role = 'owner'",
      ).bind(identity.user.id, at, commit),
      env.CATALOG.prepare(
        "UPDATE account_security SET status = 'active', admitted_at = ?, updated_at = ? WHERE user_id = ? AND EXISTS (SELECT 1 FROM installation WHERE setup_commit = ?)",
      ).bind(at, at, identity.user.id, commit),
      env.CATALOG.prepare(
        "INSERT OR IGNORE INTO workspaces (id, title, created_at) SELECT 'workspace:personal', 'Workspace', ? WHERE EXISTS(SELECT 1 FROM installation WHERE setup_commit = ?)",
      ).bind(at, commit),
      env.CATALOG.prepare(
        "INSERT OR IGNORE INTO workspace_memberships (workspace_id, user_id, role, created_at) SELECT 'workspace:personal', ?, 'owner', ? WHERE EXISTS(SELECT 1 FROM installation WHERE setup_commit = ?)",
      ).bind(identity.user.id, at, commit),
      env.CATALOG.prepare(
        "DELETE FROM setup_sessions WHERE EXISTS(SELECT 1 FROM installation WHERE setup_commit = ?)",
      ).bind(commit),
      ...starterStatements(env.CATALOG, identity.user.id),
    ]);
    if (!results[0].meta.changes)
      throw new HttpError(
        409,
        "Setup changed in another session. Reload and continue.",
        "SETUP_CONFLICT",
      );
    return Response.json({ ready: true });
  }
  if (path === "/api/v1/auth/verify" || path === "/api/v1/auth/magic") {
    const body = await json(request);
    if (typeof body.token !== "string" || body.token.length > 4096)
      throw new HttpError(
        400,
        "This confirmation link is invalid.",
        "INVALID_TOKEN",
      );
    let changedAddress: { id: string; old: string; next: string } | undefined;
    if (path.endsWith("/verify")) {
      const context = await (await nativeAuth(env)).$context;
      const proof = await verifyJWT(body.token, context.secret);
      if (!proof || typeof proof.email !== "string")
        throw new HttpError(
          410,
          "This email link has expired or is invalid. Request a new message.",
          "INVALID_TOKEN",
        );
      await currentEmailProof(env, body.token);
      const hash = await sha256(body.token);
      const marker = randomToken(18);
      const credential = !proof.updateTo
        ? await env.CATALOG.prepare(
            "SELECT a.userId FROM auth_accounts a JOIN auth_users u ON u.id = a.userId WHERE lower(u.email) = ? AND u.emailVerified = 0 AND a.providerId = 'credential'",
          )
            .bind(proof.email.toLowerCase())
            .first<{ userId: string }>()
        : null;
      let passwordHash: string | undefined;
      if (credential) {
        if (typeof body.newPassword !== "string")
          throw new HttpError(
            400,
            "Choose your password to confirm this address.",
            "PASSWORD_CONFIRMATION_REQUIRED",
          );
        passwordHash = await hashPassword(body.newPassword);
      }
      const [claimed] = await env.CATALOG.batch([
        env.CATALOG.prepare(
          "INSERT OR IGNORE INTO auth_confirmation_uses (token_hash, purpose, consumed_at, claim_id) VALUES (?, 'verify', ?, ?)",
        ).bind(hash, Date.now(), marker),
        ...(credential && passwordHash
          ? [
              env.CATALOG.prepare(
                "UPDATE auth_accounts SET password = ? WHERE userId = ? AND providerId = 'credential' AND EXISTS(SELECT 1 FROM auth_confirmation_uses WHERE token_hash = ? AND claim_id = ?)",
              ).bind(passwordHash, credential.userId, hash, marker),
              env.CATALOG.prepare(
                "DELETE FROM auth_sessions WHERE userId = ? AND EXISTS(SELECT 1 FROM auth_confirmation_uses WHERE token_hash = ? AND claim_id = ?)",
              ).bind(credential.userId, hash, marker),
            ]
          : []),
      ]);
      if (!claimed.meta.changes)
        throw new HttpError(
          409,
          "This email link has already been confirmed.",
          "TOKEN_CONSUMED",
        );
      if (
        proof.requestType === "change-email-verification" &&
        typeof proof.updateTo === "string"
      ) {
        const user = await env.CATALOG.prepare(
          "SELECT id FROM auth_users WHERE lower(email) = ? AND emailVerified = 1",
        )
          .bind(proof.email.toLowerCase())
          .first<{ id: string }>();
        if (user)
          changedAddress = {
            id: user.id,
            old: proof.email,
            next: proof.updateTo,
          };
      }
    }
    const target = new URL(
      `${canonicalOrigin(env)}/api/auth/${path.endsWith("/magic") ? "magic-link/verify" : "verify-email"}`,
    );
    target.searchParams.set("token", body.token);
    target.searchParams.set("callbackURL", `${canonicalOrigin(env)}/login`);
    if (path.endsWith("/magic") && !(await installation(env)).magic_link)
      throw new HttpError(403, "Magic links are disabled.", "METHOD_DISABLED");
    const response = await (
      await nativeAuth(env)
    ).handler(new Request(target, { headers: request.headers }));
    const destination = response.headers.get("Location");
    const failed =
      destination &&
      new URL(destination, canonicalOrigin(env)).searchParams.has("error");
    if ((!response.ok && response.status !== 302) || failed)
      throw new HttpError(
        410,
        "This email link could not be confirmed. Request a new message.",
        "INVALID_TOKEN",
      );
    if (changedAddress) {
      const changed = await env.CATALOG.prepare(
        "SELECT email FROM auth_users WHERE id = ?",
      )
        .bind(changedAddress.id)
        .first<{ email: string }>();
      if (changed?.email.toLowerCase() === changedAddress.next.toLowerCase()) {
        // Migration 0023 commits address synchronization and revocation with
        // the credential write; this notification does not gate revocation.
        await queueMail(
          env,
          changedAddress.old,
          "Your Open Whiteboard email changed",
          "Your sign-in address has changed. If you did not request this, contact your installation owner immediately.",
        ).catch(() => undefined);
      }
    }
    const headers = new Headers(response.headers);
    headers.delete("Location");
    headers.set("Content-Type", "application/json");
    return Response.json(
      { confirmed: true, signInAgain: Boolean(changedAddress) },
      { headers },
    );
  }
  throw new HttpError(404, "Authentication action not found.", "NOT_FOUND");
}
