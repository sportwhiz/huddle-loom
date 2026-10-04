import { decodeJwt } from "jose";
import type { NativeEnv } from "./types";
import { sha256 } from "../security/primitives";
import { canonicalOrigin } from "../security/config";
import { queueMail } from "../mail/outbox";
import { HttpError } from "../security/errors";

export async function queueEmailProof(
  env: NativeEnv,
  user: { id: string; email: string },
  token: string,
  subject: string,
  message: string,
) {
  const proof = decodeJwt(token);
  const purpose =
    typeof proof.requestType === "string"
      ? proof.requestType
      : "email-verification";
  const state = await env.CATALOG.prepare(
    "SELECT auth_version FROM account_security WHERE user_id = ?",
  )
    .bind(user.id)
    .first<{ auth_version: number }>();
  if (
    (!state && purpose !== "email-verification") ||
    typeof proof.exp !== "number" ||
    ![
      "email-verification",
      "change-email-confirmation",
      "change-email-verification",
    ].includes(purpose)
  )
    throw new HttpError(
      503,
      "Email confirmation could not be prepared.",
      "MAIL_UNAVAILABLE",
    );
  const expires = proof.exp * 1000;
  await env.CATALOG.batch([
    ...(purpose === "change-email-confirmation"
      ? [
          env.CATALOG.prepare(
            "DELETE FROM auth_email_proofs WHERE user_id = ? AND purpose LIKE 'change-email-%'",
          ).bind(user.id),
        ]
      : []),
    env.CATALOG.prepare(
      "INSERT INTO auth_email_proofs (user_id, purpose, token_hash, auth_version, new_email, expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, purpose) DO UPDATE SET token_hash = excluded.token_hash, auth_version = excluded.auth_version, new_email = excluded.new_email, expires_at = excluded.expires_at",
    ).bind(
      user.id,
      purpose,
      await sha256(token),
      state?.auth_version ?? 1,
      typeof proof.updateTo === "string" ? proof.updateTo.toLowerCase() : null,
      expires,
    ),
  ]);
  return queueMail(
    env,
    user.email,
    subject,
    message,
    `${canonicalOrigin(env)}/verify#token=${encodeURIComponent(token)}`,
    expires,
  );
}
export async function currentEmailProof(env: NativeEnv, token: string) {
  const row = await env.CATALOG.prepare(
    "SELECT p.user_id FROM auth_email_proofs p JOIN account_security s ON s.user_id = p.user_id WHERE p.token_hash = ? AND p.auth_version = s.auth_version AND p.expires_at > ? AND s.status NOT IN ('suspended','deletion_pending','deleted')",
  )
    .bind(await sha256(token), Date.now())
    .first<{ user_id: string }>();
  if (!row)
    throw new HttpError(
      410,
      "This confirmation was replaced or has expired. Request a new message.",
      "INVALID_TOKEN",
    );
  return row;
}
