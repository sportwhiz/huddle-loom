import type { NativeEnv } from "../auth/types";
import { nativePrincipal } from "../auth/session";
import {
  bootstrapAuthorized,
  installation,
  requireAdministrator,
  requireFreshForInstallation,
} from "../auth/policy";
import { email, json, randomToken, sha256 } from "../security/primitives";
import { limit } from "../security/limits";
import { HttpError } from "../security/errors";

// Preserve the identity used by nativeAuth's WeakMap while still checking the
// persisted sender on every request. A changed or removed sender takes effect
// immediately, including updates made by another Worker isolate.
const mailEnvironments = new WeakMap<
  NativeEnv,
  { sender: string; environment: NativeEnv }
>();

export async function mailEnvironment<T extends NativeEnv>(env: T): Promise<T> {
  if (
    env.AUTH_MODE === "access" ||
    env.AUTH_MODE === "development" ||
    env.MAIL_FROM ||
    env.MAIL_PROVIDER === "godaddy"
  )
    return env;
  const row = await env.CATALOG.prepare(
    "SELECT sender FROM installation_mail WHERE id='instance' AND confirmed_at IS NOT NULL",
  ).first<{ sender: string }>();
  if (!row?.sender || !env.EMAIL) {
    mailEnvironments.delete(env);
    return env;
  }
  const cached = mailEnvironments.get(env);
  if (cached?.sender === row.sender) return cached.environment as T;
  const environment: T = {
    ...env,
    MAIL_PROVIDER: "cloudflare",
    MAIL_FROM: row.sender,
    MAIL_FROM_SOURCE: "installation",
  };
  mailEnvironments.set(env, { sender: row.sender, environment });
  return environment;
}

export async function mailSetupRoutes(
  request: Request,
  env: NativeEnv,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/v1/installation/email")) return null;
  if (!["GET", "POST"].includes(request.method))
    throw new HttpError(405, "Method not allowed.", "METHOD_NOT_ALLOWED");
  const identity = await nativePrincipal(request, env, true);
  const settings = await installation(env);
  if (settings.state !== "ready") {
    if (
      !(await bootstrapAuthorized(request, env)) ||
      settings.setup_user_id !== identity.user.id
    )
      throw new HttpError(
        403,
        "Only the Studio owner can configure email.",
        "OWNER_REQUIRED",
      );
    await requireFreshForInstallation(env, identity.principal);
  } else
    await requireAdministrator(
      env,
      identity.principal,
      true,
      request.method !== "GET",
    );
  if (path === "/api/v1/installation/email" && request.method === "GET") {
    const row = await env.CATALOG.prepare(
      "SELECT sender,recipient,confirmed_at FROM installation_mail WHERE id='instance'",
    ).first<{
      sender: string;
      recipient: string;
      confirmed_at: number | null;
    }>();
    return Response.json({
      available: Boolean(env.EMAIL || env.MANAGED_MAIL),
      sender: env.MANAGED_MAIL ? "" : row?.sender || env.MAIL_FROM || "",
      recipient: row?.recipient ?? "",
      confirmed: Boolean(
        env.MANAGED_MAIL
          ? row?.confirmed_at && row.sender === ""
          : (row?.confirmed_at && row.sender) || env.MAIL_FROM,
      ),
      automaticSender: Boolean(env.MANAGED_MAIL),
      managed: Boolean(
        env.MANAGED_MAIL ||
          (env.MAIL_FROM && env.MAIL_FROM_SOURCE !== "installation"),
      ),
    });
  }
  if (request.method !== "POST")
    throw new HttpError(404, "Not found.", "NOT_FOUND");
  if (
    !env.MANAGED_MAIL &&
    env.MAIL_FROM &&
    env.MAIL_FROM_SOURCE !== "installation"
  )
    throw new HttpError(
      409,
      "Email is managed in this deployment’s configuration. Update its configured sender there.",
      "EMAIL_MANAGED",
    );
  const body = await json(request);
  if (path.endsWith("/test")) {
    await limit(env, "setup-email", identity.user.id, 3, 3600);
    const sender = env.MANAGED_MAIL ? "" : email(body.sender),
      recipient = email(body.recipient);
    await limit(env, "setup-email-recipient", recipient, 3, 3600);
    if (!env.EMAIL && !env.MANAGED_MAIL)
      throw new HttpError(
        409,
        "This deployment does not include the Cloudflare email connection. Update the installation first.",
        "EMAIL_BINDING_MISSING",
      );
    const attempt = randomToken(18);
    const code = String(
      crypto.getRandomValues(new Uint32Array(1))[0] % 1000000,
    ).padStart(6, "0");
    // Keep the active sender until its replacement is confirmed; failed tests
    // must never break existing invitations and password recovery.
    await env.CATALOG.prepare(
      "INSERT INTO installation_mail_tests(id,actor_id,sender,recipient,code_hash,expires_at) VALUES(?,?,?,?,?,?)",
    )
      .bind(
        attempt,
        identity.user.id,
        sender,
        recipient,
        await sha256(`${attempt}:${code}`),
        Date.now() + 900000,
      )
      .run();
    try {
      const message = {
        to: recipient,
        subject: "Confirm email for your Huddle Loom Studio",
        text: `Your confirmation code is ${code}. Enter it in Huddle Loom within 15 minutes to enable email.`,
        html: `<p>Your Huddle Loom confirmation code is <strong>${code}</strong>.</p><p>Enter it in your Studio within 15 minutes to enable email.</p>`,
      };
      if (env.MANAGED_MAIL) await env.MANAGED_MAIL.send(message);
      else await env.EMAIL!.send({ ...message, from: sender });
    } catch {
      await env.CATALOG.prepare(
        "DELETE FROM installation_mail_tests WHERE id=?",
      )
        .bind(attempt)
        .run();
      throw new HttpError(
        409,
        env.MANAGED_MAIL
          ? "GoDaddy could not send the test email. Check email sending in your hosting dashboard, then try again."
          : "Cloudflare could not send the test. Enable Email Sending for this sender’s domain, allow time for verification, then try again. General sending requires a Workers Paid plan.",
        "EMAIL_TEST_FAILED",
      );
    }
    return Response.json({ attempt, sent: true });
  }
  if (path.endsWith("/confirm")) {
    await limit(env, "setup-email-confirm", identity.user.id, 10, 900);
    if (
      typeof body.attempt !== "string" ||
      !/^[A-Za-z0-9_-]{24}$/u.test(body.attempt) ||
      typeof body.code !== "string" ||
      !/^\d{6}$/u.test(body.code)
    )
      throw new HttpError(
        400,
        "Enter the six-digit code from the test email.",
        "INVALID_CODE",
      );
    const [saved] = await env.CATALOG.batch([
      env.CATALOG.prepare(
        "INSERT INTO installation_mail(id,sender,recipient,confirmed_at) SELECT 'instance',sender,recipient,? FROM installation_mail_tests WHERE id=? AND actor_id=? AND code_hash=? AND expires_at>? ON CONFLICT(id) DO UPDATE SET sender=excluded.sender,recipient=excluded.recipient,confirmed_at=excluded.confirmed_at",
      ).bind(
        Date.now(),
        body.attempt,
        identity.user.id,
        await sha256(`${body.attempt}:${body.code}`),
        Date.now(),
      ),
      env.CATALOG.prepare(
        "DELETE FROM installation_mail_tests WHERE id=? AND actor_id=? AND code_hash=?",
      ).bind(
        body.attempt,
        identity.user.id,
        await sha256(`${body.attempt}:${body.code}`),
      ),
      env.CATALOG.prepare(
        "UPDATE installation SET version=version+1 WHERE id='instance'",
      ),
    ]);
    if (!saved.meta.changes)
      throw new HttpError(
        400,
        "That code has expired or is incorrect. Request a new test email.",
        "INVALID_CODE",
      );
    return Response.json({ confirmed: true });
  }
  throw new HttpError(404, "Not found.", "NOT_FOUND");
}
