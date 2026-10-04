import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { setDefaultResultOrder } from "node:dns";
import { connect } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { checkOnboardingScreens } from "./onboarding-visual-check.mjs";

// Fresh disposable resources. This never targets a deployed Worker or the
// user's existing local installation. No real provider credentials are used.
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
setDefaultResultOrder("ipv6first");
const origin = "http://localhost:5188";
const directory = mkdtempSync("tests/native-browser-");
const config = `${directory}/wrangler.jsonc`;
const source = JSON.parse(readFileSync("tests/wrangler.auth.jsonc", "utf8"));
source.main = "../../src/worker.ts";
source.vars.AUTH_ORIGIN = origin;
source.vars.ACCESS_INTEGRATION = "off";
delete source.vars.MAIL_PROVIDER;
delete source.vars.MAIL_FROM;
source.vars.GITHUB_CLIENT_ID = "isolated-browser-fixture";
source.vars.GITHUB_CLIENT_SECRET = "isolated-browser-fixture";
source.d1_databases[0].migrations_dir = "../../migrations";
writeFileSync(config, JSON.stringify(source, null, 2));
const env = {
  ...process.env,
  WHITEBOARD_WRANGLER_CONFIG: config,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --dns-result-order=ipv6first`,
};
let server;
let browser;
try {
  const occupied = await new Promise((resolve) => {
    const socket = connect({ host: "localhost", port: 5188 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(true);
    });
  });
  assert(
    !occupied,
    "Stop the service on localhost:5188 before running this isolated browser test.",
  );
  const migrated = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "CATALOG",
      "--local",
      "--config",
      config,
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(
    migrated.status,
    0,
    "Could not migrate the isolated browser fixture.",
  );
  server = spawn(
    process.execPath,
    [
      resolve("node_modules/vite/bin/vite.js"),
      "--host",
      "localhost",
      "--port",
      "5188",
      "--strictPort",
    ],
    { env, stdio: "ignore" },
  );
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(`${origin}/api/v1/auth/bootstrap`);
      const value = await response.json();
      if (
        response.ok &&
        value.setupState === "unclaimed" &&
        !value.email &&
        value.providers?.includes("github")
      ) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert(
    ready,
    "The isolated fresh setup fixture did not start on localhost:5188.",
  );
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROMIUM_EXECUTABLE_PATH ??
      (existsSync(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      )
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : undefined),
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const results = resolve("../../test-results/native-setup");
  mkdirSync(results, { recursive: true });
  await page.goto(`${origin}/setup`);
  await page
    .getByRole("heading", { name: "Set up your studio", exact: true })
    .waitFor();
  // Practice interactions should be usable without importing the full editor.
  const practiceNote = page.getByRole("button", { name: "Practice note: The idea", exact: true });
  const originalText = await practiceNote.innerText();
  await practiceNote.dblclick();
  await page.getByRole("textbox", { name: "Edit The idea", exact: true }).fill("Discard this draft");
  await page.getByRole("textbox", { name: "Edit The idea", exact: true }).press("Escape");
  assert.equal(await practiceNote.innerText(), originalText, "Escape must cancel a practice edit, including blur.");
  const before = await practiceNote.boundingBox();
  await practiceNote.press("ArrowRight");
  assert((await practiceNote.boundingBox()).x > before.x, "Keyboard movement must move the note.");
  await practiceNote.press("Enter");
  await page.getByRole("textbox", { name: "Edit The idea", exact: true }).fill("A saved idea");
  await page.getByLabel("Setup key", { exact: true }).click();
  assert.equal(await page.getByLabel("Setup key", { exact: true }).evaluate(element => element === document.activeElement), true, "Leaving an edit must not steal focus from setup.");
  assert((await practiceNote.innerText()).includes("A saved idea"));
  await page.getByRole("button", { name: "Add a practice note", exact: true }).click();
  await page.getByRole("textbox", { name: "Edit Your idea", exact: true }).fill("Another idea");
  await page.getByRole("textbox", { name: "Edit Your idea", exact: true }).press("Enter");
  assert.equal(await page.getByRole("button", { name: /^Practice note:/ }).count(), 4);
  await page.getByRole("button", { name: "Reset practice board", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: /^Practice note:/ }).count(), 3);
  assert.equal(await practiceNote.innerText(), originalText);
  await page.screenshot({
    path: `${results}/locked-setup.png`,
    fullPage: true,
  });
  await page
    .getByLabel("Setup key", { exact: true })
    .fill(source.vars.AUTH_BOOTSTRAP_SECRET);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("button", { name: "Continue with GitHub", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Email address", { exact: true }).count(),
    0,
    "Provider-only setup must not require unavailable email delivery.",
  );
  await page.screenshot({
    path: `${results}/github-setup.png`,
    fullPage: true,
  });

  // Navigate from a different site, so Chrome enforces its actual SameSite
  // rules. The JSON response observes cookies on that very first return GET.
  // OAuth code exchange itself is covered separately in native-setup.test.ts.
  await page.route("https://github.com/login/oauth/authorize**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<a href="${origin}/api/v1/auth/bootstrap">Return to Open Whiteboard</a><form method="post" action="${origin}/api/v1/setup/complete"><button>Cross-site mutation</button></form>`,
    }),
  );
  await page
    .getByRole("button", { name: "Continue with GitHub", exact: true })
    .click();
  await page.getByRole("link", { name: "Return to Open Whiteboard" }).waitFor();
  const providerUrl = page.url();
  const returned = page.waitForResponse(
    (response) => response.url() === `${origin}/api/v1/auth/bootstrap`,
  );
  await page.getByRole("link", { name: "Return to Open Whiteboard" }).click();
  assert.equal(
    (await (await returned).json()).unlocked,
    true,
    "Setup proof was lost on the cross-site return.",
  );

  await page.goto(providerUrl);
  const rejected = page.waitForResponse(
    (response) => response.url() === `${origin}/api/v1/setup/complete`,
  );
  await page.getByRole("button", { name: "Cross-site mutation" }).click();
  assert.equal(
    (await rejected).status(),
    403,
    "Cross-site setup mutations must remain blocked.",
  );
  await page.goto(`${origin}/setup`);
  await page
    .getByRole("button", { name: "Continue with GitHub", exact: true })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await page.screenshot({
    path: `${results}/github-setup-mobile.png`,
    fullPage: true,
    animations: "disabled",
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    "Mobile setup overflows horizontally.",
  );
  assert.deepEqual(errors, []);
  console.log(
    "Fresh native setup: browser unlock, provider-only UI, real cross-site return cookie, CSRF rejection and mobile layout passed.",
  );
  await context.close();
  await checkOnboardingScreens(browser, origin, results);
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
  }
  rmSync(directory, { recursive: true, force: true });
}
