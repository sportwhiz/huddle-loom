import { randomToken } from "./primitives";
export function auditStatement(
  database: D1Database,
  actor: string | null,
  action: string,
  target: string | null = null,
  outcome = "success",
  metadata: Record<string, string | number | boolean | null> = {},
) {
  // Callers pass fixed, reviewed fields. Never pass request bodies, URLs, headers or exceptions.
  const allowed = Object.fromEntries(
    Object.entries(metadata)
      .filter(([key]) =>
        /^(role|status|count|provider|reason|version|kind|bytes|policy|recipientId)$/u.test(
          key,
        ),
      )
      .map(([key, value]) => [
        key,
        typeof value === "string" ? value.slice(0, 160) : value,
      ]),
  );
  return database
    .prepare(
      "INSERT INTO security_audit (id, actor_id, action, target_id, outcome, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      randomToken(18),
      actor,
      action.slice(0, 100),
      target,
      outcome,
      JSON.stringify(allowed),
      new Date().toISOString(),
    );
}
export async function audit(
  database: D1Database,
  actor: string | null,
  action: string,
  target?: string | null,
  outcome?: string,
  metadata?: Record<string, string | number | boolean | null>,
) {
  await auditStatement(
    database,
    actor,
    action,
    target,
    outcome,
    metadata,
  ).run();
}
