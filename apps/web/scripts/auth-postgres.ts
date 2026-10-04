import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { libraryOptions } from "../src/auth/library";
import { PostgresIdentityRepository } from "../src/auth/postgres-repository";
import { requireAdmission, sessionIsCurrent } from "../src/auth/decisions";
import { verifyPassword } from "../src/auth/password";
import type { NativeEnv } from "../src/auth/types";

const connectionString =
  process.env.AUTH_TEST_POSTGRES_URL ??
  "postgres://postgres:disposable-canvas-conformance@127.0.0.1:55432/canvas_auth_test";
const target = new URL(connectionString);
assert.ok(
  ["localhost", "127.0.0.1"].includes(target.hostname) &&
    target.pathname === "/canvas_auth_test",
  "Use the disposable local authentication database.",
);
const root = new Pool({ connectionString });
const schema = `canvas_auth_${crypto.randomUUID().replaceAll("-", "")}`;
await root.query(`CREATE SCHEMA ${schema}`);
const pool = new Pool({
  connectionString,
  options: `-c search_path=${schema}`,
  max: 12,
});
try {
  const repository = new PostgresIdentityRepository(pool);
  await pool.query(await readFile("tests/postgres-policy.sql", "utf8"));
  const origin = "http://localhost:5182";
  const env = {
    AUTH_ORIGIN: origin,
    ENVIRONMENT: "test",
    AUTH_SECRET: "postgres-library-conformance-not-a-deployment-secret",
    AUTH_ENCRYPTION_KEYS:
      '[{"id":"test","key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]',
    MAIL_FROM: "fixture@example.invalid",
    MAIL_PROVIDER: "test",
  } as NativeEnv;
  const verification = new Map<string, string>();
  let registration = true;
  const options = libraryOptions(
    env,
    {},
    {
      user: {
        create: {
          before: async () => {
            if (!registration)
              throw new APIError("FORBIDDEN", {
                message: "Registration is closed.",
              });
          },
          after: async (user) => repository.provision(user),
        },
      },
      session: {
        create: {
          before: async (session) => {
            const account = await repository.account(session.userId);
            if (
              !account ||
              ["suspended", "deleted", "deletion_pending"].includes(
                account.status,
              )
            )
              throw new APIError("UNAUTHORIZED", {
                message: "Account unavailable.",
              });
            return {
              data: {
                ...session,
                absoluteExpiresAt: new Date(Date.now() + 86400000),
                authenticatedAt: new Date(),
                authVersion: account.auth_version,
                assurance: "weak",
              },
            };
          },
        },
      },
    },
    pool,
  );
  options.emailVerification = {
    ...options.emailVerification,
    sendVerificationEmail: async ({ user, url }) => {
      verification.set(user.email, url);
    },
    afterEmailVerification: async () => {},
  };
  options.rateLimit = {
    ...options.rateLimit,
    customStorage: {
      consume: async (key, rule) =>
        repository.consumeLimit(key, rule.max, rule.window, Date.now()),
    },
  };
  // The tested Node policy uses its own persistent mail/outbox transport.
  // These proof callbacks do not call the Cloudflare-only mail implementation.
  options.emailAndPassword = {
    ...options.emailAndPassword!,
    sendResetPassword: async () => {},
    onPasswordReset: async () => {},
  };
  const migrations = await getMigrations(options);
  await migrations.runMigrations();
  const auth = betterAuth(options);
  const password = "An isolated fixture with 8 random words!";
  const cookies = new Map<string, string>();
  const call = async (path: string, body?: unknown, status = 200) => {
    const response = await auth.handler(
      new Request(`${origin}/api/auth${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Origin: origin,
          Cookie: [...cookies]
            .map(([key, value]) => `${key}=${value}`)
            .join("; "),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    assert.equal(response.status, status, `${path}: unexpected status`);
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";")[0],
        split = pair.indexOf("=");
      cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return response;
  };
  for (const weak of [
    "short",
    "passwordpassword",
    "x".repeat(129),
    "🟢".repeat(129),
  ]) {
    // Isolate credential validation from the separately tested persistent limiter.
    await pool.query("DELETE FROM request_limits");
    await call(
      "/sign-up/email",
      {
        email: "weak@example.invalid",
        name: "Rejected fixture",
        password: weak,
      },
      400,
    );
  }
  assert.equal(
    (
      await pool.query("SELECT id FROM auth_users WHERE email = $1", [
        "weak@example.invalid",
      ])
    ).rowCount,
    0,
  );
  await pool.query("DELETE FROM request_limits");
  await call("/sign-up/email", {
    email: "member@example.invalid",
    name: "Postgres fixture",
    password,
  });
  const user = (
    await pool.query("SELECT * FROM auth_users WHERE email = $1", [
      "member@example.invalid",
    ])
  ).rows[0];
  assert.match(user.id, /^user:/u);
  const credential = (
    await pool.query('SELECT password FROM auth_accounts WHERE "userId" = $1', [
      user.id,
    ])
  ).rows[0].password;
  assert.equal(await verifyPassword({ hash: credential, password }), true);
  assert.equal(
    await verifyPassword({
      hash: credential,
      password: "incorrect but suitably long",
    }),
    false,
  );
  await call("/sign-in/email", { email: user.email, password }, 403);
  const verifyUrl = new URL(verification.get(user.email)!);
  await call(
    `${verifyUrl.pathname.slice("/api/auth".length)}${verifyUrl.search}`,
    undefined,
    302,
  );
  await call("/sign-in/email", { email: user.email, password });
  const session = (
    await pool.query('SELECT * FROM auth_sessions WHERE "userId" = $1', [
      user.id,
    ])
  ).rows[0];
  const policy = {
    absoluteExpiresAt: session.absoluteExpiresAt.getTime(),
    expiresAt: session.expiresAt.getTime(),
    authenticatedAt: session.authenticatedAt.getTime(),
    authVersion: session.authVersion,
    assurance: session.assurance,
  };
  const pending = await repository.account(user.id);
  assert.ok(pending);
  assert.throws(
    () =>
      requireAdmission(
        { state: "ready", mfa_required: 0 },
        pending,
        true,
        false,
        "weak",
      ),
    /invitation/u,
  );
  await repository.transaction(async (tx) => {
    await tx.query(
      "UPDATE account_security SET status = 'active' WHERE user_id = $1",
      [user.id],
    );
    await tx.query(
      "INSERT INTO instance_memberships(user_id,role) VALUES ($1,'member')",
      [user.id],
    );
  });
  const admitted = (await repository.account(user.id))!;
  assert.equal(sessionIsCurrent(admitted, policy, Date.now()), true);
  requireAdmission(
    { state: "ready", mfa_required: 0 },
    admitted,
    true,
    false,
    "weak",
  );
  assert.throws(
    () =>
      requireAdmission(
        { state: "ready", mfa_required: 1 },
        admitted,
        true,
        false,
        "weak",
      ),
    /second factor/u,
  );
  requireAdmission(
    { state: "ready", mfa_required: 1 },
    admitted,
    true,
    false,
    "strong",
  );
  assert.throws(
    () =>
      requireAdmission(
        { state: "ready", mfa_required: 0 },
        admitted,
        true,
        false,
        "recovery",
      ),
    /recovery factor/u,
  );
  assert.equal(
    sessionIsCurrent(
      admitted,
      { ...policy, expiresAt: Date.now() - 1 },
      Date.now(),
    ),
    false,
  );
  await repository.provision({
    id: "user:second",
    email: "second@example.invalid",
    name: "Second",
  });
  const claims = await Promise.all([
    repository.claimSetup(user.id),
    repository.claimSetup("user:second"),
  ]);
  assert.deepEqual(claims.sort(), [false, true]);
  const now = Date.now(),
    limits = await Promise.all(
      Array.from({ length: 12 }, () =>
        repository.consumeLimit("concurrency", 4, 60, now),
      ),
    );
  assert.equal(limits.filter((result) => result.allowed).length, 4);
  await repository.suspend(user.id);
  assert.equal(
    (
      await pool.query(
        'SELECT COUNT(*) FROM auth_sessions WHERE "userId" = $1',
        [user.id],
      )
    ).rows[0].count,
    "0",
  );
  assert.equal(
    sessionIsCurrent((await repository.account(user.id))!, policy, Date.now()),
    false,
  );
  assert.equal(
    (await pool.query("SELECT COUNT(*) FROM security_outbox")).rows[0].count,
    "1",
  );
  assert.equal(
    (await pool.query("SELECT COUNT(*) FROM security_audit")).rows[0].count,
    "1",
  );
  await pool.query(
    "UPDATE account_security SET status = 'active' WHERE user_id = $1",
    [user.id],
  );
  assert.equal(
    sessionIsCurrent((await repository.account(user.id))!, policy, Date.now()),
    false,
  );
  const replay = await call("/get-session");
  assert.equal(await replay.json(), null);
  registration = false;
  await call("/sign-up/email", {
    email: "closed@example.invalid",
    name: "Closed",
    password,
  });
  assert.equal(
    (
      await pool.query("SELECT COUNT(*) FROM auth_users WHERE email = $1", [
        "closed@example.invalid",
      ])
    ).rows[0].count,
    "0",
  );
  await assert.rejects(
    repository.transaction(async (tx) => {
      await tx.query(
        "UPDATE account_security SET status = 'suspended' WHERE user_id = $1",
        [user.id],
      );
      throw new Error("rollback fixture");
    }),
  );
  assert.equal((await repository.account(user.id))!.status, "active");
  console.log(
    "PostgreSQL authentication proof passed: real Better Auth schema, stable IDs, shared password verification/admission/MFA/expiry decisions, atomic setup claim, distributed rate limit, transactional revocation/audit/outbox and rollback.",
  );
} finally {
  await pool.end();
  await root.query(`DROP SCHEMA ${schema} CASCADE`);
  await root.end();
}
