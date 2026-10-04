import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { symmetricDecrypt } from "better-auth/crypto";
import { open, seal } from "../src/security/secret-store";
import type { NativeEnv } from "../src/auth/types";

// The caller stops the isolated auth server before this consistent local copy.
// Never use this file-copy procedure as a remote Cloudflare backup claim.
try {
  const response = await fetch("http://localhost:5180/api/v1/health", {
    signal: AbortSignal.timeout(500),
  });
  if (
    response.ok &&
    ((await response.json()) as { service?: string }).service ===
      "personal-whiteboard"
  )
    throw new Error("Stop the isolated 5180 fixture before copying its state.");
} catch (error) {
  if (error instanceof Error && error.message.startsWith("Stop")) throw error;
}
const source = JSON.parse(readFileSync("tests/wrangler.auth.jsonc", "utf8"));
assert.equal(source.vars.ENVIRONMENT, "test");
assert.equal(source.vars.AUTH_ORIGIN, "http://localhost:5180");
const fixture = JSON.parse(readFileSync("/tmp/canvas-auth-ui.json", "utf8"));
const directory = "tests/restore";
mkdirSync(directory, { recursive: true });
if (readdirSync(directory).length)
  throw new Error(
    "Use an empty tests/restore directory; existing backups are never overwritten.",
  );
cpSync("tests/.wrangler/state", `${directory}/.wrangler/state`, {
  recursive: true,
});
const origin = "http://localhost:5199";
source.main = "../../src/worker.ts";
source.vars.AUTH_ORIGIN = origin;
source.d1_databases[0].migrations_dir = "../../migrations";
const config = `${directory}/wrangler.jsonc`;
writeFileSync(config, JSON.stringify(source, null, 2), { mode: 0o600 });
let server: ReturnType<typeof spawn> | undefined;
const start = async () => {
  server = spawn(
    process.execPath,
    [
      resolve("node_modules/vite/bin/vite.js"),
      "--host",
      "localhost",
      "--port",
      "5199",
      "--strictPort",
    ],
    {
      env: { ...process.env, WHITEBOARD_WRANGLER_CONFIG: config },
      stdio: "ignore",
    },
  );
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`${origin}/api/v1/health`);
      if (
        response.ok &&
        ((await response.json()) as { service?: string }).service ===
          "personal-whiteboard"
      )
        return;
    } catch {}
    if (server.exitCode !== null)
      throw new Error("Restore fixture could not start.");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Restore fixture startup timed out.");
};
const stop = async () => {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => server!.once("exit", () => resolve()));
  server = undefined;
};
const cookies = new Map<string, string>(fixture.memberCookies);
let csrf = "";
async function call(path: string, body?: unknown, expected = 200) {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: origin,
      Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
      "Content-Type": "application/json",
      "X-Canvas-CSRF": csrf,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, expected, `Restore request ${path}`);
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";")[0],
      index = pair.indexOf("=");
    cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
  const value = (await response.json()) as any;
  if (value.csrf) csrf = value.csrf;
  return value;
}
const file = readdirSync(
  `${directory}/.wrangler/state/v3/d1/miniflare-D1DatabaseObject`,
).find((file) => file.endsWith(".sqlite"))!;
const database = new DatabaseSync(
  `${directory}/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/${file}`,
);
const asset = database
  .prepare("SELECT asset_key FROM asset_references WHERE board_id = ? LIMIT 1")
  .get(fixture.boardId) as { asset_key: string };
assert.ok(asset);
const blob = async () => {
  const result = await fetch(
    `${origin}/api/v1/boards/${encodeURIComponent(fixture.boardId)}/blobs/${encodeURIComponent(asset.asset_key)}`,
    {
      headers: {
        Cookie: [...cookies]
          .map(([key, value]) => `${key}=${value}`)
          .join("; "),
      },
    },
  );
  assert.equal(result.status, 200);
  return Buffer.from(await result.arrayBuffer());
};
try {
  await start();
  const before = await call(
      `/api/v1/boards/${encodeURIComponent(fixture.boardId)}`,
    ),
    bytes = await blob();
  const originalNamespace = (await call("/api/v1/auth/bootstrap"))
    .cacheNamespace;
  execFileSync(
    process.execPath,
    [
      "scripts/operator.mjs",
      "invalidate-restored-sessions",
      "--local",
      "--config",
      config,
      "--expected-origin",
      "http://localhost:5180",
      "--execute",
    ],
    { stdio: "pipe" },
  );
  await call("/api/v1/catalog", undefined, 401);
  await call("/api/v1/auth/bootstrap");
  await call("/api/auth/sign-in/email", {
    email: fixture.memberEmail,
    password: fixture.password,
  });
  assert.notEqual(
    (await call("/api/v1/auth/bootstrap")).cacheNamespace,
    originalNamespace,
  );
  const after = await call(
    `/api/v1/boards/${encodeURIComponent(fixture.boardId)}`,
  );
  assert.deepEqual(after, before);
  assert.deepEqual(await blob(), bytes);
  assert.equal(
    (
      database
        .prepare(
          "SELECT COUNT(*) AS n FROM oauth_families WHERE revoked_at IS NULL",
        )
        .get() as any
    ).n,
    0,
  );
  await stop();
  const originalFactor = database
    .prepare("SELECT secret FROM auth_two_factors LIMIT 1")
    .get() as { secret: string };
  const originalSeed = await symmetricDecrypt({
    key: source.vars.AUTH_SECRET,
    data: originalFactor.secret,
  });
  const providerSecret = await seal(
    source.vars as NativeEnv,
    "provider-canary",
    "provider:rotation-fixture",
  );
  database
    .prepare(
      "INSERT INTO auth_provider_config(id,public_config,secret,enabled,updated_at) VALUES (?, ?, ?, 0, ?)",
    )
    .run("rotation-fixture", "{}", providerSecret, new Date().toISOString());
  const intentPayload = await seal(
    source.vars as NativeEnv,
    "intent-canary",
    "intent:rotation-fixture",
  );
  database
    .prepare(
      "INSERT INTO auth_return_intents(token_hash,payload,expires_at) VALUES (?, ?, ?)",
    )
    .run("rotation-fixture", intentPayload, Date.now() + 60000);
  const newKey = randomBytes(32).toString("base64url"),
    newAuth = randomBytes(48).toString("base64url");
  source.vars.AUTH_ENCRYPTION_KEYS = JSON.stringify([
    { id: "rotation-fixture", key: newKey },
    ...JSON.parse(source.vars.AUTH_ENCRYPTION_KEYS),
  ]);
  source.vars.AUTH_SECRETS = JSON.stringify([
    { version: 2, value: newAuth },
    { version: 1, value: source.vars.AUTH_SECRET },
  ]);
  const secrets = resolve(directory, ".wrangler", "rotation-secrets.json");
  writeFileSync(secrets, JSON.stringify(source.vars), { mode: 0o600 });
  const command = [
    "exec",
    "tsx",
    "scripts/rekey.ts",
    "--local",
    "--config",
    config,
    "--secrets",
    secrets,
  ];
  const proposed = execFileSync("pnpm", command, { encoding: "utf8" });
  assert.match(proposed, /Would re-encrypt [1-9]/);
  execFileSync("pnpm", [...command, "--execute"], { stdio: "pipe" });
  assert.match(
    execFileSync("pnpm", command, { encoding: "utf8" }),
    /Would re-encrypt 0 /,
  );
  const encrypted = database
    .prepare("SELECT secret FROM auth_two_factors LIMIT 1")
    .get() as { secret: string };
  const seed = await symmetricDecrypt({
    key: { currentVersion: 2, keys: new Map([[2, newAuth]]) },
    data: encrypted.secret,
  });
  assert.ok(seed === originalSeed, "Re-encryption must preserve the factor");
  const rotatedEnv = {
    ...source.vars,
    AUTH_ENCRYPTION_KEYS: JSON.stringify([
      { id: "rotation-fixture", key: newKey },
    ]),
  } as NativeEnv;
  const provider = database
    .prepare(
      "SELECT secret FROM auth_provider_config WHERE id='rotation-fixture'",
    )
    .get() as { secret: string };
  assert.equal(
    await open(rotatedEnv, provider.secret, "provider:rotation-fixture"),
    "provider-canary",
  );
  const intent = database
    .prepare(
      "SELECT payload FROM auth_return_intents WHERE token_hash='rotation-fixture'",
    )
    .get() as { payload: string };
  assert.equal(
    await open(rotatedEnv, intent.payload, "intent:rotation-fixture"),
    "intent-canary",
  );
  for (const row of database
    .prepare(
      "SELECT id,payload FROM security_outbox WHERE kind='mail' AND payload<>''",
    )
    .all() as { id: string; payload: string }[])
    await open(
      {
        ...source.vars,
        AUTH_ENCRYPTION_KEYS: JSON.stringify([
          { id: "rotation-fixture", key: newKey },
        ]),
      } as NativeEnv,
      row.payload,
      `mail:${row.id}`,
    );
  writeFileSync(config, JSON.stringify(source, null, 2), { mode: 0o600 });
  await start();
  cookies.clear();
  await call("/api/v1/auth/bootstrap");
  await call("/api/auth/sign-in/email", {
    email: fixture.memberEmail,
    password: fixture.password,
  });
  await call(`/api/v1/boards/${encodeURIComponent(fixture.boardId)}`);
  assert.deepEqual(await blob(), bytes);
  console.log(
    "Isolated restoration passed: copied D1, BoardRoom state and R2 assets remain readable; old sessions/families are revoked, cache namespace changes, key rotation is repeatable, and fresh native sign-in still works.",
  );
} finally {
  await stop();
  database.close();
  rmSync(directory, { recursive: true, force: true });
}
