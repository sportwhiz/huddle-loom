import type { NativeEnv } from "../auth/types";
import { nativePrincipal } from "../auth/session";
import { requireAdministrator } from "../auth/policy";
import { auditStatement } from "../security/audit";
import { json, randomToken, sha256, text } from "../security/primitives";
import { HttpError } from "../security/errors";
export async function clientRoutes(request: Request, env: NativeEnv) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/v1/admin/clients")) return null;
  const { principal } = await nativePrincipal(request, env);
  await requireAdministrator(env, principal, true, request.method !== "GET");
  if (path === "/api/v1/admin/clients" && request.method === "GET") {
    const after = new URL(request.url).searchParams.get("after") ?? "";
    if (after.length > 200)
      throw new HttpError(400, "Invalid cursor.", "INVALID_INPUT");
    const rows = await env.CATALOG.prepare(
      "SELECT id, name, redirect_uris AS redirectUris, auth_method AS authMethod, trusted, revoked_at AS revokedAt, created_at AS createdAt FROM oauth_clients WHERE id > ? ORDER BY id LIMIT 51",
    )
      .bind(after)
      .all<{ id: string; redirectUris: string; trusted: number }>();
    return Response.json({
      clients: rows.results.slice(0, 50).map((row) => ({
        ...row,
        redirectUris: JSON.parse(row.redirectUris),
        trusted: Boolean(row.trusted),
      })),
      next: rows.results.length > 50 ? rows.results[49].id : null,
    });
  }
  if (path === "/api/v1/admin/clients" && request.method === "POST") {
    const body = await json(request);
    const name = text(body.name, "Client name");
    if (
      !Array.isArray(body.redirectUris) ||
      !body.redirectUris.length ||
      body.redirectUris.length > 20
    )
      throw new HttpError(
        400,
        "Add 1–20 exact redirect addresses.",
        "INVALID_INPUT",
      );
    for (const value of body.redirectUris) {
      if (typeof value !== "string" || value.length > 2048)
        throw new HttpError(400, "Invalid redirect address.", "INVALID_INPUT");
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new HttpError(
          400,
          "Invalid redirect address.",
          "INVALID_REDIRECT",
        );
      }
      if (
        url.username ||
        url.password ||
        url.hash ||
        (url.protocol !== "https:" &&
          !(
            url.protocol === "http:" &&
            ["127.0.0.1", "[::1]"].includes(url.hostname)
          ))
      )
        throw new HttpError(
          400,
          "Use HTTPS or an IP loopback redirect for a native client.",
          "INVALID_REDIRECT",
        );
    }
    if (!["none", "client_secret_basic"].includes(String(body.authMethod)))
      throw new HttpError(
        400,
        "Choose a supported client authentication method.",
        "INVALID_INPUT",
      );
    const id = `client:${crypto.randomUUID()}`;
    const secret =
      body.authMethod === "client_secret_basic" ? randomToken() : null;
    await env.CATALOG.batch([
      env.CATALOG.prepare(
        "INSERT INTO oauth_clients (id, name, redirect_uris, created_at, auth_method, secret_hash, trusted) VALUES (?, ?, ?, ?, ?, ?, 1)",
      ).bind(
        id,
        name,
        JSON.stringify([...new Set(body.redirectUris)]),
        new Date().toISOString(),
        body.authMethod,
        secret ? await sha256(secret) : null,
      ),
      auditStatement(
        env.CATALOG,
        principal.id,
        "oauth.client_registered",
        id,
        "success",
        { kind: String(body.authMethod) },
      ),
    ]);
    return Response.json(
      { id, clientSecret: secret, shownOnce: Boolean(secret) },
      { status: 201 },
    );
  }
  const match = path.match(
    /^\/api\/v1\/admin\/clients\/([^/]+)\/(revoke|rotate-secret|trust)$/u,
  );
  if (match && request.method === "POST") {
    const id = decodeURIComponent(match[1]);
    const client = await env.CATALOG.prepare(
      "SELECT auth_method, revoked_at FROM oauth_clients WHERE id = ?",
    )
      .bind(id)
      .first<{ auth_method: string; revoked_at: string | null }>();
    if (!client || client.revoked_at)
      throw new HttpError(404, "Active client not found.", "NOT_FOUND");
    const at = new Date().toISOString();
    const secret = match[2] === "rotate-secret" ? randomToken() : null;
    if (secret && client.auth_method !== "client_secret_basic")
      throw new HttpError(
        409,
        "Public clients use PKCE and have no secret to rotate.",
        "PUBLIC_CLIENT",
      );
    const body = await json(request);
    await env.CATALOG.batch([
      match[2] === "revoke"
        ? env.CATALOG.prepare(
            "UPDATE oauth_clients SET revoked_at = ? WHERE id = ?",
          ).bind(at, id)
        : secret
          ? env.CATALOG.prepare(
              "UPDATE oauth_clients SET secret_hash = ? WHERE id = ?",
            ).bind(await sha256(secret), id)
          : env.CATALOG.prepare(
              "UPDATE oauth_clients SET trusted = ? WHERE id = ?",
            ).bind(body.trusted === true ? 1 : 0, id),
      ...(["revoke", "rotate-secret"].includes(match[2])
        ? [
            env.CATALOG.prepare(
              "UPDATE oauth_grants SET revoked_at = ? WHERE client_id = ?",
            ).bind(at, id),
            env.CATALOG.prepare(
              "UPDATE oauth_tokens SET revoked_at = ? WHERE client_id = ?",
            ).bind(at, id),
          ]
        : []),
      auditStatement(env.CATALOG, principal.id, `oauth.client_${match[2]}`, id),
    ]);
    return Response.json({
      updated: true,
      ...(secret ? { clientSecret: secret, shownOnce: true } : {}),
    });
  }
  throw new HttpError(404, "Client action not found.", "NOT_FOUND");
}
