import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
const args = process.argv.slice(2),
  command = args.shift();
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
};
const flag = (name) => args.includes(`--${name}`);
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
function privateFile(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
}
function fail(message) {
  throw new Error(message);
}
function run(sql) {
  const config = option("config") ?? "wrangler.jsonc";
  if (flag("local") === flag("remote"))
    fail("Choose exactly one of --local or --remote.");
  const directory = mkdtempSync(resolve(tmpdir(), "canvas-operator-"));
  try {
    const path = resolve(directory, "operation.sql");
    writeFileSync(path, sql, { mode: 0o600 });
    const result = spawnSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "d1",
        "execute",
        "CATALOG",
        "--config",
        config,
        flag("remote") ? "--remote" : "--local",
        "--file",
        path,
        "--json",
      ],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    if (result.status !== 0)
      fail(
        "The database command failed. Check the selected configuration, migration version and Cloudflare permissions. No recovery link was issued.",
      );
    return JSON.parse(result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
try {
  if (command === "generate-secrets") {
    const path = resolve(
      option("output") ?? fail("Provide --output outside the repository."),
    );
    privateFile(
      path,
      JSON.stringify(
        {
          AUTH_SECRET: randomBytes(48).toString("base64url"),
          AUTH_BOOTSTRAP_SECRET: randomBytes(32).toString("base64url"),
          AUTH_ENCRYPTION_KEYS: JSON.stringify([
            {
              id: `key-${Date.now()}`,
              key: randomBytes(32).toString("base64url"),
            },
          ]),
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      `Wrote owner-readable secret values to ${path}. Import them with Wrangler secrets bulk and store a protected backup.`,
    );
  } else if (command === "inventory") {
    const result = run(
      "SELECT state, owner_id, setup_user_id, registration FROM installation; SELECT lower(email) AS email, COUNT(*) AS identities FROM users GROUP BY lower(email) HAVING COUNT(*) > 1; SELECT user_id FROM workspace_memberships WHERE role = 'owner'; SELECT status, COUNT(*) AS accounts FROM account_security GROUP BY status; SELECT (SELECT COUNT(*) FROM boards) AS boards, (SELECT COUNT(*) FROM resource_grants) AS grants, (SELECT COUNT(*) FROM asset_references WHERE byte_size < 0) AS assets_needing_inventory;",
    );
    const path = resolve(
      option("output") ?? fail("Provide --output for the private inventory."),
    );
    privateFile(path, JSON.stringify(result, null, 2) + "\n");
    console.log(
      `Saved migration inventory to ${path}. Review duplicate addresses and owner identities before cutover.`,
    );
  } else if (command === "recover-owner") {
    if (!flag("execute"))
      fail(
        "This revokes any earlier recovery link. Add --execute after reviewing the target installation.",
      );
    const reason = option("reason");
    if (!reason || reason.length < 8 || reason.length > 160)
      fail("Provide an 8–160 character --reason.");
    const origin = new URL(
      option("origin") ?? fail("Provide the canonical --origin."),
    );
    if (
      origin.origin !== origin.href.replace(/\/$/, "") ||
      (origin.protocol !== "https:" &&
        !(
          flag("local") && ["localhost", "127.0.0.1"].includes(origin.hostname)
        ))
    )
      fail("Use the exact HTTPS origin (or loopback with --local).");
    const output = resolve(
      option("output") ??
        fail("Provide --output for the private recovery link."),
    );
    const token = randomBytes(32).toString("base64url"),
      hash = createHash("sha256").update(token).digest("base64url"),
      at = new Date().toISOString();
    const result = run(
      `UPDATE emergency_recovery SET used_at = ${Date.now()} WHERE used_at IS NULL; INSERT INTO emergency_recovery(token_hash,user_id,expires_at,reason) SELECT ${quote(hash)}, i.owner_id, ${Date.now() + 600000}, ${quote(reason)} FROM installation i JOIN auth_users u ON u.id = i.owner_id AND u.emailVerified = 1 JOIN account_security s ON s.user_id = i.owner_id AND s.status = 'active' WHERE i.state = 'ready'; INSERT INTO security_audit(id,actor_id,action,target_id,outcome,metadata,created_at) SELECT ${quote(randomBytes(18).toString("base64url"))}, 'operator', 'account.emergency_recovery_issued', user_id, 'success', ${quote(JSON.stringify({ reason }))}, ${quote(at)} FROM emergency_recovery WHERE token_hash = ${quote(hash)}; SELECT user_id FROM emergency_recovery WHERE token_hash = ${quote(hash)};`,
    );
    if (!result.at(-1)?.results?.length)
      fail(
        "The designated owner must be verified, active, and fully configured.",
      );
    privateFile(output, `${origin.origin}/operator-recovery#token=${token}\n`);
    console.log(
      `Saved a single-use recovery link to ${output}. It expires in ten minutes. It permits factor replacement only.`,
    );
  } else if (command === "invalidate-restored-sessions") {
    if (!flag("execute"))
      fail(
        "Add --execute to invalidate credentials in the isolated restored installation.",
      );
    const expected = option("expected-origin");
    if (!expected)
      fail("Provide --expected-origin matching the restored installation.");
    const current = run("SELECT origin FROM installation;");
    if (current[0]?.results?.[0]?.origin !== expected)
      fail("The installation origin does not match --expected-origin.");
    const at = quote(new Date().toISOString());
    run(
      `UPDATE account_security SET auth_version = auth_version + 1; DELETE FROM auth_sessions; UPDATE oauth_tokens SET revoked_at = ${at}; UPDATE oauth_grants SET revoked_at = ${at}; UPDATE oauth_families SET revoked_at = ${at}; DELETE FROM oauth_codes; DELETE FROM oauth_authorization_requests; DELETE FROM auth_verifications; DELETE FROM auth_email_proofs; DELETE FROM auth_return_intents; DELETE FROM setup_sessions; DELETE FROM emergency_recovery; DELETE FROM mfa_replay; UPDATE security_outbox SET status = 'expired',payload = '',lease_key = NULL WHERE kind = 'mail'; UPDATE installation SET cache_namespace = ${quote(randomBytes(24).toString("base64url"))}, version = version + 1; INSERT INTO security_audit(id,actor_id,action,outcome,metadata,created_at) VALUES (${quote(randomBytes(18).toString("base64url"))}, 'operator', 'installation.restore_credentials_invalidated', 'success', '{}', ${at});`,
    );
    console.log(
      "Invalidated restored sessions, assistant authorizations and pending identity proofs. Verify isolated storage and origin before enabling traffic.",
    );
  } else
    fail(
      "Commands: generate-secrets, inventory, recover-owner, invalidate-restored-sessions. Database commands require --config and exactly one of --local/--remote. Private output paths must not already exist.",
    );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Operator action failed.",
  );
  process.exitCode = 1;
}
