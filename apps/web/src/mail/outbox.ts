import type { NativeEnv } from "../auth/types";
import { HttpError } from "../security/errors";
import { boundedBody, escapeHtml, randomToken } from "../security/primitives";
import { open, seal } from "../security/secret-store";
type Mail = { to: string; subject: string; text: string; html: string };
export function mailReady(env: NativeEnv) {
  return Boolean(
    (env.MAIL_PROVIDER === "godaddy" && env.MANAGED_MAIL) ||
      (env.MAIL_FROM &&
        ((env.MAIL_PROVIDER === "cloudflare" && env.EMAIL) ||
          (env.MAIL_PROVIDER === "resend" && env.MAIL_API_KEY) ||
          (env.MAIL_PROVIDER === "test" && env.ENVIRONMENT === "test"))),
  );
}
export async function queueMail(
  env: NativeEnv,
  to: string,
  subject: string,
  message: string,
  url?: string,
  expiresAt = Date.now() + 86_400_000,
) {
  if (!mailReady(env))
    throw new HttpError(
      503,
      "Email delivery is unavailable. Ask the operator to configure it.",
      "MAIL_UNAVAILABLE",
    );
  const payload: Mail = {
    to,
    subject,
    text: `${message}${url ? `\n\n${url}` : ""}`,
    html: `<p>${escapeHtml(message)}</p>${url ? `<p><a href="${escapeHtml(url)}">Continue in Open Whiteboard</a></p>` : ""}`,
  };
  const id = randomToken(18);
  const encrypted = await seal(env, JSON.stringify(payload), `mail:${id}`);
  await env.CATALOG.prepare(
    "INSERT INTO security_outbox (id, kind, payload, expires_at, next_attempt_at, attempts, status, created_at) VALUES (?, 'mail', ?, ?, ?, 0, 'pending', ?)",
  )
    .bind(id, encrypted, expiresAt, Date.now(), Date.now())
    .run();
  return id;
}
export async function processOutbox(env: NativeEnv, max = 20) {
  const now = Date.now();
  await env.CATALOG.prepare(
    "UPDATE security_outbox SET status = 'expired', payload = '' WHERE expires_at <= ? AND status IN ('pending', 'processing')",
  )
    .bind(now)
    .run();
  const jobs = await env.CATALOG.prepare(
    "SELECT * FROM security_outbox WHERE (status = 'pending' OR (status = 'processing' AND lease_until < ?)) AND next_attempt_at <= ? AND expires_at > ? ORDER BY next_attempt_at LIMIT ?",
  )
    .bind(now, now, now, max)
    .all<{ id: string; kind: string; payload: string; attempts: number }>();
  for (const candidate of jobs.results) {
    // Earlier deliveries may have waited on their providers. Each claim needs
    // a fresh lease, rather than the timestamp at the start of the whole batch.
    const leaseNow = Date.now();
    const leaseKey = randomToken(18);
    const job = await env.CATALOG.prepare(
      "UPDATE security_outbox SET status = 'processing', lease_until = ?, lease_key = ?, attempts = attempts + 1 WHERE id = ? AND (status = 'pending' OR (status = 'processing' AND lease_until < ?)) AND next_attempt_at <= ? AND expires_at > ? RETURNING id, kind, payload, attempts",
    )
      .bind(
        leaseNow + 60_000,
        leaseKey,
        candidate.id,
        leaseNow,
        leaseNow,
        leaseNow,
      )
      .first<{ id: string; kind: string; payload: string; attempts: number }>();
    if (!job) continue;
    try {
      let providerId: string | null = null;
      if (job.kind === "mail") {
        const message = JSON.parse(
          await open(env, job.payload, `mail:${job.id}`),
        ) as Mail;
        const suppressed = await env.CATALOG.prepare(
          "SELECT 1 FROM mail_suppressions WHERE email = ?",
        )
          .bind(message.to.toLowerCase())
          .first();
        if (suppressed) {
          await env.CATALOG.prepare(
            "UPDATE security_outbox SET status = 'suppressed', payload = '', lease_key = NULL, lease_until = NULL, last_error = 'Recipient delivery is suppressed after a bounce or complaint.' WHERE id = ? AND lease_key = ?",
          )
            .bind(job.id, leaseKey)
            .run();
          continue;
        }
        if (env.MAIL_PROVIDER === "godaddy" && env.MANAGED_MAIL)
          providerId = (await env.MANAGED_MAIL.send(message)).providerId;
        else if (env.MAIL_PROVIDER === "cloudflare" && env.EMAIL)
          await env.EMAIL.send({ from: env.MAIL_FROM!, ...message });
        else if (env.MAIL_PROVIDER === "resend" && env.MAIL_API_KEY) {
          const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.MAIL_API_KEY}`,
              "Content-Type": "application/json",
              "Idempotency-Key": job.id,
            },
            body: JSON.stringify({ from: env.MAIL_FROM, ...message }),
            signal: AbortSignal.timeout(15_000),
            redirect: "manual",
          });
          if (!response.ok) throw new Error("delivery rejected");
          const receipt = JSON.parse(
            new TextDecoder().decode(await boundedBody(response, 32768)),
          ) as { id?: unknown };
          if (typeof receipt.id !== "string")
            throw new Error("missing delivery receipt");
          providerId = receipt.id;
        } else if (env.MAIL_PROVIDER === "test" && env.ENVIRONMENT === "test") {
          // Keep encrypted fixture content for private CLI assertions.
          await env.CATALOG.prepare(
            "UPDATE security_outbox SET status = 'accepted', lease_until = NULL, lease_key = NULL WHERE id = ? AND lease_key = ?",
          )
            .bind(job.id, leaseKey)
            .run();
          continue;
        } else throw new Error("sender unavailable");
      } else if (job.kind === "invalidate") {
        const body = JSON.parse(job.payload) as {
          userId: string;
          after?: string;
        };
        const rooms = await env.CATALOG.prepare(
          "SELECT DISTINCT board_id FROM active_connections WHERE user_id = ? AND expires_at > ? AND board_id > ? ORDER BY board_id LIMIT 51",
        )
          .bind(body.userId, Date.now(), body.after ?? "")
          .all<{ board_id: string }>();
        if (!env.BOARD_ROOMS) throw new Error("rooms unavailable");
        const selected = rooms.results.slice(0, 50);
        for (let offset = 0; offset < selected.length; offset += 5) {
          await Promise.all(
            selected.slice(offset, offset + 5).map(async (room) => {
              const response = await env
                .BOARD_ROOMS!.getByName(room.board_id)
                .fetch("https://board-room/invalidate", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(body),
                  signal: AbortSignal.timeout(5000),
                });
              if (!response.ok) throw new Error("invalidation rejected");
            }),
          );
        }
        if (rooms.results.length > 50) {
          await env.CATALOG.prepare(
            "UPDATE security_outbox SET status = 'pending', payload = ?, next_attempt_at = ?, attempts = 0, lease_until = NULL, lease_key = NULL WHERE id = ? AND lease_key = ?",
          )
            .bind(
              JSON.stringify({
                userId: body.userId,
                after: selected.at(-1)!.board_id,
              }),
              Date.now(),
              job.id,
              leaseKey,
            )
            .run();
          continue;
        }
      }
      await env.CATALOG.prepare(
        "UPDATE security_outbox SET status = 'accepted', payload = '', lease_until = NULL, lease_key = NULL, provider_id = ?, last_error = NULL WHERE id = ? AND lease_key = ?",
      )
        .bind(providerId, job.id, leaseKey)
        .run();
    } catch {
      const dead = job.attempts >= 8;
      await env.CATALOG.prepare(
        "UPDATE security_outbox SET status = ?, next_attempt_at = ?, lease_until = NULL, lease_key = NULL, last_error = ? WHERE id = ? AND lease_key = ?",
      )
        .bind(
          dead ? "failed" : "pending",
          Date.now() + Math.min(3_600_000, 30_000 * 2 ** (job.attempts - 1)),
          job.kind === "mail"
            ? "Delivery failed; check sender configuration or recipient suppression."
            : "Connection update failed; it will be retried. Session authorization remains enforced.",
          job.id,
          leaseKey,
        )
        .run();
    }
  }
}
export function invalidationStatement(env: NativeEnv, userId: string) {
  return env.CATALOG.prepare(
    "INSERT INTO security_outbox (id, kind, payload, expires_at, next_attempt_at, attempts, status, created_at) VALUES (?, 'invalidate', ?, ?, ?, 0, 'pending', ?)",
  ).bind(
    randomToken(18),
    JSON.stringify({ userId }),
    Date.now() + 86_400_000,
    Date.now(),
    Date.now(),
  );
}
