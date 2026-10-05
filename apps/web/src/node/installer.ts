import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import type { NodeStartupError } from "./runtime";

type Settings = Record<string, string | undefined>;
export function needsInstallationGuide(error: NodeStartupError) {
  return (
    error.phase === "configuration" &&
    ["CANONICAL_ORIGIN", "SETUP_PASSWORD"].includes(error.code)
  );
}

/** Public instructions only. The guide cannot read or write installation state. */
export async function startInstallationGuide(
  error: NodeStartupError,
  settings: Settings = process.env,
) {
  if (!needsInstallationGuide(error))
    throw new Error("Installer is unavailable for this failure.");
  const port = Number(settings.PORT ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("Installer port is invalid.");
  const godaddy =
    (settings.HUDDLE_PLATFORM ?? "godaddy") === "godaddy" ||
    settings.HUDDLE_MAIL_GATEWAY === "godaddy";
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    const path = request.url?.split("?")[0];
    if (!["GET", "HEAD"].includes(request.method ?? "")) {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    if (path === "/healthz") {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(
        request.method === "HEAD"
          ? undefined
          : JSON.stringify({ ready: false, status: "configuration_required" }),
      );
      return;
    }
    if (path !== "/") {
      response.writeHead(404);
      response.end();
      return;
    }
    const nonce = Buffer.from(randomBytes(18)).toString("base64");
    response.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; connect-src 'none'`,
    );
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(request.method === "HEAD" ? undefined : page(nonce, godaddy));
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
function page(nonce: string, godaddy: boolean) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Set up Open Whiteboard</title>
<style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;background:#f6f7f9;color:#283347;font:16px/1.6 system-ui,sans-serif}main{max-width:760px;margin:6vh auto;padding:32px}header{border-bottom:1px solid #dce1e8;padding-bottom:24px}.brand{font-weight:750;letter-spacing:.06em;color:#2554c7}h1{font:500 clamp(32px,6vw,48px)/1.15 Georgia,serif;margin:24px 0 16px}.intro{max-width:56ch;color:#586171}ol{padding:0;list-style:none;counter-reset:steps}li{counter-increment:steps;margin:24px 0;padding:20px 24px;background:#ffffff;border:1px solid #dce1e8;border-radius:16px}h2{font-size:18px;margin:0 0 8px}h2:before{content:counter(steps) '. ';color:#2554c7}p{margin:8px 0}code{overflow-wrap:anywhere;font:14px/1.5 ui-monospace,monospace}button{border:1px solid #b8c0cf;background:#edf0f7;color:#283347;padding:9px 14px;border-radius:8px;cursor:pointer;font:inherit;margin:8px 8px 0 0}button:focus-visible{outline:3px solid #d2483c;outline-offset:3px}.setting{display:block;margin-top:12px;font-weight:650}.note,footer{font-size:14px;color:#586171}#status{min-height:24px} @media(prefers-color-scheme:dark){body{background:#1e242b;color:#eef1f5}li{background:#282f36;border-color:#42494e}.intro,.note,footer{color:#bbbfbf}.brand{color:#c7d1ef}header{border-color:#42494e}button{background:#354258;color:#ffffff;border-color:#65748c}h2:before{color:#8eaaf5}}</style></head><body><main><header><div class="brand">OPEN WHITEBOARD</div><h1>A place for your ideas.<br>Let’s make it yours.</h1><p class="intro">Your app is installed. Two hosting settings connect it to its address and let you claim the administrator account safely.</p></header><ol>
<li><h2>Open your hosting settings</h2><p>${godaddy ? "In your GoDaddy Node.js Hosting dashboard, open this app and its environment variables or app settings." : "Open this app’s environment variables in your Node hosting dashboard."} Keep this page open alongside the dashboard.</p><p class="note">${godaddy ? "Select the Preview or Publish tab in GoDaddy’s settings, then configure that variant. Each has its own settings; the managed database is shared." : "Apply settings to the intended deployment environment."}</p></li>
<li><h2>Set your app’s address</h2><p>${godaddy ? "Use the HTTPS address GoDaddy gave this app, or the custom domain you connected. You can use the Preview link while you try it out." : "Use this app’s public HTTPS address from your hosting dashboard."} Copy the displayed address below into your hosting settings, with no path or trailing slash.</p><code class="setting">AUTH_ORIGIN</code><code id="origin">https://your-app.example.com</code><br><button type="button" data-copy="AUTH_ORIGIN">Copy setting name</button><button type="button" id="copy-origin">Copy displayed address</button><p class="note">The displayed address comes from your browser. Check it against your dashboard before saving; it is not an ownership verification.</p></li>
<li><h2>Choose a private setup passphrase</h2><code class="setting">SETUP_PASSWORD</code><p>Enter your own unique passphrase of at least 16 characters in the dashboard’s private environment settings. Keep it in your password manager. Do not paste it into this page or share it in a link.</p><button type="button" data-copy="SETUP_PASSWORD">Copy setting name</button><p class="note">You will enter it on the administrator setup screen after the app restarts. Visiting this guide never claims the installation.</p></li>
<li><h2>Save, restart, and create your Studio</h2><p>Save the settings, then restart or redeploy this app from the dashboard. Open the configured address again to create your administrator account, save your recovery code, and finish onboarding.</p><p class="note">${godaddy ? "For a new published installation, set <code>HUDDLE_DATABASE_NAMESPACE</code> to <code>live</code> in Publish settings. Keep an existing Preview installation’s settings unchanged. New Preview installations can use <code>preview</code>." : "For separate test and production installations sharing a database, set distinct <code>HUDDLE_DATABASE_NAMESPACE</code> values such as <code>preview</code> and <code>live</code> in their environment settings."} Keep each namespace unchanged for future updates.</p><button type="button" id="reload">Check again</button></li></ol><p id="status" role="status" aria-live="polite"></p><footer>Your administrator account is created next. You can invite people once your Studio is ready.</footer></main>
<script nonce="${nonce}">const address=document.getElementById('origin');if(location.protocol==='https:')address.textContent=location.origin;async function copy(value){try{await navigator.clipboard.writeText(value);document.getElementById('status').textContent='Copied.'}catch{document.getElementById('status').textContent='Select and copy the displayed text.'}}document.querySelectorAll('[data-copy]').forEach(button=>button.addEventListener('click',()=>copy(button.dataset.copy)));document.getElementById('copy-origin').addEventListener('click',()=>copy(address.textContent));document.getElementById('reload').addEventListener('click',()=>location.reload());</script></body></html>`;
}
