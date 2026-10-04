import { D1IdentityRepository } from "./d1-repository";
import { starterStatements } from "./content";
import type {
  Installation,
  InstanceRole,
  NativeEnv,
  SecurityState,
} from "./types";
import type { Principal } from "../collaboration-types";
import { HttpError } from "../security/errors";
import { cookie, sha256 } from "../security/primitives";
import { requiresStrongAuthentication } from "./decisions";
import { guestBoardAccess } from '../guest-policy.server';

export async function installation(env: Pick<NativeEnv, "CATALOG">) {
  const row = await env.CATALOG.prepare(
    "SELECT * FROM installation WHERE id = ?",
  )
    .bind("instance")
    .first<Installation>();
  if (!row)
    throw new HttpError(
      503,
      "Apply the authentication migrations before enabling sign-in.",
      "MIGRATION_REQUIRED",
    );
  if (row.state === "unclaimed" && !row.setup_user_id) {
    const legacyOwners = await env.CATALOG.prepare(
      "SELECT COUNT(*) AS count FROM workspace_memberships WHERE role = 'owner'",
    ).first<{ count: number }>();
    if (Number(legacyOwners?.count) > 1)
      throw new HttpError(
        503,
        "Multiple legacy owners need operator review before native sign-in can be enabled. Keep Access enabled and run the migration inventory.",
        "MIGRATION_REVIEW_REQUIRED",
      );
  }
  return row;
}
export async function securityState(database: D1Database, userId: string) {
  return new D1IdentityRepository(database).account(userId);
}
export async function bootstrapAuthorized(
  request: Request | undefined,
  env: NativeEnv,
) {
  if (!request) return false;
  const value = cookie(request, "canvas-setup");
  if (!value) return false;
  const row = await env.CATALOG.prepare(
    "SELECT 1 AS ok FROM setup_sessions WHERE token_hash = ? AND expires_at > ?",
  )
    .bind(await sha256(value), Date.now())
    .first();
  return Boolean(row) && (await installation(env)).state !== "ready";
}
export async function mayRegister(
  env: NativeEnv,
  address: string,
  request?: Request,
) {
  const settings = await installation(env);
  if (await bootstrapAuthorized(request, env)) return !settings.setup_user_id;
  if (settings.state !== "ready" || settings.registration === "closed")
    return false;
  if (settings.registration === "public") return true;
  const now = new Date().toISOString();
  const invite = await env.CATALOG.prepare(
    `SELECT id FROM instance_invitations WHERE email = ? AND accepted_by IS NULL AND revoked_at IS NULL AND expires_at > ?
    UNION ALL SELECT id FROM invitations WHERE email = ? AND accepted_by IS NULL AND revoked_at IS NULL AND expires_at > ? LIMIT 1`,
  )
    .bind(address, now, address, now)
    .first();
  return Boolean(invite);
}
export async function provisionUser(
  env: NativeEnv,
  user: {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
    image?: string | null;
  },
  request?: Request,
) {
  const repository = new D1IdentityRepository(env.CATALOG);
  await repository.provision(user);
  if (await bootstrapAuthorized(request, env)) {
    if (!(await repository.claimSetup(user.id)))
      throw new HttpError(
        409,
        "Another identity reserved setup. Sign in with that identity to continue.",
        "SETUP_CONFLICT",
      );
  }
  await synchronizeIdentity(env, user);
}
export async function synchronizeIdentity(
  env: NativeEnv,
  user: { id: string; email: string; emailVerified: boolean },
) {
  if (!user.emailVerified) return;
  await env.CATALOG.prepare(
    "UPDATE users SET email = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM account_security WHERE user_id = ? AND status <> 'deleted')",
  )
    .bind(user.email.toLowerCase(), new Date().toISOString(), user.id, user.id)
    .run();
  const settings = await installation(env);
  if (settings.state === "ready" && settings.registration === "public") {
    if (settings.approval_required)
      await env.CATALOG.prepare(
        "UPDATE account_security SET status = 'pending_approval' WHERE user_id = ? AND status = 'pending_verification'",
      )
        .bind(user.id)
        .run();
    else await admit(env, user.id, "member");
  }
}
export async function admit(
  env: NativeEnv,
  userId: string,
  role: InstanceRole,
) {
  const at = new Date().toISOString();
  const seatColumn = role === "guest" ? "guest_limit" : "member_limit";
  const [added] = await env.CATALOG.batch([
    env.CATALOG.prepare(
      `INSERT OR IGNORE INTO instance_memberships (user_id, role, created_at)
      SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM account_security WHERE user_id = ? AND status IN ('pending_verification', 'pending_approval', 'active'))
      AND (SELECT COUNT(*) FROM instance_memberships WHERE ${role === "guest" ? "role = 'guest'" : "role <> 'guest'"}) < (SELECT ${seatColumn} FROM installation WHERE id = 'instance')`,
    ).bind(userId, role, at, userId),
    env.CATALOG.prepare(
      "UPDATE account_security SET status = 'active', admitted_at = COALESCE(admitted_at, ?), updated_at = ? WHERE user_id = ? AND status IN ('pending_verification', 'pending_approval') AND EXISTS (SELECT 1 FROM instance_memberships WHERE user_id = ?)",
    ).bind(at, at, userId, userId),
    ...starterStatements(env.CATALOG, userId),
  ]);
  const state = await securityState(env.CATALOG, userId);
  if (!state?.role || state.status !== "active")
    throw new HttpError(
      409,
      "The installation has reached its account limit. Ask an administrator to adjust it.",
      "SEAT_LIMIT",
    );
  return Number(added.meta.changes);
}
export function needsStrong(
  settings: Installation,
  state: SecurityState,
  twoFactorEnabled: boolean,
) {
  return requiresStrongAuthentication(settings, state, twoFactorEnabled);
}
export const DEFAULT_REAUTHENTICATION_SECONDS = 1800;
export function reauthenticationSeconds(value: unknown) {
  if (value === undefined) return DEFAULT_REAUTHENTICATION_SECONDS;
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 300 &&
    value <= 43200
    ? value
    : 300;
}
export function requireFresh(
  principal: Principal,
  strong = true,
  windowSeconds = DEFAULT_REAUTHENTICATION_SECONDS,
) {
  const time = principal.authenticatedAt
    ? new Date(principal.authenticatedAt).getTime()
    : 0;
  if (
    (strong && principal.assurance !== "strong") ||
    !Number.isFinite(time) ||
    time <= 0 ||
    time > Date.now() ||
    Date.now() - time >= reauthenticationSeconds(windowSeconds) * 1000
  )
    throw new HttpError(
      403,
      "Confirm your identity before making this change.",
      "STEP_UP_REQUIRED",
    );
}
/** Read current policy for every protected request, including existing sessions. */
export async function requireFreshForInstallation(
  env: Pick<NativeEnv, "CATALOG">,
  principal: Principal,
  strong = true,
) {
  const settings = await installation(env);
  requireFresh(principal, strong, settings.reauthentication_seconds);
}
export async function requireAdministrator(
  env: NativeEnv,
  principal: Principal,
  ownerOnly = false,
  fresh = false,
) {
  const state = await securityState(env.CATALOG, principal.id);
  if (
    state?.status !== "active" ||
    !state.role ||
    (ownerOnly
      ? state.role !== "owner"
      : !["owner", "admin"].includes(state.role))
  )
    throw new HttpError(
      403,
      "Administrator permission is required.",
      "ADMIN_REQUIRED",
    );
  if (fresh) await requireFreshForInstallation(env, principal);
  return state;
}
export function publicPrincipal(principal: Principal) {
  return {
    id: principal.id,
    email: principal.localUsername ?? principal.email,
    name: principal.name,
    avatarUrl: principal.avatarUrl,
    color: principal.color,
    authentication: principal.authentication,
  };
}
export async function validateLivePrincipal(
  database: D1Database,
  principal: Principal,
) {
  if (principal.authentication === 'guest') {
    await guestBoardAccess(database, principal, principal.resources?.[0]?.id ?? '');
    return;
  }
  if (principal.authentication === "local-development") return;
  const state = await securityState(database, principal.id);
  if (
    !state ||
    state.status !== "active" ||
    state.recovery_required ||
    (principal.authVersion !== undefined &&
      state.auth_version !== principal.authVersion)
  )
    throw new HttpError(
      401,
      "Your access has changed. Sign in again.",
      "SESSION_REVOKED",
    );
  if (principal.authentication === "native") {
    const row = await database
      .prepare(
        `SELECT a.id FROM auth_sessions a JOIN auth_users u ON u.id = a.userId JOIN installation i ON i.id = 'instance'
        JOIN instance_memberships m ON m.user_id = a.userId
        WHERE a.id = ? AND a.userId = ? AND a.expiresAt > ? AND a.absoluteExpiresAt > ? AND a.authVersion = ?
        AND i.state = 'ready' AND (u.emailVerified = 1 OR EXISTS(SELECT 1 FROM local_accounts l WHERE l.user_id=u.id)) AND a.assurance <> 'recovery'
        AND (a.assurance = 'strong' OR (m.role NOT IN ('owner','admin') AND i.mfa_required = 0 AND COALESCE(u.twoFactorEnabled,0) = 0))`,
      )
      .bind(
        principal.sessionId,
        principal.id,
        new Date().toISOString(),
        new Date().toISOString(),
        state.auth_version,
      )
      .first();
    if (!row)
      throw new HttpError(401, "Your session has ended.", "SESSION_REVOKED");
  }
  if (principal.authentication === "oauth") {
    const row = await database
      .prepare(
        `SELECT t.id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN oauth_clients c ON c.id = t.client_id JOIN oauth_families f ON f.id = t.family_id
      WHERE t.id = ? AND t.user_id = ? AND t.revoked_at IS NULL AND t.expires_at > ? AND g.revoked_at IS NULL AND g.confirmed_version >= (SELECT consent_version FROM installation WHERE id = 'instance') AND c.revoked_at IS NULL AND f.revoked_at IS NULL AND f.absolute_expires_at > ?`,
      )
      .bind(
        principal.sessionId,
        principal.id,
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .first();
    if (!row)
      throw new HttpError(
        401,
        "The connected app no longer has access.",
        "invalid_token",
      );
  }
}
