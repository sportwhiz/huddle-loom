import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { setDefaultResultOrder } from "node:dns";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Disposable native Worker/D1 installation. Never touches deployed resources or
// the user's existing local boards. Browser headers are not mocked or overridden.
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
setDefaultResultOrder("ipv6first");
const origin = "http://localhost:5298";
const callback = "https://assistant.example/callback";
const directory = mkdtempSync("tests/oauth-browser-");
const config = `${directory}/wrangler.jsonc`;
const source = JSON.parse(readFileSync("tests/wrangler.auth.jsonc", "utf8"));
source.main = "../../src/worker.ts";
source.vars.AUTH_ORIGIN = origin;
source.vars.ACCESS_INTEGRATION = "off";
delete source.vars.MAIL_PROVIDER;
delete source.vars.MAIL_FROM;
source.d1_databases[0].migrations_dir = "../../migrations";
writeFileSync(config, JSON.stringify(source, null, 2));
const env = {
  ...process.env,
  WHITEBOARD_WRANGLER_CONFIG: config,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --dns-result-order=ipv6first`,
};
let server, browser, mcp;

function totp(uri) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const secret = new URL(uri).searchParams.get("secret");
  const bits = [...secret].map(char => alphabet.indexOf(char).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from((bits.match(/.{8}/gu) ?? []).map(byte => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  return ((digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1000000).toString().padStart(6, "0");
}

try {
  const occupied = await new Promise(resolve => {
    const socket = connect({ host: "localhost", port: 5298 });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.setTimeout(1000, () => { socket.destroy(); resolve(true); });
  });
  assert(!occupied, "localhost:5298 must be free for the isolated OAuth fixture.");
  const migration = spawnSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "CATALOG", "--local", "--config", config], { env, encoding: "utf8" });
  assert.equal(migration.status, 0, migration.stderr);
  server = spawn(process.execPath, [resolve("node_modules/vite/bin/vite.js"), "--host", "localhost", "--port", "5298", "--strictPort"], { env, stdio: "ignore" });
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(`${origin}/api/v1/auth/bootstrap`);
      const value = await response.json();
      if (response.ok && value.setupState === "unclaimed") { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert(ready, "The disposable native OAuth fixture did not start.");
  browser = await chromium.launch({
    // Use Chrome's current headless mode. The legacy headless shell can bypass
    // callback interception after a form redirect and resolve the test domain.
    channel: "chromium",
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH ?? (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined),
  });
  const context = await browser.newContext();
  let csrf;
  async function call(path, body) {
    const response = await context.request.fetch(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Origin: origin, ...(body === undefined ? {} : { "X-Canvas-CSRF": csrf }) },
      ...(body === undefined ? {} : { data: body }),
      maxRedirects: 0,
    });
    const value = await response.json();
    assert(response.ok(), `${path}: ${response.status()} ${JSON.stringify(value)}`);
    if (value.csrf) csrf = value.csrf;
    return value;
  }
  await call("/api/v1/auth/bootstrap");
  await call("/api/v1/setup/unlock", { secret: source.vars.AUTH_BOOTSTRAP_SECRET });
  const account = { name: "OAuth Browser Owner", username: "oauth-owner", password: "Isolated native browser test phrase 671!" };
  await call("/api/auth/setup/local", account);
  const factor = await call("/api/auth/two-factor/enable", { password: account.password });
  const enrollmentCode = totp(factor.totpURI);
  await call("/api/auth/two-factor/verify-totp", { code: enrollmentCode });
  await call("/api/v1/setup/complete", { title: "OAuth browser studio" });
  // A fresh login includes the real local-account session and MFA gates.
  await call("/api/auth/sign-out", {});
  await call("/api/v1/auth/bootstrap");
  await call("/api/auth/sign-in/local", account);
  // Enrollment consumed this time step's TOTP. Wait for a fresh code rather
  // than bypassing the application's replay protection or assurance checks.
  while (totp(factor.totpURI) === enrollmentCode) await new Promise(resolve => setTimeout(resolve, 250));
  await call("/api/auth/two-factor/verify-totp", { code: totp(factor.totpURI) });
  const bootstrap = await call("/api/v1/auth/bootstrap");
  assert.equal(bootstrap.account.assurance, "strong");
  const registrationResponse = await fetch(`${origin}/oauth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Browser MCP fixture", redirect_uris: [callback], token_endpoint_auth_method: "none" }),
  });
  const registration = await registrationResponse.json();
  assert(registrationResponse.ok, JSON.stringify(registration));
  const page = await context.newPage();
  const errors = [];
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  page.on("requestfailed", request => {
    const url = new URL(request.url());
    errors.push(`${url.origin}${url.pathname}: ${request.failure()?.errorText}`);
  });
  await page.route(`${callback}**`, async route => {
    assert.equal(await route.request().headerValue("referer"), null, "The external callback must not receive the consent URL.");
    await route.fulfill({ contentType: "text/html", body: "<h1>Assistant callback received</h1>" });
  });
  async function consent(decision) {
    const verifier = randomBytes(48).toString("base64url");
    const state = randomBytes(18).toString("base64url");
    const url = new URL(`${origin}/oauth/authorize`);
    url.search = new URLSearchParams({ client_id: registration.client_id, redirect_uri: callback, response_type: "code", scope: "boards:read boards:write collaboration:write boards:export", resource: `${origin}/mcp`, state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
    await page.route("https://assistant.example/start", route => route.fulfill({ contentType: "text/html", body: `<a href="${url.toString()}">Connect Open Whiteboard</a>` }));
    await page.goto("https://assistant.example/start");
    const consentResponse = page.waitForResponse(response => response.url() === url.toString() && response.request().method() === "GET");
    await page.getByRole("link", { name: "Connect Open Whiteboard" }).click();
    const response = await consentResponse;
    assert.equal(response.status(), 200);
    assert.equal(response.headers()["referrer-policy"], "same-origin");
    assert(response.headers()["content-security-policy"].includes("form-action 'self' https://assistant.example"));
    if (decision === "allow") await page.getByRole("radio", { name: "All boards I can access, including future boards" }).check();
    const submitted = page.waitForResponse(response => response.url() === url.toString() && response.request().method() === "POST");
    await page.getByRole("button", { name: decision === "allow" ? "Connect app" : "Cancel", exact: true }).click();
    const approved = await submitted;
    assert.equal(await approved.request().headerValue("origin"), origin);
    assert.equal(approved.status(), 302, `Consent returned ${approved.status()}`);
    try {
      await page.getByRole("heading", { name: "Assistant callback received" }).waitFor();
    } catch (error) {
      // Report browser policy failures without exposing authorization query values.
      const location = new URL(page.url());
      const diagnostics = errors.map(value => value.replace(/https?:\/\/[^\s"']+/gu, raw => {
        try { const url = new URL(raw); return `${url.origin}${url.pathname}`; } catch { return "[URL]"; }
      }));
      throw new Error(`OAuth callback did not load from ${location.protocol}//${location.host}${location.pathname}: ${diagnostics.join("\n")}`, { cause: error });
    }
    const destination = new URL(page.url());
    assert.equal(destination.searchParams.get("state"), state);
    assert.equal(destination.searchParams.get("iss"), origin);
    if (decision === "deny") {
      assert.equal(destination.searchParams.get("error"), "access_denied");
      assert.equal(destination.searchParams.get("code"), null);
      return;
    }
    const code = destination.searchParams.get("code");
    assert(code, "Consent did not issue an authorization code.");
    const tokenResponse = await fetch(`${origin}/oauth/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: registration.client_id, code, code_verifier: verifier, redirect_uri: callback, resource: `${origin}/mcp` }),
    });
    const token = await tokenResponse.json();
    assert(tokenResponse.ok, JSON.stringify(token));
    return token;
  }
  await consent("deny");
  const token = await consent("allow");
  mcp = new Client({ name: "native-oauth-browser", version: "1.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } } }));
  const profile = await mcp.callTool({ name: "get_profile", arguments: {} });
  assert(!profile.isError, JSON.stringify(profile));
  const tools = await mcp.listTools();
  assert(tools.tools.some(tool => tool.name === "create_workflow"), "Workflow authoring tools must be available after consent.");
  assert.equal(errors.filter(value => /Content Security Policy|form-action/iu.test(value)).length, 0, errors.join("\n"));
  console.log("Native browser OAuth: login + MFA, cancel + approval, same-origin CSRF, external callback without referrer, PKCE exchange and authenticated MCP tools passed.");
} finally {
  await mcp?.close();
  await browser?.close();
  if (server && server.exitCode === null) {
    await new Promise(resolve => {
      const timeout = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5000);
      timeout.unref();
      server.once("exit", () => { clearTimeout(timeout); resolve(); });
      server.kill("SIGTERM");
    });
  }
  rmSync(directory, { recursive: true, force: true });
}
