import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteCatalog } from "./node/sqlite-catalog";
import { guestBoardAccess } from "./guest-policy.server";
import { guestRequestBoard } from "./guest-links.server";
import type { Principal } from "./collaboration-types";
let db: SqliteCatalog;
const principal: Principal = {
  id: "guest",
  name: "Guest",
  email: "",
  color: "#123",
  avatarUrl: null,
  issuer: "urn:huddle:guest",
  subject: "guest",
  authentication: "guest",
  sessionId: "session",
  grantId: "link",
  resourceMode: "selected",
  resources: [{ type: "board", id: "board" }],
};
beforeEach(async () => {
  db = new SqliteCatalog(":memory:");
  await db.exec(`CREATE TABLE installation(id TEXT,state TEXT);
 CREATE TABLE account_security(user_id TEXT,status TEXT,recovery_required INTEGER);
 CREATE TABLE boards(id TEXT,title TEXT,workbook_id TEXT,deleted_at TEXT,inheritance_disabled INTEGER);
 CREATE TABLE resource_grants(resource_type TEXT,resource_id TEXT,user_id TEXT,role TEXT,expires_at TEXT);
 CREATE TABLE guest_board_links(id TEXT,board_id TEXT,created_by TEXT,revoked_at TEXT,expires_at TEXT,role TEXT);
 CREATE TABLE guest_board_sessions(id TEXT,user_id TEXT,link_id TEXT,expires_at TEXT);
 INSERT INTO installation VALUES('instance','ready');
 INSERT INTO account_security VALUES('owner','active',0);
 INSERT INTO boards VALUES('board','Shared ideas','workbook',NULL,0);
 INSERT INTO resource_grants VALUES('board','board','owner','owner',NULL);
 INSERT INTO guest_board_links VALUES('link','board','owner',NULL,NULL,'editor');
 INSERT INTO guest_board_sessions VALUES('session','guest','link','2099-01-01T00:00:00.000Z');`);
});
afterEach(() => db.close());
const access = () =>
  guestBoardAccess(db as unknown as D1Database, principal, "board");
describe("live guest policy", () => {
  it("limits editors to one board and hides workbook metadata", async () => {
    const value = await access();
    expect(value.capabilities).toMatchObject({
      role: "editor",
      edit: true,
      share: false,
      manage: false,
      export: false,
    });
    expect(value.metadata).toEqual({
      title: "Shared ideas",
      workbookTitle: "Guest board",
      canCopy: false,
    });
    await expect(
      guestBoardAccess(db as unknown as D1Database, principal, "other"),
    ).rejects.toThrow("Board not found");
  });
  it("follows inherited ownership and respects private boards", async () => {
    await db.exec(
      "UPDATE resource_grants SET resource_type='workbook',resource_id='workbook'",
    );
    expect((await access()).capabilities.edit).toBe(true);
    await db.exec("UPDATE boards SET inheritance_disabled=1");
    await expect(access()).rejects.toThrow("turned off");
  });
  it.each([
    "UPDATE guest_board_links SET revoked_at='2026-01-01'",
    "UPDATE guest_board_links SET expires_at='2026-01-01'",
    "UPDATE guest_board_sessions SET expires_at='2026-01-01'",
    "UPDATE account_security SET status='suspended'",
    "UPDATE account_security SET recovery_required=1",
    "UPDATE resource_grants SET role='editor'",
    "UPDATE resource_grants SET expires_at='2026-01-01'",
    "UPDATE boards SET deleted_at='2026-01-01'",
    "UPDATE installation SET state='pending'",
  ])("ends access immediately for %s", async (sql) => {
    await db.exec(sql);
    await expect(access()).rejects.toThrow("turned off");
  });
  it("does not trust an altered session principal", async () => {
    await expect(
      guestBoardAccess(
        db as unknown as D1Database,
        { ...principal, id: "other" },
        "board",
      ),
    ).rejects.toThrow("turned off");
    await expect(
      guestBoardAccess(
        db as unknown as D1Database,
        { ...principal, grantId: "other" },
        "board",
      ),
    ).rejects.toThrow("turned off");
  });
  it("reads changed role rather than a cached permission", async () => {
    await db.exec("UPDATE guest_board_links SET role='viewer'");
    expect((await access()).capabilities).toMatchObject({
      edit: false,
      comment: false,
    });
  });
});
describe("guest route isolation", () => {
  it("requires an explicit matching board and excludes management routes", () => {
    expect(
      guestRequestBoard(
        new Request("https://app.test/api/v1/boards/board/bootstrap", {
          headers: { "X-Huddle-Guest": "board" },
        }),
      ),
    ).toBe("board");
    for (const path of [
      "/api/v1/admin/settings",
      "/mcp",
      "/api/v1/boards/board/export",
      "/api/v1/boards/other/bootstrap",
      "/api/v1/boards/board/guest-links",
    ])
      expect(() =>
        guestRequestBoard(
          new Request("https://app.test" + path, {
            headers: { "X-Huddle-Guest": "board" },
          }),
        ),
      ).toThrow("limited");
    expect(
      guestRequestBoard(
        new Request("https://app.test/api/v1/boards/board/bootstrap"),
      ),
    ).toBeNull();
  });
});
