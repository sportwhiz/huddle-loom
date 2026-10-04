import type { IdentityRepository, AppIdentity } from "./repository";
import type { SecurityState } from "./types";

export class D1IdentityRepository implements IdentityRepository {
  constructor(private readonly database: D1Database) {}
  account(userId: string) {
    return this.database
      .prepare(
        "SELECT s.*, m.role FROM account_security s LEFT JOIN instance_memberships m ON m.user_id = s.user_id WHERE s.user_id = ?",
      )
      .bind(userId)
      .first<SecurityState>();
  }
  async provision(user: AppIdentity) {
    const at = new Date().toISOString();
    await this.database.batch([
      this.database
        .prepare(
          "INSERT OR IGNORE INTO users (id,issuer,subject,email,display_name,avatar_url,color,created_at,updated_at) VALUES (?, 'urn:canvas:account', ?, ?, ?, ?, '#4262ff', ?, ?)",
        )
        .bind(
          user.id,
          user.id,
          user.email.toLowerCase(),
          user.name.slice(0, 80),
          user.image ?? null,
          at,
          at,
        ),
      this.database
        .prepare(
          "INSERT OR IGNORE INTO account_security(user_id,status,auth_version,recovery_required,created_at,updated_at) VALUES (?, 'pending_verification', 1, 0, ?, ?)",
        )
        .bind(user.id, at, at),
    ]);
  }
  async claimSetup(userId: string) {
    const result = await this.database
      .prepare(
        "UPDATE installation SET state = 'configuring', setup_user_id = ?, version = version + 1 WHERE id = 'instance' AND setup_user_id IS NULL AND state <> 'ready'",
      )
      .bind(userId)
      .run();
    return Boolean(result.meta.changes);
  }
  async consumeLimit(key: string, max: number, seconds: number, now: number) {
    const bucket = Math.floor(now / (seconds * 1000));
    const row = await this.database
      .prepare(
        "INSERT INTO request_limits(key,bucket,count,updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(key,bucket) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at RETURNING count",
      )
      .bind(key, bucket, new Date(now).toISOString())
      .first<{ count: number }>();
    return {
      allowed: Number(row?.count ?? max + 1) <= max,
      retryAfter: seconds - (Math.floor(now / 1000) % seconds),
    };
  }
}
