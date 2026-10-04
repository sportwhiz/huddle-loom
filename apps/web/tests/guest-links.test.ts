import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteCatalog } from "../src/node/sqlite-catalog";
import type { NativeEnv } from "../src/auth/types";
import {
  authenticateGuestRequest,
  guestEntryRoutes,
  readGuestSession,
} from "../src/guest-links.server";
import { hmac, randomToken, sha256 } from "../src/security/primitives";

const origin = "https://app.example";
const boardId = "board:shared";
const editorLink = "A".repeat(24);
const viewerLink = "B".repeat(24);
let db: SqliteCatalog, env: NativeEnv;
let editorToken: string, viewerToken: string;
let boardCookie: string, editorCookie: string, viewerCookie: string;

beforeEach(async () => {
  db = new SqliteCatalog(":memory:");
  env = {
    CATALOG: db as unknown as D1Database,
    AUTH_MODE: "native",
    AUTH_ORIGIN: origin,
    AUTH_SECRET: "isolated-guest-link-fixture-secret",
  };
  editorToken = randomToken();
  viewerToken = randomToken();
  boardCookie = `__Host-huddle-guest-${(await sha256(boardId)).slice(0, 24)}`;
  editorCookie = `${boardCookie}-${(await sha256(editorLink)).slice(0, 16)}`;
  viewerCookie = `${boardCookie}-${(await sha256(viewerLink)).slice(0, 16)}`;
  await db.exec(`
    CREATE TABLE installation(id TEXT,state TEXT);
    CREATE TABLE account_security(user_id TEXT,status TEXT,recovery_required INTEGER);
    CREATE TABLE boards(id TEXT,title TEXT,workbook_id TEXT,deleted_at TEXT,inheritance_disabled INTEGER);
    CREATE TABLE resource_grants(resource_type TEXT,resource_id TEXT,user_id TEXT,role TEXT,expires_at TEXT);
    CREATE TABLE users(id TEXT,display_name TEXT,color TEXT);
    CREATE TABLE guest_board_links(id TEXT,board_id TEXT,created_by TEXT,revoked_at TEXT,expires_at TEXT,role TEXT);
    CREATE TABLE guest_board_sessions(id TEXT,user_id TEXT,link_id TEXT,expires_at TEXT,token_hash TEXT);
    INSERT INTO installation VALUES('instance','ready');
    INSERT INTO account_security VALUES('owner','active',0);
    INSERT INTO boards VALUES('board:shared','Shared ideas','workbook',NULL,0);
    INSERT INTO resource_grants VALUES('board','board:shared','owner','owner',NULL);
    INSERT INTO users VALUES('editor','Editor','#123'),('viewer','Viewer','#456');
  `);
  for (const [link, role, user, raw] of [
    [editorLink, "editor", "editor", editorToken],
    [viewerLink, "viewer", "viewer", viewerToken],
  ]) {
    await db
      .prepare("INSERT INTO guest_board_links VALUES(?,'board:shared','owner',NULL,NULL,?)")
      .bind(link, role).run();
    await db
      .prepare("INSERT INTO guest_board_sessions VALUES(?,?,?,'2099-01-01T00:00:00.000Z',?)")
      .bind(`${user}-session`, user, link, await sha256(raw)).run();
  }
});
afterEach(() => db.close());

function request(cookies: string, init: RequestInit = {}, query = "") {
  const headers = new Headers(init.headers);
  headers.set("Cookie", cookies);
  headers.set("Origin", origin);
  return new Request(
    `${origin}/api/v1/boards/${encodeURIComponent(boardId)}/commands${query}`,
    { ...init, headers },
  );
}
const sharedCookies = () =>
  `${boardCookie}=${viewerToken}; ${editorCookie}=${editorToken}; ${viewerCookie}=${viewerToken}`;
const lookup = (link?: string, cookies = sharedCookies()) =>
  readGuestSession(request(cookies), env, boardId, link);
function mutate(link: string, csrf: string) {
  return authenticateGuestRequest(request(sharedCookies(), {
    method: "POST",
    headers: {
      "X-Huddle-Guest-Link": link,
      "X-Huddle-Guest-CSRF": csrf,
    },
  }), env, boardId);
}

describe("guest links in tabs sharing a cookie jar", () => {
  it("keeps each link's identity and CSRF token after another link joins", async () => {
    const editor = await lookup(editorLink);
    const viewer = await lookup(viewerLink);
    expect(editor?.principal.id).toBe("editor");
    expect(viewer?.principal.id).toBe("viewer");
    expect(editor?.csrf).toBe(await hmac(env.AUTH_SECRET!, `guest-csrf:${editorToken}`));
    expect(viewer?.csrf).not.toBe(editor?.csrf);
    expect((await mutate(editorLink, editor!.csrf)).id).toBe("editor");
  });
  it("uses the selected link for WebSocket reconnection", async () => {
    const socket = request(sharedCookies(), {
      headers: { Upgrade: "websocket" },
    }, `?guest=1&linkId=${editorLink}`);
    expect((await authenticateGuestRequest(socket, env, boardId)).grantId).toBe(editorLink);
  });
  it("does not use another link's cookie to satisfy a requested link", async () => {
    expect(await lookup(editorLink, `${boardCookie}=${viewerToken}`)).toBeNull();
    await expect(mutate(editorLink,
      await hmac(env.AUTH_SECRET!, `guest-csrf:${viewerToken}`),
    )).rejects.toMatchObject({ code: "CSRF_REJECTED" });
  });
  it("promotes a legacy board cookie before another tab can replace it", async () => {
    const response = (await guestEntryRoutes(new Request(
      `${origin}/api/v1/guest-links/session?board=${encodeURIComponent(boardId)}&linkId=${editorLink}`,
      { headers: { Cookie: `${boardCookie}=${editorToken}` } },
    ), env))!;
    expect(response.status).toBe(200);
    const value = await response.json();
    expect(value.guest.sessionId).toBe("editor-session");
    expect(value.guest).not.toHaveProperty("cookieToken");
    expect(response.headers.getSetCookie()).toEqual(expect.arrayContaining([
      expect.stringContaining(`${editorCookie}=${editorToken}; Path=/; HttpOnly; SameSite=Lax; Secure;`),
    ]));
    expect((await lookup(editorLink,
      `${editorCookie}=${editorToken}; ${boardCookie}=${viewerToken}`,
    ))?.principal.id).toBe("editor");
  });
  it("continues serving clients without a link selector", async () => {
    expect((await lookup(undefined, `${boardCookie}=${editorToken}`))?.principal.id).toBe("editor");
  });
  it("ends only the revoked link, even while another link remains valid", async () => {
    await db.prepare("UPDATE guest_board_links SET revoked_at='2026-01-01' WHERE id=?")
      .bind(editorLink).run();
    expect(await lookup(editorLink)).toBeNull();
    expect((await lookup(viewerLink))?.principal.id).toBe("viewer");
  });
  it("rejects malformed link selectors", async () => {
    await expect(lookup("bad link")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
