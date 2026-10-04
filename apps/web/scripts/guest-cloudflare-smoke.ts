/** Run against a fresh, isolated local Wrangler fixture. */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { qualifyGuestSharing } from "./guest-smoke";
const origin = process.env.GUEST_TEST_ORIGIN ?? "http://localhost:5186";
assert.equal(new URL(origin).hostname, "localhost");
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
      "Content-Type": "application/json",
      "X-Canvas-CSRF": csrf,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const item of response.headers.getSetCookie()) {
    const pair = item.split(";")[0],
      i = pair.indexOf("=");
    cookies.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const value: any = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  if (value.csrf) csrf = value.csrf;
  return value;
}
function totp(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret)
    bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  const key = Buffer.from(
    bits.match(/.{8}/g)!.map((value) => parseInt(value, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  return String(
    (digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1000000,
  ).padStart(6, "0");
}
assert.equal(
  (await call("/api/v1/auth/bootstrap")).setupState,
  "unclaimed",
  "Use a fresh isolated local fixture",
);
await call("/api/v1/setup/unlock", {
  secret: "Guest local fixture setup password",
});
const password = "Local guest qualification password 2026!";
await call("/api/auth/setup/local", {
  username: "guestreview",
  name: "Guest review owner",
  password,
});
await call("/api/v1/auth/bootstrap");
const factor = await call("/api/auth/two-factor/enable", { password });
const seed = new URL(factor.totpURI).searchParams.get("secret")!;
await call("/api/auth/two-factor/verify-totp", { code: totp(seed) });
await call("/api/v1/auth/bootstrap");
await call("/api/v1/setup/complete", { title: "Guest sharing review" });
const catalog = await call("/api/v1/catalog");
const board = await call(
  "/api/v1/boards",
  { title: "Ideas for our next huddle", workbookId: catalog.workbooks[0].id },
  201,
);
await qualifyGuestSharing(origin, call, board.id);
const link = await call(
  `/api/v1/boards/${encodeURIComponent(board.id)}/guest-links`,
  { role: "editor", expiresInDays: 7 },
  201,
);
await writeFile(
  "/tmp/huddle-guest-browser-fixture.json",
  JSON.stringify({
    url: link.url,
    boardId: board.id,
    username: "guestreview",
    password,
    seed,
  }),
  { mode: 0o600 },
);
console.log(
  "Cloudflare local D1/R2/Durable Object guest qualification passed; browser fixture saved.",
);
