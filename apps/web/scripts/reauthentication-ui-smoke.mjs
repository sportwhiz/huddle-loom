// Local browser fixture; all requests are intercepted and no live policy changes.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
const origin = process.env.UI_ORIGIN ?? "http://127.0.0.1:5300";
assert(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
await mkdir("/tmp/huddle-verification-policy", { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined) });
try {
  for (const [theme, width] of [["light", 1440], ["dark", 390]]) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: theme });
    await context.addInitScript(theme => localStorage.setItem("whiteboard-appearance", theme), theme);
    const settings = { title: "Open Whiteboard", registration: "invite", approval_required: 0, mfa_required: 0, magic_link: 0, dynamic_registration: 0, reauthentication_seconds: 1800, session_idle_seconds: 604800, session_absolute_seconds: 2592000 };
    const writes = [], failures = [];
    await context.route("**/api/**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (!path.startsWith("/api/")) return route.continue();
      if (path === "/api/v1/auth/bootstrap") return route.fulfill({ json: { mode: "native", configured: true, setup: false, csrf: "fixture", cacheNamespace: "policy-fixture", user: { id: "owner", name: "Alex", email: "alex@example.test", color: "#3D4A73" }, account: { status: "active", role: "owner", verified: true, needsMfa: false, recoveryRequired: false, onboarding: 999, authVersion: 1, expiresAt: new Date(Date.now() + 3600000).toISOString() } } });
      if (path === "/api/v1/workspace") return route.fulfill({ json: { catalog: { boards: [], folders: [], workbooks: [] }, user: { name: "Alex", email: "alex@example.test", color: "#3D4A73" }, workspace: { canCreate: true, owner: true }, notifications: { notifications: [] } } });
      if (path === "/api/v1/admin/settings") {
        if (request.method() === "PATCH") { const body = request.postDataJSON(); writes.push(body); Object.assign(settings, body); return route.fulfill({ json: { saved: true } }); }
        return route.fulfill({ json: { settings, mailReady: false, providers: { providers: [], callbacks: {}, allowedOidcOrigins: [] } } });
      }
      if (path === "/api/v1/admin/owner-transfer") return route.fulfill({ json: { transfers: [] } });
      return route.fulfill({ json: { notice: null } });
    });
    const page = await context.newPage(); page.on("pageerror", error => failures.push(error.message));
    await page.goto(origin + "/settings/sign-in");
    const select = page.getByLabel("Ask again for protected changes after");
    await select.waitFor({ timeout: 10000 }).catch(async error => { await page.screenshot({ path: "/tmp/huddle-policy-failure.png" }); console.log(await page.locator("body").innerText(), failures); throw error; }); assert.equal(await select.inputValue(), "1800");
    assert.equal(await select.locator("option").count(), 6);
    await select.selectOption("3600"); await page.getByRole("button", { name: "Save policy", exact: true }).click();
    await page.waitForFunction(() => document.body.textContent.includes("Changes saved"));
    assert.equal(writes.length, 1); assert.equal(writes[0].reauthentication_seconds, 3600); assert.equal(writes[0].session_idle_seconds, 604800);
    await page.reload(); await select.waitFor(); assert.equal(await select.inputValue(), "3600");
    await select.scrollIntoViewIfNeeded();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Policy page must fit the viewport");
    await page.screenshot({ path: `/tmp/huddle-verification-policy/${theme}.png` });
    assert.deepEqual(failures, []); await context.close();
  }
  console.log("Verification policy UI passed: light/dark/mobile, defaults, choices, save payload and reload.");
} finally { await browser.close(); }
