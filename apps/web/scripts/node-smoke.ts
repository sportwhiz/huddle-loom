/** Disposable local Node qualification. Never points at an operator's database. */
import assert from "node:assert/strict";
import { qualifyGuestSharing } from "./guest-smoke";
import { randomBytes, createHmac, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const database = process.env.HUDDLE_NODE_TEST_DATABASE;
assert.ok(
  database && database.endsWith("_test"),
  "An explicit disposable *_test database is required",
);
assert.equal(
  process.env.DB_HOST,
  "127.0.0.1",
  "Only a local disposable MySQL fixture is permitted",
);
const origin = "http://127.0.0.1:5219";
const directory = await mkdtemp(resolve(tmpdir(), "huddle-node-smoke-"));
const password = `Huddle test ${randomBytes(18).toString("base64url")}!`;
const setupPassword = randomBytes(24).toString("base64url");
const config = {
  ...process.env,
  DB_NAME: database,
  ENVIRONMENT: "test",
  PORT: "5219",
  AUTH_ORIGIN: origin,
  SETUP_PASSWORD: setupPassword,
  HUDDLE_PLATFORM:
    process.env.HUDDLE_NODE_TEST_PLATFORM ??
    (process.env.HUDDLE_NODE_TEST_CATALOG === "sqlite"
      ? "node-private-volume"
      : "node-mysql"),
  HUDDLE_DATA_DIRECTORY: directory,
  HUDDLE_ASSETS_DIRECTORY: resolve("dist-node/client"),
  HUDDLE_MIGRATIONS_DIRECTORY: resolve("migrations"),
};
let runtime: { close(): Promise<void> } | undefined;
async function start() {
  if (!process.env.HUDDLE_NODE_TEST_PACKAGE) {
    const { startNodeRuntime } = await import("../src/node/runtime");
    return startNodeRuntime(config);
  }
  const child = spawn(process.execPath, [resolve("dist-node/server.mjs")], {
    cwd: resolve("dist-node"),
    env: config,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let diagnostics = "";
  child.stderr.on("data", (data) => {
    diagnostics = (diagnostics + String(data)).slice(-2000);
  });
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  const close = async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 10000);
    await exited;
    clearTimeout(force);
  };
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null)
        throw new Error(`Packaged server exited: ${diagnostics}`);
      try {
        const health = await fetch(origin + "/api/v1/auth/bootstrap");
        if (health.ok) {
          assert.ok(
            !diagnostics.includes("Yjs was already imported"),
            "Packaged server loaded duplicate Yjs runtimes",
          );
          return { close };
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Packaged server did not become ready");
  } catch (error) {
    await close();
    throw error;
  }
}
const cookies = new Map<string, string>();
let csrf = "";
async function call(
  path: string,
  body?: unknown,
  expected = 200,
  method = body === undefined ? "GET" : "POST",
) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
      Origin: origin,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      "X-Canvas-CSRF": csrf,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0];
    const equal = pair.indexOf("=");
    cookies.set(pair.slice(0, equal), pair.slice(equal + 1));
  }
  const raw = await response.text();
  let value: any;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw;
  }
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(value)}`);
  if (value?.csrf) csrf = value.csrf;
  return value;
}
function totp(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret.toUpperCase().replace(/=/g, ""))
    bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(
    bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[19] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
    6,
    "0",
  );
}
async function qualifyMcp(boardId: string) {
  const callback = "https://client.example/callback",
    resource = origin + "/mcp";
  const registration = await call(
    "/oauth/register",
    {
      client_name: "Node smoke assistant",
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
    },
    201,
  );
  const verifier = randomBytes(48).toString("base64url"),
    state = randomBytes(18).toString("base64url");
  const url = new URL("/oauth/authorize", origin);
  for (const [key, value] of Object.entries({
    client_id: registration.client_id,
    redirect_uri: callback,
    response_type: "code",
    scope: "boards:read boards:write",
    resource,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }))
    url.searchParams.set(key, value);
  const cookieHeader = () =>
    [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
  const consent = await fetch(url, {
    headers: { Cookie: cookieHeader(), Accept: "text/html" },
  });
  const html = await consent.text();
  assert.equal(consent.status, 200);
  for (const cookie of consent.headers.getSetCookie()) {
    const pair = cookie.split(";")[0],
      equal = pair.indexOf("=");
    cookies.set(pair.slice(0, equal), pair.slice(equal + 1));
  }
  const requestId = html.match(/name="request_id" value="([^"]+)"/)?.[1],
    token = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(requestId && token);
  const approved = await fetch(origin + "/oauth/authorize", {
    method: "POST",
    headers: {
      Cookie: cookieHeader(),
      Origin: origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    redirect: "manual",
    body: new URLSearchParams({
      request_id: requestId,
      csrf: token,
      decision: "allow",
      resource_mode: "all",
    }),
  });
  assert.equal(approved.status, 302, await approved.text());
  const destination = new URL(approved.headers.get("location")!);
  assert.equal(destination.searchParams.get("state"), state);
  const exchanged = await fetch(origin + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: registration.client_id,
      code: destination.searchParams.get("code")!,
      code_verifier: verifier,
      redirect_uri: callback,
      resource,
    }),
  });
  const credentials = (await exchanged.json()) as {
    access_token: string;
    refresh_token: string;
  };
  assert.equal(exchanged.status, 200);
  assert.ok(credentials.access_token);
  const client = new Client({ name: "node-qualification", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resource), {
        requestInit: {
          headers: { Authorization: `Bearer ${credentials.access_token}` },
        },
      }),
    );
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 21);
    assert.ok(tools.tools.some((tool) => tool.name === "create_workflow"));
    const workflow = await client.callTool({
      name: "create_workflow",
      arguments: {
        boardId,
        operationId: "node-mcp-workflow",
        title: "Node workflow",
        nodes: [
          { ref: "request", label: "Receive request" },
          { ref: "review", label: "Review request" },
          { ref: "done", label: "Send result" },
        ],
        edges: [
          { sourceRef: "request", targetRef: "review" },
          { sourceRef: "review", targetRef: "done", label: "Approved" },
        ],
      },
    });
    assert.ok(!workflow.isError, JSON.stringify(workflow));
    const mapped = await call(
      `/api/v1/boards/${encodeURIComponent(boardId)}/semantic`,
    );
    assert.equal(mapped.board.connectors.length, 2);
    const semantic = JSON.stringify(mapped);
    for (const text of [
      "Receive request",
      "Review request",
      "Send result",
      "Approved",
    ])
      assert.ok(semantic.includes(text));
  } finally {
    await client.close();
  }
  const rotated = await fetch(origin + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: registration.client_id,
      refresh_token: credentials.refresh_token,
      resource,
    }),
  });
  assert.equal(rotated.status, 200);
  const refreshed = (await rotated.json()) as { access_token: string };
  const revoked = await fetch(origin + "/oauth/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: refreshed.access_token,
      client_id: registration.client_id,
    }),
  });
  assert.equal(revoked.status, 200);
  const rejected = await fetch(resource, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${refreshed.access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "revoked", version: "1" },
      },
    }),
  });
  assert.equal(rejected.status, 401);
}
try {
  runtime = await start();
  assert.equal((await call("/api/v1/auth/bootstrap")).setupState, "unclaimed");
  await call("/api/v1/setup/unlock", { secret: "wrong" }, 403);
  await call("/api/v1/setup/unlock", { secret: setupPassword });
  const owner = await call("/api/auth/setup/local", {
    username: "nodeowner",
    name: "Node owner",
    password,
  });
  assert.ok(owner.recoveryCode);
  await call("/api/v1/auth/bootstrap");
  await call("/api/v1/setup/complete", { title: "Node test" }, 403);
  const factor = await call("/api/auth/two-factor/enable", { password });
  const seed = new URL(factor.totpURI).searchParams.get("secret")!;
  await call("/api/auth/two-factor/verify-totp", { code: totp(seed) });
  await call("/api/v1/auth/bootstrap");
  await call("/api/v1/setup/complete", { title: "Node test" });
  assert.equal((await call("/api/v1/admin/settings")).settings.reauthentication_seconds, 1800);
  await call("/api/v1/admin/settings", { reauthentication_seconds: 3600 }, 200, "PATCH");
  assert.equal((await call("/api/v1/admin/settings")).settings.reauthentication_seconds, 3600);
  const catalog = await call("/api/v1/catalog");
  const workbookId = catalog.workbooks[0].id;
  const board = await call(
    "/api/v1/boards",
    { title: "Node restart board", workbookId },
    201,
  );
  const boardPath = `/api/v1/boards/${encodeURIComponent(board.id)}`;
  // The browser opens this endpoint before it can render or edit a board.
  const initialBootstrap = await call(`${boardPath}/bootstrap`);
  assert.equal(
    initialBootstrap.snapshot.format,
    "cloudflare-whiteboard/native",
  );
  assert.equal(initialBootstrap.metadata.title, "Node restart board");
  assert.ok(initialBootstrap.documentEpoch);
  assert.ok(initialBootstrap.collaboration);
  await call(`${boardPath}/commands`, {
    operationId: "node-smoke-note",
    operations: [
      {
        type: "create_note",
        text: "Saved on Node",
        color: "yellow",
        x: 20,
        y: 20,
      },
    ],
  });
  assert.match(
    JSON.stringify(await call(`${boardPath}/semantic`)),
    /Saved on Node/,
  );
  const socket = new WebSocket(
    origin.replace("http:", "ws:") + boardPath + "/ws",
    {
      headers: {
        Origin: origin,
        Cookie: [...cookies]
          .map(([key, value]) => `${key}=${value}`)
          .join("; "),
      },
    },
  );
  const snapshot = await new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("WebSocket snapshot timeout")),
      5000,
    );
    socket.on("message", (message) => {
      const value = JSON.parse(message.toString());
      if (value.type === "snapshot") {
        clearTimeout(timeout);
        resolve(value);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  assert.ok(snapshot.revision);
  socket.close();
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  const checkGuestsAfterRestart = await qualifyGuestSharing(
    origin,
    call,
    board.id,
  );
  await qualifyMcp(board.id);
  const updates = await call("/api/v1/admin/updates");
  assert.equal(updates.deploymentMode, "manual-node");
  const ownerNotice = await call("/api/v1/updates/notice");
  assert.ok(Object.hasOwn(ownerNotice, "notice"));
  assert.equal(JSON.stringify(ownerNotice).includes("hook"), false);
  await call(
    "/api/v1/admin/updates/connection",
    {
      hook: "https://api.cloudflare.com/client/v4/accounts/example/workers/builds/deploy_hooks/example",
    },
    409,
  );
  const invitation = await call("/api/v1/admin/local-invitations", {
    label: "Node test guest",
    role: "guest",
  });
  const ownerCookies = new Map(cookies),
    ownerCsrf = csrf;
  cookies.clear();
  csrf = "";
  await call("/api/v1/auth/bootstrap");
  const guest = await call("/api/auth/setup/local", {
    username: "nodeguest",
    name: "Node guest",
    password,
    invitation: invitation.token,
  });
  assert.ok(guest.recoveryCode);
  await call("/api/v1/auth/bootstrap");
  await call("/api/v1/admin/people", undefined, 403);
  const guestNotice = await call("/api/v1/updates/notice");
  assert.ok(Object.hasOwn(guestNotice, "notice"));
  await call("/api/v1/admin/updates", undefined, 403);
  const privateBoard = await fetch(origin + boardPath + "/semantic", {
    headers: {
      Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
      Origin: origin,
    },
  });
  assert.ok(
    [403, 404].includes(privateBoard.status),
    "An invited guest cannot read an unshared board",
  );
  cookies.clear();
  for (const [key, value] of ownerCookies) cookies.set(key, value);
  csrf = ownerCsrf;
  assert.equal(
    (await call("/api/v1/admin/local-invitations")).invitations[0]
      .accepted_by !== null,
    true,
  );
  await runtime.close();
  runtime = undefined;
  runtime = await start();
  assert.equal((await call("/api/v1/auth/bootstrap")).setup, false);
  assert.equal((await call("/api/v1/admin/settings")).settings.reauthentication_seconds, 3600);
  await checkGuestsAfterRestart();
  const restartedBootstrap = await call(`${boardPath}/bootstrap`);
  assert.equal(
    restartedBootstrap.documentEpoch,
    initialBootstrap.documentEpoch,
  );
  assert.equal(
    restartedBootstrap.snapshot.format,
    "cloudflare-whiteboard/native",
  );
  assert.equal(restartedBootstrap.metadata.title, "Node restart board");
  const restored = await call(`${boardPath}/semantic`);
  assert.equal(restartedBootstrap.revision, restored.revision);
  assert.match(JSON.stringify(restored), /Saved on Node/);
  assert.equal(restored.board.connectors.length, 2);
  assert.match(JSON.stringify(restored), /Receive request/);
  await call("/api/v1/setup/unlock", { secret: setupPassword }, 409);
  console.log(
    "Node owner/guest setup, MFA, private-board authorization, board save, WebSocket, OAuth/MCP discovery/workflow/refresh/revocation, provider-specific updates and durable restart/session/key continuity passed.",
  );
} finally {
  await runtime?.close();
  await rm(directory, { recursive: true, force: true });
}
