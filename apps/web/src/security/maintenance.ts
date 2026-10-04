import type { NativeEnv } from "../auth/types";
import { finishAccountDeletion } from "../auth/account-routes";
import { processOutbox } from "../mail/outbox";
import { reconcileAssets } from "../storage.server";

export async function securityMaintenance(env: NativeEnv) {
  const outcomes = await Promise.allSettled([
    env.BLOBS
      ? reconcileAssets({ ...env, BLOBS: env.BLOBS })
      : Promise.resolve(),
    processOutbox(env),
  ]);
  for (const [index, result] of outcomes.entries())
    if (result.status === "rejected")
      console.error(
        index === 0
          ? "Asset reconciliation failed; retrying on the next schedule."
          : "Outbox processing failed; retrying on the next schedule.",
      );
  const pending = await env.CATALOG.prepare(
    "SELECT user_id, deletion_actor_id FROM account_security WHERE status = 'deletion_pending' LIMIT 20",
  ).all<{ user_id: string; deletion_actor_id: string | null }>();
  for (const account of pending.results)
    await finishAccountDeletion(
      env,
      account.user_id,
      account.deletion_actor_id ?? "operator",
    );
  const now = Date.now();
  const at = new Date(now).toISOString();
  await env.CATALOG.batch([
    env.CATALOG.prepare('DELETE FROM guest_board_sessions WHERE expires_at <= ?').bind(at),
    env.CATALOG.prepare("DELETE FROM installation_mail_tests WHERE expires_at<=?").bind(now),
    env.CATALOG.prepare(
      "DELETE FROM security_audit WHERE id IN (SELECT id FROM security_audit WHERE created_at < ? ORDER BY created_at LIMIT 500)",
    ).bind(new Date(now - 90 * 86400_000).toISOString()),
    env.CATALOG.prepare(
      "DELETE FROM emergency_recovery WHERE expires_at <= ?",
    ).bind(now),
    env.CATALOG.prepare(
      "DELETE FROM auth_return_intents WHERE expires_at <= ?",
    ).bind(now),
    env.CATALOG.prepare(
      "DELETE FROM auth_email_proofs WHERE expires_at <= ?",
    ).bind(now),
    env.CATALOG.prepare(
      "DELETE FROM mail_delivery_receipts WHERE received_at < ?",
    ).bind(now - 30 * 86400_000),
    env.CATALOG.prepare(
      "DELETE FROM setup_sessions WHERE expires_at <= ?",
    ).bind(now),
    env.CATALOG.prepare("DELETE FROM mfa_replay WHERE expires_at <= ?").bind(
      now,
    ),
    env.CATALOG.prepare(
      "DELETE FROM active_connections WHERE expires_at <= ?",
    ).bind(now),
    env.CATALOG.prepare("DELETE FROM request_limits WHERE updated_at < ?").bind(
      new Date(now - 7 * 86400_000).toISOString(),
    ),
    env.CATALOG.prepare(
      "DELETE FROM auth_sessions WHERE expiresAt <= ? OR absoluteExpiresAt <= ?",
    ).bind(at, at),
    env.CATALOG.prepare(
      "DELETE FROM mail_webhook_events WHERE received_at < ?",
    ).bind(now - 7 * 86400_000),
    env.CATALOG.prepare(
      "UPDATE security_outbox SET status = 'expired', payload = '', lease_key = NULL WHERE expires_at <= ? AND status <> 'accepted'",
    ).bind(now),
    env.CATALOG.prepare(
      "DELETE FROM security_outbox WHERE created_at < ? AND status IN ('expired','accepted','suppressed')",
    ).bind(now - 30 * 86400_000),
  ]);
}
