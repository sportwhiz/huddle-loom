import type { Pool, PoolClient } from "pg";
import type { IdentityRepository, AppIdentity } from "./repository";
import type { SecurityState } from "./types";

/** Authentication adapter proof. Board, OAuth and blob storage still require a Node port. */
export class PostgresIdentityRepository implements IdentityRepository {
  constructor(private readonly pool: Pool) {}
  async transaction<T>(work: (connection: PoolClient) => Promise<T>) {
    const connection = await this.pool.connect();
    try {
      await connection.query("BEGIN");
      const value = await work(connection);
      await connection.query("COMMIT");
      return value;
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }
  async account(userId: string) {
    const result = await this.pool.query<SecurityState>(
      "SELECT s.*,m.role FROM account_security s LEFT JOIN instance_memberships m ON m.user_id = s.user_id WHERE s.user_id = $1",
      [userId],
    );
    return result.rows[0] ?? null;
  }
  async provision(user: AppIdentity) {
    await this.transaction(async (connection) => {
      await connection.query(
        "INSERT INTO users(id,email,display_name) VALUES ($1,$2,$3) ON CONFLICT(id) DO NOTHING",
        [user.id, user.email.toLowerCase(), user.name.slice(0, 80)],
      );
      await connection.query(
        "INSERT INTO account_security(user_id,status) VALUES ($1,'pending_verification') ON CONFLICT(user_id) DO NOTHING",
        [user.id],
      );
    });
  }
  async claimSetup(userId: string) {
    const result = await this.pool.query(
      "UPDATE installation SET state = 'configuring', setup_user_id = $1, version = version + 1 WHERE id = 'instance' AND setup_user_id IS NULL AND state <> 'ready'",
      [userId],
    );
    return Boolean(result.rowCount);
  }
  async consumeLimit(key: string, max: number, seconds: number, now: number) {
    const result = await this.pool.query<{ count: number }>(
      "INSERT INTO request_limits(key,bucket,count,updated_at) VALUES ($1,$2,1,$3) ON CONFLICT(key,bucket) DO UPDATE SET count = request_limits.count + 1, updated_at = EXCLUDED.updated_at RETURNING count",
      [key, Math.floor(now / (seconds * 1000)), new Date(now)],
    );
    return {
      allowed: result.rows[0].count <= max,
      retryAfter: seconds - (Math.floor(now / 1000) % seconds),
    };
  }
  async suspend(userId: string) {
    return this.transaction(async (connection) => {
      const changed = await connection.query(
        "UPDATE account_security SET status = 'suspended',auth_version = auth_version + 1 WHERE user_id = $1 AND user_id IS DISTINCT FROM (SELECT owner_id FROM installation WHERE id = 'instance') RETURNING user_id",
        [userId],
      );
      if (!changed.rowCount) throw new Error("Protected or missing account.");
      await connection.query('DELETE FROM auth_sessions WHERE "userId" = $1', [
        userId,
      ]);
      await connection.query(
        "INSERT INTO security_outbox(kind,payload) VALUES ('invalidate',$1)",
        [JSON.stringify({ userId })],
      );
      await connection.query(
        "INSERT INTO security_audit(action,target_id) VALUES ('account.suspended',$1)",
        [userId],
      );
    });
  }
}
