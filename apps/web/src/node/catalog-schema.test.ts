import { randomUUID } from "node:crypto";
import { createPool, type Pool, type PoolConnection } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CATALOG_TABLES,
  CATALOG_TRIGGERS,
  migrateCatalogSchema,
} from "./catalog-schema";

it("exports primary keys for every catalog table and native security triggers", () => {
  for (const table of Object.values(CATALOG_TABLES))
    expect(table.primaryKey.length).toBeGreaterThan(0);
  expect(
    CATALOG_TRIGGERS.some((trigger) =>
      /RAISE\(|json_each|strftime|UPDATE OF /.test(trigger.sql),
    ),
  ).toBe(false);
  expect(
    CATALOG_TRIGGERS.find((trigger) => trigger.name === "bound_session_expiry")
      ?.sql,
  ).toContain("SET NEW.expiresAt");
});

// Dedicated, disposable database only. Never infer production DB_* settings.
describe.skipIf(!process.env.HUDDLE_SCHEMA_TEST_MYSQL_URL)(
  "native MySQL catalog security invariants",
  () => {
    let pool: Pool;
    const at = "2026-10-03T20:00:00.000Z";
    beforeAll(async () => {
      const url = process.env.HUDDLE_SCHEMA_TEST_MYSQL_URL!;
      if (!new URL(url).pathname.endsWith("_test"))
        throw new Error("A disposable *_test database is required");
      pool = createPool(url);
      await Promise.all([
        migrateCatalogSchema(pool),
        migrateCatalogSchema(pool),
      ]);
    }, 30_000);
    afterAll(async () => {
      await pool?.end();
    });
    async function transaction(
      work: (connection: PoolConnection) => Promise<void>,
    ) {
      const connection = await pool.getConnection();
      try {
        await connection.query("SET @hl_catalog_update_columns = NULL");
        await connection.query(
          "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
        );
        await connection.beginTransaction();
        await connection.query(
          "SELECT id FROM hl_catalog_mutex WHERE id=1 FOR UPDATE",
        );
        await work(connection);
      } finally {
        await connection.rollback();
        connection.release();
      }
    }
    async function user(connection: PoolConnection, role?: string) {
      const id = randomUUID();
      await connection.execute(
        "INSERT INTO users(id,issuer,subject,email,display_name,color,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [id, "urn:test", id, id + "@test.invalid", "Test", "#000000", at, at],
      );
      await connection.execute(
        "INSERT INTO auth_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)",
        [id, "Test", id + "@test.invalid", at, at],
      );
      await connection.execute(
        "INSERT INTO account_security(user_id,status,created_at,updated_at) VALUES (?,'active',?,?)",
        [id, at, at],
      );
      if (role)
        await connection.execute(
          "INSERT INTO instance_memberships(user_id,role,created_at) VALUES (?,?,?)",
          [id, role, at],
        );
      return id;
    }
    it("indexes expiry for global guest quotas and cleanup", async () => {
      const [rows] = await pool.query("SELECT COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='guest_board_sessions' AND INDEX_NAME='guest_sessions_expiry' ORDER BY SEQ_IN_INDEX");
      expect(rows).toEqual([{COLUMN_NAME:'expires_at'}]);
    });
    it("supports shadow guest sessions and enforces guest link constraints", async () => {
      await transaction(async connection => {
        const owner = await user(connection);
        const guest = randomUUID(), board = randomUUID(), workbook = randomUUID(), link = randomUUID();
        await connection.execute("INSERT INTO users(id,issuer,subject,email,display_name,color,created_at,updated_at) VALUES (?,'guest',?,'guest@test.invalid','Guest','#000000',?,?)", [guest,guest,at,at]);
        await connection.execute("INSERT INTO workbooks(id,title,created_at) VALUES (?,'Guest test',?)", [workbook,at]);
        await connection.execute("INSERT INTO boards(id,workbook_id,title,created_at,updated_at) VALUES (?,?,'Guest test',?,?)", [board,workbook,at,at]);
        const insert = "INSERT INTO guest_board_links(id,board_id,created_by,token_hash,token_ciphertext,role,created_at) VALUES (?,?,?,?,?,?,?)";
        await connection.execute(insert,[link,board,owner,link,'encrypted','editor',at]);
        await expect(connection.execute(insert,[randomUUID(),board,owner,randomUUID(),'encrypted','owner',at])).rejects.toMatchObject({errno:3819});
        await expect(connection.execute(insert,[randomUUID(),board,owner,link,'encrypted','viewer',at])).rejects.toMatchObject({errno:1062});
        await expect(connection.execute(insert,[randomUUID(),randomUUID(),owner,randomUUID(),'encrypted','viewer',at])).rejects.toMatchObject({errno:1452});
        await connection.execute("INSERT INTO guest_board_sessions(id,link_id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?,?)",[randomUUID(),link,guest,randomUUID(),at,at]);
        const [rows] = await connection.execute("SELECT (SELECT COUNT(*) FROM auth_users WHERE id=?) accounts,(SELECT COUNT(*) FROM account_security WHERE user_id=?) security",[guest,guest]);
        expect(rows).toEqual([{accounts:0,security:0}]);
        await expect(connection.execute("DELETE FROM guest_board_links WHERE id=?",[link])).rejects.toMatchObject({errno:1451});
      });
    });
    async function account(connection: PoolConnection, id: string) {
      const accountId = randomUUID();
      await connection.execute(
        "INSERT INTO auth_accounts(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (?,?,'credential',?,'old',?,?)",
        [accountId, id, id, at, at],
      );
      return accountId;
    }
    async function session(connection: PoolConnection, id: string) {
      const sessionId = randomUUID();
      await connection.execute(
        "INSERT INTO auth_sessions(id,expiresAt,token,createdAt,updatedAt,userId,absoluteExpiresAt,authenticatedAt,assurance,authVersion) VALUES (?,?,?,?,?,?,?,?,'mfa',1)",
        [
          sessionId,
          "2027-01-01T00:00:00.000Z",
          randomUUID(),
          at,
          at,
          id,
          "2027-02-01T00:00:00.000Z",
          at,
        ],
      );
      return sessionId;
    }
    async function workbook(connection: PoolConnection) {
      const id = randomUUID();
      await connection.execute(
        "INSERT INTO workbooks(id,title,created_at) VALUES (?, ?, ?)",
        [id, "Book", at],
      );
      return id;
    }
    it("preserves a bounded verification window in the native catalog", () =>
      transaction(async (connection) => {
        expect((await connection.query("SELECT reauthentication_seconds FROM installation"))[0]).toEqual([{ reauthentication_seconds: 1800 }]);
        for (const invalid of [299, 43201])
          await expect(connection.execute("UPDATE installation SET reauthentication_seconds=?", [invalid])).rejects.toThrow();
        for (const valid of [300, 3600, 43200]) {
          await connection.execute("UPDATE installation SET reauthentication_seconds=?", [valid]);
          expect((await connection.query("SELECT reauthentication_seconds FROM installation"))[0]).toEqual([{ reauthentication_seconds: valid }]);
        }
      }));
    it("protects the designated owner and enforces only one owner", () =>
      transaction(async (connection) => {
        const owner = await user(connection, "owner");
        await connection.execute(
          "UPDATE installation SET owner_id=?,state='ready' WHERE id='instance'",
          [owner],
        );
        await expect(
          connection.execute(
            "DELETE FROM instance_memberships WHERE user_id=?",
            [owner],
          ),
        ).rejects.toThrow("LAST_OWNER");
        await expect(
          connection.execute(
            "UPDATE instance_memberships SET role='member' WHERE user_id=?",
            [owner],
          ),
        ).rejects.toThrow("LAST_OWNER");
        await expect(
          connection.execute(
            "UPDATE account_security SET status='suspended' WHERE user_id=?",
            [owner],
          ),
        ).rejects.toThrow("LAST_OWNER");
        const other = await user(connection);
        await expect(
          connection.execute(
            "INSERT INTO instance_memberships(user_id,role,created_at) VALUES (?,'owner',?)",
            [other, at],
          ),
        ).rejects.toThrow();
      }));
    it("rejects new seats at capacity", () =>
      transaction(async (connection) => {
        await connection.execute("UPDATE installation SET member_limit=1");
        await user(connection, "member");
        const other = await user(connection);
        await expect(
          connection.execute(
            "INSERT INTO instance_memberships(user_id,role,created_at) VALUES (?,'member',?)",
            [other, at],
          ),
        ).rejects.toThrow("SEAT_LIMIT");
      }));
    it("rejects removal of the final credential and validates method guard rows", () =>
      transaction(async (connection) => {
        const id = await user(connection);
        const credential = await account(connection, id);
        await expect(
          connection.execute("DELETE FROM auth_accounts WHERE id=?", [
            credential,
          ]),
        ).rejects.toThrow("LAST_METHOD");
        await expect(
          connection.execute(
            "INSERT INTO auth_method_changes(id,user_id,deployed_providers,password_enabled,database_oidc_enabled) VALUES (?,?,'[]',0,0)",
            [randomUUID(), id],
          ),
        ).rejects.toThrow("LAST_METHOD");
        await expect(
          connection.execute(
            "INSERT INTO auth_method_changes(id,user_id,excluded_account,deployed_providers,password_enabled,database_oidc_enabled) VALUES (?,?,'missing','[]',1,0)",
            [randomUUID(), id],
          ),
        ).rejects.toThrow("METHOD_CHANGED");
      }));
    it("clamps session renewal to its absolute expiry", () =>
      transaction(async (connection) => {
        const id = await user(connection);
        const sid = await session(connection, id);
        await connection.execute(
          "UPDATE auth_sessions SET expiresAt=? WHERE id=?",
          ["2030-01-01T00:00:00.000Z", sid],
        );
        const [rows] = await connection.execute(
          "SELECT expiresAt FROM auth_sessions WHERE id=?",
          [sid],
        );
        expect((rows as { expiresAt: string }[])[0].expiresAt).toBe(
          "2027-02-01T00:00:00.000Z",
        );
      }));
    it("rolls back quota increments for rejected mail", () =>
      transaction(async (connection) => {
        await connection.execute("UPDATE installation SET mail_limit=1");
        const insert = () =>
          connection.execute(
            "INSERT INTO security_outbox(id,kind,payload,expires_at,next_attempt_at,status,created_at) VALUES (?,'mail','{}',1,1,'pending',1)",
            [randomUUID()],
          );
        await insert();
        await expect(insert()).rejects.toThrow("MAIL_LIMIT");
        const [rows] = await connection.query(
          "SELECT count FROM daily_usage WHERE kind='mail'",
        );
        expect(Number((rows as { count: number }[])[0].count)).toBe(1);
      }));
    it("enforces board count limits and denies suspended recipients", () =>
      transaction(async (connection) => {
        const id = await user(connection);
        const book = await workbook(connection);
        await connection.execute("UPDATE installation SET board_limit=0");
        await expect(
          connection.execute(
            "INSERT INTO boards(id,workbook_id,title,created_at,updated_at,created_by) VALUES (?,?,?,?,?,?)",
            [randomUUID(), book, "Board", at, at, id],
          ),
        ).rejects.toThrow("BOARD_LIMIT");
        await connection.execute(
          "UPDATE account_security SET status='suspended' WHERE user_id=?",
          [id],
        );
        await expect(
          connection.execute(
            "INSERT INTO resource_grants(resource_type,resource_id,user_id,role,created_at,updated_at) VALUES ('board',?,?,'editor',?,?)",
            [randomUUID(), id, at, at],
          ),
        ).rejects.toThrow("ACCOUNT_UNAVAILABLE");
      }));
    it("enforces storage reservation limits", () =>
      transaction(async (connection) => {
        const id = await user(connection);
        await connection.execute(
          "UPDATE installation SET state='ready',storage_limit=5",
        );
        await expect(
          connection.execute(
            "INSERT INTO quota_reservations(id,user_id,kind,amount,expires_at) VALUES (?,?,'storage',6,9999999999999)",
            [randomUUID(), id],
          ),
        ).rejects.toThrow("STORAGE_LIMIT");
      }));
    it("revokes sessions and writes an audit after password changes", () =>
      transaction(async (connection) => {
        const id = await user(connection);
        const credential = await account(connection, id);
        await session(connection, id);
        await connection.execute(
          "UPDATE auth_accounts SET password='new' WHERE id=?",
          [credential],
        );
        const [sessions] = await connection.execute(
          "SELECT id FROM auth_sessions WHERE userId=?",
          [id],
        );
        expect(sessions).toEqual([]);
        const [audit] = await connection.execute(
          "SELECT id FROM security_audit WHERE actor_id=? AND action='account.password_changed'",
          [id],
        );
        expect(audit as unknown[]).toHaveLength(1);
      }));
    it("requires a verified proof before changing email", () =>
      transaction(async (connection) => {
        const id = await user(connection);
        await expect(
          connection.execute(
            "UPDATE auth_users SET email='changed@test.invalid' WHERE id=?",
            [id],
          ),
        ).rejects.toThrow("EMAIL_PROOF_EXPIRED");
      }));
    it("requires a factor enrolled after recovery began", () =>
      transaction(async (connection) => {
        const id = await user(connection);
        await connection.execute(
          "UPDATE account_security SET recovery_required=1,recovery_started_at=? WHERE user_id=?",
          [at, id],
        );
        await expect(
          connection.execute(
            "UPDATE account_security SET recovery_required=0 WHERE user_id=?",
            [id],
          ),
        ).rejects.toThrow("REPLACEMENT_FACTOR_REQUIRED");
      }));
    it("rejects ownership and content transfers without valid recipients", () =>
      transaction(async (connection) => {
        const source = await user(connection);
        const target = await user(connection);
        await expect(
          connection.execute(
            "INSERT INTO resource_ownership_transfers(id,resource_type,resource_id,source_id,target_id) VALUES (?,'board',?,?,?)",
            [randomUUID(), randomUUID(), source, target],
          ),
        ).rejects.toThrow("OWNERSHIP_TRANSFER_CONFLICT");
        await expect(
          connection.execute(
            "INSERT INTO content_transfer_operations(id,source_id,target_id,resources) VALUES (?,?,?,'[]')",
            [randomUUID(), source, target],
          ),
        ).rejects.toThrow("INVALID_RECIPIENT");
      }));
    it("enforces a single active software update and case-insensitive local names", () =>
      transaction(async (connection) => {
        const insert = () =>
          connection.execute(
            "INSERT INTO software_updates(id,`release`,previous_release,version,status,created_at,updated_at) VALUES (?,'a','b','1','queued',1,1)",
            [randomUUID()],
          );
        await insert();
        await expect(insert()).rejects.toThrow("Duplicate");
        const one = await user(connection);
        const two = await user(connection);
        await connection.execute(
          "INSERT INTO local_accounts(user_id,username) VALUES (?,'Example')",
          [one],
        );
        await expect(
          connection.execute(
            "INSERT INTO local_accounts(user_id,username) VALUES (?,'example')",
            [two],
          ),
        ).rejects.toThrow("Duplicate");
      }));
    it("protects active users from credential cascade bypass and allows pending deletion", () =>
      transaction(async (connection) => {
        const id = await user(connection);
        await account(connection, id);
        await session(connection, id);
        await expect(
          connection.execute("DELETE FROM auth_users WHERE id=?", [id]),
        ).rejects.toThrow("LAST_METHOD");
        await connection.execute(
          "UPDATE account_security SET status='deletion_pending' WHERE user_id=?",
          [id],
        );
        await connection.execute("DELETE FROM auth_users WHERE id=?", [id]);
        const [remaining] = await connection.execute(
          "SELECT id FROM auth_accounts WHERE userId=?",
          [id],
        );
        expect(remaining).toEqual([]);
      }));
    it("audits explicit same-value permission confirmation and exposes migration history", () =>
      transaction(async (connection) => {
        const id = await user(connection);
        const client = randomUUID();
        const grant = randomUUID();
        await connection.execute(
          "INSERT INTO oauth_clients(id,name,redirect_uris,created_at) VALUES (?,'Test','[]',?)",
          [client, at],
        );
        await connection.execute(
          "INSERT INTO oauth_grants(id,user_id,client_id,scopes,resource_mode,resources,confirmed_version,created_at) VALUES (?,?,?,'read','selected','[]',1,?)",
          [grant, id, client, at],
        );
        await connection.execute("SET @hl_catalog_update_columns = ?", [
          JSON.stringify(["resources", "confirmed_version"]),
        ]);
        await connection.execute(
          "UPDATE oauth_grants SET resources='[]',confirmed_version=1 WHERE id=?",
          [grant],
        );
        const [audit] = await connection.execute(
          "SELECT id FROM security_audit WHERE actor_id=? AND action='oauth.permissions_confirmed'",
          [id],
        );
        expect(audit as unknown[]).toHaveLength(1);
        const [migrations] = await connection.query(
          "SELECT name,applied_at FROM d1_migrations ORDER BY id",
        );
        expect(migrations as unknown[]).toHaveLength(28);
      }));
    it("evaluates JSON resource ownership when the recipient is valid", () =>
      transaction(async (connection) => {
        const source = await user(connection, "member");
        const target = await user(connection, "member");
        await expect(
          connection.execute(
            "INSERT INTO content_transfer_operations(id,source_id,target_id,resources) VALUES (?,?,?,?)",
            [
              randomUUID(),
              source,
              target,
              JSON.stringify([{ type: "board", id: randomUUID() }]),
            ],
          ),
        ).rejects.toThrow("CONTENT_TRANSFER_CONFLICT");
      }));
  },
);
