import assert from "node:assert/strict";

// These fixtures exercise rendering and interaction, not authentication policy.
// The native Worker lifecycle and GitHub callback tests cover the real policy.
export async function checkOnboardingScreens(browser, origin, results) {
  const user = {
    id: "onboarding-visual-owner",
    name: "Alex Morgan",
    email: "alex@example.invalid",
    color: "#435dd9",
    avatarUrl: null,
  };
  const account = {
    status: "pending",
    role: null,
    verified: true,
    assurance: "basic",
    needsMfa: true,
    recoveryRequired: false,
    twoFactorEnabled: false,
    setupUser: true,
    authVersion: 1,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    onboarding: 0,
  };
  const base = {
    mode: "native",
    configured: true,
    setup: true,
    unlocked: true,
    setupReserved: true,
    setupState: "claimed",
    title: "Huddle Loom",
    csrf: "visual-fixture",
    email: false,
    providers: ["github"],
    access: false,
    cacheNamespace: "visual-fixture",
    registration: "invite",
    user,
    account,
    setupReview: {
      registration: "invite",
      memberLimit: 25,
      guestLimit: 100,
      boardLimit: 1000,
    },
  };
  for (const layout of [
    { name: "desktop-light", width: 1280, height: 900, theme: "light" },
    { name: "desktop-dark", width: 1280, height: 900, theme: "dark" },
    { name: "mobile-light", width: 390, height: 844, theme: "light" },
    { name: "mobile-dark", width: 390, height: 844, theme: "dark" },
  ]) {
    const context = await browser.newContext({
      viewport: { width: layout.width, height: layout.height },
      colorScheme: layout.theme,
    });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let state = structuredClone(base);
      let passwordMethod = false;
      let methodsUnavailable = false;
      let workbooks = [{ id: "personal", title: "Personal", folderId: null, role: "owner" }];
      const mutations = [];
      await page.route("**/api/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const respond = (json, status = 200) => route.fulfill({ status, json });
        if (path === "/api/v1/auth/bootstrap") return respond(state);
        if (path === "/api/auth/list-accounts")
          return methodsUnavailable
            ? respond({ error: "Account methods unavailable" }, 503)
            : respond([{ providerId: passwordMethod ? "credential" : "github" }]);
        if (path === "/api/v1/auth/intent") return respond({ ok: true });
        if (path === "/api/auth/two-factor/enable")
          return respond({
            totpURI:
              "otpauth://totp/Huddle Loom:alex@example.invalid?secret=JBSWY3DPEHPK3PXP&issuer=Huddle Loom",
            backupCodes: Array.from(
              { length: 10 },
              (_, i) => `demo${i}-code${i}`,
            ),
          });
        if (path === "/api/auth/two-factor/verify-totp") {
          mutations.push(path);
          if (request.postDataJSON().code !== "654321")
            return respond(
              {
                error:
                  "That code has expired. Try the current code from your app.",
              },
              400,
            );
          state.account.assurance = "strong";
          state.account.needsMfa = false;
          state.account.twoFactorEnabled = true;
          return respond({ status: true });
        }
        if (path === "/api/v1/setup/complete") {
          mutations.push(path);
          assert.equal(request.postDataJSON().title, "Design studio");
          state.setup = false;
          state.account.status = "active";
          state.account.role = "owner";
          return respond({ ok: true });
        }
        if (path === "/api/v1/workspace")
          return respond({
            catalog: {
              folders: [],
              workbooks,
              boards: [],
            },
            user: { ...user, authentication: "native" },
            workspace: { owner: true, canCreate: true },
            notifications: { notifications: [] },
          });
        if (path === "/api/v1/account/onboarding") return respond({ ok: true });
        if (path === "/api/v1/catalog") return respond({ folders: [], workbooks, boards: [] });
        if (path === "/api/v1/connections") return respond({ connections: [] });
        if (path === "/api/v1/workbooks" && request.method() === "POST") {
          assert.equal(request.postDataJSON().title, "Project notes");
          workbooks = [{ id: "project-notes", title: "Project notes", folderId: null, role: "owner" }];
          return respond(workbooks[0]);
        }
        return respond(
          { error: `Unmocked visual fixture route: ${path}` },
          400,
        );
      });
      const snapshot = async (name) => {
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
          `${layout.name}/${name} overflows horizontally`,
        );
        const mainCount = await page.locator(".identity-page").count();
        assert(mainCount <= 1, "Multiple identity screens rendered");
        assert.equal(
          await page.locator("html").getAttribute("data-theme"),
          layout.theme,
        );
        await page.screenshot({
          path: `${results}/${layout.name}-${name}.png`,
          fullPage: true,
          animations: "disabled",
        });
      };
      await page.goto(`${origin}/setup`);
      await page
        .getByRole("heading", { name: "Protect your account", exact: true })
        .waitFor();
      await snapshot("security-choice");
      await page
        .getByRole("button", { name: "Use an authenticator app", exact: false })
        .click();
      await page
        .getByRole("button", { name: "Get setup code", exact: true })
        .waitFor();
      await page.locator('.identity-factor button[type="submit"]:not(:disabled)').waitFor();
      assert.equal(
        await page.getByLabel("Current password", { exact: true }).count(),
        0,
        "Provider-only enrollment must not ask for a password",
      );
      await snapshot("authenticator-start");
      await page
        .getByRole("button", { name: "Get setup code", exact: true })
        .click();
      await page.getByAltText("Authenticator setup QR code").waitFor();
      await snapshot("authenticator-scan");
      await page
        .getByText("Enter a setup key instead", { exact: true })
        .click();
      assert.equal(
        await page.locator(".identity-secret").textContent(),
        "JBSWY3DPEHPK3PXP",
      );
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      const saved = page.getByRole("button", {
        name: "I’ve saved my codes",
        exact: true,
      });
      assert(
        await saved.isDisabled(),
        "Recovery codes must be acknowledged before proceeding",
      );
      await snapshot("recovery-codes");
      const download = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "Download recovery codes", exact: true })
        .click();
      assert.equal(
        (await download).suggestedFilename(),
        "huddle-loom-recovery-codes.txt",
      );
      await saved.click();
      assert.deepEqual(
        mutations,
        [],
        "Do not verify or enable the factor before recovery codes are saved and a code is entered",
      );
      await snapshot("authenticator-verify");
      await page.getByLabel("Six-digit code", { exact: true }).fill("000000");
      await page
        .getByRole("button", { name: "Verify authenticator", exact: true })
        .click();
      await page
        .getByRole("alert")
        .filter({ hasText: "That code has expired" })
        .waitFor();
      await snapshot("authenticator-error");
      await page.getByLabel("Six-digit code", { exact: true }).fill("654321");
      await page
        .getByRole("button", { name: "Verify authenticator", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Your studio is ready", exact: true })
        .waitFor();
      await snapshot("workspace-ready");
      await page
        .getByLabel("Studio name", { exact: true })
        .fill("Design studio");
      await page
        .getByRole("button", { name: "Open my studio", exact: true })
        .click();
      await page
        .getByRole("dialog", {
          name: "Ideas woven together",
          exact: true,
        })
        .waitFor();
      for (const [index, name] of [
        "tour-welcome",
        "tour-organize",
        "tour-collaborate",
        "tour-assistant",
      ].entries()) {
        await snapshot(name);
        if (index < 3)
          await page.getByRole("button", { name: "Next", exact: true }).click();
      }
      await page
        .getByRole("button", { name: "Let’s get started", exact: false })
        .click();
      assert.equal(await page.getByRole("dialog").count(), 0);
      await page.evaluate(() =>
        window.dispatchEvent(new Event("canvas-open-tour")),
      );
      await page.getByRole("dialog").waitFor();
      await page
        .getByRole("button", { name: "Skip tour", exact: false })
        .click();
      assert.equal(
        await page.getByRole("dialog").count(),
        0,
        "Tour must remain skippable",
      );

      state.account.onboarding = 7;
      workbooks = [];
      await page.reload();
      await page.getByRole("button", { name: "Create a workbook", exact: true }).click();
      const workbookName = page.getByRole("textbox", { name: "Workbook name", exact: true });
      await workbookName.waitFor({ state: "visible" });
      assert(await workbookName.evaluate(element => element === document.activeElement), "The first-workbook action must open and focus its form, including on mobile");
      await workbookName.fill("Project notes");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByRole("button", { name: "Create a board", exact: true }).waitFor();
      if (layout.width < 721) await page.getByRole("button", { name: "Studio navigation", exact: true }).click();
      assert.equal(await page.locator('.studio-empty-art img').getAttribute('src'), `/brand/first-idea${layout.theme === 'dark' ? '-dark' : ''}.webp`);
      await snapshot("studio-first-idea");
      if (layout.width < 721) await page.getByRole("button", { name: "Studio navigation", exact: true }).click();
      await page.getByRole("button", { name: "Shared with me 0", exact: true }).click();
      assert.equal(await page.locator('.studio-empty-art img').getAttribute('src'), `/brand/huddle${layout.theme === 'dark' ? '-dark' : ''}.webp`);
      assert.equal(await page.getByRole('button', {name: 'Create a board', exact: true}).count(), 0);
      await snapshot("studio-shared");
      // Manual appearance overrides must change the artwork as well as CSS.
      await page.locator('summary[aria-label="Appearance"]').click();
      await page.getByRole('button', { name: layout.theme === 'dark' ? 'Light appearance' : 'Dark appearance', exact: true }).click();
      assert.equal(await page.locator('.studio-empty-art img').getAttribute('src'), `/brand/huddle${layout.theme === 'dark' ? '' : '-dark'}.webp`);
      await page.locator('summary[aria-label="Appearance"]').click();
      await page.getByRole('button', { name: 'Use system appearance', exact: true }).click();
      assert.equal(await page.locator('.studio-empty-art img').getAttribute('src'), `/brand/huddle${layout.theme === 'dark' ? '-dark' : ''}.webp`);
      if (layout.width < 721) await page.getByRole("button", { name: "Studio navigation", exact: true }).click();
      await page.getByRole("link", { name: "Connected apps", exact: true }).click();
      await page.getByRole('heading', {name: 'Connected apps', exact: true}).waitFor();
      await page.getByRole('button', {name: 'Claude', exact: true}).click();
      await page.getByRole('link', {name: 'Read the Claude guide ↗', exact: true}).waitFor();
      await snapshot("connected-apps");
      assert.equal(await page.getByRole('alert').count(), 0);

      state = {
        ...structuredClone(base),
        setup: false,
        unlocked: false,
        user: undefined,
        account: null,
        email: true,
      };
      await page.goto(`${origin}/login`);
      await page
        .getByRole("heading", { name: "Welcome back", exact: true })
        .waitFor();
      await snapshot("sign-in");
      await page
        .getByRole("button", { name: "Create account", exact: true })
        .click();
      await snapshot("new-account");
      state = {
        ...structuredClone(base),
        setup: false,
        account: {
          ...account,
          verified: false,
          needsMfa: false,
          setupUser: false,
        },
      };
      await page.goto(`${origin}/login`);
      await page
        .getByRole("heading", { name: "Check your inbox", exact: true })
        .waitFor();
      await snapshot("verify-email");
      state.account.verified = true;
      state.account.status = "pending_approval";
      await page.reload();
      await page
        .getByRole("heading", {
          name: "Your request is with an administrator",
          exact: true,
        })
        .waitFor();
      await snapshot("awaiting-approval");
      await page.goto(`${origin}/invite?invitation=visual-invite`);
      await page
        .getByRole("heading", { name: "Join your shared space", exact: true })
        .waitFor();
      await snapshot("invitation");
      assert.equal(await page.getByRole("alert").count(), 0, "Invitation fixture must not hide unexpected errors");
      state = structuredClone(base);
      passwordMethod = true;
      await page.goto(`${origin}/setup`);
      await page.getByRole("button", { name: "Use an authenticator app", exact: false }).click();
      await page.getByLabel("Current password", { exact: true }).waitFor();
      assert(await page.getByLabel("Current password", { exact: true }).evaluate(element => element.required), "Password accounts must still confirm their password");
      await snapshot("authenticator-password");
      methodsUnavailable = true;
      await page.reload();
      await page.getByRole("button", { name: "Use an authenticator app", exact: false }).click();
      await page.getByLabel("Current password", { exact: true }).waitFor();
      assert.equal(await page.getByLabel("Current password", { exact: true }).evaluate(element => element.required), false, "Unknown methods must retain an optional password field");
      assert.deepEqual(errors, [], `${layout.name}: browser runtime errors`);
      console.log(
        `Onboarding visual/interaction fixtures passed: ${layout.name}`,
      );
    } finally {
      await context.close();
    }
  }
}
