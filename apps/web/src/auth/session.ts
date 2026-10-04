import type { NativeEnv } from "./types";
import type { Principal } from "../collaboration-types";
import { nativeAuth } from "./library";
import { installation, needsStrong, securityState } from "./policy";
import { checkCanonicalRequest } from "../security/config";
import { HttpError } from "../security/errors";
import { sessionIsCurrent, requireAdmission } from "./decisions";
export async function readNativeSession(
  request: Request,
  env: NativeEnv,
  renew = false,
) {
  checkCanonicalRequest(request, env);
  const auth = await nativeAuth(env);
  const result = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true, disableRefresh: !renew },
    returnHeaders: true,
  });
  const value = result.response;
  if (!value) return null;
  const stored = await env.CATALOG.prepare(
    `SELECT a.absoluteExpiresAt, a.authenticatedAt, a.assurance, a.authVersion, a.expiresAt,
    s.*, m.role, u.display_name, u.avatar_url, u.color, au.twoFactorEnabled FROM auth_sessions a
    JOIN account_security s ON s.user_id = a.userId JOIN users u ON u.id = a.userId JOIN auth_users au ON au.id = a.userId
    LEFT JOIN instance_memberships m ON m.user_id = a.userId WHERE a.id = ? AND a.userId = ?`,
  )
    .bind(value.session.id, value.user.id)
    .first<
      import("./types").SecurityState & {
        absoluteExpiresAt: string;
        authenticatedAt: string;
        assurance: "weak" | "strong" | "recovery";
        authVersion: number;
        expiresAt: string;
        display_name: string;
        avatar_url: string | null;
        color: string;
        twoFactorEnabled: number;
      }
    >();
  if (!stored) return null;
  const policy = {
    ...stored,
    absoluteExpiresAt: Date.parse(stored.absoluteExpiresAt),
    expiresAt: Date.parse(stored.expiresAt),
    authenticatedAt: Date.parse(stored.authenticatedAt),
  };
  if (!sessionIsCurrent(stored, policy, Date.now())) return null;
  const principal: Principal = {
    id: value.user.id,
    email: value.user.email,
    name: stored.display_name,
    avatarUrl: stored.avatar_url,
    color: stored.color,
    authentication: "native",
    issuer: "urn:canvas:account",
    subject: value.user.id,
    sessionId: value.session.id,
    expiresAt: new Date(
      Math.min(policy.absoluteExpiresAt, policy.expiresAt),
    ).toISOString(),
    authVersion: policy.authVersion,
    assurance: policy.assurance,
    authenticatedAt: new Date(policy.authenticatedAt).toISOString(),
  };
  const local = await env.CATALOG.prepare(
    "SELECT username FROM local_accounts WHERE user_id = ?",
  )
    .bind(value.user.id)
    .first<{ username: string }>();
  if (local) principal.localUsername = local.username;
  return {
    localUsername: local?.username,
    identityVerified: value.user.emailVerified || Boolean(local),
    principal,
    user: { ...value.user, twoFactorEnabled: Boolean(stored.twoFactorEnabled) },
    session: value.session,
    state: stored,
    policy,
    headers: result.headers,
  };
}
export async function nativePrincipal(
  request: Request,
  env: NativeEnv,
  restricted = false,
) {
  const identity = await readNativeSession(request, env);
  if (!identity)
    throw new HttpError(401, "Sign in to continue.", "AUTHENTICATION_REQUIRED");
  if (restricted) return identity;
  const settings = await installation(env);
  requireAdmission(
    settings,
    identity.state,
    identity.identityVerified,
    Boolean(identity.user.twoFactorEnabled),
    identity.policy.assurance,
  );
  return identity;
}
export function cookiesFromResponse(request: Request, response: Response) {
  const values = new Map(
    (request.headers.get("cookie") ?? "").split(";").map((part) => {
      const pair = part.trim();
      const i = pair.indexOf("=");
      return [pair.slice(0, i < 0 ? 0 : i), i < 0 ? "" : pair.slice(i + 1)];
    }),
  );
  for (const item of response.headers.getSetCookie()) {
    const [pair] = item.split(";");
    const i = pair.indexOf("=");
    values.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const headers = new Headers(request.headers);
  headers.set(
    "cookie",
    [...values]
      .filter(([key]) => key)
      .map(([key, value]) => `${key}=${value}`)
      .join("; "),
  );
  return new Request(request.url, { headers });
}
