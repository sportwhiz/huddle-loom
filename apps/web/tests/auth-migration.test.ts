import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
const migrations = readdirSync(directory)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const now = "2026-10-03T12:00:00.000Z";

function apply(db: DatabaseSync, names: string[]) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS fixture_migrations (name TEXT PRIMARY KEY)",
  );
  for (const name of names) {
    if (
      db.prepare("SELECT name FROM fixture_migrations WHERE name = ?").get(name)
    )
      continue;
    db.exec("BEGIN");
    try {
      db.exec(readFileSync(`${directory}/${name}`, "utf8"));
      db.prepare("INSERT INTO fixture_migrations VALUES (?)").run(name);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function legacy(owners = 1) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  apply(db, migrations.slice(0, 4));
  db.prepare(
    "INSERT INTO workspaces VALUES ('workspace:default','Existing installation',?)",
  ).run(now);
  // Existing usage intentionally exceeds the new default member and board limits.
  for (let i = 0; i < 30; i++) {
    db.prepare(
      "INSERT INTO users VALUES (?, 'https://fixture.cloudflareaccess.com', ?, ?, ?, NULL, '#4262ff', ?, ?)",
    ).run(
      `user:${i}`,
      `subject:${i}`,
      `person${i}@example.invalid`,
      `Person ${i}`,
      now,
      now,
    );
    db.prepare(
      "INSERT INTO workspace_memberships VALUES ('workspace:default',?,?,?)",
    ).run(`user:${i}`, i < owners ? "owner" : "editor", now);
  }
  db.prepare(
    "INSERT INTO folders VALUES ('folder:legacy',NULL,'Existing folder',0,?,NULL)",
  ).run(now);
  db.prepare(
    "INSERT INTO workbooks VALUES ('workbook:legacy','folder:legacy','Existing workbook',0,?,NULL)",
  ).run(now);
  for (let i = 0; i < 101; i++) {
    const board = `board:${i}`;
    db.prepare(
      "INSERT INTO boards VALUES (?,'workbook:legacy',?,0,?,?,NULL,NULL,?)",
    ).run(board, `Board ${i}`, now, now, i === 0 ? 1 : 0);
    db.prepare(
      "INSERT INTO resource_grants VALUES ('board',?,'user:0','owner','direct',NULL,?,?)",
    ).run(board, now, now);
  }
  db.prepare(
    "INSERT INTO resource_grants VALUES ('workbook','workbook:legacy','user:1','viewer','direct',NULL,?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO asset_references VALUES ('board:0','existing-image','user:0',?)",
  ).run(now);
  db.prepare(
    "INSERT INTO user_profiles VALUES ('user:0','Chosen name','#654321',?)",
  ).run(now);
  db.prepare(
    "INSERT INTO user_board_preferences VALUES ('user:0','board:0',1,?)",
  ).run(now);
  db.prepare(
    "INSERT INTO oauth_clients VALUES ('client:legacy','Existing assistant','[\"https://client.example/callback\"]',?)",
  ).run(now);
  for (const id of ["live", "revoked"]) {
    db.prepare("INSERT INTO oauth_tokens VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
      id,
      `${id}-access-hash`,
      `${id}-refresh-hash`,
      "client:legacy",
      "user:0",
      "https://canvas.example/mcp",
      "boards:read boards:write",
      now,
      "2026-10-03T13:00:00.000Z",
      "2026-10-10T12:00:00.000Z",
      id === "revoked" ? now : null,
    );
  }
  return db;
}

describe("additive native authentication migrations", () => {
  it("commits email changes and access revocation together, or rolls back both", () => {
    const db = legacy();
    try {
      apply(db, migrations);
      const address = "changed@example.invalid";
      const version = Number(db.prepare("SELECT auth_version FROM account_security WHERE user_id = 'user:0'").get()!.auth_version);
      db.prepare("INSERT INTO auth_email_proofs(user_id,purpose,token_hash,auth_version,new_email,expires_at) VALUES ('user:0','change-email-verification','email-proof',?,?,?)").run(version,address,Date.now() + 600000);
      db.prepare("INSERT INTO auth_confirmation_uses(token_hash,purpose,consumed_at) VALUES ('email-proof','verify',?)").run(Date.now());
      db.prepare("INSERT INTO auth_sessions(id,token,userId,createdAt,updatedAt,expiresAt,absoluteExpiresAt,authenticatedAt,assurance,authVersion) VALUES ('email-session','fixture-token','user:0',?,?,?,?,?,'strong',?)").run(now,now,"2099-01-01T00:00:00.000Z","2099-01-01T00:00:00.000Z",now,version);
      const change = () => db.prepare("UPDATE auth_users SET email = ?, emailVerified = 1 WHERE id = 'user:0'").run(address);
      db.exec("CREATE TRIGGER failed_email_audit BEFORE INSERT ON security_audit WHEN NEW.action = 'account.email_changed' BEGIN SELECT RAISE(ABORT,'injected email audit failure'); END");
      expect(change).toThrow('injected email audit failure');
      for (const table of ['users','auth_users'])
        expect(db.prepare(`SELECT email FROM ${table} WHERE id = 'user:0'`).get()!.email).toBe('person0@example.invalid');
      expect(db.prepare("SELECT auth_version FROM account_security WHERE user_id = 'user:0'").get()!.auth_version).toBe(version);
      expect(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get()!.n).toBe(1);
      expect(db.prepare("SELECT revoked_at FROM oauth_tokens WHERE id = 'live'").get()!.revoked_at).toBeNull();
      expect(db.prepare("SELECT revoked_at FROM oauth_grants WHERE id = 'live'").get()!.revoked_at).toBeNull();
      expect(db.prepare("SELECT COUNT(*) AS n FROM security_outbox WHERE kind = 'invalidate'").get()!.n).toBe(0);
      db.exec('DROP TRIGGER failed_email_audit');
      change();
      for (const table of ['users','auth_users'])
        expect(db.prepare(`SELECT email FROM ${table} WHERE id = 'user:0'`).get()!.email).toBe(address);
      expect(db.prepare("SELECT auth_version FROM account_security WHERE user_id = 'user:0'").get()!.auth_version).toBe(version + 1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get()!.n).toBe(0);
      expect(db.prepare("SELECT revoked_at FROM oauth_tokens WHERE id = 'live'").get()!.revoked_at).not.toBeNull();
      expect(db.prepare("SELECT revoked_at FROM oauth_grants WHERE id = 'live'").get()!.revoked_at).not.toBeNull();
      expect(db.prepare("SELECT COUNT(*) AS n FROM security_audit WHERE action = 'account.email_changed'").get()!.n).toBe(1);
      expect(db.prepare("SELECT COUNT(*) AS n FROM security_outbox WHERE kind = 'invalidate'").get()!.n).toBe(1);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it.each(["added", "changed"])(
    "atomically revokes password %s access and rolls back a failed audit",
    (action) => {
      const db = legacy();
      try {
        apply(
          db,
          migrations.filter((name) => name < "0021_password_revocation.sql"),
        );
        const insert = () =>
          db
            .prepare(
              "INSERT INTO auth_accounts(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES ('credential:fixture','user:0','credential','user:0','fixture-hash',?,?)",
            )
            .run(now, now);
        if (action === "changed") insert();
        db.prepare(
          "INSERT INTO auth_sessions(id,token,userId,createdAt,updatedAt,expiresAt,absoluteExpiresAt,authenticatedAt,assurance,authVersion) VALUES ('session:fixture','fixture-token','user:0',?,?,?,?,?,'strong',1)",
        ).run(
          now,
          now,
          "2099-01-01T00:00:00.000Z",
          "2099-01-01T00:00:00.000Z",
          now,
        );
        apply(db, migrations);
        const previous = db
          .prepare(
            "SELECT password FROM auth_accounts WHERE id='credential:fixture'",
          )
          .get();
        const version = Number(
          db
            .prepare(
              "SELECT auth_version FROM account_security WHERE user_id='user:0'",
            )
            .get()!.auth_version,
        );
        const mutate =
          action === "added"
            ? insert
            : () =>
                db.exec(
                  "UPDATE auth_accounts SET password='replacement-fixture-hash' WHERE id='credential:fixture'",
                );
        db.exec(
          "CREATE TRIGGER fixture_password_failure BEFORE INSERT ON security_audit WHEN NEW.action IN ('account.password_added','account.password_changed') BEGIN SELECT RAISE(ABORT,'injected password audit failure'); END",
        );
        expect(mutate).toThrow(/injected password audit failure/);
        expect(
          db
            .prepare(
              "SELECT password FROM auth_accounts WHERE id='credential:fixture'",
            )
            .get(),
        ).toEqual(previous);
        expect(
          db
            .prepare(
              "SELECT auth_version FROM account_security WHERE user_id='user:0'",
            )
            .get()!.auth_version,
        ).toBe(version);
        expect(
          db.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get()!.n,
        ).toBe(1);
        expect(
          db
            .prepare("SELECT revoked_at FROM oauth_tokens WHERE id='live'")
            .get()!.revoked_at,
        ).toBeNull();
        expect(
          db
            .prepare("SELECT revoked_at FROM oauth_grants WHERE id='live'")
            .get()!.revoked_at,
        ).toBeNull();
        db.exec("DROP TRIGGER fixture_password_failure");
        mutate();
        expect(
          db
            .prepare(
              "SELECT auth_version FROM account_security WHERE user_id='user:0'",
            )
            .get()!.auth_version,
        ).toBe(version + 1);
        expect(
          db.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get()!.n,
        ).toBe(0);
        expect(
          db
            .prepare("SELECT revoked_at FROM oauth_tokens WHERE id='live'")
            .get()!.revoked_at,
        ).not.toBeNull();
        expect(
          db
            .prepare("SELECT revoked_at FROM oauth_grants WHERE id='live'")
            .get()!.revoked_at,
        ).not.toBeNull();
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM security_outbox WHERE kind='invalidate'",
            )
            .get()!.n,
        ).toBe(1);
        expect(
          db
            .prepare("SELECT COUNT(*) AS n FROM security_audit WHERE action=?")
            .get(`account.password_${action}`)!.n,
        ).toBe(1);
      } finally {
        db.close();
      }
    },
  );

  it("preserves existing content, identities, permissions and live MCP authorization", () => {
    const db = legacy();
    try {
      const before = Object.fromEntries(
        [
          "users",
          "boards",
          "workbooks",
          "resource_grants",
          "user_profiles",
          "user_board_preferences",
          "oauth_tokens",
        ].map((table) => [
          table,
          db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
        ]),
      );
      // Reopen the migration sequence after a partial rollout, then repeat it.
      apply(db, migrations.slice(4, 10));
      apply(db, migrations);
      apply(db, migrations);
      for (const table of [
        "users",
        "workbooks",
        "resource_grants",
        "user_profiles",
        "user_board_preferences",
      ]) {
        expect(db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).toEqual(
          before[table],
        );
      }
      for (const row of before.boards)
        expect(
          db.prepare("SELECT * FROM boards WHERE id = ?").get(row.id as string),
        ).toMatchObject({ ...row, created_by: "user:0" });
      for (const row of before.oauth_tokens)
        expect(
          db
            .prepare("SELECT * FROM oauth_tokens WHERE id = ?")
            .get(row.id as string),
        ).toMatchObject(row);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM auth_users WHERE emailVerified = 0",
          )
          .get()?.n,
      ).toBe(30);
      expect(
        db
          .prepare(
            "SELECT user_id FROM access_identities WHERE issuer = 'https://fixture.cloudflareaccess.com' AND subject = 'subject:0'",
          )
          .get()?.user_id,
      ).toBe("user:0");
      expect(
        db
          .prepare("SELECT state, owner_id, setup_user_id FROM installation")
          .get(),
      ).toMatchObject({
        state: "configuring",
        owner_id: "user:0",
        setup_user_id: "user:0",
      });
      expect(db.prepare("SELECT owner_id FROM folders").get()?.owner_id).toBe(
        "user:0",
      );
      expect(
        db.prepare("SELECT byte_size, uploaded_by FROM asset_references").get(),
      ).toMatchObject({ byte_size: -1, uploaded_by: "user:0" });
      expect(
        db
          .prepare(
            `SELECT t.id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
        JOIN oauth_families f ON f.id = t.family_id JOIN installation i ON i.id = 'instance'
        WHERE t.revoked_at IS NULL AND g.revoked_at IS NULL AND f.revoked_at IS NULL
        AND g.confirmed_version >= i.consent_version ORDER BY t.id`,
          )
          .all(),
      ).toEqual([{ id: "live" }]);
      expect(
        db
          .prepare(
            "SELECT scopes, resource_mode FROM oauth_grants WHERE id = 'live'",
          )
          .get(),
      ).toMatchObject({
        scopes: "boards:read boards:write",
        resource_mode: "all",
      });
      expect(
        db
          .prepare(
            "SELECT absolute_expires_at FROM oauth_families WHERE id = 'live'",
          )
          .get()?.absolute_expires_at,
      ).toBe("2026-10-10T12:00:00.000Z");
      expect(
        db
          .prepare("SELECT revoked_at FROM oauth_grants WHERE id = 'revoked'")
          .get()?.revoked_at,
      ).toBe(now);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("does not guess an owner when a legacy installation has multiple owners", () => {
    const db = legacy(2);
    try {
      apply(db, migrations);
      expect(
        db
          .prepare("SELECT state, owner_id, setup_user_id FROM installation")
          .get(),
      ).toMatchObject({
        state: "unclaimed",
        owner_id: null,
        setup_user_id: null,
      });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM workspace_memberships WHERE role = 'owner'",
          )
          .get()?.n,
      ).toBe(2);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM instance_memberships WHERE role = 'owner'",
          )
          .get()?.n,
      ).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS n FROM users").get()?.n).toBe(30);
    } finally {
      db.close();
    }
  });

  it("rolls back an interrupted migration and allows a clean retry", () => {
    const db = new DatabaseSync(":memory:");
    try {
      apply(db, migrations.slice(0, 5));
      db.exec("BEGIN");
      db.exec(readFileSync(`${directory}/${migrations[5]}`, "utf8"));
      db.exec("ROLLBACK");
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE name = 'installation'")
          .get(),
      ).toBeUndefined();
      apply(db, migrations);
      expect(
        db.prepare("SELECT state, owner_id FROM installation").get(),
      ).toMatchObject({ state: "unclaimed", owner_id: null });
    } finally {
      db.close();
    }
  });
});
