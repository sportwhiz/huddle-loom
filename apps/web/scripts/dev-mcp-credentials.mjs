import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

/** Real OAuth fixture for explicitly enabled local development servers. */
export async function developmentMcpCredentials(base) {
  const origin = new URL(base).origin;
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
  const bootstrap = await (
    await fetch(`${origin}/api/v1/auth/bootstrap`)
  ).json();
  assert.equal(
    bootstrap.mode,
    "development",
    "Use the isolated development fixture; never mint test grants against a personal deployment.",
  );
  const response = await fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "MCP authoring regression fixture",
      redirect_uris: ["http://127.0.0.1:9876/callback"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(response.status, 201);
  const client = await response.json();
  const verifier = randomBytes(48).toString("base64url"),
    resource = `${origin}/mcp`;
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: "http://127.0.0.1:9876/callback",
    response_type: "code",
    scope: "boards:read boards:write boards:export collaboration:write",
    resource,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const consent = await fetch(`${origin}/oauth/authorize?${params}`, {
    headers: { Accept: "text/html" },
  });
  assert.equal(consent.status, 200);
  const requestId = (await consent.text()).match(
    /name="request_id" value="([^"]+)"/u,
  )?.[1];
  assert.ok(requestId);
  const approved = await fetch(`${origin}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: origin,
    },
    body: new URLSearchParams({
      request_id: requestId,
      decision: "allow",
      resource_mode: "all",
    }),
  });
  assert.equal(approved.status, 302);
  const code = new URL(approved.headers.get("Location")).searchParams.get(
    "code",
  );
  const exchange = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: "http://127.0.0.1:9876/callback",
      resource,
    }),
  });
  assert.equal(exchange.status, 200);
  const token = await exchange.json();
  return {
    headers: { Authorization: `Bearer ${token.access_token}` },
    async revoke() {
      await fetch(`${origin}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.client_id,
          token: token.refresh_token,
          token_type_hint: "refresh_token",
        }),
      });
    },
  };
}
