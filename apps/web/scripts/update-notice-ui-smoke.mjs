// Local UI fixture. All APIs are intercepted; this never deploys an update.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
const origin = process.env.UI_ORIGIN ?? "http://127.0.0.1:5300";
assert(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
const screenshots = "/tmp/huddle-update-notices";
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({headless:true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined)});
const fixture = { id: `1.2.3:${"a".repeat(40)}`, version: "1.2.3", security: true, notes: "Improved account protection and connection reliability.\nYour boards and files stay in place.", inProgress:false, guidedUpgrade:false, deploymentMode:"cloudflare" };
try {
  for (const [role, theme, width] of [["owner","light",1440], ["admin","dark",1440], ["member","dark",390]]) {
    const context = await browser.newContext({viewport:{width,height:960},colorScheme:theme});
    await context.addInitScript(theme => localStorage.setItem("whiteboard-appearance",theme),theme);
    let notice = {...fixture};
    const failures = [], mutations = [];
    await context.route("**/api/**", async route => {
      const path=new URL(route.request().url()).pathname;
      if (route.request().method()!=="GET") mutations.push(path);
      if(path==="/api/v1/auth/bootstrap")return route.fulfill({json:{mode:"native",configured:true,setup:false,csrf:"fixture",cacheNamespace:"notice-studio",user:{id:role,name:"Alex",email:"alex",color:"#3D4A73"},account:{status:"active",role,verified:true,needsMfa:false,recoveryRequired:false,onboarding:999,authVersion:1,expiresAt:new Date(Date.now()+3600000).toISOString()}}});
      if(path==="/api/v1/updates/notice")return route.fulfill({json:{notice}});
      if(path==="/api/v1/workspace")return route.fulfill({json:{catalog:{boards:[],folders:[],workbooks:[]},user:{name:"Alex",email:"alex",color:"#3D4A73"},workspace:{canCreate:true,owner:role==="owner"},notifications:{notifications:[]}}});
      if(path==="/api/v1/admin/updates")return route.fulfill({json:{current:{version:"1.2.0",commit:"b".repeat(40)},available:{...fixture,commit:"a".repeat(40)},updateAvailable:true,connected:false,runnerReady:false,automaticSecurity:false,checkedAt:Date.now(),history:[]}});
      return route.fulfill({json:{}});
    });
    const page=await context.newPage();page.on("pageerror",error=>failures.push(error.message));
    await page.goto(origin);
    const dialog=page.getByRole("dialog",{name:"A security update is ready"});
    if(role==="owner") {
      await page.getByPlaceholder("Search boards and notes").click();
      await page.waitForTimeout(3000);
      assert.equal(await dialog.count(),0,"The prompt must not take focus while someone is editing text");
      await page.getByRole("heading",{name:"Your studio",exact:true}).click();
    }
    await dialog.waitFor();
    await page.screenshot({path:`${screenshots}/${role}-${theme}.png`});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    if(role==="member"){
      assert.equal(await page.getByRole("link",{name:/Review update/}).count(),0);
      await page.getByRole("button",{name:"Got it",exact:true}).click();
    } else {
      if(role==="admin") await page.getByText(/Studio owner, who can install/).waitFor();
      // Keyboard stays in the dialog and Escape postpones it.
      await page.keyboard.press("Shift+Tab");
      assert.equal(await page.evaluate(()=>Boolean(document.activeElement?.closest('[role="dialog"]'))),true);
      await page.keyboard.press("Escape");
    }
    assert.equal(await dialog.count(),0);
    await page.getByRole("button",{name:/Security update 1.2.3/}).waitFor();
    await page.reload();
    await page.getByRole("button",{name:/Security update 1.2.3/}).waitFor();
    await page.waitForTimeout(2500);
    assert.equal(await dialog.count(),0,"A dismissed release must not reopen after refresh");
    // A new release prompts even when an older one was postponed.
    notice={...notice,id:`1.2.4:${"c".repeat(40)}`,version:"1.2.4"};
    await page.reload();await dialog.waitFor();
    // Per-account dismissal synchronizes between tabs.
    const other=await context.newPage();await other.goto(origin);
    const otherDialog=other.getByRole("dialog",{name:"A security update is ready"});
    await otherDialog.waitFor();
    await page.keyboard.press("Escape");await otherDialog.waitFor({state:"hidden"});
    if(role!=="member"){
      await page.getByRole("button",{name:/Security update 1.2.4/}).click();
      await page.getByRole("link",{name:/Review update/}).click();
      await page.getByRole("heading",{name:"Studio updates"}).waitFor();
      assert.equal(await page.getByRole("dialog").count(),0);
    }
    // Installing the release (no pending notice) clears the persistent affordance.
    notice=null;await other.reload();
    await other.getByRole("heading",{name:"Your studio",exact:true}).waitFor();
    assert.equal(await other.locator(".update-notice-pill").count(),0);
    assert.deepEqual(mutations,[],"A notice must never install or mutate hosting settings");
    assert.deepEqual(failures,[]);
    await context.close();
  }
  console.log("Update notice UI passed: owner/admin/member, light/dark/mobile, keyboard, snooze, refresh, new release, cross-tab dismissal, review navigation and installed-state removal.");
} finally {await browser.close();}
