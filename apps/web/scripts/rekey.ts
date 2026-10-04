import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  open,
  seal,
  validateEncryptionKeys,
} from "../src/security/secret-store";
import {
  symmetricDecrypt,
  symmetricEncrypt,
  parseEnvelope,
  type SecretConfig,
} from "better-auth/crypto";
import type { NativeEnv } from "../src/auth/types";

const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(`--${name}`) + 1];
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
async function main() {
  const remote = args.includes("--remote"),
    local = args.includes("--local");
  if (
    remote === local ||
    !args.includes("--config") ||
    !args.includes("--secrets")
  )
    throw new Error(
      "Choose --local or --remote, --config and --secrets. Add --execute to apply the reviewed rotation.",
    );
  const path = resolve(option("secrets"));
  if ((statSync(path).mode & 0o077) !== 0)
    throw new Error(
      "The secret file must be readable only by its owner (chmod 600).",
    );
  const env = JSON.parse(readFileSync(path, "utf8")) as NativeEnv;
  validateEncryptionKeys(env);
  const active = (JSON.parse(env.AUTH_ENCRYPTION_KEYS!) as { id: string }[])[0]
    .id;
  const ring = env.AUTH_SECRETS
    ? (JSON.parse(env.AUTH_SECRETS) as { version: number; value: string }[])
    : undefined;
  if (
    ring &&
    (!ring.length ||
      ring.some(
        (key) =>
          !Number.isSafeInteger(key.version) ||
          key.version < 0 ||
          key.value.length < 32,
      ) ||
      new Set(ring.map((key) => key.version)).size !== ring.length)
  )
    throw new Error("Invalid authentication key ring.");
  const authKey: SecretConfig | undefined = ring
    ? {
        currentVersion: ring[0].version,
        keys: new Map(ring.map((key) => [key.version, key.value])),
        legacySecret: env.AUTH_SECRET,
      }
    : undefined;
  const directory = mkdtempSync(resolve(tmpdir(), "canvas-rekey-"));
  const run = (sql: string) => {
    const file = resolve(directory, "operation.sql");
    writeFileSync(file, sql, { mode: 0o600 });
    const result = spawnSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "d1",
        "execute",
        "CATALOG",
        "--config",
        option("config"),
        remote ? "--remote" : "--local",
        "--file",
        file,
        "--json",
      ],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    if (result.status !== 0)
      throw new Error(
        "Database operation failed. The rotation can be safely rerun with all retained keys.",
      );
    return JSON.parse(result.stdout) as {
      results: Record<string, string>[];
      meta: { changes: number };
    }[];
  };
  try {
    const tables = [
      {
        table: "auth_provider_config",
        id: "id",
        column: "secret",
        purpose: "provider:",
      },
      {
        table: "auth_return_intents",
        id: "token_hash",
        column: "payload",
        purpose: "intent:",
      },
      {
        table: "security_outbox",
        id: "id",
        column: "payload",
        purpose: "mail:",
        where: "AND kind = 'mail'",
      },
      ...(authKey
        ? [
            { table: "auth_two_factors", id: "id", column: "secret" },
            ...["accessToken", "refreshToken"].map((column) => ({
              table: "auth_accounts",
              id: "id",
              column,
            })),
          ]
        : []),
    ];
    let examined = 0,
      changed = 0;
    for (const item of tables) {
      let cursor = "";
      for (;;) {
        const rows = run(
          `SELECT ${item.id} AS row_id, ${item.column} AS value FROM ${item.table} WHERE ${item.id} > ${quote(cursor)} AND ${item.column} IS NOT NULL AND ${item.column} <> '' ${"where" in item ? (item.where ?? "") : ""} ORDER BY ${item.id} LIMIT 50;`,
        )[0].results;
        if (!rows.length) break;
        for (const row of rows) {
          cursor = row.row_id;
          examined++;
          const purpose = "purpose" in item ? item.purpose : undefined;
          // Verify even already-current ciphertext; never report a successful audit
          // merely because the key identifier looks right.
          const plaintext = purpose
            ? await open(env, row.value, `${purpose}${row.row_id}`)
            : await symmetricDecrypt({ key: authKey!, data: row.value });
          if (
            purpose
              ? row.value.startsWith(`${active}.`)
              : parseEnvelope(row.value)?.version === authKey!.currentVersion
          )
            continue;
          const next = purpose
            ? await seal(env, plaintext, `${purpose}${row.row_id}`)
            : await symmetricEncrypt({ key: authKey!, data: plaintext });
          if (args.includes("--execute"))
            changed += run(
              `UPDATE ${item.table} SET ${item.column} = ${quote(next)} WHERE ${item.id} = ${quote(row.row_id)} AND ${item.column} = ${quote(row.value)};`,
            )[0].meta.changes;
          else changed++;
        }
      }
    }
    if (args.includes("--execute"))
      run(
        `INSERT INTO security_audit(id,actor_id,action,outcome,metadata,created_at) VALUES (${quote(crypto.randomUUID())},'operator','installation.keys_rotated','success',${quote(JSON.stringify({ examined, changed, keyId: active, authVersion: authKey?.currentVersion }))},${quote(new Date().toISOString())});`,
      );
    console.log(
      `${args.includes("--execute") ? "Re-encrypted" : "Would re-encrypt"} ${changed} of ${examined} verified records. Keep retained keys until a second audit reports zero changes and all old deployments are retired.`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(() => {
  console.error(
    "Rotation could not finish. Check the configuration, private key file and retained keys. No plaintext was logged. Keep all original keys and rerun after correction.",
  );
  process.exitCode = 1;
});
