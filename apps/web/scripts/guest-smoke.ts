/** Anonymous sharing qualification, reusable for either runtime. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
type OwnerCall = (
  path: string,
  body?: unknown,
  expected?: number,
  method?: string,
) => Promise<any>;
export async function qualifyGuestSharing(
  origin: string,
  owner: OwnerCall,
  boardId: string,
) {
  const path = `/api/v1/boards/${encodeURIComponent(boardId)}`;
  const create = async (role: string, password?: string) =>
    owner(`${path}/guest-links`, { role, password, expiresInDays: 7 }, 201);
  const viewer = await create("viewer");
  assert.match(viewer.url, /#link=[A-Za-z0-9_-]{43}$/);
  assert.equal(new URL(viewer.url).search, "", "Secrets stay in URL fragments");
  const listed = await owner(`${path}/guest-links`);
  assert.equal(
    listed.links.find((item: any) => item.id === viewer.id).url,
    viewer.url,
  );
  function guest(link: any, jar = new Map<string, string>()) {
    let entryCsrf = "",
      session: any;
    const token = new URL(link.url).hash.slice(6);
    const cookie = () =>
      [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
    async function call(
      endpoint: string,
      body?: unknown,
      expected: number | number[] = 200,
      method = body === undefined ? "GET" : "POST",
      override: Record<string, string> = {},
    ) {
      const response = await fetch(origin + endpoint, {
        method,
        headers: {
          Cookie: cookie(),
          Origin: origin,
          "Content-Type": "application/json",
          "X-Canvas-CSRF": entryCsrf,
          ...(endpoint.startsWith(path)
            ? {
                "X-Huddle-Guest": boardId,
                "X-Huddle-Guest-Link": link.id,
                "X-Huddle-Guest-CSRF": session?.csrf ?? "",
              }
            : {}),
          ...override,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const value of response.headers.getSetCookie()) {
        const [pair] = value.split(";");
        const index = pair.indexOf("=");
        jar.set(pair.slice(0, index), pair.slice(index + 1));
        if (pair.startsWith("huddle-guest-")) {
          assert.match(value, /HttpOnly/);
          assert.match(value, /SameSite=Lax/);
          assert.match(value, /Path=\//);
        }
      }
      const raw = await response.text();
      let value: any;
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
      assert.ok(
        (Array.isArray(expected) ? expected : [expected]).includes(
          response.status,
        ),
        `${endpoint} (${response.status}): ${JSON.stringify(value)}`,
      );
      if (value.entryCsrf) entryCsrf = value.entryCsrf;
      if (value.guest) session = value.guest;
      return value;
    }
    const bootstrap = () =>
      call(`/api/v1/guest-links/session?board=${encodeURIComponent(boardId)}&linkId=${encodeURIComponent(link.id)}`);
    const inspect = () =>
      call("/api/v1/guest-links/inspect", { boardId, token });
    const join = (password?: string, expected: number | number[] = 200) =>
      call(
        "/api/v1/guest-links/join",
        { boardId, token, name: "Anonymous guest", password },
        expected,
      );
    async function socket() {
      const ws = new WebSocket(
        origin.replace(/^http/, "ws") + path + `/ws?guest=1&linkId=${encodeURIComponent(link.id)}`,
        {
          headers: { Origin: origin, Cookie: cookie() },
          // Local Wrangler can leave TCP open after a valid Close frame. Bound
          // the handshake wait; assertions still require the server close code.
          closeTimeout: 1000,
        },
      );
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Guest snapshot timeout")),
          5000,
        );
        ws.on("message", (raw) => {
          if (JSON.parse(raw.toString()).type === "snapshot") {
            clearTimeout(timeout);
            resolve();
          }
        });
        ws.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      return ws;
    }
    return {
      call,
      bootstrap,
      inspect,
      join,
      socket,
      get session() {
        return session;
      },
    };
  }
  const read = guest(viewer);
  await read.call(`${path}/bootstrap`, undefined, 401);
  assert.equal((await read.bootstrap()).guest, null);
  assert.equal((await read.inspect()).role, "viewer");
  await read.join();
  assert.equal(read.session.role, "viewer");
  const boot = await read.call(`${path}/bootstrap`);
  assert.equal(boot.metadata.workbookTitle, "Guest board");
  assert.equal(boot.metadata.canCopy, false);
  assert.equal(boot.collaboration.capabilities.export, false);
  assert.equal(boot.collaboration.capabilities.share, false);
  const operation = {
    operationId: randomUUID(),
    operations: [
      {
        type: "create_note",
        text: "From a link",
        color: "yellow",
        x: 200,
        y: 200,
      },
    ],
  };
  await read.call(`${path}/commands`, operation, 403);
  await read.call(
    `${path}/collaboration/commands`,
    {
      action: "add_comment",
      operationId: randomUUID(),
      body: "Viewer must not post",
      x: 0,
      y: 0,
    },
    400,
  );
  for (const endpoint of [
    "/api/v1/workspace",
    "/api/v1/admin/settings",
    "/mcp",
    `${path}/guest-links`,
    `${path}/export`,
  ])
    await read.call(endpoint, undefined, 403, "GET", {
      "X-Huddle-Guest": boardId,
    });
  await read.call(
    "/api/v1/boards/board%3Aother/bootstrap",
    undefined,
    403,
    "GET",
    { "X-Huddle-Guest": boardId },
  );
  const ws = await read.socket();
  const closed = new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Revocation did not close guest socket")),
      5000,
    );
    ws.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  await owner(`${path}/guest-links/${viewer.id}`, undefined, 200, "DELETE");
  assert.equal(await closed, 4003);
  await read.call(`${path}/bootstrap`, undefined, 401);
  await read.inspect().then(
    () => assert.fail("Revoked link reopened"),
    (error) => assert.match(error.message, /404|unavailable|turned off/),
  );
  const comment = guest(await create("commenter"));
  await comment.bootstrap();
  await comment.join();
  await comment.call(`${path}/collaboration/commands`, {
    action: "add_comment",
    operationId: randomUUID(),
    body: "Guest feedback",
    x: 10,
    y: 20,
  });
  await comment.call(`${path}/commands`, operation, 403);
  const protectedLink = await create("editor", "Shared board secret");
  const edit = guest(protectedLink);
  await edit.bootstrap();
  const info = await edit.inspect();
  assert.equal(info.title, null);
  assert.equal(info.passwordRequired, true);
  await edit.join("wrong password", 403);
  await edit.join("Shared board secret");
  await edit.call(`${path}/commands`, operation, 403, "POST", {
    "X-Huddle-Guest-CSRF": "forged",
  });
  await edit.call(`${path}/commands`, operation, 403, "POST", {
    Origin: "https://attacker.invalid",
  });
  await edit.call(`${path}/commands`, operation);
  assert.match(
    JSON.stringify(await edit.call(`${path}/semantic`)),
    /From a link/,
  );
  const editWs = await edit.socket();
  const changed = new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Settings change did not close guest socket")),
      5000,
    );
    editWs.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  await owner(
    `${path}/guest-links/${protectedLink.id}`,
    { role: "viewer", expiresInDays: 1, password: "New board secret" },
    200,
    "PATCH",
  );
  assert.equal(await changed, 4003);
  await edit.call(`${path}/bootstrap`, undefined, 401);
  await edit.join("Shared board secret", 403);
  await edit.join("New board secret");
  assert.equal(edit.session.role, "viewer");
  await edit.call(`${path}/commands`, operation, 403);
  await owner(
    `${path}/guest-links/${protectedLink.id}`,
    undefined,
    200,
    "DELETE",
  );
  assert.equal((await edit.bootstrap()).guest, null);
  assert.equal(
    (await owner(`${path}/bootstrap`)).collaboration.capabilities.role,
    "owner",
    "Guest cookies do not change account permissions",
  );
  // Browser tabs share cookies, but a different link must not replace a tab's
  // identity, role, CSRF token or WebSocket authentication.
  const sharedJar = new Map<string, string>();
  const tabEditorLink = await create("editor"), tabViewerLink = await create("viewer");
  const tabEditor = guest(tabEditorLink, sharedJar), tabViewer = guest(tabViewerLink, sharedJar);
  await tabEditor.bootstrap();
  await tabEditor.join();
  const editorSession = tabEditor.session.sessionId;
  await tabViewer.bootstrap();
  await tabViewer.join();
  assert.equal((await tabEditor.bootstrap()).guest.sessionId, editorSession);
  assert.equal((await tabViewer.bootstrap()).guest.role, "viewer");
  await tabEditor.call(`${path}/collaboration/commands`, { action: "add_comment", operationId: randomUUID(), body: "From the editor tab", x: 10, y: 20 });
  await tabEditor.call(`${path}/commands`, { ...operation, operationId: randomUUID() });
  await tabViewer.call(`${path}/commands`, { ...operation, operationId: randomUUID() }, 403);
  const reconnected = await tabEditor.socket();
  reconnected.close();
  await tabEditor.join();
  assert.equal(tabEditor.session.sessionId, editorSession, "Reopening reuses this link's session");
  await owner(`${path}/guest-links/${tabEditorLink.id}`, undefined, 200, "DELETE");
  assert.equal((await tabEditor.bootstrap()).guest, null);
  assert.equal((await tabViewer.bootstrap()).guest.role, "viewer", "Revoking one link preserves the other tab");
  await owner(`${path}/guest-links/${tabViewerLink.id}`, undefined, 200, "DELETE");
  await owner("/api/v1/admin/settings", { guest_limit: 2 }, 200, "PATCH");
  const concurrentLink = await create("editor");
  const applicants = [
    guest(concurrentLink),
    guest(concurrentLink),
    guest(concurrentLink),
  ];
  for (const applicant of applicants) await applicant.bootstrap();
  const joined = await Promise.all(
    applicants.map((applicant) => applicant.join(undefined, [200, 409])),
  );
  assert.equal(
    joined.filter((result) => result.guest).length,
    1,
    "Concurrent joins respect the installation limit atomically",
  );
  await owner(
    `${path}/guest-links/${concurrentLink.id}`,
    undefined,
    200,
    "DELETE",
  );
  const replacement = guest(await create("viewer"));
  await replacement.bootstrap();
  await replacement.join();
  await owner("/api/v1/admin/settings", { guest_limit: 100 }, 200, "PATCH");
  console.log(
    "Anonymous guest view/comment/edit, passwords, CSRF, board isolation and live revoke/change passed.",
  );
  return async () => {
    assert.ok(
      (await comment.bootstrap()).guest,
      "Guest session survives a restart",
    );
    await comment.call(`${path}/bootstrap`);
  };
}
