import type { NativeEnv } from "./auth/types";
import type { Principal, Role } from "./collaboration-types";
import { requireBoardRole } from "./collaboration.server";
import { guestBoardAccess, LIVE_GUEST_LINK } from "./guest-policy.server";
import { canonicalOrigin, checkCanonicalRequest } from "./security/config";
import {
  cookie,
  equal,
  hmac,
  json,
  randomToken,
  sha256,
  text,
} from "./security/primitives";
import { csrfBootstrap, requireCsrf } from "./security/request";
import { clientIp, limit } from "./security/limits";
import { HttpError } from "./security/errors";
import { seal, open } from "./security/secret-store";
import { derivePasswordHash, verifyPassword } from "./auth/password";
import { auditStatement } from "./security/audit";

type Link = {
  id: string;
  board_id: string;
  role: Exclude<Role, "owner">;
  password_hash: string | null;
  expires_at: string | null;
  title: string;
};
const SESSION_SECONDS = 8 * 3600;
const tokenPattern = /^[a-zA-Z0-9_-]{43}$/u;
function token(value: unknown) {
  if (typeof value !== "string" || !tokenPattern.test(value))
    throw new HttpError(
      404,
      "This guest link is unavailable.",
      "GUEST_LINK_UNAVAILABLE",
    );
  return value;
}
function board(value: unknown) {
  return text(value, "Board", 160);
}
async function cookieName(env: NativeEnv, boardId: string, linkId?: string) {
  return `${canonicalOrigin(env).startsWith("https:") ? "__Host-" : ""}huddle-guest-${(await sha256(boardId)).slice(0, 24)}${linkId ? `-${(await sha256(linkId)).slice(0, 16)}` : ""}`;
}
async function sessionCookie(env: NativeEnv, boardId: string, raw: string, expiresAt: string, linkId?: string) {
  return `${await cookieName(env, boardId, linkId)}=${raw}; Path=/; HttpOnly; SameSite=Lax${canonicalOrigin(env).startsWith("https:") ? "; Secure" : ""}; Max-Age=${Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000))}`;
}
async function liveLink(env: NativeEnv, value: unknown, boardId: string) {
  const at = new Date().toISOString();
  const row = await env.CATALOG.prepare(
    `SELECT l.id,l.board_id,l.role,l.password_hash,l.expires_at,b.title
    FROM guest_board_links l JOIN boards b ON b.id=l.board_id WHERE l.token_hash=? AND l.board_id=? AND ${LIVE_GUEST_LINK}`,
  )
    .bind(await sha256(token(value)), boardId, at, at)
    .first<Link>();
  if (!row)
    throw new HttpError(
      404,
      "This guest link has expired or been turned off. Ask the board owner for a new link.",
      "GUEST_LINK_UNAVAILABLE",
    );
  return row;
}

export async function readGuestSession(
  request: Request,
  env: NativeEnv,
  boardId: string,
  linkId?: string,
) {
  checkCanonicalRequest(request, env);
  if (linkId !== undefined && !/^[a-zA-Z0-9_-]{24}$/u.test(linkId))
    throw new HttpError(400, "Invalid guest link.", "INVALID_INPUT");
  // Each link has its own session. Retain the board cookie as a fallback for
  // sessions created before link isolation and clients without a selector.
  const raw =
    (linkId && cookie(request, await cookieName(env, boardId, linkId))) ||
    cookie(request, await cookieName(env, boardId));
  if (!raw || !tokenPattern.test(raw)) return null;
  const at = new Date().toISOString();
  const row = await env.CATALOG.prepare(
    `SELECT s.id,s.user_id,s.link_id,s.expires_at,u.display_name,u.color
    FROM guest_board_sessions s JOIN guest_board_links l ON l.id=s.link_id JOIN users u ON u.id=s.user_id
    JOIN boards b ON b.id=l.board_id WHERE s.token_hash=? AND l.board_id=? AND s.expires_at > ? AND ${LIVE_GUEST_LINK}${linkId ? " AND l.id=?" : ""}`,
  )
    .bind(await sha256(raw), boardId, at, at, at, ...(linkId ? [linkId] : []))
    .first<{
      id: string;
      user_id: string;
      link_id: string;
      expires_at: string;
      display_name: string;
      color: string;
    }>();
  if (!row) return null;
  const principal: Principal = {
    id: row.user_id,
    name: row.display_name,
    email: "",
    avatarUrl: null,
    color: row.color,
    authentication: "guest",
    issuer: "urn:huddle:guest",
    subject: row.user_id,
    sessionId: row.id,
    expiresAt: row.expires_at,
    grantId: row.link_id,
    resourceMode: "selected",
    resources: [{ type: "board", id: boardId }],
  };
  return { principal, csrf: await hmac(env.AUTH_SECRET!, `guest-csrf:${raw}`), cookieToken: raw };
}

export function guestRequestBoard(request: Request) {
  const url = new URL(request.url);
  const explicit = request.headers.get("X-Huddle-Guest");
  const socket =
    request.headers.get("Upgrade")?.toLowerCase() === "websocket" &&
    url.searchParams.get("guest") === "1";
  if (!explicit && !socket) return null;
  const match = url.pathname.match(
    /^\/api\/v1\/boards\/([^/]+)(?:\/(bootstrap|semantic|preview|commands|ws|collaboration(?:\/commands)?|comment-preferences|blobs(?:\/[^/]+)?))?$/u,
  );
  if (!match)
    throw new HttpError(
      403,
      "Guest access is limited to the shared board.",
      "GUEST_SCOPE_REQUIRED",
    );
  const boardId = decodeURIComponent(match[1]);
  if (explicit && explicit !== boardId)
    throw new HttpError(
      403,
      "Guest access is limited to the shared board.",
      "GUEST_SCOPE_REQUIRED",
    );
  return boardId;
}
export async function authenticateGuestRequest(
  request: Request,
  env: NativeEnv,
  boardId: string,
) {
  const session = await readGuestSession(
    request,
    env,
    boardId,
    request.headers.get("X-Huddle-Guest-Link") ??
      new URL(request.url).searchParams.get("linkId") ??
      undefined,
  );
  if (!session)
    throw new HttpError(
      401,
      "Guest access has ended. Open the shared link to join again.",
      "GUEST_ACCESS_ENDED",
    );
  if (!["GET", "HEAD"].includes(request.method)) {
    if (
      request.headers.get("Origin") !== canonicalOrigin(env) ||
      request.headers.get("Sec-Fetch-Site") === "cross-site" ||
      !equal(request.headers.get("X-Huddle-Guest-CSRF") ?? "", session.csrf)
    )
      throw new HttpError(
        403,
        "This action must come from the shared board.",
        "CSRF_REJECTED",
      );
  }
  return session.principal;
}

async function publicSession(
  env: NativeEnv,
  session: NonNullable<Awaited<ReturnType<typeof readGuestSession>>>,
  boardId: string,
) {
  const access = await guestBoardAccess(
    env.CATALOG,
    session.principal,
    boardId,
  );
  return {
    boardId,
    user: {
      id: session.principal.id,
      name: session.principal.name,
      color: session.principal.color,
    },
    linkId: session.principal.grantId,
    sessionId: session.principal.sessionId,
    expiresAt: session.principal.expiresAt,
    csrf: session.csrf,
    role: access.capabilities.role,
    title: access.metadata.title,
  };
}

/** Public entry points never authenticate or grant an installation account. */
export async function guestEntryRoutes(
  request: Request,
  env: NativeEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/v1/guest-links/")) return null;
  if ((env.AUTH_MODE ?? "native") !== "native")
    throw new HttpError(
      404,
      "Guest links require application authentication.",
      "NOT_FOUND",
    );
  checkCanonicalRequest(request, env);
  if (
    url.pathname === "/api/v1/guest-links/session" &&
    request.method === "GET"
  ) {
    const boardId = board(url.searchParams.get("board"));
    const csrf = await csrfBootstrap(request, env);
    const linkId = url.searchParams.get("linkId") ?? undefined;
    const session = await readGuestSession(
      request, env, boardId, linkId,
    );
    const headers = new Headers({ "Set-Cookie": csrf.cookie });
    if (session && linkId)
      headers.append("Set-Cookie", await sessionCookie(env, boardId, session.cookieToken, session.principal.expiresAt!, linkId));
    return Response.json(
      {
        entryCsrf: csrf.token,
        guest: session ? await publicSession(env, session, boardId) : null,
      },
      { headers },
    );
  }
  if (
    request.method !== "POST" ||
    !["/api/v1/guest-links/inspect", "/api/v1/guest-links/join"].includes(
      url.pathname,
    )
  )
    throw new HttpError(405, "Guest action unavailable.", "METHOD_NOT_ALLOWED");
  await requireCsrf(request, env);
  await limit(env, "guest-entry-ip", clientIp(request), 60, 60);
  const body = await json(request, 4096);
  const boardId = board(body.boardId);
  const link = await liveLink(env, body.token, boardId);
  await limit(env, "guest-entry-link", link.id, 180, 60);
  if (url.pathname.endsWith("/inspect"))
    return Response.json({
      id: link.id,
      title: link.password_hash ? null : link.title,
      passwordRequired: Boolean(link.password_hash),
      role: link.role,
    });
  const name = text(body.name, "Your name", 60);
  if (link.password_hash) {
    await limit(
      env,
      "guest-password",
      `${clientIp(request)}:${link.id}`,
      20,
      600,
    );
    if (
      typeof body.password !== "string" ||
      !(await verifyPassword({
        hash: link.password_hash,
        password: body.password,
      }))
    )
      throw new HttpError(
        403,
        "The board password is incorrect.",
        "GUEST_PASSWORD_INCORRECT",
      );
  }
  const existing = await readGuestSession(request, env, boardId, link.id);
  if (existing && existing.principal.grantId === link.id)
    return Response.json({
      guest: await publicSession(env, existing, boardId),
    }, { headers: { "Set-Cookie": await sessionCookie(env, boardId, existing.cookieToken, existing.principal.expiresAt!, link.id) } });
  const id = randomToken(18),
    userId = `guest:${randomToken(18)}`,
    raw = randomToken();
  const at = new Date().toISOString();
  const expiresAt = new Date(
    Math.min(
      Date.now() + SESSION_SECONDS * 1000,
      link.expires_at ? Date.parse(link.expires_at) : Infinity,
    ),
  ).toISOString();
  const color = ["#6476a4", "#9a7651", "#6b8b70", "#987490"][
    crypto.getRandomValues(new Uint8Array(1))[0] % 4
  ];
  const [, inserted] = await env.CATALOG.batch([
    env.CATALOG.prepare(
      "INSERT INTO users(id,issuer,subject,email,display_name,avatar_url,color,created_at,updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)",
    ).bind(
      userId,
      "urn:huddle:guest",
      userId,
      `${userId.slice(6)}@guest.invalid`,
      name,
      color,
      at,
      at,
    ),
    env.CATALOG.prepare(
      `INSERT INTO guest_board_sessions(id,link_id,user_id,token_hash,expires_at,created_at)
      SELECT ?,l.id,?,?,?,? FROM guest_board_links l JOIN boards b ON b.id=l.board_id
      WHERE l.id=? AND COALESCE(l.password_hash,'')=? AND ${LIVE_GUEST_LINK}
      AND (SELECT COUNT(*) FROM guest_board_sessions active_session JOIN guest_board_links l ON l.id=active_session.link_id JOIN boards b ON b.id=l.board_id WHERE active_session.expires_at > ? AND ${LIVE_GUEST_LINK}) < (SELECT guest_limit FROM installation WHERE id='instance')`,
    ).bind(
      id,
      userId,
      await sha256(raw),
      expiresAt,
      at,
      link.id,
      link.password_hash ?? "",
      at,
      at,
      at,
      at,
      at,
    ),
  ]);
  if (!inserted.meta.changes) {
    await env.CATALOG.prepare("DELETE FROM users WHERE id=?")
      .bind(userId)
      .run();
    throw new HttpError(
      409,
      "This link changed or the guest limit was reached. Try again or contact the board owner.",
      "GUEST_JOIN_UNAVAILABLE",
    );
  }
  const headers = new Headers();
  for (const selector of [undefined, link.id])
    headers.append("Set-Cookie", await sessionCookie(env, boardId, raw, expiresAt, selector));
  const joined = new Request(request.url, {
    headers: { Cookie: `${await cookieName(env, boardId)}=${raw}` },
  });
  const session = await readGuestSession(joined, env, boardId, link.id);
  if (!session)
    throw new HttpError(
      409,
      "This guest link changed. Open it again.",
      "GUEST_JOIN_UNAVAILABLE",
    );
  return Response.json(
    { guest: await publicSession(env, session, boardId) },
    { headers },
  );
}

function linkOptions(body: Record<string, unknown>) {
  if (!["viewer", "commenter", "editor"].includes(String(body.role)))
    throw new HttpError(
      400,
      "Choose viewer, commenter or editor.",
      "INVALID_ROLE",
    );
  const days = Number(body.expiresInDays);
  if (![0, 1, 7, 30, 90].includes(days))
    throw new HttpError(400, "Choose a supported expiry.", "INVALID_INPUT");
  if (
    body.password !== undefined &&
    body.password !== null &&
    (typeof body.password !== "string" ||
      body.password.length < 8 ||
      body.password.length > 128)
  )
    throw new HttpError(
      400,
      "Use 8–128 characters for a board password.",
      "INVALID_PASSWORD",
    );
  return {
    role: String(body.role),
    expiresAt: days
      ? new Date(Date.now() + days * 86400000).toISOString()
      : null,
  };
}
export async function manageGuestLinks(
  request: Request,
  env: NativeEnv,
  principal: Principal,
  boardId: string,
  linkId?: string,
) {
  if ((env.AUTH_MODE ?? "native") !== "native")
    throw new HttpError(
      400,
      "Enable application authentication to use guest links.",
      "GUEST_LINKS_UNAVAILABLE",
    );
  await requireBoardRole(env.CATALOG, boardId, principal, "owner");
  if (request.method === "GET" && !linkId) {
    const at = new Date().toISOString();
    const rows = await env.CATALOG.prepare(
      `SELECT l.id,l.role,l.password_hash,l.expires_at,l.revoked_at,l.created_at,l.token_ciphertext,
      CASE WHEN ${LIVE_GUEST_LINK} THEN 1 ELSE 0 END AS available FROM guest_board_links l JOIN boards b ON b.id=l.board_id
      WHERE l.board_id=? ORDER BY available DESC,l.created_at DESC LIMIT 20`,
    )
      .bind(at, at, boardId)
      .all<{
        id: string;
        available: number;
        role: string;
        password_hash: string | null;
        expires_at: string | null;
        revoked_at: string | null;
        created_at: string;
        token_ciphertext: string;
      }>();
    return Response.json({
      links: await Promise.all(
        rows.results.map(async (row) => ({
          id: row.id,
          available: Boolean(row.available),
          role: row.role,
          passwordProtected: Boolean(row.password_hash),
          expiresAt: row.expires_at,
          revokedAt: row.revoked_at,
          createdAt: row.created_at,
          url: row.available
            ? `${canonicalOrigin(env)}/guest/${encodeURIComponent(boardId)}#link=${await open(env, row.token_ciphertext, `guest-link:${row.id}`)}`
            : null,
        })),
      ),
    });
  }
  if (
    !["POST", "PATCH", "DELETE"].includes(request.method) ||
    (request.method === "POST") === Boolean(linkId)
  )
    throw new HttpError(
      405,
      "Guest sharing action unavailable.",
      "METHOD_NOT_ALLOWED",
    );
  const at = new Date().toISOString();
  if (!linkId) {
    const body = await json(request, 4096),
      options = linkOptions(body),
      id = randomToken(18),
      raw = randomToken();
    const [result] = await env.CATALOG.batch([
      env.CATALOG.prepare(
        `INSERT INTO guest_board_links(id,board_id,created_by,token_hash,token_ciphertext,role,password_hash,expires_at,revoked_at,created_at)
      SELECT ?,?,?,?,?,?,?,?,NULL,? WHERE (SELECT COUNT(*) FROM guest_board_links l JOIN boards b ON b.id=l.board_id WHERE l.board_id=? AND ${LIVE_GUEST_LINK}) < 10`,
      ).bind(
        id,
        boardId,
        principal.id,
        await sha256(raw),
        await seal(env, raw, `guest-link:${id}`),
        options.role,
        typeof body.password === "string"
          ? await derivePasswordHash(body.password)
          : null,
        options.expiresAt,
        at,
        boardId,
        at,
        at,
      ),
      env.CATALOG.prepare(
        `INSERT INTO security_audit(id,actor_id,action,target_id,outcome,metadata,created_at)
        SELECT ?,?,'guest-link.create',?,'success',?,? WHERE EXISTS(SELECT 1 FROM guest_board_links WHERE id=?)`,
      ).bind(
        randomToken(18),
        principal.id,
        boardId,
        JSON.stringify({ role: options.role }),
        at,
        id,
      ),
    ]);
    if (!result.meta.changes)
      throw new HttpError(
        409,
        "Turn off an existing guest link before creating another.",
        "GUEST_LINK_LIMIT",
      );
    return Response.json(
      {
        id,
        url: `${canonicalOrigin(env)}/guest/${encodeURIComponent(boardId)}#link=${raw}`,
      },
      { status: 201 },
    );
  }
  const current = await env.CATALOG.prepare(
    "SELECT id FROM guest_board_links WHERE id=? AND board_id=? AND revoked_at IS NULL",
  )
    .bind(linkId, boardId)
    .first();
  if (!current) throw new HttpError(404, "Guest link not found.", "NOT_FOUND");
  if (request.method === "DELETE") {
    await env.CATALOG.batch([
      env.CATALOG.prepare(
        "UPDATE guest_board_links SET revoked_at=? WHERE id=? AND board_id=?",
      ).bind(at, linkId, boardId),
      env.CATALOG.prepare(
        "DELETE FROM guest_board_sessions WHERE link_id=?",
      ).bind(linkId),
      auditStatement(env.CATALOG, principal.id, "guest-link.revoke", boardId),
    ]);
  } else {
    const body = await json(request, 4096),
      options = linkOptions(body);
    const hash =
      typeof body.password === "string"
        ? await derivePasswordHash(body.password)
        : null;
    await env.CATALOG.batch([
      env.CATALOG.prepare(
        "UPDATE guest_board_links SET role=?,expires_at=?,password_hash=CASE WHEN ?=1 THEN ? ELSE password_hash END WHERE id=? AND board_id=? AND revoked_at IS NULL",
      ).bind(
        options.role,
        options.expiresAt,
        body.password !== undefined ? 1 : 0,
        hash,
        linkId,
        boardId,
      ),
      env.CATALOG.prepare(
        "DELETE FROM guest_board_sessions WHERE link_id=?",
      ).bind(linkId),
      auditStatement(
        env.CATALOG,
        principal.id,
        "guest-link.update",
        boardId,
        "success",
        { role: options.role },
      ),
    ]);
  }
  await env.BOARD_ROOMS?.getByName(boardId).fetch(
    "https://board-room/invalidate-guest-link",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ linkId }),
    },
  );
  return Response.json({ ok: true });
}
