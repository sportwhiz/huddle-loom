import type { NativeEnv } from "../auth/types";
import { canonicalOrigin } from "../security/config";
import { boundedBody, equal, unbase64url } from "../security/primitives";
import { HttpError } from "../security/errors";
import { clientIp, limit } from "../security/limits";

// Svix/Resend signs the exact bytes as id.timestamp.body. No parsed body is signed.
export async function mailWebhook(request: Request, env: NativeEnv) {
  if (
    !env.MAIL_WEBHOOK_SECRET ||
    (env.MAIL_PROVIDER !== "resend" && env.ENVIRONMENT !== "test")
  )
    throw new HttpError(404, "Not found.", "NOT_FOUND");
  if (
    new URL(request.url).origin !== canonicalOrigin(env) ||
    request.method !== "POST"
  )
    throw new HttpError(
      405,
      "Use the configured POST webhook endpoint.",
      "METHOD_NOT_ALLOWED",
    );
  await limit(env, "mail-webhook", clientIp(request), 120, 60);
  const id = request.headers.get("svix-id") ?? "";
  const timestamp = request.headers.get("svix-timestamp") ?? "";
  const signatures = request.headers.get("svix-signature") ?? "";
  if (
    !/^[a-zA-Z0-9_-]{1,100}$/u.test(id) ||
    !/^\d{10}$/u.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
    signatures.length > 2048
  )
    throw new HttpError(400, "Invalid webhook signature.", "INVALID_SIGNATURE");
  const body = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(await boundedBody(request, 32768));
  const rawKey = unbase64url(env.MAIL_WEBHOOK_SECRET.replace(/^whsec_/u, ""));
  if (rawKey.byteLength < 16)
    throw new HttpError(
      503,
      "The webhook signing key is invalid.",
      "MAIL_UNAVAILABLE",
    );
  const key = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${id}.${timestamp}.${body}`),
    ),
  );
  const expected = btoa(
    Array.from(digest, (value) => String.fromCharCode(value)).join(""),
  );
  if (
    !signatures
      .split(" ")
      .some(
        (value) => value.startsWith("v1,") && equal(value.slice(3), expected),
      )
  )
    throw new HttpError(400, "Invalid webhook signature.", "INVALID_SIGNATURE");
  let event: {
    type?: unknown;
    created_at?: unknown;
    data?: { email_id?: unknown; to?: unknown };
  };
  try {
    event = JSON.parse(body);
    if (!event || typeof event !== "object" || Array.isArray(event))
      throw new Error("Expected a webhook object");
  } catch {
    throw new HttpError(400, "Invalid webhook body.", "INVALID_INPUT");
  }
  const eventTime =
    typeof event.created_at === "string" &&
    Number.isFinite(Date.parse(event.created_at))
      ? new Date(event.created_at).toISOString()
      : new Date().toISOString();
  const statuses: Record<string, string> = {
    "email.delivered": "delivered",
    "email.bounced": "bounced",
    "email.complained": "complained",
    "email.failed": "failed",
    "email.delivery_delayed": "delayed",
    "email.sent": "sent",
  };
  const status = statuses[String(event.type)];
  const receipt =
    typeof event.data?.email_id === "string" &&
    event.data.email_id.length <= 200
      ? event.data.email_id
      : null;
  const statements = [
    env.CATALOG.prepare(
      "INSERT OR IGNORE INTO mail_webhook_events(id, received_at) VALUES (?, ?)",
    ).bind(id, Date.now()),
  ];
  if (receipt && status)
    statements.push(
      env.CATALOG.prepare(
        "INSERT INTO mail_delivery_receipts(provider_id,status,event_at,received_at) VALUES (?, ?, ?, ?) ON CONFLICT(provider_id) DO UPDATE SET status = excluded.status, event_at = excluded.event_at, received_at = excluded.received_at WHERE excluded.event_at >= mail_delivery_receipts.event_at",
      ).bind(receipt, status, eventTime, Date.now()),
    );
  if (
    ["bounced", "complained"].includes(status) &&
    Array.isArray(event.data?.to)
  ) {
    const addresses = event.data.to
      .filter(
        (value: unknown) =>
          typeof value === "string" &&
          value.length <= 254 &&
          /^[^@\s]+@[^@\s]+$/u.test(value),
      )
      .slice(0, 20) as string[];
    if (addresses.length)
      statements.push(
        ...addresses.map((address) =>
          env.CATALOG.prepare(
            "INSERT INTO mail_suppressions(email,reason,created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET reason = excluded.reason",
          ).bind(address.toLowerCase(), status, eventTime),
        ),
      );
  }
  await env.CATALOG.batch(statements);
  return Response.json({ received: true });
}
