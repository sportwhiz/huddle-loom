import type { NativeEnv } from "./types";
import { canonicalOrigin } from "../security/config";
import { cookie, json, randomToken, sha256 } from "../security/primitives";
import { open, seal } from "../security/secret-store";
import { clientIp, limit } from "../security/limits";
import { HttpError } from "../security/errors";

type Intent = {
  kind: "membership" | "invite" | "invitation" | "ownership";
  value: string;
  resourceId: string;
};
async function available(env: NativeEnv, intent: Intent) {
  const at = new Date().toISOString();
  if (intent.kind === "ownership")
    return env.CATALOG.prepare(
      "SELECT t.id, t.target_id AS targetId, t.expires_at AS expiresAt FROM owner_transfers t JOIN installation i ON i.owner_id = t.source_id AND i.version = t.version WHERE t.id = ? AND t.accepted_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > ?",
    )
      .bind(intent.resourceId, Date.now())
      .first<{ id: string; targetId: string; expiresAt: number }>();
  const table =
    intent.kind === "membership" ? "instance_invitations" : "invitations";
  return env.CATALOG.prepare(
    `SELECT id, email, expires_at AS expiresAt FROM ${table} WHERE id = ? AND accepted_by IS NULL AND revoked_at IS NULL AND expires_at > ?`,
  )
    .bind(intent.resourceId, at)
    .first<{ id: string; email: string; expiresAt: string }>();
}
export async function captureIntent(request: Request, env: NativeEnv) {
  await limit(env, "onboarding-intent", clientIp(request), 20, 3600);
  const body = await json(request);
  if (
    !["membership", "invite", "invitation", "ownership"].includes(
      String(body.kind),
    ) ||
    typeof body.value !== "string" ||
    body.value.length > 256
  )
    throw new HttpError(400, "Invalid invitation link.", "INVALID_INVITATION");
  const kind = body.kind as Intent["kind"];
  const table =
    kind === "ownership"
      ? "owner_transfers"
      : kind === "membership"
        ? "instance_invitations"
        : "invitations";
  const row = await env.CATALOG.prepare(
    `SELECT id FROM ${table} WHERE ${kind === "invitation" ? "id" : "token_hash"} = ?`,
  )
    .bind(kind === "invitation" ? body.value : await sha256(body.value))
    .first<{ id: string }>();
  if (!row)
    throw new HttpError(
      410,
      "This invitation is unavailable. Ask the person who invited you for a new link.",
      "INVALID_INVITATION",
    );
  const intent: Intent = { kind, value: body.value, resourceId: row.id };
  const active = await available(env, intent);
  if (!active)
    throw new HttpError(
      410,
      "This invitation has expired, was revoked, or has already been accepted.",
      "INVALID_INVITATION",
    );
  const token = randomToken();
  const hash = await sha256(token);
  const expires = Math.min(
    Date.now() + 86400_000,
    typeof active.expiresAt === "number"
      ? active.expiresAt
      : Date.parse(active.expiresAt),
  );
  const payload = await seal(env, JSON.stringify(intent), `intent:${hash}`);
  const saved = await env.CATALOG.batch([
    env.CATALOG.prepare(
      "DELETE FROM auth_return_intents WHERE expires_at <= ?",
    ).bind(Date.now()),
    env.CATALOG.prepare(
      "INSERT INTO auth_return_intents (token_hash, payload, expires_at) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM auth_return_intents) < 100000",
    ).bind(hash, payload, expires),
  ]);
  if (!saved[1].meta.changes)
    throw new HttpError(
      429,
      "Invitation entry is busy. Please try again shortly.",
      "INTENT_LIMIT",
    );
  return Response.json(
    { saved: true },
    {
      headers: {
        "Set-Cookie": `canvas-intent=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(1, Math.floor((expires - Date.now()) / 1000))}${canonicalOrigin(env).startsWith("https:") ? "; Secure" : ""}`,
      },
    },
  );
}
export async function resolveIntent(
  request: Request,
  env: NativeEnv,
  user?: { id: string; email: string; emailVerified: boolean },
) {
  if (
    !user ||
    (!user.emailVerified &&
      !(await env.CATALOG.prepare(
        "SELECT 1 FROM local_accounts WHERE user_id=?",
      )
        .bind(user.id)
        .first()))
  )
    return undefined;
  const token = cookie(request, "canvas-intent");
  if (!token) return undefined;
  const hash = await sha256(token);
  const row = await env.CATALOG.prepare(
    "SELECT payload FROM auth_return_intents WHERE token_hash = ? AND expires_at > ?",
  )
    .bind(hash, Date.now())
    .first<{ payload: string }>();
  if (!row) return undefined;
  const intent = JSON.parse(
    await open(env, row.payload, `intent:${hash}`),
  ) as Intent;
  const active = await available(env, intent);
  if (
    !active ||
    ("email" in active
      ? active.email.toLowerCase() !== user.email.toLowerCase()
      : active.targetId !== user.id)
  )
    return undefined;
  return intent.kind === "ownership"
    ? `/account/owner-transfer#token=${encodeURIComponent(intent.value)}`
    : `/invite#${intent.kind}=${encodeURIComponent(intent.value)}`;
}
