import { softwarePasskey } from "./passkey-fixture";
import { conformance } from "./auth-conformance";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  readdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { open } from "../src/security/secret-store";
import type { NativeEnv } from "../src/auth/types";

const origin = process.env.AUTH_TEST_ORIGIN ?? "http://localhost:5180";
assert.equal(
  new URL(origin).hostname,
  "localhost",
  "This destructive fixture is limited to the isolated loopback installation.",
);
const config = JSON.parse(readFileSync("tests/wrangler.auth.jsonc", "utf8"));
const fixture = config.vars as NativeEnv;
const files = readdirSync(
  "tests/.wrangler/state/v3/d1/miniflare-D1DatabaseObject",
).filter((name) => name.endsWith(".sqlite"));
const database = files
  .map(
    (name) =>
      new DatabaseSync(
        resolve("tests/.wrangler/state/v3/d1/miniflare-D1DatabaseObject", name),
      ),
  )
  .find((db) => {
    try {
      return Boolean(
        db.prepare("SELECT 1 FROM installation WHERE id = 'instance'").get(),
      );
    } catch {
      db.close();
      return false;
    }
  });
assert.ok(database, "Apply the isolated local authentication migrations.");
// The Worker also writes this local fixture. Wait for its short transactions.
database.exec("PRAGMA busy_timeout = 5000");
if (process.argv.includes("--reset")) {
  assert.equal(fixture.ENVIRONMENT, "test");
  assert.equal(fixture.AUTH_ORIGIN, "http://localhost:5180");
  database.exec(
    "PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE; UPDATE installation SET state = 'unclaimed', owner_id = NULL, setup_user_id = NULL; UPDATE account_security SET status = 'deletion_pending';",
  );
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('d1_migrations','installation')",
    )
    .all() as { name: string }[];
  for (const table of tables) {
    assert.match(table.name, /^[a-zA-Z_]+$/u);
    database.exec(`DELETE FROM "${table.name}"`);
  }
  // Resetting tables removes migration-seeded singleton rows too. Restore the
  // updater defaults so this fixture represents a freshly migrated installation.
  database.exec("INSERT INTO software_update_settings(id) VALUES ('instance')");
  database.exec(
    "UPDATE installation SET state = 'unclaimed', setup_user_id = NULL, owner_id = NULL, version = 1, consent_version = 1, setup_commit = NULL, ownership_commit = NULL, registration = 'invite', approval_required = 0, mfa_required = 0, magic_link = 0, member_limit = 25, guest_limit = 100, board_limit = 1000, user_board_limit = 100, storage_limit = 5368709120, user_storage_limit = 1073741824, mail_limit = 500; COMMIT; PRAGMA foreign_keys = ON;",
  );
}
database.exec("DELETE FROM request_limits");
class Client {
  cookies = new Map<string, string>();
  csrf = "";
  async call(
    path: string,
    body?: unknown,
    expected: number | number[] = 200,
    method = body === undefined ? "GET" : "POST",
  ) {
    const response = await fetch(`${origin}${path}`, {
      method,
      redirect: "manual",
      headers: {
        Cookie: [...this.cookies]
          .map(([key, value]) => `${key}=${value}`)
          .join("; "),
        Origin: origin,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(["POST", "PUT", "PATCH", "DELETE"].includes(method)
          ? { "X-Canvas-CSRF": this.csrf }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const raw = await response.text();
    const value =
      response.headers.get("Content-Type")?.includes("application/json") && raw
        ? JSON.parse(raw)
        : {};
    assert.ok(
      (Array.isArray(expected) ? expected : [expected]).includes(
        response.status,
      ),
      `${method} ${path}: ${response.status} ${JSON.stringify(value)}`,
    );
    assert.match(
      response.headers.get("Cache-Control") ?? "",
      /(?:^|,\s*)no-store(?:,|$)/u,
    );
    if (value.csrf) this.csrf = value.csrf;
    return value;
  }
}
function codeFor(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret)
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const keyBytes = Uint8Array.from(bits.match(/.{8}/gu) ?? [], (byte) =>
    parseInt(byte, 2),
  );
  return (async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const counter = new Uint8Array(8);
    new DataView(counter.buffer).setBigUint64(
      0,
      BigInt(Math.floor(Date.now() / 30000)),
    );
    const digest = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, counter),
    );
    const offset = digest[19] & 15;
    return (
      (new DataView(digest.buffer).getUint32(offset) & 0x7fffffff) %
      1000000
    )
      .toString()
      .padStart(6, "0");
  })();
}
let client = new Client();
await client.call("/api/v1/auth/bootstrap");
await client.call("/api/v1/me", undefined, 401);
await client.call("/api/v1/setup/unlock", { secret: "invalid" }, 403);
await client.call("/api/v1/setup/unlock", {
  secret: fixture.AUTH_BOOTSTRAP_SECRET,
});
const setup = database
  .prepare(
    "SELECT u.email FROM installation i JOIN auth_users u ON u.id = i.setup_user_id WHERE i.state = 'configuring'",
  )
  .get() as { email: string } | undefined;
let address = setup?.email ?? `owner-${Date.now()}@example.invalid`;
const password = "An isolated fixture with 8 random words!";
const started = performance.now();
if (!setup) {
  const rival = new Client();
  await rival.call("/api/v1/auth/bootstrap");
  await rival.call("/api/v1/setup/unlock", {
    secret: fixture.AUTH_BOOTSTRAP_SECRET,
  });
  const attempts = await Promise.all(
    [
      { candidate: client, email: address },
      { candidate: rival, email: `rival-${Date.now()}@example.invalid` },
    ].map(async (candidate) => ({
      ...candidate,
      result: await candidate.candidate.call(
        "/api/auth/sign-up/email",
        { name: "Fixture Owner", email: candidate.email, password },
        [202, 409],
      ),
    })),
  );
  const winners = attempts.filter(
    (attempt) => attempt.result.code !== "SETUP_CONFLICT",
  );
  assert.equal(winners.length, 1);
  client = winners[0].candidate;
  address = winners[0].email;
  assert.equal(
    (
      database
        .prepare(
          "SELECT COUNT(*) AS n FROM installation WHERE state = 'configuring' AND setup_user_id IS NOT NULL",
        )
        .get() as any
    ).n,
    1,
  );
}
console.log(
  `Worker password hash and signup: ${Math.round(performance.now() - started)} ms`,
);
const token = await latestToken(address, "Verify your Huddle Loom email");
assert.ok(token);
await client.call(
  `/api/auth/verify-email?token=${encodeURIComponent(token)}`,
  undefined,
  404,
);
if (!setup)
  await client.call(
    "/api/v1/auth/verify",
    { token, newPassword: password },
    200,
  );
await client.call("/api/auth/sign-in/email", { email: address, password });
const current = await client.call("/api/v1/auth/bootstrap");
assert.equal(current.account.setupUser, true);
assert.equal(current.account.verified, true);
await client.call("/api/v1/setup/complete", {}, 403);
const factor = await client.call("/api/auth/two-factor/enable", { password });
assert.equal(factor.backupCodes.length, 10);
const seed = new URL(factor.totpURI).searchParams.get("secret")!;
await client.call("/api/auth/two-factor/verify-totp", {
  code: await codeFor(seed),
});
const ready = await client.call("/api/v1/auth/bootstrap");
assert.equal(ready.account.assurance, "strong");
await client.call("/api/v1/setup/complete", {});
await client.call("/api/v1/me");
await client.call(
  "/api/v1/setup/unlock",
  { secret: fixture.AUTH_BOOTSTRAP_SECRET },
  409,
);
console.log(
  "Native Worker/D1: protected setup, email confirmation, password login, MFA, owner admission passed.",
);
const security = await client.call("/api/v1/account/security");
assert.equal(security.role, "owner");
assert.equal(security.sessions[0].current, true);
assert.equal("token" in security.sessions[0], false);
const catalog = await client.call("/api/v1/catalog");
assert.equal(catalog.workbooks.length, 1);
const workbookId = catalog.workbooks[0].id;
const board = await client.call(
  "/api/v1/boards",
  { workbookId, title: "Native auth conformance board" },
  201,
);
assert.ok(board.id);
const people = await client.call("/api/v1/admin/people");
assert.equal(
  people.people.filter((person: any) => person.role === "owner").length,
  1,
);
await client.call(
  "/api/v1/admin/settings",
  { registration: "public", approval_required: 1 },
  200,
  "PATCH",
);
const member = new Client();
await member.call("/api/v1/auth/bootstrap");
const memberEmail = `member-${Date.now()}@example.invalid`;
await member.call(
  "/api/auth/sign-up/email",
  { name: "Fixture Member", email: memberEmail, password },
  202,
);
const message = database
  .prepare(
    "SELECT id, payload FROM security_outbox WHERE kind = 'mail' ORDER BY created_at DESC LIMIT 1",
  )
  .get() as { id: string; payload: string };
const pending = JSON.parse(
  await open(fixture, message.payload, `mail:${message.id}`),
);
const memberToken = new URLSearchParams(
  new URL(pending.text.split("\n").at(-1)).hash.slice(1),
).get("token");
await member.call(
  "/api/v1/auth/verify",
  { token: memberToken, newPassword: password },
  200,
);
await member.call("/api/auth/sign-in/email", { email: memberEmail, password });
const memberBootstrap = await member.call("/api/v1/auth/bootstrap");
assert.equal(memberBootstrap.account.status, "pending_approval");
const incorrect = new Client();
await incorrect.call("/api/v1/auth/bootstrap");
for (const wrongPassword of ["short", "passwordpassword"]) {
  const known = await incorrect.call(
    "/api/auth/sign-in/email",
    { email: memberEmail, password: wrongPassword },
    401,
  );
  const unknown = await incorrect.call(
    "/api/auth/sign-in/email",
    { email: "not-registered@example.invalid", password: wrongPassword },
    401,
  );
  assert.deepEqual(
    known,
    unknown,
    "Invalid sign-in must not expose whether the address exists.",
  );
}
const oversizedKnown = await incorrect.call(
  "/api/auth/sign-in/email",
  { email: memberEmail, password: "x".repeat(513) },
  400,
);
const oversizedUnknown = await incorrect.call(
  "/api/auth/sign-in/email",
  { email: "not-registered@example.invalid", password: "x".repeat(513) },
  400,
);
assert.deepEqual(oversizedKnown, oversizedUnknown);
await member.call("/api/v1/catalog", undefined, 403);
await client.call(
  `/api/v1/admin/people/${encodeURIComponent(memberBootstrap.user.id)}/approve`,
  {},
);
await member.call("/api/v1/catalog");
// Add-password uses a server-only library endpoint, and needs the same policy.
const memberCredential = database
  .prepare(
    "SELECT id FROM auth_accounts WHERE userId = ? AND providerId = 'credential'",
  )
  .get(memberBootstrap.user.id) as { id: string };
database
  .prepare(
    "UPDATE auth_accounts SET providerId = 'fixture-passwordless' WHERE id = ?",
  )
  .run(memberCredential.id);
for (const weak of ["short", "passwordpassword", "x".repeat(129)]) {
  const rejected = await member.call(
    "/api/v1/account/password",
    { newPassword: weak },
    400,
  );
  assert.equal(rejected.code, "WEAK_PASSWORD");
}
await member.call("/api/v1/account/password", { newPassword: password });
await member.call("/api/v1/catalog", undefined, 401);
await member.call("/api/auth/sign-in/email", { email: memberEmail, password });
database
  .prepare("DELETE FROM auth_accounts WHERE id = ?")
  .run(memberCredential.id);
const passwordAdded = new Client();
await passwordAdded.call("/api/v1/auth/bootstrap");
await passwordAdded.call("/api/auth/sign-in/email", {
  email: memberEmail,
  password,
});
assert.equal(
  (await passwordAdded.call("/api/v1/auth/bootstrap")).user.id,
  memberBootstrap.user.id,
);
await member.call("/api/v1/admin/people", undefined, 403);
await member.call(
  `/api/v1/boards/${encodeURIComponent(board.id)}/bootstrap`,
  undefined,
  404,
);
const membership = await client.call(
  "/api/v1/admin/invitations",
  {
    email: `guest-${Date.now()}@example.invalid`,
    role: "guest",
    sendEmail: false,
  },
  201,
);
assert.ok(membership.link.includes("#membership="));
await client.call(
  `/api/v1/admin/people/${encodeURIComponent(memberBootstrap.user.id)}/suspend`,
  { reason: "Conformance suspension" },
);
await member.call("/api/v1/catalog", undefined, 401);
await client.call(
  `/api/v1/admin/people/${encodeURIComponent(memberBootstrap.user.id)}/restore`,
  {},
);
await member.call("/api/v1/catalog", undefined, 401);
const badCsrf = await fetch(`${origin}/api/v1/admin/settings`, {
  method: "PATCH",
  headers: {
    Cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    Origin: "https://attacker.invalid",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ registration: "public" }),
});
assert.equal(badCsrf.status, 403);
const unknown = await client.call("/api/v1/not-a-real-route", undefined, 404);
assert.equal(unknown.code, "NOT_FOUND");
await client.call("/api/v1/account/delete", { confirm: address }, 409);
console.log(
  "Native Worker/D1 account, admission, permissions, admin, suspension, owner guards and CSRF passed.",
);
// Exercise the full invited-user lifecycle with real encrypted mail proofs.
database.exec("DELETE FROM request_limits");
async function latestToken(email: string, subject: string) {
  const rows = database!
    .prepare(
      "SELECT id,payload FROM security_outbox WHERE kind = 'mail' AND payload <> '' ORDER BY created_at DESC",
    )
    .all() as { id: string; payload: string }[];
  for (const row of rows) {
    const message = JSON.parse(
      await open(fixture, row.payload, `mail:${row.id}`),
    );
    if (message.to !== email || message.subject !== subject) continue;
    const link = new URL(message.text.split("\n").at(-1));
    return new URLSearchParams(link.hash.slice(1)).get("token")!;
  }
  throw new Error(`Expected fixture email was not queued: ${subject}`);
}
const guestEmail = (
  database
    .prepare("SELECT email FROM instance_invitations WHERE id = ?")
    .get(membership.id) as any
).email;
await client.call(
  "/api/v1/admin/settings",
  { registration: "invite" },
  200,
  "PATCH",
);
const guest = new Client();
await guest.call("/api/v1/auth/bootstrap");
await guest.call(
  "/api/auth/sign-up/email",
  { name: "Invited Fixture", email: guestEmail, password },
  202,
);
const guestVerification = await latestToken(
  guestEmail,
  "Verify your Huddle Loom email",
);
await guest.call("/api/v1/auth/verify", {
  token: guestVerification,
  newPassword: password,
});
await guest.call(
  "/api/v1/auth/verify",
  { token: guestVerification, newPassword: password },
  [409, 410],
);
await guest.call("/api/auth/sign-in/email", { email: guestEmail, password });
const membershipToken = new URLSearchParams(
  new URL(membership.link).hash.slice(1),
).get("membership");
await client.call("/api/v1/membership/accept", { token: membershipToken }, 403);
await guest.call("/api/v1/catalog", undefined, 403);
await guest.call("/api/v1/membership/accept", { token: membershipToken });
assert.equal(
  (await guest.call("/api/v1/auth/bootstrap")).account.role,
  "guest",
);
assert.equal((await guest.call("/api/v1/catalog")).workbooks.length, 0);
await guest.call("/api/v1/membership/accept", { token: membershipToken });
const guestId = (await guest.call("/api/v1/auth/bootstrap")).user.id;
await guest.call("/api/auth/request-password-reset", {
  email: guestEmail,
  redirectTo: `${origin}/recover`,
});
const reset = await latestToken(guestEmail, "Reset your Huddle Loom password");
const resetClient = new Client();
await resetClient.call("/api/v1/auth/bootstrap");
await resetClient.call("/api/auth/reset-password", {
  token: reset,
  newPassword: password,
});
await resetClient.call(
  "/api/auth/reset-password",
  { token: reset, newPassword: password },
  400,
);
await guest.call("/api/v1/catalog", undefined, 401);
await guest.call("/api/auth/sign-in/email", { email: guestEmail, password });
await guest.call("/api/auth/change-password", {
  currentPassword: password,
  newPassword: password,
  revokeOtherSessions: false,
});
await guest.call("/api/v1/catalog", undefined, 401);
await guest.call("/api/auth/sign-in/email", { email: guestEmail, password });
const newAddress = `changed-${Date.now()}@example.invalid`;
await guest.call("/api/auth/change-email", {
  newEmail: newAddress,
  callbackURL: `${origin}/login`,
});
assert.equal(
  (
    database
      .prepare("SELECT email FROM auth_users WHERE id = ?")
      .get(guestId) as any
  ).email,
  guestEmail,
);
const approveAddress = await latestToken(
  guestEmail,
  "Confirm your Huddle Loom email change",
);
await guest.call("/api/v1/auth/verify", { token: approveAddress });
assert.equal(
  (
    database
      .prepare("SELECT email FROM auth_users WHERE id = ?")
      .get(guestId) as any
  ).email,
  guestEmail,
);
const confirmAddress = await latestToken(
  newAddress,
  "Verify your Huddle Loom email",
);
await guest.call("/api/v1/auth/verify", { token: confirmAddress });
assert.equal(
  (
    database
      .prepare("SELECT email FROM auth_users WHERE id = ?")
      .get(guestId) as any
  ).email,
  newAddress,
);
await guest.call("/api/v1/catalog", undefined, 401);
await guest.call("/api/auth/sign-in/email", { email: newAddress, password });
await guest.call("/api/v1/account/delete", { confirm: newAddress });
await guest.call("/api/v1/catalog", undefined, 401);
assert.equal(
  (
    database
      .prepare("SELECT status FROM account_security WHERE user_id = ?")
      .get(guestId) as any
  ).status,
  "deleted",
);
// This fixture creates several people from one IP within a few seconds. Start a
// new test phase without weakening the production signup limiter.
database.exec("DELETE FROM request_limits");
await client.call(
  "/api/v1/admin/settings",
  { registration: "public" },
  200,
  "PATCH",
);
await guest.call(
  "/api/auth/sign-up/email",
  { name: "New identity", email: newAddress, password },
  202,
);
const newId = (
  database
    .prepare("SELECT id FROM auth_users WHERE email = ?")
    .get(newAddress) as any
).id;
assert.notEqual(newId, guestId);
assert.equal(
  (
    database
      .prepare("SELECT COUNT(*) AS n FROM resource_grants WHERE user_id = ?")
      .get(newId) as any
  ).n,
  0,
);
console.log(
  "Native account lifecycle: invited guest, wrong recipient, verification replay, password reset/replay, two-address email change, deletion and clean re-registration passed.",
);
await conformance({
  origin,
  owner: client,
  member,
  board,
  database,
  memberId: memberBootstrap.user.id,
  memberEmail,
  password,
  webhookSecret: fixture.MAIL_WEBHOOK_SECRET!,
  fixture,
});
// Optional email sign-in requires an explicit confirmation and remains subject to MFA.
database.exec("DELETE FROM request_limits");
const magic = new Client();
await magic.call("/api/v1/auth/bootstrap");
await magic.call("/api/auth/sign-in/magic-link", { email: memberEmail }, 403);
await client.call("/api/v1/admin/settings", { magic_link: 1 }, 200, "PATCH");
await magic.call("/api/auth/sign-in/magic-link", { email: memberEmail });
const magicToken = await latestToken(memberEmail, "Sign in to Huddle Loom");
await magic.call(
  `/api/auth/magic-link/verify?token=${encodeURIComponent(magicToken)}`,
  undefined,
  404,
);
assert.equal((await magic.call("/api/v1/auth/bootstrap")).user, null);
await magic.call("/api/v1/auth/magic", { token: magicToken });
assert.equal(
  (await magic.call("/api/v1/auth/bootstrap")).user.id,
  memberBootstrap.user.id,
);
await magic.call("/api/v1/auth/magic", { token: magicToken }, 410);
await magic.call("/api/auth/sign-in/magic-link", { email: address });
const ownerMagic = new Client();
await ownerMagic.call("/api/v1/auth/bootstrap");
await ownerMagic.call("/api/v1/auth/magic", {
  token: await latestToken(address, "Sign in to Huddle Loom"),
});
assert.equal(
  (await ownerMagic.call("/api/v1/auth/bootstrap")).account.needsMfa,
  true,
);
await ownerMagic.call("/api/v1/catalog", undefined, 403);
await client.call("/api/v1/admin/settings", { magic_link: 0 }, 200, "PATCH");
console.log(
  "Native magic links: disabled by default, explicit confirmation, scanner-safe GET, single-use proof and owner MFA enforcement passed.",
);
// User verification is required at enrollment and at sign-in.
const unverifiedDevice = softwarePasskey(origin);
await unverifiedDevice.register(client, { verified: false, expected: 401 });
const device = softwarePasskey(origin);
await device.register(client);
const deviceClient = new Client();
await deviceClient.call("/api/v1/auth/bootstrap");
await device.authenticate(deviceClient, { verified: false, expected: 401 });
await device.authenticate(deviceClient, {
  responseOrigin: "https://attacker.invalid",
  expected: 400,
});
const assertion = await device.authenticate(deviceClient);
await deviceClient.call(
  "/api/auth/passkey/verify-authentication",
  assertion,
  400,
);
assert.equal(
  (await deviceClient.call("/api/v1/auth/bootstrap")).account.assurance,
  "strong",
);
const memberDevice = softwarePasskey(origin);
await member.call("/api/auth/sign-in/email", { email: memberEmail, password });
await memberDevice.register(member);
const recipient = new Client();
await recipient.call("/api/v1/auth/bootstrap");
await memberDevice.authenticate(recipient);
const handover = await deviceClient.call("/api/v1/admin/owner-transfer", {
  targetId: memberBootstrap.user.id,
});
const transferToken = new URLSearchParams(
  new URL(handover.link).hash.slice(1),
).get("token");
await deviceClient.call(
  "/api/v1/account/owner-transfer/accept",
  { token: transferToken },
  409,
);
// A failure in the final audit must roll back roles, token consumption and session revocation together.
database.exec(
  "CREATE TRIGGER fixture_abort_transfer BEFORE INSERT ON security_audit WHEN NEW.action = 'installation.owner_received' BEGIN SELECT RAISE(ABORT, 'fixture transfer failure'); END",
);
await recipient.call(
  "/api/v1/account/owner-transfer/accept",
  { token: transferToken },
  503,
);
assert.equal(
  (database.prepare("SELECT owner_id FROM installation").get() as any).owner_id,
  ready.user.id,
);
await deviceClient.call("/api/v1/admin/settings");
await recipient.call("/api/v1/catalog");
database.exec("DROP TRIGGER fixture_abort_transfer");
const handoverResults = await Promise.all(
  [1, 2].map(async () => {
    const response = await fetch(
      `${origin}/api/v1/account/owner-transfer/accept`,
      {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: [...recipient.cookies]
            .map(([key, value]) => `${key}=${value}`)
            .join("; "),
          "X-Canvas-CSRF": recipient.csrf,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: transferToken }),
      },
    );
    assert.ok([200, 401, 409].includes(response.status));
    return response.status;
  }),
);
assert.equal(handoverResults.filter((status) => status === 200).length, 1);
assert.equal(
  (
    database
      .prepare(
        "SELECT COUNT(*) AS n FROM instance_memberships WHERE role = 'owner'",
      )
      .get() as any
  ).n,
  1,
);
assert.equal(
  (database.prepare("SELECT owner_id FROM installation").get() as any).owner_id,
  memberBootstrap.user.id,
);
await deviceClient.call("/api/v1/catalog", undefined, 401);
await recipient.call("/api/v1/catalog", undefined, 401);
await device.authenticate(deviceClient);
await memberDevice.authenticate(recipient);
await recipient.call(
  "/api/v1/account/owner-transfer/accept",
  { token: transferToken },
  409,
);
const handback = await recipient.call("/api/v1/admin/owner-transfer", {
  targetId: ready.user.id,
});
await deviceClient.call("/api/v1/account/owner-transfer/accept", {
  token: new URLSearchParams(new URL(handback.link).hash.slice(1)).get("token"),
});
await device.authenticate(deviceClient);
await deviceClient.call(
  `/api/v1/admin/people/${encodeURIComponent(memberBootstrap.user.id)}/role`,
  { role: "member" },
);
await member.call("/api/auth/sign-in/email", { email: memberEmail, password });
client = deviceClient;
console.log(
  "Native ownership transfer: wrong recipient, injected transaction failure, concurrent single winner, old-session revocation, replay rejection and return handover passed.",
);
let recover = new Client();
await recover.call("/api/v1/auth/bootstrap");
await recover.call("/api/auth/sign-in/email", { email: address, password });
const recoveryRival = new Client();
await recoveryRival.call("/api/v1/auth/bootstrap");
await recoveryRival.call("/api/auth/sign-in/email", {
  email: address,
  password,
});
const recoveryAttempts = await Promise.all(
  [recover, recoveryRival].map(async (candidate) => {
    const response = await fetch(
      `${origin}/api/auth/two-factor/verify-backup-code`,
      {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: [...candidate.cookies]
            .map(([key, value]) => `${key}=${value}`)
            .join("; "),
          "X-Canvas-CSRF": candidate.csrf,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code: factor.backupCodes[0] }),
      },
    );
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";")[0],
        split = pair.indexOf("=");
      candidate.cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return { candidate, status: response.status };
  }),
);
assert.equal(recoveryAttempts.filter((item) => item.status === 200).length, 1);
assert.ok(
  recoveryAttempts
    .filter((item) => item.status !== 200)
    .every((item) => [401, 409].includes(item.status)),
);
recover = recoveryAttempts.find((item) => item.status === 200)!.candidate;
assert.equal(
  (await recover.call("/api/v1/auth/bootstrap")).account.recoveryRequired,
  true,
);
await recover.call("/api/v1/catalog", undefined, 403);
await deviceClient.call("/api/v1/catalog", undefined, 401);
await recover.call("/api/v1/account/recovery-complete", {}, 409);
const replacement = softwarePasskey(origin);
await replacement.register(recover);
await recover.call("/api/v1/account/recovery-complete", {});
await recover.call("/api/v1/catalog", undefined, 401);
await replacement.authenticate(recover);
await recover.call("/api/v1/catalog");
assert.equal(
  (
    database
      .prepare("SELECT COUNT(*) AS n FROM auth_passkeys WHERE userId = ?")
      .get(ready.user.id) as any
  ).n,
  1,
);
assert.equal(
  (
    database
      .prepare("SELECT COUNT(*) AS n FROM auth_two_factors WHERE userId = ?")
      .get(ready.user.id) as any
  ).n,
  0,
);
await device.authenticate(deviceClient, { expected: 401 });
console.log(
  "Native passkeys/recovery: signed ceremonies, user verification, wrong origins, replay rejection, restricted recovery, replacement enrollment and old-factor removal passed.",
);
const recoveryDirectory = mkdtempSync(
  resolve(tmpdir(), "canvas-recovery-test-"),
);
try {
  const output = resolve(recoveryDirectory, "owner-link.txt");
  execFileSync(
    process.execPath,
    [
      "scripts/operator.mjs",
      "recover-owner",
      "--local",
      "--config",
      "tests/wrangler.auth.jsonc",
      "--execute",
      "--reason",
      "Isolated recovery conformance",
      "--origin",
      origin,
      "--output",
      output,
    ],
    { stdio: "pipe" },
  );
  assert.equal(statSync(output).mode & 0o777, 0o600);
  const proof = new URLSearchParams(
    new URL(readFileSync(output, "utf8").trim()).hash.slice(1),
  ).get("token");
  const first = new Client(),
    second = new Client();
  await Promise.all([
    first.call("/api/v1/auth/bootstrap"),
    second.call("/api/v1/auth/bootstrap"),
  ]);
  const attempts = await Promise.all(
    [first, second].map(async (candidate) => {
      const response = await fetch(`${origin}/api/auth/operator-recovery`, {
        method: "POST",
        headers: {
          Origin: origin,
          "X-Canvas-CSRF": candidate.csrf,
          Cookie: [...candidate.cookies]
            .map(([key, value]) => `${key}=${value}`)
            .join("; "),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: proof }),
      });
      for (const line of response.headers.getSetCookie()) {
        const pair = line.split(";")[0],
          index = pair.indexOf("=");
        candidate.cookies.set(pair.slice(0, index), pair.slice(index + 1));
      }
      return { candidate, status: response.status };
    }),
  );
  assert.deepEqual(attempts.map((item) => item.status).sort(), [200, 400]);
  await recover.call("/api/v1/catalog", undefined, 401);
  await first.call("/api/auth/operator-recovery", { token: proof }, 400);
  assert.equal(
    (
      database
        .prepare(
          "SELECT COUNT(*) AS n FROM security_audit WHERE action = 'account.emergency_recovery_started'",
        )
        .get() as any
    ).n,
    1,
  );
  assert.equal(
    (
      database
        .prepare(
          "SELECT COUNT(*) AS n FROM auth_sessions WHERE userId = ? AND assurance = 'recovery'",
        )
        .get(ready.user.id) as any
    ).n,
    1,
  );
  const emergencyClient = attempts.find(
    (item) => item.status === 200,
  )!.candidate;
  const factor = await emergencyClient.call("/api/auth/two-factor/enable", {
    password,
    issuer: "Huddle Loom",
  });
  const totpSecret = new URL(factor.totpURI).searchParams.get("secret")!;
  await emergencyClient.call("/api/auth/two-factor/verify-totp", {
    code: await codeFor(totpSecret),
  });
  await emergencyClient.call("/api/v1/account/recovery-complete", {});
  await emergencyClient.call("/api/v1/catalog", undefined, 401);
  const fresh = await emergencyClient.call("/api/auth/sign-in/email", {
    email: ready.user.email,
    password,
  });
  assert.equal(fresh.twoFactorRedirect, true);
  // UI verification can use the next TOTP window without exposing production credentials.
  if (process.argv.includes("--ui-fixture"))
    writeFileSync(
      "/tmp/canvas-auth-ui.json",
      JSON.stringify({
        email: ready.user.email,
        password,
        totpSecret,
        memberEmail,
        memberCookies: [...member.cookies],
        boardId: board.id,
      }),
      { mode: 0o600 },
    );
  console.log(
    "Operator recovery: actual CLI issuance, private file permissions, concurrent single winner, revoked old sessions, restricted assurance and replay rejection passed.",
  );
} finally {
  rmSync(recoveryDirectory, { recursive: true, force: true });
}
// Measure a separate fixture phase, outside the brute-force policy checks.
// Four concurrent password checks share the isolate's bounded KDF queue.
database.exec("DELETE FROM request_limits");
const passwordClients = Array.from({ length: 4 }, () => new Client());
await Promise.all(
  passwordClients.map((candidate) => candidate.call("/api/v1/auth/bootstrap")),
);
const batchStart = performance.now();
const verificationTimes = await Promise.all(
  passwordClients.map(async (candidate) => {
    const start = performance.now();
    await candidate.call("/api/auth/sign-in/email", {
      email: memberEmail,
      password,
    });
    return Math.round(performance.now() - start);
  }),
);
verificationTimes.sort((a, b) => a - b);
console.log(
  `Native password concurrency: 4 successful sign-ins, p50 ${verificationTimes[1]} ms, max ${verificationTimes[3]} ms, batch ${Math.round(performance.now() - batchStart)} ms. Local wall time includes HTTP, D1 and queued scrypt; deployed CPU/memory needs Cloudflare measurement.`,
);
database.close();
