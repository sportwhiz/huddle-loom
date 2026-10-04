// Real product UI with local, intercepted APIs. No account, sharing, or hosting changes.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
const origin = process.env.UI_ORIGIN ?? "http://127.0.0.1:5302";
assert(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
const output = "/tmp/huddle-guided-tours";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROMIUM_EXECUTABLE_PATH ??
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
});
const user = {
  id: "tour-owner",
  name: "Alex Weaver",
  email: "alex@example.test",
  color: "#3D4A73",
};
const settings = {
  title: "Huddle Loom",
  registration: "invite",
  approval_required: 1,
  mfa_required: 0,
  magic_link: 0,
  dynamic_registration: 0,
  session_idle_seconds: 3600,
  session_absolute_seconds: 86400,
};
const data = {
  transfers: [],
  people: [],
  invitations: [],
  clients: [],
  events: [],
  settings,
  providers: { providers: [], callbacks: {}, allowedOidcOrigins: [] },
  usage: { accounts: [], boards: 1, referencedStorageBytes: 0, mailToday: 0 },
  limits: {},
  jobs: [],
  receipts: [],
  migrations: [],
  rehearsals: [],
  origin,
  authentication: "native",
  emailReady: false,
};
let snapshot;
try {
  for (const [theme, width, role, height] of [
    ["light", 1440, "owner", 1000],
    ["dark", 1440, "owner", 1000],
    ["dark", 390, "owner", 844],
    ["light", 390, "guest", 844],
    ["light", 844, "owner", 390],
  ].filter(
    (item) =>
      !process.env.TOUR_WIDTH || item[1] === Number(process.env.TOUR_WIDTH),
  )) {
    const context = await browser.newContext({
      viewport: { width, height },
      colorScheme: theme,
      reducedMotion: "reduce",
    });
    await context.addInitScript(
      (theme) => localStorage.setItem("whiteboard-appearance", theme),
      theme,
    );
    const errors = [],
      writes = [];
    let seen = 0;
    let anonymousRole;
    const collaboration = {
      revision: 0,
      comments: [],
      timer: null,
      voteRounds: [],
      brainstorm: null,
      presentation: null,
      raisedHands: {},
      checkpoints: [],
      activity: [],
      participants: [],
      currentUserId: user.id,
      capabilities: {
        role: role === "guest" ? "viewer" : "owner",
        edit: role !== "guest",
        comment: role !== "guest",
        manage: role !== "guest",
        facilitate: role !== "guest",
      },
    };
    await context.routeWebSocket("**/api/v1/boards/**/ws", (ws) => {
      ws.onMessage(() => {});
    });
    await context.route("**/api/**", async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname;
      if (!path.startsWith("/api/")) return route.continue();
      if (req.method() !== "GET") {
        writes.push(path);
        if (path === "/api/v1/account/onboarding") {
          const body = req.postDataJSON();
          seen |= { home: 1, board: 2, admin: 4, account: 8, connections: 16 }[
            body.journey
          ];
        }
        return route.fulfill({ json: { saved: true } });
      }
      if (path === "/api/v1/auth/bootstrap")
        return route.fulfill({
          json: {
            mode: "native",
            configured: true,
            setup: false,
            csrf: "fixture",
            cacheNamespace: "tour-test",
            user,
            account: {
              status: "active",
              role,
              verified: true,
              needsMfa: false,
              recoveryRequired: false,
              onboarding: seen,
              authVersion: 1,
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
            },
          },
        });
      if (path === "/api/v1/guest-links/session")
        return route.fulfill({
          json: {
            entryCsrf: "fixture",
            guest: {
              boardId: "board:tour",
              linkId: `guest-link-${anonymousRole}`,
              sessionId: "guest-session-fixture",
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
              csrf: "fixture",
              user,
              role: anonymousRole,
              title: "Ideas together",
            },
          },
        });
      if (path === "/api/v1/workspace")
        return route.fulfill({
          json: {
            catalog: {
              boards: [],
              folders: [],
              workbooks:
                role === "guest"
                  ? []
                  : [
                      {
                        id: "workbook:test",
                        title: "Ideas",
                        role: "owner",
                        folderId: null,
                      },
                    ],
            },
            user,
            workspace: { canCreate: role !== "guest", owner: role === "owner" },
            notifications: { notifications: [] },
          },
        });
      if (path.endsWith("/bootstrap"))
        return route.fulfill({
          json: {
            revision: 0,
            updatedAt: new Date().toISOString(),
            documentEpoch: "tour-fixture",
            snapshot,
            collaboration,
            metadata: {
              title: "Ideas together",
              workbookTitle: "Ideas",
              canCopy: true,
            },
          },
        });
      if (path === "/api/v1/connections")
        return route.fulfill({ json: { connections: [] } });
      if (path === "/api/v1/account/security")
        return route.fulfill({
          json: {
            user,
            verified: true,
            mfa: false,
            mfaRequired: false,
            recoveryRequired: false,
            methods: [{ id: "credential", providerId: "credential" }],
            passkeys: [],
            sessions: [],
            events: [],
          },
        });
      if (path === "/api/v1/admin/updates")
        return route.fulfill({
          json: {
            current: { version: "1.2.0", commit: "a".repeat(40) },
            available: null,
            connected: false,
            runnerReady: false,
            automaticSecurity: false,
            checkedAt: Date.now(),
            history: [],
          },
        });
      if (path === "/api/v1/admin/local-invitations")
        return route.fulfill({ json: { invitations: [] } });
      if (path.startsWith("/api/v1/admin/"))
        return route.fulfill({ json: data });
      return route.fulfill({ json: { notice: null } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.log("PAGE ERROR", error.message);
    });
    await page.goto(origin);
    await page.locator(".onboarding-card").waitFor();
    // Every step points to a measured, visible control, stays inside viewport, and
    // does not cover its spotlight. Test real target rectangles, not static classes.
    async function walk(label) {
      console.log("Walking", label, theme, width);
      let count = 0;
      do {
        await page.waitForTimeout(240);
        console.log(
          "Step",
          label,
          await page
            .locator(".onboarding-card")
            .getAttribute("data-tour-target"),
        );
        await page.screenshot({ path: `${output}/latest.png` });
        await page.locator(".onboarding-spotlight").waitFor();
        assert.equal(
          await page.locator(".onboarding-missing").count(),
          0,
          `${label}: target missing`,
        );
        const card = await page.locator(".onboarding-card").boundingBox(),
          spot = await page.locator(".onboarding-spotlight").boundingBox();
        assert(
          card.x >= 0 &&
            card.y >= 0 &&
            card.x + card.width <= width + 1 &&
            card.y + card.height <= height + 1,
          `${label}: card offscreen ${JSON.stringify(card)}`,
        );
        const overlap =
          Math.max(
            0,
            Math.min(card.x + card.width, spot.x + spot.width) -
              Math.max(card.x, spot.x),
          ) *
          Math.max(
            0,
            Math.min(card.y + card.height, spot.y + spot.height) -
              Math.max(card.y, spot.y),
          );
        assert.equal(overlap, 0, `${label}: card covers target`);
        await page.keyboard.press("Shift+Tab");
        assert(
          await page.evaluate(
            () => !!document.activeElement?.closest('[role="dialog"]'),
          ),
        );
        if (count === 0)
          await page.screenshot({
            path: `${output}/${label}-${theme}-${width}.png`,
          });
        const next = page.locator(".onboarding-next");
        const done = (await next.innerText()).includes("Finish");
        await next.click();
        count++;
        if (done) break;
      } while (count < 20);
      assert(count < 20);
      await page.locator(".onboarding-card").waitFor({ state: "hidden" });
    }
    await walk("studio");
    await page.reload();
    await page.waitForTimeout(1300);
    assert.equal(
      await page.locator(".onboarding-card").count(),
      0,
      "Completed guide repeats after reload",
    );
    // Replay is available at the real control; skipping does not edit anything.
    if (
      !(await page
        .getByRole("button", { name: "Studio navigation", exact: true })
        .isVisible())
    )
      await page
        .getByRole("button", { name: "Quick tour", exact: true })
        .click();
    else {
      await page
        .getByRole("button", { name: "Studio navigation", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Quick tour", exact: true })
        .click();
    }
    await page.locator(".onboarding-card").waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".onboarding-card").waitFor({ state: "hidden" });
    if (width <= 540) {
      await page
        .getByRole("button", { name: "Studio navigation", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Quick tour", exact: true })
        .click();
      await page.locator(".onboarding-card").waitFor();
      await page.locator(".onboarding-next").click();
      await page.waitForTimeout(250);
      await page
        .getByRole("button", {
          name: "Leave the guide and explore",
          exact: true,
        })
        .click();
      await page.waitForFunction(
        () => !!document.activeElement?.closest(".sidebar-nav"),
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Studio navigation", exact: true })
          .getAttribute("aria-expanded"),
        "true",
        "Explore must leave its navigation target available",
      );
    }

    for (const path of [
      "/settings/connections",
      "/settings/account",
      ...(role === "owner"
        ? [
            "/settings/people",
            "/settings/invitations",
            "/settings/sign-in",
            "/settings/clients",
            "/settings/usage",
            "/settings/activity",
            "/settings/updates",
            "/settings/system",
          ]
        : []),
    ].filter(
      (path) => !process.env.TOUR_ONLY || path.endsWith(process.env.TOUR_ONLY),
    )) {
      console.log("Loading", path, theme, width);
      await page.goto(origin + path);
      await page.getByRole("heading", { level: 1 }).waitFor();
      if (
        process.env.TOUR_ONLY ||
        path === "/settings/connections" ||
        path === "/settings/account" ||
        path === "/settings/people"
      )
        await page.locator(".onboarding-card").waitFor();
      else {
        await page.waitForTimeout(1000);
        console.log(
          "Replay state",
          path,
          await page.locator(".onboarding-card").count(),
          await page.locator("[role=dialog]").count(),
        );
        if ((await page.locator(".onboarding-card").count()) === 0)
          await page
            .getByRole("button", { name: "Quick tour", exact: true })
            .click();
        await page.locator(".onboarding-card").waitFor();
      }
      await walk(path.split("/").at(-1));
    }
    if (!snapshot)
      snapshot = await page.evaluate(async () => {
        const { createLocalBoard } = await import(
          "/src/blocksuite/create-board.ts"
        );
        const { captureNativeSnapshot } = await import(
          "/src/blocksuite/runtime/snapshot.ts"
        );
        const board = createLocalBoard();
        const snapshot = captureNativeSnapshot(board.workspace);
        board.workspace.dispose();
        return snapshot;
      });
    await page.goto(origin + "/boards/board%3Atour");
    await page.locator(".creation-rail").waitFor({ timeout: 120000 });
    await page.locator(".onboarding-card").waitFor();
    await walk("board");
    // Continue after an unavailable control with an explicit, non-pointing fallback.
    await page
      .getByRole("button", { name: "Keyboard shortcuts", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Take a quick board tour", exact: true })
      .click();
    await page.locator(".onboarding-card").waitFor();
    await page
      .getByRole("button", { name: "Leave the guide and explore", exact: true })
      .click();
    await page.locator(".onboarding-card").waitFor({ state: "hidden" });
    await page.waitForFunction(() =>
      document.activeElement?.matches(
        '.creation-rail button, button[aria-label="Fit board"]',
      ),
    );
    await page.evaluate(() =>
      window.dispatchEvent(new Event("canvas-open-tour")),
    );
    await page.locator(".onboarding-card").waitFor();
    await page.evaluate(() => {
      document.querySelector(".creation-rail")?.remove();
      document.querySelector('button[aria-label="Fit board"]')?.remove();
    });
    await page.locator(".onboarding-missing").waitFor();
    assert.equal(await page.locator(".onboarding-spotlight").count(), 0);
    await page.keyboard.press("Escape");
    if (width === 1440 && theme === "light")
      for (const guestRole of ["viewer", "editor"]) {
        anonymousRole = guestRole;
        collaboration.capabilities.role = guestRole;
        collaboration.capabilities.edit = guestRole === "editor";
        collaboration.capabilities.manage = false;
        collaboration.capabilities.comment = guestRole === "editor";
        const before = writes.length;
        await page.goto(origin + "/guest/board%3Atour");
        await page.locator(".creation-rail").waitFor();
        await page.locator(".onboarding-card").waitFor();
        await walk(`anonymous-${guestRole}`);
        assert.equal(
          writes.length,
          before,
          "Anonymous guide must never mutate an account",
        );
        await page
          .getByRole("button", { name: "Keyboard shortcuts", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Take a quick board tour", exact: true })
          .click();
        await page.locator(".onboarding-card").waitFor();
        await page.keyboard.press("Escape");
        assert.equal(writes.length, before);
      }
    assert(
      writes.every((path) => path === "/api/v1/account/onboarding"),
      `Tour caused a mutation: ${writes}`,
    );
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    "Guided tours passed: real Studio, board, connected apps, account, every admin section; light/dark/mobile, guest roles, anchored geometry, focus, completion, skip, replay and missing controls.",
  );
} finally {
  await browser.close();
}
