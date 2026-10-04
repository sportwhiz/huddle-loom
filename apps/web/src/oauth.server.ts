import { HttpError } from "./security/errors";
import type { Principal } from "./collaboration-types";
import type { NativeEnv } from "./auth/types";
import { canonicalOrigin, validatePublicHttps } from "./security/config";
import {
  boundedBody,
  escapeHtml,
  equal,
  json,
  randomToken,
  sha256,
} from "./security/primitives";
import {
  authorizedCatalog,
  requireBoardRole,
  requireWorkbookRole,
} from "./collaboration.server";
import { readCatalog } from "./catalog.server";
import {
  requireFresh,
  securityState,
  validateLivePrincipal,
} from "./auth/policy";
import { consentContentSecurityPolicy, csrfBootstrap } from "./security/request";
import { auditStatement } from "./security/audit";

const SCOPES = [
  "boards:read",
  "boards:write",
  "collaboration:write",
  "boards:export",
] as const;
const descriptions = {
  "boards:read": "Read and search the boards you select",
  "boards:write":
    "Create and edit sticky notes, shapes and connected workflows",
  "collaboration:write": "Add comments and manage board collaboration",
  "boards:export": "Download editable board archives",
};
function now() {
  return new Date().toISOString();
}
function originFor(request: Request, env?: NativeEnv) {
  return env && (env.AUTH_MODE ?? "native") === "native"
    ? canonicalOrigin(env)
    : new URL(request.url).origin;
}
function resourceFor(request: Request, env?: NativeEnv) {
  return `${originFor(request, env)}/mcp`;
}
export async function ensureOAuthSchema(_database: D1Database) {
  /* Reviewed deploy-time migrations own the schema. */
}
function scopes(value: string) {
  const requested = [...new Set(value.split(/\s+/u).filter(Boolean))];
  if (
    !requested.length ||
    requested.some(
      (scope) => !SCOPES.includes(scope as (typeof SCOPES)[number]),
    )
  )
    throw new HttpError(400, "Unsupported OAuth scope.", "invalid_scope");
  return requested;
}
function redirectAllowed(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
function redirects(value: unknown) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 20 ||
    value.some((uri) => !redirectAllowed(uri))
  )
    throw new HttpError(
      400,
      "Provide exact HTTPS callbacks or native loopback IP callbacks.",
      "invalid_client_metadata",
    );
  return value as string[];
}

export function oauthProtectedResource(request: Request, env?: NativeEnv) {
  const origin = originFor(request, env);
  return Response.json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: [...SCOPES],
    resource_documentation: `${origin}/docs/mcp`,
  });
}
export async function oauthAuthorizationMetadata(
  request: Request,
  env?: NativeEnv,
) {
  const origin = originFor(request, env);
  const dynamic = env
    ? await env.CATALOG.prepare(
        "SELECT dynamic_registration FROM installation WHERE id = 'instance'",
      ).first<{ dynamic_registration: number }>()
    : null;
  return Response.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    ...(dynamic?.dynamic_registration
      ? { registration_endpoint: `${origin}/oauth/register` }
      : {}),
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...SCOPES],
    authorization_response_iss_parameter_supported: true,
    ...(env?.CIMD_ALLOWED_ORIGINS
      ? { client_id_metadata_document_supported: true }
      : {}),
  });
}
export async function registerOAuthClient(
  request: Request,
  database: D1Database,
  env?: NativeEnv,
) {
  const enabled = await database
    .prepare(
      "SELECT dynamic_registration FROM installation WHERE id = 'instance'",
    )
    .first<{ dynamic_registration: number }>();
  if (!enabled?.dynamic_registration)
    throw new HttpError(
      403,
      "An administrator must register this client.",
      "registration_disabled",
    );
  const body = await json(request);
  const uris = redirects(body.redirect_uris);
  if (
    body.token_endpoint_auth_method !== undefined &&
    body.token_endpoint_auth_method !== "none"
  )
    throw new HttpError(
      400,
      "Dynamic registration supports public PKCE clients.",
      "invalid_client_metadata",
    );
  const id = `oauth-client:${randomToken(18)}`;
  const name =
    typeof body.client_name === "string" && body.client_name.trim()
      ? body.client_name.trim().slice(0, 120)
      : "MCP client";
  const inserted = await database
    .prepare(
      "INSERT INTO oauth_clients (id, name, redirect_uris, created_at) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM oauth_clients WHERE revoked_at IS NULL) < 10000 AND (SELECT dynamic_registration FROM installation WHERE id = 'instance') = 1",
    )
    .bind(id, name, JSON.stringify(uris), now())
    .run();
  if (!inserted.meta.changes)
    throw new HttpError(
      429,
      "Client registration limit reached or registration is disabled.",
      "registration_limited",
    );
  return Response.json(
    {
      client_id: id,
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    { status: 201 },
  );
}
type Client = {
  id: string;
  name: string;
  redirect_uris: string;
  auth_method: string;
  secret_hash: string | null;
  revoked_at: string | null;
  trusted: number;
  metadata_url: string | null;
  metadata_expires_at: string | null;
};
async function client(database: D1Database, id: string, env?: NativeEnv) {
  let row = await database
    .prepare("SELECT * FROM oauth_clients WHERE id = ? AND revoked_at IS NULL")
    .bind(id)
    .first<Client>();
  if (id.startsWith("https://") && (!row || row.metadata_url)) {
    if (!env?.CIMD_ALLOWED_ORIGINS)
      throw new HttpError(
        400,
        "This metadata client is no longer approved.",
        "invalid_client",
      );
    const url = validatePublicHttps(
      id,
      env.CIMD_ALLOWED_ORIGINS.split(",").map((value) => value.trim()),
    );
    if (row?.metadata_expires_at && row.metadata_expires_at > now()) return row;
    const disabled = await database
      .prepare(
        "SELECT id FROM oauth_clients WHERE id = ? AND revoked_at IS NOT NULL",
      )
      .bind(id)
      .first();
    if (disabled)
      throw new HttpError(400, "Client is disabled.", "invalid_client");
    const response = await fetch(url, {
      redirect: "manual",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new HttpError(
        400,
        "Client metadata is unavailable.",
        "invalid_client",
      );
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(
        new TextDecoder().decode(await boundedBody(response, 32768)),
      );
    } catch {
      throw new HttpError(
        400,
        "Client metadata must be valid JSON.",
        "invalid_client_metadata",
      );
    }
    if (!metadata || Array.isArray(metadata) || typeof metadata !== "object")
      throw new HttpError(
        400,
        "Invalid client metadata.",
        "invalid_client_metadata",
      );
    if (
      metadata.client_id !== id ||
      (metadata.token_endpoint_auth_method !== undefined &&
        metadata.token_endpoint_auth_method !== "none")
    )
      throw new HttpError(
        400,
        "Client metadata does not identify a public client at this URL.",
        "invalid_client_metadata",
      );
    const uris = redirects(metadata.redirect_uris);
    const name =
      typeof metadata.client_name === "string"
        ? metadata.client_name.slice(0, 120)
        : "MCP client";
    await database
      .prepare(
        "INSERT INTO oauth_clients (id, name, redirect_uris, created_at, metadata_url, metadata_expires_at) SELECT ?, ?, ?, ?, ?, ? WHERE ((SELECT COUNT(*) FROM oauth_clients WHERE revoked_at IS NULL) < 10000 OR EXISTS(SELECT 1 FROM oauth_clients WHERE id = ? AND revoked_at IS NULL)) ON CONFLICT(id) DO UPDATE SET name = excluded.name, redirect_uris = excluded.redirect_uris, metadata_expires_at = excluded.metadata_expires_at WHERE oauth_clients.revoked_at IS NULL",
      )
      .bind(
        id,
        name,
        JSON.stringify(uris),
        now(),
        id,
        new Date(Date.now() + 3600_000).toISOString(),
        id,
      )
      .run();
    row = await database
      .prepare(
        "SELECT * FROM oauth_clients WHERE id = ? AND revoked_at IS NULL",
      )
      .bind(id)
      .first<Client>();
  }
  if (!row)
    throw new HttpError(
      400,
      "Client is unknown or disabled.",
      "invalid_client",
    );
  return row;
}
async function clientAuthentication(
  request: Request,
  database: D1Database,
  form: URLSearchParams,
  env?: NativeEnv,
) {
  let id = form.get("client_id");
  let secret: string | null = null;
  const basic = request.headers.get("Authorization");
  if (basic) {
    if (!basic.startsWith("Basic "))
      throw new HttpError(
        401,
        "Unsupported client authentication.",
        "invalid_client",
      );
    try {
      const value = atob(basic.slice(6));
      const i = value.indexOf(":");
      id = decodeURIComponent(value.slice(0, i));
      secret = decodeURIComponent(value.slice(i + 1));
      if (i < 0 || (form.has("client_id") && form.get("client_id") !== id))
        throw new Error();
    } catch {
      throw new HttpError(
        401,
        "Client authentication failed.",
        "invalid_client",
      );
    }
  }
  if (!id) throw new HttpError(400, "client_id is required.", "invalid_client");
  const info = await client(database, id, env);
  if (
    info.auth_method === "client_secret_basic"
      ? !secret ||
        !info.secret_hash ||
        !equal(info.secret_hash, await sha256(secret))
      : Boolean(basic)
  )
    throw new HttpError(401, "Client authentication failed.", "invalid_client");
  return info;
}
function errorRedirect(
  uri: string,
  state: string | null,
  issuer: string,
  error: string,
) {
  const target = new URL(uri);
  target.searchParams.set("error", error);
  target.searchParams.set("iss", issuer);
  if (state) target.searchParams.set("state", state);
  return Response.redirect(target.toString(), 302);
}

export async function authorizeOAuth(
  request: Request,
  database: D1Database,
  principal: Principal,
  env?: NativeEnv,
) {
  const origin = originFor(request, env);
  if (principal.authentication === "native") requireFresh(principal, false);
  if (request.method === "GET") {
    const url = new URL(request.url);
    const id = url.searchParams.get("client_id");
    const uri = url.searchParams.get("redirect_uri");
    const challenge = url.searchParams.get("code_challenge");
    if (
      !id ||
      !uri ||
      !redirectAllowed(uri) ||
      url.searchParams.get("response_type") !== "code" ||
      url.searchParams.get("code_challenge_method") !== "S256" ||
      !challenge ||
      !/^[A-Za-z0-9_-]{43}$/u.test(challenge)
    )
      throw new HttpError(
        400,
        "A PKCE authorization request is required.",
        "invalid_request",
      );
    const info = await client(database, id, env);
    if (!(JSON.parse(info.redirect_uris) as string[]).includes(uri))
      throw new HttpError(
        400,
        "The redirect address is not registered.",
        "invalid_redirect_uri",
      );
    if (url.searchParams.get("resource") !== resourceFor(request, env))
      return errorRedirect(
        uri,
        url.searchParams.get("state"),
        origin,
        "invalid_target",
      );
    const requested = scopes(
      url.searchParams.get("scope") ??
        "boards:read boards:write collaboration:write boards:export",
    );
    const pendingId = randomToken(18);
    await database
      .prepare(
        "INSERT INTO oauth_authorization_requests (id, client_id, user_id, redirect_uri, state, resource, scopes, code_challenge, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        pendingId,
        id,
        principal.id,
        uri,
        url.searchParams.get("state"),
        resourceFor(request, env),
        JSON.stringify(requested),
        challenge,
        now(),
        new Date(Date.now() + 600_000).toISOString(),
      )
      .run();
    const catalog = await authorizedCatalog(
      database,
      principal,
      await readCatalog(database),
    );
    const csrf =
      env && (env.AUTH_MODE ?? "native") === "native"
        ? await csrfBootstrap(request, env)
        : { token: "", cookie: "" };
    const options = [
      ...catalog.workbooks
        .filter((item) => item.id !== "workbook:shared")
        .map((item) => ({ type: "workbook", id: item.id, title: item.title })),
      ...catalog.boards.map((item) => ({
        type: "board",
        id: item.id,
        title: item.title,
      })),
    ];
    const choices = options
      .slice(0, 200)
      .map(
        (item, index) =>
          `<label class="resource"><input type="checkbox" name="selection" value="${escapeHtml(JSON.stringify({ type: item.type, id: item.id }))}"${index === 0 ? " checked" : ""}><span>${escapeHtml(item.title)}<small>${item.type === "workbook" ? "Workbook • includes future boards" : "This board"}</small></span></label>`,
      )
      .join("");
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect ${escapeHtml(info.name)} · Huddle Loom</title><script src="/auth-consent.js"></script><link rel="stylesheet" href="/auth-consent.css"></head><body><main><a class="brand" href="/">Huddle Loom</a><section><span class="eyebrow">CONNECTED APP</span><h1>Connect ${escapeHtml(info.name)}?</h1><p>This app will act as ${escapeHtml(principal.name)}. ${info.trusted ? "Your operator has marked this client as trusted." : "This client has not been verified by your operator."}</p><ul>${requested.map((scope) => `<li>${descriptions[scope as keyof typeof descriptions]}</li>`).join("")}</ul><form method="post" action="${escapeHtml(url.pathname + url.search)}"><input type="hidden" name="request_id" value="${pendingId}"><input type="hidden" name="csrf" value="${escapeHtml(csrf.token)}"><fieldset><legend>Choose its access</legend><label><input type="radio" name="resource_mode" value="selected" checked> Selected boards and workbooks</label><div class="resources">${choices || "<p>Create a workbook before connecting an assistant.</p>"}</div><label><input type="radio" name="resource_mode" value="all"> All boards I can access, including future boards</label></fieldset><p class="hint">Your current board permissions still apply. You can disconnect this app in account settings.</p><footer><button name="decision" value="deny">Cancel</button><button class="primary" name="decision" value="allow">Connect app</button></footer></form></section></main></body></html>`;
    return new Response(body, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": consentContentSecurityPolicy(uri),
        ...(csrf.cookie ? { "Set-Cookie": csrf.cookie } : {}),
      },
    });
  }
  if (request.method !== "POST")
    throw new HttpError(405, "Method not allowed.", "invalid_request");
  const form = new URLSearchParams(
    new TextDecoder().decode(await boundedBody(request, 32768)),
  );
  const pendingId = form.get("request_id");
  const pending = await database
    .prepare(
      "SELECT * FROM oauth_authorization_requests WHERE id = ? AND user_id = ? AND expires_at > ? AND consumed_at IS NULL",
    )
    .bind(pendingId, principal.id, now())
    .first<{
      id: string;
      client_id: string;
      redirect_uri: string;
      state: string | null;
      resource: string;
      scopes: string;
      code_challenge: string;
    }>();
  if (!pending)
    throw new HttpError(
      400,
      "This connection request has expired or was already used.",
      "invalid_request",
    );
  await client(database, pending.client_id, env);
  if (form.get("decision") !== "allow") {
    await database
      .prepare(
        "UPDATE oauth_authorization_requests SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL",
      )
      .bind(now(), pending.id)
      .run();
    return errorRedirect(
      pending.redirect_uri,
      pending.state,
      origin,
      "access_denied",
    );
  }
  const mode = form.get("resource_mode") === "all" ? "all" : "selected";
  const selected: { type: "board" | "workbook"; id: string }[] = [];
  if (mode === "selected") {
    for (const raw of form.getAll("selection").slice(0, 200)) {
      let item;
      try {
        item = JSON.parse(raw);
      } catch {
        throw new HttpError(
          400,
          "Invalid resource selection.",
          "invalid_request",
        );
      }
      if (
        !item ||
        !["board", "workbook"].includes(item.type) ||
        typeof item.id !== "string"
      )
        throw new HttpError(
          400,
          "Invalid resource selection.",
          "invalid_request",
        );
      if (item.type === "board")
        await requireBoardRole(database, item.id, principal, "viewer");
      else await requireWorkbookRole(database, item.id, principal, "viewer");
      selected.push(item);
    }
    if (!selected.length)
      throw new HttpError(
        400,
        "Select at least one board or workbook.",
        "invalid_request",
      );
  }
  const decision = randomToken(18);
  const code = randomToken();
  const grantId = `oauth-grant:${crypto.randomUUID()}`;
  const result = await database.batch([
    database
      .prepare(
        "UPDATE oauth_authorization_requests SET consumed_at = ?, decision_id = ? WHERE id = ? AND user_id = ? AND consumed_at IS NULL AND expires_at > ?",
      )
      .bind(now(), decision, pending.id, principal.id, now()),
    database
      .prepare(
        "INSERT INTO oauth_grants (id, user_id, client_id, scopes, resource_mode, resources, confirmed_version, created_at) SELECT ?, ?, ?, ?, ?, ?, (SELECT consent_version FROM installation WHERE id = 'instance'), ? WHERE EXISTS(SELECT 1 FROM oauth_authorization_requests WHERE id = ? AND decision_id = ?)",
      )
      .bind(
        grantId,
        principal.id,
        pending.client_id,
        pending.scopes,
        mode,
        JSON.stringify(selected),
        now(),
        pending.id,
        decision,
      ),
    database
      .prepare(
        "INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, resource, scopes, code_challenge, created_at, expires_at, grant_id) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS(SELECT 1 FROM oauth_authorization_requests WHERE id = ? AND decision_id = ?)",
      )
      .bind(
        await sha256(code),
        pending.client_id,
        principal.id,
        pending.redirect_uri,
        pending.resource,
        pending.scopes,
        pending.code_challenge,
        now(),
        new Date(Date.now() + 60_000).toISOString(),
        grantId,
        pending.id,
        decision,
      ),
    auditStatement(
      database,
      principal.id,
      "oauth.consent_granted",
      grantId,
      "success",
      { count: selected.length },
    ),
  ]);
  if (!result[0].meta.changes)
    throw new HttpError(
      400,
      "This connection request was already used.",
      "invalid_request",
    );
  const target = new URL(pending.redirect_uri);
  target.searchParams.set("code", code);
  target.searchParams.set("iss", origin);
  if (pending.state) target.searchParams.set("state", pending.state);
  return Response.redirect(target.toString(), 302);
}
function liveGrantCondition(env?: NativeEnv) {
  return `g.revoked_at IS NULL AND c.revoked_at IS NULL AND s.status = 'active' AND s.recovery_required = 0
    AND g.confirmed_version >= i.consent_version ${env && (env.AUTH_MODE ?? "native") === "native" ? "AND i.state = 'ready' AND (au.emailVerified = 1 OR EXISTS(SELECT 1 FROM local_accounts WHERE user_id=au.id))" : ""}`;
}
function liveGrantExists(env?: NativeEnv) {
  return `EXISTS(SELECT 1 FROM oauth_grants g JOIN account_security s ON s.user_id = g.user_id
    JOIN instance_memberships m ON m.user_id = g.user_id JOIN oauth_clients c ON c.id = g.client_id
    JOIN installation i ON i.id = 'instance' LEFT JOIN auth_users au ON au.id = g.user_id
    WHERE g.id = grant_id AND ${liveGrantCondition(env)})`;
}
async function activeGrant(
  database: D1Database,
  grantId: string,
  env?: NativeEnv,
) {
  const row = await database
    .prepare(
      `SELECT g.scopes FROM oauth_grants g JOIN account_security s ON s.user_id = g.user_id
    JOIN instance_memberships m ON m.user_id = g.user_id JOIN oauth_clients c ON c.id = g.client_id
    JOIN installation i ON i.id = 'instance' LEFT JOIN auth_users au ON au.id = g.user_id
    WHERE g.id = ? AND ${liveGrantCondition(env)}`,
    )
    .bind(grantId)
    .first<{ scopes: string }>();
  if (!row)
    throw new HttpError(
      400,
      "This connection is no longer authorized.",
      "invalid_grant",
    );
  return row;
}
function intersectScopes(source: string, grant: string) {
  const permitted = new Set(JSON.parse(grant) as string[]);
  return JSON.stringify(
    (JSON.parse(source) as string[]).filter((scope) => permitted.has(scope)),
  );
}
export async function exchangeOAuthToken(
  request: Request,
  database: D1Database,
  env?: NativeEnv,
) {
  const form = new URLSearchParams(
    new TextDecoder().decode(await boundedBody(request, 16384)),
  );
  const info = await clientAuthentication(request, database, form, env);
  const grantType = form.get("grant_type");
  const access = randomToken();
  const refresh = randomToken();
  const id = `oauth-token:${crypto.randomUUID()}`;
  const marker = randomToken(18);
  const at = now();
  const expires = new Date(Date.now() + 3600_000).toISOString();
  const accessHash = await sha256(access);
  const refreshHash = await sha256(refresh);
  let record: {
    user_id: string;
    resource: string;
    scopes: string;
    grant_id: string;
    family_id?: string;
    refresh_expires_at?: string;
  };
  let changes: number;
  if (grantType === "authorization_code") {
    const code = form.get("code");
    const verifier = form.get("code_verifier");
    if (!code || !verifier || !/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier))
      throw new HttpError(
        400,
        "A valid PKCE verifier is required.",
        "invalid_request",
      );
    const hash = await sha256(code);
    const source = await database
      .prepare("SELECT * FROM oauth_codes WHERE code_hash = ?")
      .bind(hash)
      .first<{
        user_id: string;
        resource: string;
        scopes: string;
        grant_id: string;
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        expires_at: string;
        used_at: string | null;
      }>();
    if (
      !source ||
      source.used_at ||
      source.expires_at <= at ||
      source.client_id !== info.id ||
      source.redirect_uri !== form.get("redirect_uri") ||
      source.resource !== form.get("resource") ||
      source.resource !== resourceFor(request, env) ||
      source.code_challenge !== (await sha256(verifier))
    )
      throw new HttpError(
        400,
        "The authorization code is invalid.",
        "invalid_grant",
      );
    const grant = await activeGrant(database, source.grant_id, env);
    source.scopes = intersectScopes(source.scopes, grant.scopes);
    record = source;
    const family = `oauth-family:${crypto.randomUUID()}`;
    const absolute = new Date(Date.now() + 30 * 86400_000).toISOString();
    const results = await database.batch([
      database
        .prepare(
          `UPDATE oauth_codes SET used_at = ?, exchange_id = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? AND ${liveGrantExists(env)}`,
        )
        .bind(at, marker, hash, at),
      database
        .prepare(
          "INSERT INTO oauth_families (id, grant_id, absolute_expires_at) SELECT ?, ?, ? WHERE EXISTS(SELECT 1 FROM oauth_codes WHERE code_hash = ? AND exchange_id = ?)",
        )
        .bind(family, source.grant_id, absolute, hash, marker),
      database
        .prepare(
          "INSERT INTO oauth_tokens (id, access_hash, refresh_hash, client_id, user_id, resource, scopes, created_at, expires_at, refresh_expires_at, grant_id, family_id) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS(SELECT 1 FROM oauth_codes WHERE code_hash = ? AND exchange_id = ?)",
        )
        .bind(
          id,
          accessHash,
          refreshHash,
          info.id,
          source.user_id,
          source.resource,
          source.scopes,
          at,
          expires,
          absolute,
          source.grant_id,
          family,
          hash,
          marker,
        ),
    ]);
    changes = Math.min(...results.map((result) => Number(result.meta.changes)));
  } else if (grantType === "refresh_token") {
    const refreshToken = form.get("refresh_token");
    if (!refreshToken)
      throw new HttpError(400, "refresh_token is required.", "invalid_request");
    const source = await database
      .prepare("SELECT * FROM oauth_tokens WHERE refresh_hash = ?")
      .bind(await sha256(refreshToken))
      .first<{
        id: string;
        user_id: string;
        client_id: string;
        resource: string;
        scopes: string;
        grant_id: string;
        family_id: string;
        refresh_expires_at: string;
        rotated_at: string | null;
        revoked_at: string | null;
      }>();
    if (
      !source ||
      source.client_id !== info.id ||
      source.resource !== resourceFor(request, env) ||
      (form.get("resource") && form.get("resource") !== source.resource) ||
      source.refresh_expires_at <= at
    )
      throw new HttpError(
        400,
        "The refresh token is invalid.",
        "invalid_grant",
      );
    if (source.rotated_at) {
      await revokeFamily(database, source.family_id);
      throw new HttpError(
        400,
        "Refresh replay detected. Reconnect this app.",
        "invalid_grant",
      );
    }
    if (source.revoked_at)
      throw new HttpError(
        400,
        "The refresh token was revoked.",
        "invalid_grant",
      );
    const grant = await activeGrant(database, source.grant_id, env);
    source.scopes = intersectScopes(source.scopes, grant.scopes);
    const family = await database
      .prepare(
        "SELECT absolute_expires_at FROM oauth_families WHERE id = ? AND revoked_at IS NULL AND absolute_expires_at > ?",
      )
      .bind(source.family_id, at)
      .first<{ absolute_expires_at: string }>();
    if (!family)
      throw new HttpError(400, "The connection has expired.", "invalid_grant");
    record = source;
    const results = await database.batch([
      database
        .prepare(
          `UPDATE oauth_tokens SET revoked_at = ?, rotated_at = ?, rotation_id = ? WHERE id = ? AND revoked_at IS NULL AND rotated_at IS NULL AND refresh_expires_at > ? AND ${liveGrantExists(env)} AND EXISTS(SELECT 1 FROM oauth_families WHERE id = family_id AND revoked_at IS NULL AND absolute_expires_at > ?)`,
        )
        .bind(at, at, marker, source.id, at, at),
      database
        .prepare(
          "INSERT INTO oauth_tokens (id, access_hash, refresh_hash, client_id, user_id, resource, scopes, created_at, expires_at, refresh_expires_at, grant_id, family_id, parent_id) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS(SELECT 1 FROM oauth_tokens WHERE id = ? AND rotation_id = ?) AND EXISTS(SELECT 1 FROM oauth_families WHERE id = ? AND revoked_at IS NULL)",
        )
        .bind(
          id,
          accessHash,
          refreshHash,
          info.id,
          source.user_id,
          source.resource,
          source.scopes,
          at,
          expires,
          family.absolute_expires_at,
          source.grant_id,
          source.family_id,
          source.id,
          source.id,
          marker,
          source.family_id,
        ),
    ]);
    changes = Math.min(...results.map((result) => Number(result.meta.changes)));
    if (!changes) await revokeFamily(database, source.family_id);
  } else
    throw new HttpError(
      400,
      "Unsupported grant type.",
      "unsupported_grant_type",
    );
  if (!changes)
    throw new HttpError(
      400,
      "This credential was already consumed.",
      "invalid_grant",
    );
  return Response.json(
    {
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refresh,
      scope: (JSON.parse(record.scopes) as string[]).join(" "),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
async function revokeFamily(database: D1Database, familyId: string) {
  await database.batch([
    database
      .prepare("UPDATE oauth_families SET revoked_at = ? WHERE id = ?")
      .bind(now(), familyId),
    database
      .prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE family_id = ?")
      .bind(now(), familyId),
  ]);
}
export async function revokeOAuthToken(
  request: Request,
  database: D1Database,
  env?: NativeEnv,
) {
  const form = new URLSearchParams(
    new TextDecoder().decode(await boundedBody(request, 16384)),
  );
  const info = await clientAuthentication(request, database, form, env);
  const value = form.get("token");
  if (value) {
    const row = await database
      .prepare(
        "SELECT family_id FROM oauth_tokens WHERE client_id = ? AND (access_hash = ? OR refresh_hash = ?)",
      )
      .bind(info.id, await sha256(value), await sha256(value))
      .first<{ family_id: string }>();
    if (row) await revokeFamily(database, row.family_id);
  }
  return new Response(null);
}
export async function authenticateOAuth(
  request: Request,
  database: D1Database,
  env?: NativeEnv,
): Promise<Principal> {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ") || header.length > 4096)
    throw new HttpError(401, "OAuth access token required.", "invalid_token");
  const row = await database
    .prepare(
      `SELECT t.id AS tokenId, t.scopes, g.scopes AS grantScopes, t.expires_at AS expiresAt, t.grant_id AS grantId, g.resource_mode AS mode, g.resources, u.id, u.email, u.display_name AS name, u.avatar_url AS avatarUrl, u.color, u.issuer, u.subject, s.auth_version AS authVersion
    FROM oauth_tokens t JOIN users u ON u.id = t.user_id JOIN account_security s ON s.user_id = u.id JOIN oauth_grants g ON g.id = t.grant_id JOIN oauth_families f ON f.id = t.family_id JOIN oauth_clients c ON c.id = t.client_id JOIN instance_memberships m ON m.user_id = t.user_id JOIN installation i ON i.id = 'instance' LEFT JOIN auth_users au ON au.id = t.user_id
    WHERE t.access_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ? AND t.resource = ? AND f.revoked_at IS NULL AND f.absolute_expires_at > ? AND g.revoked_at IS NULL AND c.revoked_at IS NULL AND ${liveGrantCondition(env)}`,
    )
    .bind(
      await sha256(header.slice(7).trim()),
      now(),
      resourceFor(request, env),
      now(),
    )
    .first<{
      tokenId: string;
      scopes: string;
      grantScopes: string;
      expiresAt: string;
      grantId: string;
      mode: "all" | "selected";
      resources: string;
      id: string;
      email: string;
      name: string;
      avatarUrl: string | null;
      color: string;
      issuer: string;
      subject: string;
      authVersion: number;
    }>();
  if (!row)
    throw new HttpError(
      401,
      "This connected app is expired or no longer authorized.",
      "invalid_token",
    );
  await database
    .prepare(
      "UPDATE oauth_grants SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)",
    )
    .bind(now(), row.grantId, new Date(Date.now() - 60000).toISOString())
    .run();
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatarUrl,
    color: row.color,
    issuer: row.issuer,
    subject: row.subject,
    sessionId: row.tokenId,
    expiresAt: row.expiresAt,
    authentication: "oauth",
    scopes: JSON.parse(intersectScopes(row.scopes, row.grantScopes)),
    authVersion: row.authVersion,
    grantId: row.grantId,
    resourceMode: row.mode,
    resources: JSON.parse(row.resources),
  };
}
export function oauthChallenge(
  request: Request,
  error = "invalid_token",
  env?: NativeEnv,
) {
  return `Bearer resource_metadata="${originFor(request, env)}/.well-known/oauth-protected-resource", scope="${SCOPES.join(" ")}", error="${error}"`;
}
export async function listOAuthConnections(
  database: D1Database,
  principal: Principal,
) {
  const rows = await database
    .prepare(
      `SELECT g.id, g.client_id AS clientId, c.name, g.scopes, g.resource_mode AS resourceMode, g.resources, g.confirmed_version AS confirmedVersion, i.consent_version AS requiredVersion, g.created_at AS createdAt, g.last_used_at AS lastUsedAt, g.revoked_at AS revokedAt, c.revoked_at AS clientRevokedAt, MAX(CASE WHEN f.revoked_at IS NULL THEN f.absolute_expires_at END) AS refreshExpiresAt
    FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id JOIN installation i ON i.id = 'instance' LEFT JOIN oauth_families f ON f.grant_id = g.id WHERE g.user_id = ? GROUP BY g.id ORDER BY g.created_at DESC LIMIT 200`,
    )
    .bind(principal.id)
    .all<{
      id: string;
      clientId: string;
      name: string;
      scopes: string;
      resources: string;
      refreshExpiresAt: string;
      revokedAt: string | null;
      clientRevokedAt: string | null;
      confirmedVersion: number;
      requiredVersion: number;
    }>();
  return {
    connections: rows.results.map((row) => ({
      ...row,
      scopes: JSON.parse(row.scopes),
      resources: JSON.parse(row.resources),
      status:
        row.revokedAt || row.clientRevokedAt
          ? "revoked"
          : !row.refreshExpiresAt || row.refreshExpiresAt <= now()
            ? "expired"
            : row.confirmedVersion < row.requiredVersion
              ? "confirmation_required"
              : "active",
    })),
  };
}
export async function revokeOAuthConnection(
  database: D1Database,
  principal: Principal,
  grantId: string,
) {
  const grant = await database
    .prepare("SELECT id FROM oauth_grants WHERE id = ? AND user_id = ?")
    .bind(grantId, principal.id)
    .first();
  if (!grant) throw new HttpError(404, "Connected app not found.", "NOT_FOUND");
  await database.batch([
    database
      .prepare(
        "UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND user_id = ?",
      )
      .bind(now(), grantId, principal.id),
    database
      .prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ?")
      .bind(now(), grantId),
    auditStatement(database, principal.id, "oauth.disconnected", grantId),
  ]);
  return { revoked: true };
}

export async function updateOAuthConnection(
  request: Request,
  env: NativeEnv,
  principal: Principal,
  grantId: string,
) {
  if (principal.authentication === "oauth")
    throw new HttpError(
      403,
      "Use your account to manage app access.",
      "ACCOUNT_REQUIRED",
    );
  if (principal.authentication === "native") requireFresh(principal, false);
  const body = await json(request);
  const grant = await env.CATALOG.prepare(
    `SELECT g.* FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
    WHERE g.id = ? AND g.user_id = ? AND g.revoked_at IS NULL AND c.revoked_at IS NULL
    AND EXISTS(SELECT 1 FROM oauth_families f WHERE f.grant_id = g.id AND f.revoked_at IS NULL AND f.absolute_expires_at > ?)`,
  )
    .bind(grantId, principal.id, now())
    .first<{
      scopes: string;
      resource_mode: "all" | "selected";
      resources: string;
    }>();
  if (!grant)
    throw new HttpError(
      409,
      "This authorization has ended. Connect the app again.",
      "CONNECTION_ENDED",
    );
  if (
    !Array.isArray(body.scopes) ||
    !body.scopes.length ||
    body.scopes.length > 4 ||
    body.scopes.some((scope) => typeof scope !== "string")
  )
    throw new HttpError(400, "Select app permissions.", "INVALID_INPUT");
  const requested = scopes((body.scopes as string[]).join(" "));
  if (
    requested.some(
      (scope) => !(JSON.parse(grant.scopes) as string[]).includes(scope),
    )
  )
    throw new HttpError(
      400,
      "Additional permissions require a new connection.",
      "PERMISSION_EXPANSION",
    );
  if (
    !["all", "selected"].includes(String(body.resourceMode)) ||
    (grant.resource_mode === "selected" && body.resourceMode === "all")
  )
    throw new HttpError(
      400,
      "Additional board access requires a new connection.",
      "PERMISSION_EXPANSION",
    );
  const selection: { type: "board" | "workbook"; id: string }[] = [];
  if (body.resourceMode === "selected") {
    if (
      !Array.isArray(body.resources) ||
      !body.resources.length ||
      body.resources.length > 200
    )
      throw new HttpError(
        400,
        "Select at least one board or workbook.",
        "INVALID_INPUT",
      );
    const original = JSON.parse(grant.resources) as {
      type: string;
      id: string;
    }[];
    for (const item of body.resources) {
      if (
        !item ||
        typeof item !== "object" ||
        !["board", "workbook"].includes(item.type) ||
        typeof item.id !== "string"
      )
        throw new HttpError(400, "Invalid board selection.", "INVALID_INPUT");
      if (item.type === "board")
        await requireBoardRole(env.CATALOG, item.id, principal, "viewer");
      else await requireWorkbookRole(env.CATALOG, item.id, principal, "viewer");
      if (
        grant.resource_mode === "selected" &&
        !original.some(
          (value) => value.type === item.type && value.id === item.id,
        )
      ) {
        const parent =
          item.type === "board"
            ? await env.CATALOG.prepare(
                "SELECT workbook_id FROM boards WHERE id = ? AND deleted_at IS NULL",
              )
                .bind(item.id)
                .first<{ workbook_id: string }>()
            : null;
        if (
          !parent ||
          !original.some(
            (value) =>
              value.type === "workbook" && value.id === parent.workbook_id,
          )
        )
          throw new HttpError(
            400,
            "Additional board access requires a new connection.",
            "PERMISSION_EXPANSION",
          );
      }
      if (
        !selection.some(
          (value) => value.id === item.id && value.type === item.type,
        )
      )
        selection.push({ type: item.type, id: item.id });
    }
  }
  const [changed] = await env.CATALOG.batch([
    env.CATALOG.prepare(
      `UPDATE oauth_grants SET scopes = ?, resource_mode = ?, resources = ?, confirmed_version = (SELECT consent_version FROM installation WHERE id = 'instance')
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM oauth_clients c WHERE c.id = client_id AND c.revoked_at IS NULL)
      AND EXISTS(SELECT 1 FROM oauth_families f WHERE f.grant_id = oauth_grants.id AND f.revoked_at IS NULL AND f.absolute_expires_at > ?) AND scopes = ? AND resource_mode = ? AND resources = ? AND EXISTS(SELECT 1 FROM account_security s WHERE s.user_id = oauth_grants.user_id AND s.status = 'active' AND s.recovery_required = 0)`,
    ).bind(
      JSON.stringify(requested),
      body.resourceMode,
      JSON.stringify(selection),
      grantId,
      principal.id,
      now(),
      grant.scopes,
      grant.resource_mode,
      grant.resources,
    ),
  ]);
  if (!changed.meta.changes)
    throw new HttpError(
      409,
      "This authorization has ended. Connect the app again.",
      "CONNECTION_ENDED",
    );
  return { updated: true };
}
