import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";
import { execFileSync } from "node:child_process";
import { seal } from "../src/security/secret-store";
import type { NativeEnv } from "../src/auth/types";

type BrowserFixture = {
  cookies: Map<string, string>;
  csrf: string;
  call: (
    path: string,
    body?: unknown,
    expected?: number,
    method?: string,
  ) => Promise<any>;
};
export async function conformance(ctx: {
  origin: string;
  owner: BrowserFixture;
  member: BrowserFixture;
  board: { id: string };
  database: DatabaseSync;
  memberId: string;
  memberEmail: string;
  password: string;
  webhookSecret: string;
  fixture: NativeEnv;
}) {
  const {
    origin,
    owner,
    member,
    board,
    database,
    memberId,
    memberEmail,
    password,
  } = ctx;
  const cookie = () =>
    [...owner.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  async function raw(
    path: string,
    body: BodyInit,
    headers: Record<string, string> = {},
    method = "POST",
  ) {
    return fetch(`${origin}${path}`, {
      method,
      redirect: "manual",
      headers: {
        Cookie: cookie(),
        Origin: origin,
        "X-Canvas-CSRF": owner.csrf,
        ...headers,
      },
      body,
    });
  }
  await member.call("/api/auth/sign-in/email", {
    email: memberEmail,
    password,
  });
  const invitation = await owner.call(
    `/api/v1/boards/${encodeURIComponent(board.id)}/share`,
    { email: memberEmail, role: "editor", expiresInDays: 1 },
    201,
  );
  await member.call("/api/v1/invitations/accept", { token: invitation.token });
  await owner.call(`/api/v1/boards/${encodeURIComponent(board.id)}/semantic`);
  // Omit the invalidation outbox deliberately: the socket's authoritative lease
  // must still stop traffic after an account is revoked.
  const socket = new WebSocket(
    `${origin.replace(/^http/, "ws")}/api/v1/boards/${encodeURIComponent(board.id)}/ws`,
    {
      headers: {
        Origin: origin,
        Cookie: [...member.cookies]
          .map(([key, value]) => `${key}=${value}`)
          .join("; "),
      },
    },
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Native socket did not receive its snapshot")),
      5000,
    );
    socket.on("message", (data) => {
      if (JSON.parse(String(data)).type === "snapshot") {
        clearTimeout(timeout);
        resolve();
      }
    });
    socket.once("error", reject);
  });
  const revokedAt = Date.now();
  database
    .prepare(
      "UPDATE account_security SET auth_version = auth_version + 1 WHERE user_id = ?",
    )
    .run(memberId);
  const pulse = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({
          type: "presence",
          idle: false,
          cursor: { x: 0, y: 0 },
        }),
      );
  }, 100);
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error(
              "Revoked native socket retained access past its five-second lease",
            ),
          ),
        5500,
      );
      socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once("error", reject);
    });
    assert.ok(Date.now() - revokedAt <= 5500);
  } finally {
    clearInterval(pulse);
    socket.terminate();
  }
  await member.call("/api/v1/catalog", undefined, 401);
  await member.call("/api/auth/sign-in/email", {
    email: memberEmail,
    password,
  });
  console.log(
    "Native WebSocket: missed invalidation still closes the revoked session within its five-second lease; fresh login restores access.",
  );
  await owner.call(
    "/api/v1/admin/settings",
    { dynamic_registration: 1 },
    200,
    "PATCH",
  );
  const registration = await fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Native fixture assistant",
      redirect_uris: ["http://127.0.0.1:9876/callback"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registration.status, 201);
  const registered = (await registration.json()) as any;
  const resource = `${origin}/mcp`,
    verifier = randomBytes(48).toString("base64url");
  const parameters = new URLSearchParams({
    client_id: registered.client_id,
    redirect_uri: "http://127.0.0.1:9876/callback",
    response_type: "code",
    scope: "boards:read boards:write boards:export",
    resource,
    state: "fixture-state",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const invalidParameters = new URLSearchParams(parameters);
  invalidParameters.set("response_type", "invalid");
  for (const accept of ["text/html", "application/json"]) {
    const invalid = await fetch(
      `${origin}/oauth/authorize?${invalidParameters}`,
      {
        headers: { Cookie: cookie(), Accept: accept },
        redirect: "manual",
      },
    );
    assert.equal(invalid.status, 400);
    assert.ok(invalid.headers.get("Content-Type")?.includes(accept));
    if (accept === "text/html")
      assert.match(await invalid.text(), /Connection needs attention/);
  }
  const consent = await fetch(`${origin}/oauth/authorize?${parameters}`, {
    headers: { Cookie: cookie(), Accept: "text/html" },
    redirect: "manual",
  });
  assert.equal(consent.status, 200);
  const html = await consent.text();
  const requestId = html.match(/name="request_id" value="([^"]+)"/)?.[1];
  assert.ok(requestId);
  const approved = await raw(
    "/oauth/authorize",
    new URLSearchParams({
      request_id: requestId,
      csrf: owner.csrf,
      decision: "allow",
      resource_mode: "selected",
      selection: JSON.stringify({ type: "board", id: board.id }),
    }),
    { "Content-Type": "application/x-www-form-urlencoded" },
  );
  assert.equal(approved.status, 302, await approved.text());
  const destination = new URL(approved.headers.get("location")!);
  assert.equal(destination.searchParams.get("state"), "fixture-state");
  assert.equal(destination.searchParams.get("iss"), origin);
  async function token(form: Record<string, string>, expected = 200) {
    const response = await fetch(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: registered.client_id,
        resource,
        ...form,
      }),
    });
    const value = (await response.json()) as any;
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  }
  const exchange = {
    grant_type: "authorization_code",
    code: destination.searchParams.get("code")!,
    code_verifier: verifier,
    redirect_uri: "http://127.0.0.1:9876/callback",
  };
  const tokens = await token(exchange);
  await token(exchange, 400);
  const mcp = new McpClient({ name: "native-conformance", version: "1" });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      },
    }),
  );
  const catalog = await mcp.callTool({ name: "list_workbooks", arguments: {} });
  assert.ok(!catalog.isError);
  const contents = JSON.parse(
    (catalog.content as any[]).find((item) => item.type === "text").text,
  );
  assert.deepEqual(
    contents.boards.map((item: any) => item.id),
    [board.id],
  );
  assert.equal(contents.workbooks[0].id, "workbook:shared");
  const authored = async (name: string, args: Record<string, unknown>) => {
    const result = await mcp.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return (
      result.structuredContent ??
      JSON.parse(
        (result.content as any[]).find((item) => item.type === "text").text,
      )
    );
  };
  const workflow = {
    boardId: board.id,
    operationId: "native-consent-workflow",
    title: "Request approval",
    nodes: [
      { ref: "request", label: "Receive request", kind: "start" },
      { ref: "review", label: "Review request", kind: "decision" },
      { ref: "details", label: "Request missing details", kind: "exception" },
      { ref: "fulfill", label: "Fulfill request" },
      { ref: "decline", label: "Explain decline", kind: "end" },
      { ref: "done", label: "Confirm completion", kind: "end" },
    ],
    edges: [
      { sourceRef: "request", targetRef: "review" },
      { sourceRef: "review", targetRef: "details", label: "More information" },
      { sourceRef: "details", targetRef: "review", label: "Retry review" },
      { sourceRef: "review", targetRef: "fulfill", label: "Approved" },
      { sourceRef: "review", targetRef: "decline", label: "Declined" },
      { sourceRef: "fulfill", targetRef: "done", label: "Delivered" },
    ],
  };
  const receipt = await authored("create_workflow", workflow);
  assert.deepEqual(await authored("create_workflow", workflow), receipt);
  const diagram = await authored("get_board", { boardId: board.id });
  assert.equal(diagram.board.notes.length, 6);
  assert.equal(diagram.board.connectors.length, 6);
  assert.deepEqual(
    (await authored("inspect_board", { boardId: board.id })).issues,
    [],
  );
  const note = diagram.board.notes[0];
  await authored("batch_edit_board", {
    boardId: board.id,
    operationId: "native-refinement",
    expectedRevision: diagram.revision,
    operations: [
      {
        type: "update_text",
        id: note.id,
        text: "Receive a new customer request",
      },
    ],
  });
  assert.ok(
    (await authored("get_board", { boardId: board.id })).board.notes.some(
      (item: any) =>
        item.id === note.id && item.text === "Receive a new customer request",
    ),
  );
  const ownerCatalog = await owner.call("/api/v1/catalog");
  const outside = await owner.call(
    "/api/v1/boards",
    {
      title: "Outside assistant selection",
      workbookId: ownerCatalog.workbooks[0].id,
    },
    201,
  );
  assert.equal(
    (
      await mcp.callTool({
        name: "get_board",
        arguments: { boardId: outside.id },
      })
    ).isError,
    true,
  );
  assert.equal(
    (
      await mcp.callTool({
        name: "create_workflow",
        arguments: { ...workflow, boardId: outside.id },
      })
    ).isError,
    true,
  );
  console.log(
    "Native restricted assistant: editable notes, labeled branches and retry arrows, layout inspection, idempotent creation and refinement passed; unselected boards are denied.",
  );
  const connections = await owner.call("/api/v1/connections");
  const grant = connections.connections.find(
    (item: any) => item.clientId === registered.client_id,
  );
  assert.equal(grant.status, "active");
  assert.equal(grant.resourceMode, "selected");
  await owner.call(
    `/api/v1/connections/${encodeURIComponent(grant.id)}/permissions`,
    {
      scopes: ["boards:read"],
      resourceMode: "selected",
      resources: [{ type: "board", id: board.id }],
    },
    200,
    "POST",
  );
  const denied = await mcp.callTool({
    name: "upload_image",
    arguments: {
      boardId: board.id,
      contentType: "image/png",
      data: "aW52YWxpZA==",
    },
  });
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied), /boards:write/);
  await owner.call(
    `/api/v1/connections/${encodeURIComponent(grant.id)}/permissions`,
    {
      scopes: ["boards:read", "boards:write"],
      resourceMode: "all",
      resources: [],
    },
    400,
    "POST",
  );
  await owner.call("/api/v1/admin/settings", { mfa_required: 1 }, 200, "PATCH");
  assert.equal(
    (await owner.call("/api/v1/connections")).connections.find(
      (item: any) => item.id === grant.id,
    ).status,
    "confirmation_required",
  );
  await owner.call(
    `/api/v1/connections/${encodeURIComponent(grant.id)}/permissions`,
    {
      scopes: ["boards:read"],
      resourceMode: "selected",
      resources: [{ type: "board", id: board.id }],
    },
    200,
    "POST",
  );
  await owner.call("/api/v1/admin/settings", { mfa_required: 0 }, 200, "PATCH");
  await owner.call(
    `/api/v1/connections/${encodeURIComponent(grant.id)}/permissions`,
    {
      scopes: ["boards:read"],
      resourceMode: "selected",
      resources: [{ type: "board", id: board.id }],
    },
    200,
    "POST",
  );
  const rotated = await token({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
  });
  assert.equal(rotated.scope, "boards:read");
  await token(
    { grant_type: "refresh_token", refresh_token: tokens.refresh_token },
    400,
  );
  const replayed = await fetch(resource, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${rotated.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "fixture", version: "1" },
      },
    }),
  });
  assert.equal(replayed.status, 401);
  await mcp.close();
  console.log(
    "Native OAuth: PKCE, single-use codes, selected resources, live permission narrowing, consent renewal and refresh replay revocation passed.",
  );
  const confidential = await owner.call(
    "/api/v1/admin/clients",
    {
      name: "Confidential fixture",
      redirectUris: ["http://127.0.0.1:9876/callback"],
      authMethod: "client_secret_basic",
    },
    201,
  );
  assert.ok(confidential.clientSecret);
  const privateParameters = new URLSearchParams(parameters);
  privateParameters.set("client_id", confidential.id);
  privateParameters.set("scope", "boards:read");
  const privateConsent = await fetch(
    `${origin}/oauth/authorize?${privateParameters}`,
    { headers: { Cookie: cookie(), Accept: "text/html" }, redirect: "manual" },
  );
  assert.equal(privateConsent.status, 200);
  const privateRequest = (await privateConsent.text()).match(
    /name="request_id" value="([^"]+)"/,
  )?.[1];
  assert.ok(privateRequest);
  const privateApproval = await raw(
    "/oauth/authorize",
    new URLSearchParams({
      request_id: privateRequest,
      csrf: owner.csrf,
      decision: "allow",
      resource_mode: "selected",
      selection: JSON.stringify({ type: "board", id: board.id }),
    }),
    { "Content-Type": "application/x-www-form-urlencoded" },
  );
  assert.equal(privateApproval.status, 302);
  const privateExchange = {
    ...exchange,
    code: new URL(privateApproval.headers.get("location")!).searchParams.get(
      "code",
    )!,
  };
  const privateToken = async (
    secret: string,
    form: Record<string, string>,
    status: number,
  ) => {
    const response = await fetch(`${origin}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${encodeURIComponent(confidential.id)}:${encodeURIComponent(secret)}`).toString("base64")}`,
      },
      body: new URLSearchParams({ resource, ...form }),
    });
    const result = (await response.json()) as any;
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  await privateToken("incorrect-fixture-secret", privateExchange, 401);
  const privateTokens = await privateToken(
    confidential.clientSecret,
    privateExchange,
    200,
  );
  assert.equal(privateTokens.scope, "boards:read");
  const newSecret = await owner.call(
    `/api/v1/admin/clients/${encodeURIComponent(confidential.id)}/rotate-secret`,
    {},
  );
  const refreshPrivate = {
    grant_type: "refresh_token",
    refresh_token: privateTokens.refresh_token,
  };
  await privateToken(confidential.clientSecret, refreshPrivate, 401);
  await privateToken(newSecret.clientSecret, refreshPrivate, 400);
  const privateGrant = database
    .prepare("SELECT revoked_at FROM oauth_grants WHERE client_id=?")
    .get(confidential.id) as any;
  assert.ok(privateGrant.revoked_at);
  console.log(
    "Native confidential MCP client: registered authentication is enforced, valid credentials exchange a code, and secret rotation invalidates the old secret and grants.",
  );
  // Real R2 uploads race for the final quota bytes; the database must admit only one.
  await owner.call(
    "/api/v1/admin/settings",
    { storage_limit: 1048576, user_storage_limit: 1048576 },
    200,
    "PATCH",
  );
  const upload = async (bytes: Buffer) => {
    const key = createHash("sha256")
      .update(bytes)
      .digest("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_");
    const response = await raw(
      `/api/v1/boards/${encodeURIComponent(board.id)}/blobs/${encodeURIComponent(key)}`,
      bytes,
      { "Content-Type": "image/png" },
      "PUT",
    );
    return { response, key };
  };
  const uploads = await Promise.all([
    upload(randomBytes(700000)),
    upload(randomBytes(700000)),
  ]);
  assert.deepEqual(
    uploads.map((item) => item.response.status).sort(),
    [201, 409],
  );
  const successful = uploads.find((item) => item.response.status === 201)!;
  const asset = await fetch(
    `${origin}/api/v1/boards/${encodeURIComponent(board.id)}/blobs/${encodeURIComponent(successful.key)}`,
    { headers: { Cookie: cookie() } },
  );
  assert.equal(asset.status, 200);
  assert.equal((await asset.arrayBuffer()).byteLength, 700000);
  assert.match(asset.headers.get("Content-Security-Policy")!, /sandbox/);
  await owner.call(
    "/api/v1/admin/settings",
    { storage_limit: 5368709120, user_storage_limit: 1073741824 },
    200,
    "PATCH",
  );
  console.log(
    "Native quotas: concurrent R2 uploads respect global/user limits and the successful asset remains readable.",
  );
  // Transfers must validate the complete selection before any grant changes.
  const ownCatalog = await member.call("/api/v1/catalog");
  const folderA = await member.call(
    "/api/v1/folders",
    { title: "Move race A" },
    201,
  );
  const folderB = await member.call(
    "/api/v1/folders",
    { title: "Move race B" },
    201,
  );
  const folderMoves = await Promise.all(
    [
      [folderA.id, folderB.id],
      [folderB.id, folderA.id],
    ].map(async ([id, parentId]) => {
      const response = await fetch(
        `${origin}/api/v1/folders/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: {
            Cookie: [...member.cookies]
              .map(([key, value]) => `${key}=${value}`)
              .join("; "),
            Origin: origin,
            "X-Canvas-CSRF": member.csrf,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ parentId }),
        },
      );
      assert.ok([200, 400, 409].includes(response.status));
      return response.status;
    }),
  );
  assert.equal(folderMoves.filter((status) => status === 200).length, 1);
  const movedFolders = database
    .prepare("SELECT parent_id FROM folders WHERE id IN (?,?)")
    .all(folderA.id, folderB.id) as { parent_id: string | null }[];
  assert.equal(
    movedFolders.filter((folder) => folder.parent_id === null).length,
    1,
  );
  const wb = await member.call(
    "/api/v1/workbooks",
    { title: "Transfer fixture" },
    201,
  );
  const owned = await member.call(
    "/api/v1/boards",
    { title: "Transfer fixture board", workbookId: wb.id },
    201,
  );
  const ownerId = (await owner.call("/api/v1/auth/bootstrap")).user.id;
  // A provider secret edit must not strand an owner whose only login method is
  // that provider. TOTP alone is a second factor, not an alternative login.
  const providerSecret = await seal(
    ctx.fixture,
    "disposable-provider-secret",
    "provider:github",
  );
  database
    .prepare(
      "INSERT INTO auth_provider_config(id,public_config,secret,enabled,tested_at,updated_at) VALUES ('github',?,?,1,?,?)",
    )
    .run(
      JSON.stringify({ clientId: "fixture-client" }),
      providerSecret,
      Date.now(),
      new Date().toISOString(),
    );
  database
    .prepare(
      "UPDATE auth_accounts SET providerId='github' WHERE userId=? AND providerId='credential'",
    )
    .run(ownerId);
  database.exec("UPDATE installation SET version=version+1");
  try {
    await owner.call(
      "/api/v1/admin/providers/github",
      {
        enabled: true,
        clientId: "edited-client",
        clientSecret: "replacement-fixture-secret",
      },
      409,
      "PUT",
    );
    await owner.call(
      "/api/v1/admin/providers/github",
      { enabled: false },
      409,
      "PUT",
    );
    assert.equal(
      (
        database
          .prepare("SELECT secret FROM auth_provider_config WHERE id='github'")
          .get() as any
      ).secret,
      providerSecret,
    );
    const googleId = `fixture-google-${Date.now()}`;
    database
      .prepare(
        "INSERT INTO auth_provider_config(id,public_config,secret,enabled,tested_at,updated_at) VALUES ('google',?,?,1,?,?)",
      )
      .run(
        JSON.stringify({ clientId: "fixture-google" }),
        await seal(ctx.fixture, "disposable-google-secret", "provider:google"),
        Date.now(),
        new Date().toISOString(),
      );
    database
      .prepare(
        "INSERT INTO auth_accounts(id,accountId,providerId,userId,createdAt,updatedAt) VALUES (?,?,'google',?,?,?)",
      )
      .run(
        googleId,
        googleId,
        ownerId,
        new Date().toISOString(),
        new Date().toISOString(),
      );
    database.exec("UPDATE installation SET version=version+1");
    const changes = await Promise.all([
      raw(
        "/api/v1/admin/providers/github",
        JSON.stringify({ enabled: false }),
        { "Content-Type": "application/json" },
        "PUT",
      ),
      raw("/api/auth/unlink-account", JSON.stringify({ accountId: googleId }), {
        "Content-Type": "application/json",
      }),
    ]);
    for (const response of changes)
      assert.ok(
        [200, 409].includes(response.status),
        `Unexpected method change status: ${response.status} ${await response.text()}`,
      );
    assert.equal(
      changes.filter((response) => response.status === 200).length,
      1,
      "A concurrent provider disable and unlink must leave one usable method",
    );
    const usable = database
      .prepare(
        "SELECT COUNT(*) AS n FROM auth_accounts a JOIN auth_provider_config p ON p.id=a.providerId WHERE a.userId=? AND p.enabled=1 AND p.tested_at IS NOT NULL",
      )
      .get(ownerId) as { n: number };
    assert.equal(usable.n, 1);
    assert.equal(
      (
        database
          .prepare("SELECT COUNT(*) AS n FROM auth_method_changes")
          .get() as { n: number }
      ).n,
      0,
    );
  } finally {
    database
      .prepare(
        "UPDATE auth_accounts SET providerId='credential' WHERE userId=? AND providerId='github'",
      )
      .run(ownerId);
    database.exec(
      "DELETE FROM auth_provider_config WHERE id IN ('github','google'); UPDATE installation SET version=version+1",
    );
    database
      .prepare(
        "DELETE FROM auth_accounts WHERE userId=? AND providerId='google'",
      )
      .run(ownerId);
  }
  console.log(
    "Native provider administration: sole-provider edits are rejected; concurrent provider disable and unlink preserve a usable sign-in method.",
  );
  await owner.call(
    `/api/v1/admin/people/${encodeURIComponent(memberId)}/transfer-content`,
    {
      targetId: ownerId,
      reason: "Conformance rollback",
      resources: [
        { type: "board", id: owned.id },
        { type: "board", id: "board:missing-fixture" },
      ],
    },
    409,
  );
  assert.equal(
    (
      database
        .prepare(
          "SELECT role FROM resource_grants WHERE user_id = ? AND resource_id = ? AND resource_type = 'board'",
        )
        .get(memberId, owned.id) as any
    ).role,
    "owner",
  );
  await owner.call(
    `/api/v1/admin/people/${encodeURIComponent(memberId)}/transfer-content`,
    {
      targetId: ownerId,
      reason: "Conformance transfer",
      resources: [
        { type: "board", id: owned.id },
        { type: "workbook", id: wb.id },
      ],
    },
  );
  assert.equal(
    (
      database
        .prepare(
          "SELECT role FROM resource_grants WHERE user_id = ? AND resource_id = ? AND resource_type = 'board'",
        )
        .get(memberId, owned.id) as any
    ).role,
    "editor",
  );
  assert.equal(
    (
      database
        .prepare("SELECT created_by FROM boards WHERE id = ?")
        .get(owned.id) as any
    ).created_by,
    ownerId,
  );
  console.log(
    "Native administration: mixed invalid content transfer rolls back; complete transfer changes ownership and quota attribution.",
  );
  // The normal Share dialog must enforce the same quota accounting as recovery
  // transfers. Exercise both failures and a complete handover through HTTP.
  const allocationOwner = () => (database.prepare("SELECT created_by FROM boards WHERE id = ?").get(board.id) as { created_by: string }).created_by;
  const limits = database.prepare("SELECT user_board_limit, user_storage_limit FROM installation").get() as { user_board_limit: number; user_storage_limit: number };
  const recipientBoards = (database.prepare("SELECT COUNT(*) AS n FROM boards WHERE created_by = ? AND deleted_at IS NULL").get(memberId) as { n: number }).n;
  const boardBytes = (database.prepare("SELECT SUM(byte_size) AS n FROM asset_references WHERE board_id = ?").get(board.id) as { n: number }).n;
  assert.ok(boardBytes > 0);
  const ownershipPath = `/api/v1/boards/${encodeURIComponent(board.id)}/ownership`;
  try {
    database.prepare("UPDATE installation SET user_board_limit = ?").run(recipientBoards);
    const boardLimit = await owner.call(ownershipPath, { userId: memberId }, 409);
    assert.equal(boardLimit.code, "USER_BOARD_LIMIT");
    assert.equal(allocationOwner(), ownerId);
    database.prepare("UPDATE installation SET user_board_limit = ?, user_storage_limit = ?").run(limits.user_board_limit, boardBytes - 1);
    const storageLimit = await owner.call(ownershipPath, { userId: memberId }, 409);
    assert.equal(storageLimit.code, "USER_STORAGE_LIMIT");
    assert.equal(allocationOwner(), ownerId);
  } finally {
    database.prepare("UPDATE installation SET user_board_limit = ?, user_storage_limit = ?").run(limits.user_board_limit, limits.user_storage_limit);
  }
  await owner.call(ownershipPath, { userId: memberId });
  assert.equal(allocationOwner(), memberId);
  await owner.call(ownershipPath, { userId: memberId }, 403);
  await member.call(ownershipPath, { userId: ownerId });
  assert.equal(allocationOwner(), ownerId);
  assert.equal((database.prepare("SELECT COUNT(*) AS n FROM resource_ownership_transfers").get() as { n: number }).n, 0);
  console.log("Native board sharing: board/storage quota failures roll back, ownership and asset allocation move together, and the new owner can transfer back.");
  async function webhook(
    event: any,
    options: { tamper?: boolean; age?: number; id?: string } = {},
  ) {
    const body = JSON.stringify(event),
      id = options.id ?? `msg_${randomBytes(8).toString("hex")}`,
      timestamp = String(Math.floor(Date.now() / 1000) - (options.age ?? 0));
    const signature = createHmac(
      "sha256",
      Buffer.from(ctx.webhookSecret.replace(/^whsec_/, ""), "base64"),
    )
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64");
    return fetch(`${origin}/api/v1/mail/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "svix-id": id,
        "svix-timestamp": timestamp,
        "svix-signature": `v1,${signature}`,
      },
      body: options.tamper ? body + " " : body,
    });
  }
  const event = {
    type: "email.delivered",
    created_at: new Date().toISOString(),
    data: { email_id: "fixture-receipt", to: ["fixture@example.invalid"] },
  };
  assert.equal((await webhook(event, { tamper: true })).status, 400);
  assert.equal((await webhook(event, { age: 600 })).status, 400);
  assert.equal((await webhook(null)).status, 400);
  assert.equal((await webhook(event, { id: "msg_repeat" })).status, 200);
  assert.equal((await webhook(event, { id: "msg_repeat" })).status, 200);
  assert.equal(
    (
      await webhook({
        ...event,
        type: "email.sent",
        created_at: new Date(Date.now() - 60000).toISOString(),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      database
        .prepare(
          "SELECT status FROM mail_delivery_receipts WHERE provider_id = 'fixture-receipt'",
        )
        .get() as any
    ).status,
    "delivered",
  );
  assert.equal(
    (await webhook({ ...event, type: "email.bounced" })).status,
    200,
  );
  assert.ok(
    database
      .prepare(
        "SELECT 1 FROM mail_suppressions WHERE email = 'fixture@example.invalid'",
      )
      .get(),
  );
  console.log(
    "Native email webhooks: signature tampering, expired signatures, malformed payloads, duplicate delivery and out-of-order receipts passed.",
  );
  const orphan = await upload(randomBytes(64));
  assert.equal(orphan.response.status, 201);
  const getObject = () =>
    execFileSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "r2",
        "object",
        "get",
        `canvas-auth-tests-blobs/${orphan.key}`,
        "--local",
        "--config",
        "tests/wrangler.auth.jsonc",
        "--pipe",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  assert.equal(getObject().byteLength, 64);
  database
    .prepare(
      "DELETE FROM asset_references WHERE board_id = ? AND asset_key = ?",
    )
    .run(board.id, orphan.key);
  database
    .prepare(
      "INSERT INTO quota_reservations(id,user_id,kind,amount,resource_id,expires_at) VALUES ('orphan-fixture',?,'storage_cleanup',0,?,?)",
    )
    .run(ownerId, orphan.key, Date.now() - 1000);
  const addJob = database.prepare(
    "INSERT INTO security_outbox(id,kind,payload,expires_at,next_attempt_at,attempts,status,created_at) VALUES (?,'mail',?,?,?,0,'pending',?)",
  );
  addJob.run(
    "expired-mail-fixture",
    "expired-proof-canary",
    Date.now() - 1000,
    Date.now() - 1000,
    Date.now(),
  );
  addJob.run(
    "failed-mail-fixture",
    "private-malformed-payload-canary",
    Date.now() + 3600000,
    // Select this fixture ahead of the earlier lifecycle invalidations. Each
    // scheduled invocation intentionally handles at most 20 jobs.
    Date.now() - 86400_000,
    Date.now(),
  );
  const tick = () =>
    fetch(`${origin}/cdn-cgi/local/scheduled?format=json`).then(
      async (response) => {
        assert.equal(response.status, 200);
        assert.equal(((await response.json()) as any).outcome, "ok");
      },
    );
  await Promise.all([tick(), tick()]);
  assert.throws(getObject, "Unreferenced marked blob must be collected");
  assert.equal(
    (
      database
        .prepare(
          "SELECT payload FROM security_outbox WHERE id='expired-mail-fixture'",
        )
        .get() as any
    ).payload,
    "",
  );
  const failed = database
    .prepare(
      "SELECT attempts,last_error FROM security_outbox WHERE id='failed-mail-fixture'",
    )
    .get() as any;
  assert.equal(failed.attempts, 1);
  assert.ok(!failed.last_error.includes("canary"));
  const preserved = await fetch(
    `${origin}/api/v1/boards/${encodeURIComponent(board.id)}/blobs/${encodeURIComponent(successful.key)}`,
    { headers: { Cookie: cookie() } },
  );
  assert.equal(preserved.status, 200);
  console.log(
    "Native scheduled jobs: concurrent claims, sanitized retry failure, expired-mail removal, orphan R2 cleanup and live asset preservation passed.",
  );
}
