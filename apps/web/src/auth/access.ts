import type { Principal } from "../collaboration-types";

export type AuthEnv = {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  INITIAL_OWNER_EMAIL?: string;
  ENVIRONMENT?: string;
};

type AccessClaims = {
  aud?: string | string[];
  email?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  name?: string;
  sub?: string;
  nonce?: string;
};

type AccessKeys = { keys?: JsonWebKey[] };

import { HttpError } from "../security/errors";
export { HttpError } from "../security/errors";

const COLORS = [
  "#4262ff",
  "#8a5cf5",
  "#e25b8f",
  "#d96c3d",
  "#0d8f75",
  "#2474b5",
  "#8b6b20",
];
const keySets = new Map<string, { expiresAt: number; value: AccessKeys }>();

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJson<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
}

async function digestId(value: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  let binary = "";
  for (const byte of digest.slice(0, 18)) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

function normalizeTeamDomain(value: string) {
  return value
    .trim()
    .replace(/^https?:\/\//u, "")
    .replace(/\/$/u, "");
}

async function readKeySet(teamDomain: string) {
  const current = keySets.get(teamDomain);
  if (current && current.expiresAt > Date.now()) return current.value;
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok)
    throw new HttpError(
      503,
      "Authentication keys are unavailable",
      "AUTH_KEYS_UNAVAILABLE",
    );
  const value = (await response.json()) as AccessKeys;
  keySets.set(teamDomain, { value, expiresAt: Date.now() + 60 * 60 * 1000 });
  return value;
}

async function verifyAccessToken(token: string, env: AuthEnv) {
  const parts = token.split(".");
  if (parts.length !== 3)
    throw new HttpError(401, "Invalid authentication token", "INVALID_TOKEN");
  const header = decodeJson<{ alg?: string; kid?: string }>(parts[0]);
  const claims = decodeJson<AccessClaims>(parts[1]);
  if (header.alg !== "RS256" || !header.kid) {
    throw new HttpError(
      401,
      "Unsupported authentication token",
      "INVALID_TOKEN",
    );
  }
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new HttpError(
      503,
      "Cloudflare Access is not configured for the application",
      "AUTH_NOT_CONFIGURED",
    );
  }
  const teamDomain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const expectedIssuer = `https://${teamDomain}`;
  if (
    claims.iss !== expectedIssuer ||
    !claims.sub ||
    !claims.email ||
    !claims.exp
  ) {
    throw new HttpError(
      401,
      "Authentication token claims are invalid",
      "INVALID_TOKEN",
    );
  }
  const audiences = Array.isArray(claims.aud)
    ? claims.aud
    : claims.aud
      ? [claims.aud]
      : [];
  if (!audiences.includes(env.ACCESS_AUD) || claims.exp * 1000 <= Date.now()) {
    throw new HttpError(
      401,
      "Authentication session has expired",
      "SESSION_EXPIRED",
    );
  }
  let keys = await readKeySet(teamDomain);
  let jwk = keys.keys?.find(
    (key) => (key as JsonWebKey & { kid?: string }).kid === header.kid,
  );
  if (!jwk) {
    keySets.delete(teamDomain);
    keys = await readKeySet(teamDomain);
    jwk = keys.keys?.find(
      (key) => (key as JsonWebKey & { kid?: string }).kid === header.kid,
    );
    if (!jwk)
      throw new HttpError(
        401,
        "Authentication signing key was not found",
        "INVALID_TOKEN",
      );
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    decodeBase64Url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!verified)
    throw new HttpError(
      401,
      "Authentication token signature is invalid",
      "INVALID_TOKEN",
    );
  return claims;
}

function readCookie(request: Request, name: string) {
  const cookies = request.headers.get("Cookie")?.split(";") ?? [];
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function localRequest(request: Request) {
  const hostname = new URL(request.url).hostname;
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost")
  );
}

function displayName(email: string, claimName?: string) {
  if (claimName?.trim()) return claimName.trim().slice(0, 80);
  return email
    .split("@")[0]
    .replace(/[._-]+/gu, " ")
    .replace(/\b\w/gu, (value) => value.toUpperCase())
    .slice(0, 80);
}

async function makePrincipal(input: {
  issuer: string;
  subject: string;
  email: string;
  name?: string;
  expiresAt?: number;
  authentication: Principal["authentication"];
}) {
  const email = input.email.trim().toLocaleLowerCase();
  const idDigest = await digestId(`${input.issuer}\0${input.subject}`);
  const colorSeed = [...idDigest].reduce(
    (sum, value) => sum + value.charCodeAt(0),
    0,
  );
  return {
    id: `user:${idDigest}`,
    email,
    name: displayName(email, input.name),
    avatarUrl: null,
    color: COLORS[colorSeed % COLORS.length],
    issuer: input.issuer,
    subject: input.subject,
    sessionId: crypto.randomUUID(),
    expiresAt: input.expiresAt
      ? new Date(input.expiresAt * 1000).toISOString()
      : null,
    authentication: input.authentication,
  } satisfies Principal;
}

export async function authenticateLegacy(
  request: Request,
  env: AuthEnv,
): Promise<Principal> {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (assertion) {
    const claims = await verifyAccessToken(assertion, env);
    return makePrincipal({
      issuer: claims.iss!,
      subject: claims.sub!,
      email: claims.email!,
      name: claims.name,
      expiresAt: claims.exp,
      authentication: "cloudflare-access",
    });
  }
  if (
    localRequest(request) &&
    (env.ENVIRONMENT === "development" || env.ENVIRONMENT === "test")
  ) {
    const localEmail =
      request.headers.get("X-Whiteboard-Dev-Email") ??
      readCookie(request, "whiteboard_dev_email") ??
      env.INITIAL_OWNER_EMAIL ??
      "owner@local.test";
    if (!/^[^@\s]+@[^@\s]+$/u.test(localEmail)) {
      throw new HttpError(
        400,
        "Local test identity must be an email address",
        "INVALID_LOCAL_IDENTITY",
      );
    }
    return makePrincipal({
      issuer: "urn:personal-whiteboard:local",
      subject: localEmail.toLocaleLowerCase(),
      email: localEmail,
      authentication: "local-development",
    });
  }
  throw new HttpError(
    401,
    "Sign in through Cloudflare Access",
    "AUTHENTICATION_REQUIRED",
  );
}

export function authErrorResponse(error: unknown) {
  if (error instanceof HttpError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }
  return Response.json(
    { error: "Authentication failed", code: "AUTHENTICATION_FAILED" },
    { status: 401 },
  );
}

export function localSessionResponse(
  request: Request,
  email: unknown,
  env: AuthEnv,
) {
  if (
    !localRequest(request) ||
    !["development", "test"].includes(env.ENVIRONMENT ?? "")
  ) {
    throw new HttpError(404, "Not found", "NOT_FOUND");
  }
  if (typeof email !== "string" || !/^[^@\s]+@[^@\s]+$/u.test(email)) {
    throw new HttpError(
      400,
      "A valid email address is required",
      "INVALID_LOCAL_IDENTITY",
    );
  }
  return Response.json(
    { email: email.toLocaleLowerCase() },
    {
      headers: {
        "Set-Cookie": `whiteboard_dev_email=${encodeURIComponent(email.toLocaleLowerCase())}; Path=/; SameSite=Lax; HttpOnly`,
      },
    },
  );
}
