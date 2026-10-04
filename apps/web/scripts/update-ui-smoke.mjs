// UI-only fixture: requests are intercepted; no hosting operations occur.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
const origin = process.env.UI_ORIGIN ?? "http://127.0.0.1:5194";
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROMIUM_EXECUTABLE_PATH ??
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
});
const output = "/tmp/huddle-updates-ui";
await mkdir(output, { recursive: true });
try {
  for (const [name, width, theme] of [
    ["desktop-light", 1440, "light"],
    ["desktop-dark", 1440, "dark"],
    ["mobile-dark", 390, "dark"],
  ]) {
    const page = await browser.newPage({
      viewport: { width, height: 1000 },
      colorScheme: theme,
    });
    const failures = [];
    page.on("pageerror", (error) => failures.push(error.message));
    await page.addInitScript(
      (theme) => localStorage.setItem("whiteboard-appearance", theme),
      theme,
    );
    const current = {
      version: "1.2.0",
      commit: "a".repeat(40),
      schema: "b".repeat(64),
      protocol: 1,
      dataFormat: 1,
      security: false,
      notes: "",
    };
    const data = {
      current,
      available: {
        ...current,
        version: "1.2.1",
        notes:
          "Smoother connections during busy huddles.\nImproved account recovery and keyboard navigation.",
        security: true,
      },
      connected: true,
      managedConnection: true,
      runnerReady: true,
      automaticSecurity: false,
      checkedAt: Date.now(),
      checkError: null,
      updateAvailable: true,
      incompatibility: null,
      history: [],
    };
    let installs = 0;
    let retries = 0;
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/v1/auth/bootstrap")
        return route.fulfill({
          json: {
            mode: "native",
            configured: true,
            setup: false,
            csrf: "fixture",
            title: "Huddle Loom",
            user: {
              id: "owner",
              name: "Owner",
              email: "owner",
              color: "#3D4A73",
            },
            account: {
              status: "active",
              role: "owner",
              verified: true,
              needsMfa: false,
              recoveryRequired: false,
              twoFactorEnabled: true,
              assurance: "strong",
              onboarding: 999,
              authVersion: 1,
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
            },
          },
        });
      if (url.pathname === "/api/v1/admin/updates/install") {
        if (route.request().headers()["x-canvas-csrf"] !== "fixture")
          throw new Error("Missing CSRF header");
        installs++;
        data.history = [
          {
            id: "one",
            kind: "update",
            version: "1.2.1",
            status: "queued",
            created_at: Date.now(),
            updated_at: Date.now(),
          },
        ];
        return route.fulfill({ status: 202, json: { id: "one" } });
      }
      if (url.pathname === "/api/v1/admin/updates/retry-deployment") {
        if (route.request().headers()["x-canvas-csrf"] !== "fixture") throw new Error("Missing recovery CSRF header");
        const body = route.request().postDataJSON();
        if (body.id !== "one" || body.cancelledBuild !== true) throw new Error("Wrong recovery confirmation");
        retries++;
        data.history[0].status = "queued";
        return route.fulfill({status: 202, json: {id: "one"}});
      }
      if (url.pathname.startsWith("/api/v1/admin/updates"))
        return route.fulfill({ json: data });
      return route.fulfill({
        json: { boards: [], folders: [], workbooks: [], workspaces: [] },
      });
    });
    await page.goto(origin + "/settings/updates");
    await page.getByRole("heading", { name: "Studio updates" }).waitFor();
    await page
      .getByRole("button", { name: "Update now", exact: true })
      .waitFor();
    if (
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )
    )
      throw new Error("Horizontal overflow");
    await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
    await page.getByRole("button", { name: "Update now", exact: true }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    if (installs) throw new Error("Cancel triggered deployment");
    await page.getByRole("button", { name: "Update now", exact: true }).click();
    await page
      .getByRole("button", { name: "Install update", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Waiting for Cloudflare" })
      .waitFor();
    if (installs !== 1) throw new Error("Incorrect install count");
    data.history[0] = {...data.history[0], status: "uncertain", checkpoint: "before-publication", delayed: true};
    await page.reload();
    await page.getByRole("heading", {name: "Retry this deployment"}).waitFor();
    const retry = page.getByRole("button", {name: "Retry the same deployment", exact: true});
    if (await retry.isEnabled()) throw new Error("Recovery did not require build-stop confirmation");
    await page.screenshot({path: `${output}/${name}-recovery.png`, fullPage: true});
    await page.getByRole("checkbox", {name: "I confirmed the previous build has stopped in Cloudflare"}).check();
    await retry.click();
    await page.getByRole("heading", {name: "Waiting for Cloudflare"}).waitFor();
    if (retries !== 1 || installs !== 1) throw new Error("Incorrect recovery request count");
    data.runnerReady = false;
    data.connected = false;
    data.history[0] = {...data.history[0], kind: "source", status: "queued", delayed: true, message: "Source deployment stopped. Retry this exact Git revision in Cloudflare build history."};
    await page.reload();
    await page.getByRole("heading", {name: "Finish the first deployment"}).waitFor();
    if (await page.getByRole("button", {name: "Clear stalled preparation"}).count()) throw new Error("Bootstrap offered an unusable preparation recovery action");
    if (await page.getByRole("button", {name: "Retry the same deployment", exact: true}).count()) throw new Error("Bootstrap offered recovery through an unregistered hook");
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("Bootstrap recovery has horizontal overflow");
    await page.screenshot({path: `${output}/${name}-bootstrap.png`, fullPage: true});
    data.history = [];
    data.available = null;
    data.updateAvailable = false;
    await page.reload();
    await page.getByRole("heading", {name: "No stable release yet"}).waitFor();
    await page.getByText("Deployment connection needed", {exact: true}).waitFor();
    await page.getByRole("button", {name: "Check for updates", exact: true}).click();
    await page.getByRole("heading", {name: "No stable release yet"}).waitFor();
    if (installs !== 1 || retries !== 1) throw new Error("Empty release check triggered deployment");
    if (await page.getByRole("heading", {name: "You’re up to date"}).count()) throw new Error("Empty channel claimed a stable release was installed");
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("Empty channel has horizontal overflow");
    await page.screenshot({path: `${output}/${name}-no-stable-release.png`, fullPage: true});
    if (failures.length) throw new Error(failures.join("\n"));
    await page.close();
    console.log(`${name}: layout, cancel, confirmation, progress, stopped-build recovery and bootstrap guidance passed`);
  }
} finally {
  await browser.close();
}
