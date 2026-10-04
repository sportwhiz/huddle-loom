import type { InstanceRole, NativeEnv } from "../auth/types";
import { nativePrincipal } from "../auth/session";
import {
  admit,
  installation,
  requireAdministrator,
  requireFresh,
  securityState,
} from "../auth/policy";
import { tombstoneAccount, revokeIdentity } from "../auth/account-routes";
import { canonicalOrigin } from "../security/config";
import { email, json, randomToken, sha256, text } from "../security/primitives";
import { HttpError } from "../security/errors";
import { audit, auditStatement } from "../security/audit";
import { limit } from "../security/limits";
import {
  invalidationStatement,
  mailReady,
  processOutbox,
  queueMail,
} from "../mail/outbox";
import { providerInventory, saveProvider } from "./providers";

function settingsDto(value: Awaited<ReturnType<typeof installation>>) {
  const keys = [
    "title",
    "registration",
    "approval_required",
    "mfa_required",
    "magic_link",
    "member_limit",
    "guest_limit",
    "board_limit",
    "storage_limit",
    "user_board_limit",
    "user_storage_limit",
    "mail_limit",
    "session_idle_seconds",
    "session_absolute_seconds",
    "dynamic_registration",
  ];
  return Object.fromEntries(
    keys.map((key) => [key, value[key as keyof typeof value]]),
  );
}
function page(url: URL) {
  const size = 50;
  const cursor = url.searchParams.get("after") ?? "";
  if (cursor.length > 200)
    throw new HttpError(400, "Invalid page cursor.", "INVALID_CURSOR");
  return {
    size,
    cursor,
    query: (url.searchParams.get("q") ?? "").slice(0, 120),
  };
}
export async function usage(env: NativeEnv) {
  const rows = await env.CATALOG.batch<{
    count?: number;
    bytes?: number;
    role?: string;
  }>([
    env.CATALOG.prepare(
      "SELECT role, COUNT(*) AS count FROM instance_memberships GROUP BY role",
    ),
    env.CATALOG.prepare(
      "SELECT COUNT(*) AS count FROM boards WHERE deleted_at IS NULL",
    ),
    env.CATALOG.prepare(
      "SELECT COALESCE(SUM(MAX(byte_size,0)), 0) AS bytes FROM asset_references",
    ),
    env.CATALOG.prepare(
      "SELECT count FROM daily_usage WHERE day = ? AND kind = ?",
    ).bind(new Date().toISOString().slice(0, 10), "mail"),
  ]);
  return {
    accounts: rows[0].results,
    boards: rows[1].results[0]?.count ?? 0,
    referencedStorageBytes: rows[2].results[0]?.bytes ?? 0,
    mailToday: rows[3].results[0]?.count ?? 0,
  };
}
async function transferContent(
  env: NativeEnv,
  actorId: string,
  sourceId: string,
  input: Record<string, unknown>,
) {
  const targetId = text(input.targetId, "Recipient account", 100);
  const reason = text(input.reason, "Transfer reason", 160);
  if (
    !Array.isArray(input.resources) ||
    !input.resources.length ||
    input.resources.length > 200
  )
    throw new HttpError(
      400,
      "Select 1–200 owned resources.",
      "INVALID_RESOURCES",
    );
  const resources = input.resources.map((entry: unknown) => {
    if (!entry || typeof entry !== "object")
      throw new HttpError(400, "Invalid resource.", "INVALID_RESOURCES");
    const item = entry as { type: string; id: string };
    if (
      !["folder", "workbook", "board"].includes(item.type) ||
      typeof item.id !== "string" ||
      item.id.length > 100
    )
      throw new HttpError(400, "Invalid resource.", "INVALID_RESOURCES");
    return { type: item.type, id: item.id };
  });
  if (
    new Set(resources.map((item) => `${item.type}:${item.id}`)).size !==
    resources.length
  )
    throw new HttpError(400, "Select each resource once.", "INVALID_RESOURCES");
  const items = JSON.stringify(resources);
  const id = randomToken(18);
  const at = new Date().toISOString();
  await env.CATALOG.batch([
    // The trigger validates the entire selection under the batch transaction lock.
    env.CATALOG.prepare(
      "INSERT INTO content_transfer_operations (id, source_id, target_id, resources) VALUES (?, ?, ?, ?)",
    ).bind(id, sourceId, targetId, items),
    env.CATALOG.prepare(
      "INSERT INTO resource_grants (resource_type, resource_id, user_id, role, source, created_at, updated_at) SELECT json_extract(value, '$.type'), json_extract(value, '$.id'), ?, 'owner', 'direct', ?, ? FROM json_each(?) WHERE json_extract(value, '$.type') IN ('board','workbook') ON CONFLICT(resource_type, resource_id, user_id) DO UPDATE SET role = 'owner', source = 'direct', expires_at = NULL, updated_at = excluded.updated_at",
    ).bind(targetId, at, at, items),
    env.CATALOG.prepare(
      "UPDATE resource_grants SET role = 'editor', updated_at = ? WHERE user_id = ? AND role = 'owner' AND EXISTS(SELECT 1 FROM json_each(?) WHERE json_extract(value, '$.type') = resource_type AND json_extract(value, '$.id') = resource_id)",
    ).bind(at, sourceId, items),
    env.CATALOG.prepare(
      "UPDATE folders SET owner_id = ? WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?) WHERE json_extract(value, '$.type') = 'folder')",
    ).bind(targetId, items),
    env.CATALOG.prepare(
      "UPDATE boards SET created_by = ? WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?) WHERE json_extract(value, '$.type') = 'board')",
    ).bind(targetId, items),
    auditStatement(
      env.CATALOG,
      actorId,
      "admin.content_transferred",
      sourceId,
      "success",
      { count: resources.length, reason },
    ),
    invalidationStatement(env, sourceId),
    env.CATALOG.prepare(
      "DELETE FROM content_transfer_operations WHERE id = ?",
    ).bind(id),
  ]);
  return { transferred: resources.length };
}
export async function adminRoutes(
  request: Request,
  env: NativeEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/v1/admin/")) return null;
  const { principal, user } = await nativePrincipal(request, env);
  const me = await requireAdministrator(
    env,
    principal,
    false,
    request.method !== "GET",
  );
  if (url.pathname === "/api/v1/admin/local-invitations") {
    if (request.method === "GET")
      return Response.json({
        invitations: (
          await env.CATALOG.prepare(
            "SELECT id,label,role,created_at,expires_at,accepted_by,revoked_at FROM local_invitations ORDER BY created_at DESC LIMIT 100",
          ).all()
        ).results,
      });
    if (request.method === "POST") {
      const body = await json(request);
      await limit(env, "local-invitations", principal.id, 30, 3600);
      const label = text(body.label, "Who is this invitation for?", 80);
      if (
        body.role !== undefined &&
        !["guest", "member"].includes(String(body.role))
      )
        throw new HttpError(400, "Choose member or guest.", "INVALID_ROLE");
      const role = body.role === "guest" ? "guest" : "member";
      const token = randomToken(32),
        id = randomToken(18);
      const created = await env.CATALOG.prepare(
        "INSERT INTO local_invitations(id,token_hash,label,role,created_by,created_at,expires_at) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM local_invitations WHERE accepted_by IS NULL AND revoked_at IS NULL AND expires_at>?)<100",
      )
        .bind(
          id,
          await sha256(token),
          label,
          role,
          principal.id,
          Date.now(),
          Date.now() + 7 * 86400000,
          Date.now(),
        )
        .run();
      if (!created.meta.changes)
        throw new HttpError(
          409,
          "Revoke unused invitations before creating more.",
          "INVITATION_LIMIT",
        );
      await audit(env.CATALOG, principal.id, "local_invitation.created", id);
      return Response.json({ id, token });
    }
  }
  const localInvitation = url.pathname.match(
    /^\/api\/v1\/admin\/local-invitations\/([A-Za-z0-9_-]+)\/revoke$/u,
  );
  if (localInvitation && request.method === "POST") {
    await env.CATALOG.prepare(
      "UPDATE local_invitations SET revoked_at=? WHERE id=? AND accepted_by IS NULL",
    )
      .bind(Date.now(), localInvitation[1])
      .run();
    await audit(
      env.CATALOG,
      principal.id,
      "local_invitation.revoked",
      localInvitation[1],
    );
    return Response.json({ revoked: true });
  }
  const p = page(url);
  if (url.pathname === "/api/v1/admin/recipients" && request.method === "GET") {
    const ownership = url.searchParams.get("kind") === "ownership";
    if (ownership) await requireAdministrator(env, principal, true);
    const people = await env.CATALOG.prepare(
      `SELECT u.id, u.name, COALESCE((SELECT username FROM local_accounts WHERE user_id=u.id),u.email) AS email FROM auth_users u JOIN account_security s ON s.user_id = u.id JOIN instance_memberships m ON m.user_id = u.id
      WHERE (u.emailVerified = 1 OR EXISTS(SELECT 1 FROM local_accounts WHERE user_id=u.id)) AND s.status = 'active' AND s.recovery_required = 0 AND m.role IN ('member','admin','owner') AND u.id <> ?
      AND (u.name LIKE ? OR COALESCE((SELECT username FROM local_accounts WHERE user_id=u.id),u.email) LIKE ?) ${ownership ? "AND m.role IN ('member','admin') AND (u.twoFactorEnabled = 1 OR EXISTS(SELECT 1 FROM auth_passkeys WHERE userId = u.id))" : ""} ORDER BY u.name,u.id LIMIT 25`,
    )
      .bind(
        url.searchParams.get("exclude") ?? principal.id,
        `%${p.query}%`,
        `%${p.query}%`,
      )
      .all();
    return Response.json({ people: people.results });
  }
  if (url.pathname === "/api/v1/admin/people" && request.method === "GET") {
    const status = url.searchParams.get("status") ?? "current";
    if (
      ![
        "current",
        "pending_approval",
        "pending_verification",
        "active",
        "suspended",
        "deleted",
      ].includes(status)
    )
      throw new HttpError(
        400,
        "Choose a valid account status.",
        "INVALID_INPUT",
      );
    const rows = await env.CATALOG.prepare(
      `SELECT u.id, COALESCE((SELECT username FROM local_accounts WHERE user_id=u.id),u.email) AS email, (SELECT username FROM local_accounts WHERE user_id=u.id) AS localUsername, u.display_name AS name, s.status, s.auth_version AS authVersion, m.role, a.emailVerified AS verified, a.twoFactorEnabled AS twoFactorEnabled, u.created_at AS createdAt
      FROM users u JOIN account_security s ON s.user_id = u.id LEFT JOIN instance_memberships m ON m.user_id = u.id LEFT JOIN auth_users a ON a.id = u.id
      WHERE u.id > ? AND (COALESCE((SELECT username FROM local_accounts WHERE user_id=u.id),u.email) LIKE ? OR u.display_name LIKE ?) AND ((? = 'current' AND s.status <> 'deleted') OR s.status = ?) ORDER BY u.id LIMIT ?`,
    )
      .bind(
        p.cursor,
        `%${p.query}%`,
        `%${p.query}%`,
        status,
        status,
        p.size + 1,
      )
      .all();
    return Response.json({
      people: rows.results.slice(0, p.size),
      next: rows.results.length > p.size ? rows.results[p.size - 1].id : null,
    });
  }
  if (
    url.pathname === "/api/v1/admin/people/bulk" &&
    request.method === "POST"
  ) {
    const body = await json(request);
    const reason = text(body.reason, "Administrative reason", 160);
    if (
      !Array.isArray(body.ids) ||
      !body.ids.length ||
      body.ids.length > 25 ||
      body.ids.some((id) => typeof id !== "string" || id.length > 100) ||
      !["approve", "suspend", "secure"].includes(String(body.action))
    )
      throw new HttpError(
        400,
        "Select 1–25 people and a supported action.",
        "INVALID_INPUT",
      );
    const results = [];
    for (const id of [...new Set(body.ids)] as string[]) {
      try {
        const response = await adminRoutes(
          new Request(
            `${canonicalOrigin(env)}/api/v1/admin/people/${encodeURIComponent(id)}/${body.action}`,
            {
              method: "POST",
              headers: request.headers,
              body: JSON.stringify({ reason }),
            },
          ),
          env,
        );
        results.push({ id, ok: Boolean(response?.ok) });
      } catch (error) {
        results.push({
          id,
          ok: false,
          error:
            error instanceof HttpError
              ? error.message
              : "Action could not be completed.",
        });
      }
    }
    return Response.json({ results });
  }
  const inventoryMatch = url.pathname.match(
    /^\/api\/v1\/admin\/people\/([^/]+)\/content$/u,
  );
  if (inventoryMatch && request.method === "POST") {
    const id = decodeURIComponent(inventoryMatch[1]);
    const body = await json(request);
    const reason = text(body.reason, "Recovery reason", 160);
    const resources = await env.CATALOG.prepare(
      `SELECT * FROM (SELECT g.resource_type AS type, g.resource_id AS id, COALESCE(b.title, w.title) AS title FROM resource_grants g LEFT JOIN boards b ON g.resource_type = 'board' AND b.id = g.resource_id AND b.deleted_at IS NULL LEFT JOIN workbooks w ON g.resource_type = 'workbook' AND w.id = g.resource_id AND w.deleted_at IS NULL WHERE g.user_id = ? AND g.role = 'owner' AND (b.id IS NOT NULL OR w.id IS NOT NULL) UNION ALL SELECT 'folder', id, title FROM folders WHERE owner_id = ? AND deleted_at IS NULL) WHERE type || ':' || id > ? ORDER BY type,id LIMIT 201`,
    )
      .bind(
        id,
        id,
        typeof body.after === "string" ? body.after.slice(0, 220) : "",
      )
      .all();
    await audit(
      env.CATALOG,
      principal.id,
      "admin.content_inventory_read",
      id,
      "success",
      { reason, count: resources.results.length },
    );
    return Response.json({
      resources: resources.results.slice(0, 200),
      next:
        resources.results.length > 200
          ? `${resources.results[199].type}:${resources.results[199].id}`
          : null,
    });
  }
  const userMatch = url.pathname.match(
    /^\/api\/v1\/admin\/people\/([^/]+)\/(approve|suspend|restore|role|secure|delete|transfer-content)$/u,
  );
  if (userMatch && request.method === "POST") {
    const targetId = decodeURIComponent(userMatch[1]);
    const action = userMatch[2];
    const body = await json(request);
    const target = await securityState(env.CATALOG, targetId);
    if (!target || target.status === "deleted")
      throw new HttpError(404, "Account not found.", "NOT_FOUND");
    if (
      target.role === "owner" ||
      targetId === principal.id ||
      (me.role === "admin" && target.role === "admin")
    )
      throw new HttpError(
        403,
        "This account requires an owner action through the ownership or recovery flow.",
        "PROTECTED_ACCOUNT",
      );
    if (action === "approve") {
      const verified = await env.CATALOG.prepare(
        "SELECT id FROM auth_users WHERE id = ? AND (emailVerified = 1 OR EXISTS(SELECT 1 FROM local_accounts WHERE user_id=auth_users.id))",
      )
        .bind(targetId)
        .first();
      if (!verified)
        throw new HttpError(
          409,
          "The account must verify its email first.",
          "VERIFICATION_REQUIRED",
        );
      await admit(env, targetId, "member");
    } else if (action === "role") {
      if (
        !["member", "guest", "admin"].includes(String(body.role)) ||
        (body.role === "admin" && me.role !== "owner")
      )
        throw new HttpError(
          403,
          "Only the owner can appoint an administrator.",
          "OWNER_REQUIRED",
        );
      if (
        !(await env.CATALOG.prepare(
          "UPDATE instance_memberships SET role = ? WHERE user_id = ? AND role <> ? RETURNING user_id",
        )
          .bind(body.role, targetId, "owner")
          .first())
      )
        throw new HttpError(
          409,
          "Admit this account before changing its role.",
          "ADMISSION_REQUIRED",
        );
      await revokeIdentity(
        env,
        targetId,
        principal.id,
        "admin.role_changed",
        false,
      );
    } else if (action === "suspend") {
      text(body.reason, "Suspension reason", 160);
      await env.CATALOG.batch([
        env.CATALOG.prepare(
          "UPDATE account_security SET status = 'suspended', auth_version = auth_version + 1, updated_at = ? WHERE user_id = ? AND user_id <> (SELECT owner_id FROM installation WHERE id = 'instance')",
        ).bind(new Date().toISOString(), targetId),
        env.CATALOG.prepare("DELETE FROM auth_sessions WHERE userId = ?").bind(
          targetId,
        ),
        env.CATALOG.prepare(
          "UPDATE oauth_tokens SET revoked_at = ? WHERE user_id = ?",
        ).bind(new Date().toISOString(), targetId),
        env.CATALOG.prepare(
          "UPDATE oauth_grants SET revoked_at = ? WHERE user_id = ?",
        ).bind(new Date().toISOString(), targetId),
        invalidationStatement(env, targetId),
      ]);
    } else if (action === "restore") {
      await env.CATALOG.prepare(
        "UPDATE account_security SET status = 'active', auth_version = auth_version + 1 WHERE user_id = ? AND status = 'suspended' AND EXISTS(SELECT 1 FROM instance_memberships WHERE user_id = ?)",
      )
        .bind(targetId, targetId)
        .run();
    } else if (action === "secure")
      await revokeIdentity(
        env,
        targetId,
        principal.id,
        "admin.account_secured",
        true,
      );
    else if (action === "delete") {
      if (body.confirm !== targetId)
        throw new HttpError(
          400,
          "Confirm the selected account ID.",
          "CONFIRMATION_REQUIRED",
        );
      await tombstoneAccount(env, principal.id, targetId);
    } else if (action === "transfer-content")
      return Response.json(
        await transferContent(env, principal.id, targetId, body),
      );
    await audit(
      env.CATALOG,
      principal.id,
      `admin.${action}`,
      targetId,
      "success",
      {
        role: String(body.role ?? target.role),
        reason: typeof body.reason === "string" ? body.reason : null,
      },
    );
    return Response.json({ updated: true });
  }
  if (url.pathname === "/api/v1/admin/invitations") {
    if (request.method === "GET") {
      const rows = await env.CATALOG.prepare(
        "SELECT id, email, role, invited_by, created_at, expires_at, accepted_by, accepted_at, revoked_at FROM instance_invitations WHERE id > ? AND email LIKE ? ORDER BY id LIMIT ?",
      )
        .bind(p.cursor, `%${p.query}%`, p.size + 1)
        .all();
      return Response.json({
        invitations: rows.results.slice(0, p.size),
        next: rows.results.length > p.size ? rows.results[p.size - 1].id : null,
      });
    }
    if (request.method === "POST") {
      await limit(env, "invitation", principal.id, 30, 3600);
      const body = await json(request);
      const address = email(body.email);
      const role = body.role as InstanceRole;
      if (
        !["member", "guest", "admin"].includes(role) ||
        (role === "admin" && me.role !== "owner")
      )
        throw new HttpError(
          403,
          "Choose a role you can grant.",
          "INVALID_ROLE",
        );
      const token = randomToken();
      const id = `instance-invitation:${crypto.randomUUID()}`;
      const at = new Date().toISOString();
      const expires = new Date(Date.now() + 7 * 86_400_000).toISOString();
      await env.CATALOG.batch([
        env.CATALOG.prepare(
          "UPDATE instance_invitations SET revoked_at = ? WHERE email = ? AND accepted_by IS NULL AND revoked_at IS NULL",
        ).bind(at, address),
        env.CATALOG.prepare(
          "INSERT INTO instance_invitations (id, token_hash, email, role, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).bind(
          id,
          await sha256(token),
          address,
          role,
          principal.id,
          at,
          expires,
        ),
        auditStatement(
          env.CATALOG,
          principal.id,
          "invitation.created",
          id,
          "success",
          { role },
        ),
      ]);
      const link = `${canonicalOrigin(env)}/invite#membership=${token}`;
      let delivery: string | null = null;
      if (body.sendEmail === true)
        delivery = await queueMail(
          env,
          address,
          "You are invited to Huddle Loom",
          "Accept your invitation using the address it was sent to.",
          link,
          Date.parse(expires),
        );
      return Response.json(
        { id, link, expiresAt: expires, delivery },
        { status: 201 },
      );
    }
  }
  const inviteMatch = url.pathname.match(
    /^\/api\/v1\/admin\/invitations\/([^/]+)\/(revoke|resend)$/u,
  );
  if (inviteMatch && request.method === "POST") {
    const id = decodeURIComponent(inviteMatch[1]);
    const invite = await env.CATALOG.prepare(
      "SELECT email, role FROM instance_invitations WHERE id = ? AND accepted_by IS NULL AND revoked_at IS NULL",
    )
      .bind(id)
      .first<{ email: string; role: string }>();
    if (!invite || (invite.role === "admin" && me.role !== "owner"))
      throw new HttpError(404, "Pending invitation not found.", "NOT_FOUND");
    if (inviteMatch[2] === "revoke") {
      await env.CATALOG.prepare(
        "UPDATE instance_invitations SET revoked_at = ? WHERE id = ? AND accepted_by IS NULL",
      )
        .bind(new Date().toISOString(), id)
        .run();
      return Response.json({ revoked: true });
    }
    await limit(env, "invitation-resend", id, 3, 3600);
    const token = randomToken();
    const expires = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const changed = await env.CATALOG.prepare(
      "UPDATE instance_invitations SET token_hash = ?, expires_at = ? WHERE id = ? AND accepted_by IS NULL AND revoked_at IS NULL RETURNING id",
    )
      .bind(await sha256(token), expires, id)
      .first();
    if (!changed)
      throw new HttpError(
        409,
        "The invitation has changed.",
        "INVITATION_CONFLICT",
      );
    const link = `${canonicalOrigin(env)}/invite#membership=${token}`;
    const body = await json(request);
    if (body.sendEmail === true)
      await queueMail(
        env,
        invite.email,
        "Your Huddle Loom invitation",
        "Use this updated invitation. Previous links no longer work.",
        link,
        Date.parse(expires),
      );
    return Response.json({ link, expiresAt: expires });
  }
  if (url.pathname === "/api/v1/admin/settings") {
    await requireAdministrator(env, principal, true, request.method !== "GET");
    if (request.method === "GET")
      return Response.json({
        settings: settingsDto(await installation(env)),
        mailReady: mailReady(env),
        providers: await providerInventory(env),
      });
    if (request.method === "PATCH") {
      const body = await json(request);
      const current = await installation(env);
      const allowed = [
        "title",
        "registration",
        "approval_required",
        "mfa_required",
        "magic_link",
        "member_limit",
        "guest_limit",
        "board_limit",
        "storage_limit",
        "user_board_limit",
        "user_storage_limit",
        "mail_limit",
        "session_idle_seconds",
        "session_absolute_seconds",
        "dynamic_registration",
      ];
      const entries = Object.entries(body).filter(([key]) =>
        allowed.includes(key),
      );
      if (
        !entries.length ||
        Object.keys(body).some((key) => !allowed.includes(key))
      )
        throw new HttpError(400, "Invalid settings fields.", "INVALID_INPUT");
      for (const [key, value] of entries) {
        if (key === "title") text(value, "Installation name", 80);
        else if (key === "registration") {
          if (!["closed", "invite", "public"].includes(String(value)))
            throw new HttpError(
              400,
              "Choose a registration policy.",
              "INVALID_INPUT",
            );
          if (value === "public" && !mailReady(env))
            throw new HttpError(
              409,
              "Configure email before enabling public registration.",
              "MAIL_REQUIRED",
            );
        } else if (
          [
            "approval_required",
            "mfa_required",
            "magic_link",
            "dynamic_registration",
          ].includes(key)
        ) {
          if (value !== 0 && value !== 1)
            throw new HttpError(
              400,
              "Use enabled or disabled.",
              "INVALID_INPUT",
            );
          if (key === "magic_link" && value === 1 && !mailReady(env))
            throw new HttpError(
              409,
              "Configure email before enabling magic links.",
              "MAIL_REQUIRED",
            );
        } else if (
          typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value < (key === "member_limit" ? 1 : 0) ||
          value >
            (key.includes("storage")
              ? 1_099_511_627_776
              : key.startsWith("session_")
                ? 7_776_000
                : 1_000_000)
        )
          throw new HttpError(
            400,
            "A limit is outside the supported range.",
            "INVALID_INPUT",
          );
      }
      const idle = Number(
        body.session_idle_seconds ?? current.session_idle_seconds,
      );
      const absolute = Number(
        body.session_absolute_seconds ?? current.session_absolute_seconds,
      );
      if (idle < 300 || idle > absolute || absolute > 7_776_000)
        throw new HttpError(
          400,
          "Session limits must be between five minutes and 90 days, with idle no longer than absolute.",
          "INVALID_INPUT",
        );
      const stronger = body.mfa_required === 1 && !current.mfa_required;
      await env.CATALOG.batch([
        env.CATALOG.prepare(
          `UPDATE installation SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, version = version + 1, consent_version = consent_version + ? WHERE id = 'instance'`,
        ).bind(...entries.map(([, value]) => value), stronger ? 1 : 0),
        auditStatement(
          env.CATALOG,
          principal.id,
          "installation.settings_changed",
          "instance",
          "success",
          { policy: String(body.registration ?? current.registration) },
        ),
      ]);
      return Response.json({ saved: true });
    }
  }
  if (url.pathname === "/api/v1/admin/providers" && request.method === "GET") {
    await requireAdministrator(env, principal, true);
    return Response.json(await providerInventory(env));
  }
  const providerMatch = url.pathname.match(
    /^\/api\/v1\/admin\/providers\/([^/]+)$/u,
  );
  if (providerMatch && request.method === "PUT") {
    await requireAdministrator(env, principal, true, true);
    return Response.json(
      await saveProvider(
        env,
        principal.id,
        decodeURIComponent(providerMatch[1]),
        await json(request),
      ),
    );
  }
  if (url.pathname === "/api/v1/admin/usage" && request.method === "GET")
    return Response.json({
      usage: await usage(env),
      limits: settingsDto(await installation(env)),
    });
  if (url.pathname === "/api/v1/admin/activity" && request.method === "GET") {
    const rows = await env.CATALOG.prepare(
      "SELECT id, actor_id, action, target_id, outcome, metadata, created_at FROM security_audit WHERE (? = '' OR (created_at, id) < (SELECT created_at, id FROM security_audit WHERE id = ?)) AND action LIKE ? ORDER BY created_at DESC, id DESC LIMIT ?",
    )
      .bind(
        p.cursor,
        p.cursor,
        `%${p.query}%`,
        url.searchParams.get("export") === "true" ? 1000 : p.size + 1,
      )
      .all();
    if (url.searchParams.get("export") === "true") {
      requireFresh(principal);
      return Response.json(
        { events: rows.results },
        {
          headers: {
            "Content-Disposition":
              'attachment; filename="canvas-security-audit.json"',
          },
        },
      );
    }
    return Response.json({
      events: rows.results.slice(0, p.size),
      next: rows.results.length > p.size ? rows.results[p.size - 1].id : null,
    });
  }
  if (url.pathname === "/api/v1/admin/system" && request.method === "GET") {
    const [jobs, migrations, rehearsals, receipts] = await env.CATALOG.batch([
      env.CATALOG.prepare(
        "SELECT id, kind, status, attempts, next_attempt_at, last_error, created_at FROM security_outbox WHERE status IN ('failed','pending','processing') ORDER BY created_at DESC LIMIT 50",
      ),
      env.CATALOG.prepare(
        "SELECT name, applied_at FROM d1_migrations ORDER BY id",
      ),
      env.CATALOG.prepare(
        "SELECT kind, completed_at, evidence FROM operator_rehearsals",
      ),
      env.CATALOG.prepare(
        "SELECT o.id, o.created_at, o.status AS queue_status, r.status AS delivery_status, r.event_at FROM security_outbox o LEFT JOIN mail_delivery_receipts r ON r.provider_id = o.provider_id WHERE o.kind = 'mail' ORDER BY o.created_at DESC LIMIT 50",
      ),
    ]);
    return Response.json({
      origin: canonicalOrigin(env),
      version: "0.1.0",
      authentication: "native",
      accessIntegration: env.ACCESS_INTEGRATION ?? "off",
      emailReady: mailReady(env),
      jobs: jobs.results,
      migrations: migrations.results,
      rehearsals: rehearsals.results,
      receipts: receipts.results,
      recoveryGuide: "/docs/security-operations.html",
    });
  }
  if (url.pathname === "/api/v1/admin/mail/test" && request.method === "POST") {
    if (!user.emailVerified)
      throw new HttpError(
        409,
        "Add and verify your email address first, or use the email connection test with a chosen inbox.",
        "VERIFICATION_REQUIRED",
      );
    await queueMail(
      env,
      principal.email,
      "Huddle Loom delivery test",
      "Your installation can queue transactional email. Provider acceptance does not guarantee inbox delivery.",
    );
    await processOutbox(env, 1);
    return Response.json({ queued: true });
  }
  if (
    url.pathname === "/api/v1/admin/jobs/retry" &&
    request.method === "POST"
  ) {
    const body = await json(request);
    const id = text(body.id, "Job ID", 100);
    const changed = await env.CATALOG.prepare(
      "UPDATE security_outbox SET status = 'pending', attempts = 0, next_attempt_at = ? WHERE id = ? AND status = 'failed' AND expires_at > ?",
    )
      .bind(Date.now(), id, Date.now())
      .run();
    if (!changed.meta.changes)
      throw new HttpError(
        409,
        "This job has expired or no longer needs a retry.",
        "JOB_UNAVAILABLE",
      );
    await audit(env.CATALOG, principal.id, "operations.job_retried", id);
    return Response.json({ queued: true });
  }
  if (
    url.pathname === "/api/v1/admin/owner-transfer" &&
    request.method === "GET"
  ) {
    await requireAdministrator(env, principal, true);
    const transfers = await env.CATALOG.prepare(
      "SELECT t.id, t.target_id AS targetId, u.display_name AS targetName, t.expires_at AS expiresAt FROM owner_transfers t JOIN users u ON u.id = t.target_id JOIN installation i ON i.owner_id = t.source_id AND i.version = t.version WHERE t.source_id = ? AND t.accepted_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > ? ORDER BY t.expires_at DESC LIMIT 20",
    )
      .bind(principal.id, Date.now())
      .all();
    return Response.json({ transfers: transfers.results });
  }
  if (
    url.pathname === "/api/v1/admin/owner-transfer/cancel" &&
    request.method === "POST"
  ) {
    await requireAdministrator(env, principal, true, true);
    const body = await json(request);
    const id = text(body.id, "Transfer ID", 100);
    const changed = await env.CATALOG.prepare(
      "UPDATE owner_transfers SET revoked_at = ? WHERE id = ? AND source_id = ? AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id",
    )
      .bind(Date.now(), id, principal.id)
      .first();
    if (!changed)
      throw new HttpError(
        409,
        "This transfer has already ended.",
        "TRANSFER_EXPIRED",
      );
    await audit(
      env.CATALOG,
      principal.id,
      "installation.owner_transfer_cancelled",
      id,
    );
    return Response.json({ cancelled: true });
  }
  if (
    url.pathname === "/api/v1/admin/owner-transfer" &&
    request.method === "POST"
  ) {
    await requireAdministrator(env, principal, true, true);
    const body = await json(request);
    const targetId = text(body.targetId, "New owner", 100);
    const target = await env.CATALOG.prepare(
      "SELECT u.id, u.email, u.emailVerified FROM auth_users u JOIN account_security s ON s.user_id = u.id JOIN instance_memberships m ON m.user_id = u.id WHERE u.id = ? AND (u.emailVerified = 1 OR EXISTS(SELECT 1 FROM local_accounts WHERE user_id=u.id)) AND s.status = 'active' AND s.recovery_required = 0 AND m.role IN ('member','admin') AND (u.twoFactorEnabled = 1 OR EXISTS(SELECT 1 FROM auth_passkeys WHERE userId = u.id))",
    )
      .bind(targetId)
      .first<{ id: string; email: string; emailVerified: number }>();
    if (!target)
      throw new HttpError(
        409,
        "Choose a verified active member with MFA enrolled.",
        "OWNER_RECIPIENT_REQUIRED",
      );
    const settings = await installation(env);
    const token = randomToken();
    const id = randomToken(18);
    await env.CATALOG.batch([
      env.CATALOG.prepare(
        "UPDATE owner_transfers SET revoked_at = ? WHERE source_id = ? AND accepted_at IS NULL AND revoked_at IS NULL",
      ).bind(Date.now(), principal.id),
      env.CATALOG.prepare(
        "INSERT INTO owner_transfers (id, source_id, target_id, token_hash, expires_at, version) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(
        id,
        principal.id,
        targetId,
        await sha256(token),
        Date.now() + 1800_000,
        settings.version,
      ),
    ]);
    const link = `${canonicalOrigin(env)}/account/owner-transfer#token=${token}`;
    if (mailReady(env) && target.emailVerified)
      await queueMail(
        env,
        target.email,
        "Huddle Loom ownership transfer",
        "The current owner has asked you to accept responsibility for this installation.",
        link,
        Date.now() + 1800_000,
      );
    await audit(
      env.CATALOG,
      principal.id,
      "installation.owner_transfer_requested",
      targetId,
    );
    return Response.json({ id, link, expiresIn: 1800 });
  }
  throw new HttpError(404, "Administration action not found.", "NOT_FOUND");
}

export async function acceptOwnerTransfer(request: Request, env: NativeEnv) {
  const { principal, user, identityVerified } = await nativePrincipal(
    request,
    env,
  );
  requireFresh(principal, true);
  if (!identityVerified)
    throw new HttpError(
      403,
      "Verify your email first.",
      "VERIFICATION_REQUIRED",
    );
  const body = await json(request);
  const token = text(body.token, "Transfer token", 100);
  const acceptance = randomToken(18);
  const transfer = await env.CATALOG.prepare(
    "SELECT * FROM owner_transfers WHERE token_hash = ? AND target_id = ? AND expires_at > ? AND accepted_at IS NULL AND revoked_at IS NULL",
  )
    .bind(await sha256(token), principal.id, Date.now())
    .first<{
      id: string;
      source_id: string;
      target_id: string;
      version: number;
    }>();
  if (!transfer)
    throw new HttpError(
      409,
      "This ownership transfer is no longer available.",
      "TRANSFER_EXPIRED",
    );
  const result = await env.CATALOG.batch([
    env.CATALOG.prepare(
      "UPDATE installation SET owner_id = ?, ownership_commit = ?, version = version + 1 WHERE id = 'instance' AND owner_id = ? AND version = ? AND EXISTS(SELECT 1 FROM owner_transfers WHERE id = ? AND target_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?) AND EXISTS(SELECT 1 FROM auth_users u JOIN account_security s ON s.user_id = u.id JOIN instance_memberships m ON m.user_id = u.id WHERE u.id = ? AND (u.emailVerified = 1 OR EXISTS(SELECT 1 FROM local_accounts WHERE user_id=u.id)) AND s.status = 'active' AND s.recovery_required = 0 AND m.role IN ('member','admin') AND (u.twoFactorEnabled = 1 OR EXISTS(SELECT 1 FROM auth_passkeys WHERE userId = u.id)))",
    ).bind(
      transfer.target_id,
      acceptance,
      transfer.source_id,
      transfer.version,
      transfer.id,
      principal.id,
      Date.now(),
      principal.id,
    ),
    env.CATALOG.prepare(
      "UPDATE instance_memberships SET role = 'admin' WHERE user_id = ? AND EXISTS(SELECT 1 FROM installation WHERE ownership_commit = ?)",
    ).bind(transfer.source_id, acceptance),
    env.CATALOG.prepare(
      "UPDATE instance_memberships SET role = 'owner' WHERE user_id = ? AND EXISTS(SELECT 1 FROM installation WHERE ownership_commit = ?)",
    ).bind(transfer.target_id, acceptance),
    env.CATALOG.prepare(
      "UPDATE owner_transfers SET accepted_at = ?, acceptance_id = ? WHERE id = ? AND EXISTS(SELECT 1 FROM installation WHERE ownership_commit = ?)",
    ).bind(Date.now(), acceptance, transfer.id, acceptance),
    ...[transfer.source_id, transfer.target_id].flatMap((userId) => [
      env.CATALOG.prepare(
        "DELETE FROM auth_sessions WHERE userId = ? AND EXISTS(SELECT 1 FROM installation WHERE ownership_commit = ?)",
      ).bind(userId, acceptance),
      env.CATALOG.prepare(
        "UPDATE account_security SET auth_version = auth_version + 1, updated_at = ? WHERE user_id = ? AND EXISTS(SELECT 1 FROM installation WHERE ownership_commit = ?)",
      ).bind(new Date().toISOString(), userId, acceptance),
      env.CATALOG.prepare(
        "INSERT INTO security_outbox (id,kind,payload,expires_at,next_attempt_at,attempts,status,created_at) SELECT ?,'invalidate',?,?,?,0,'pending',? WHERE EXISTS(SELECT 1 FROM installation WHERE ownership_commit = ?)",
      ).bind(
        randomToken(18),
        JSON.stringify({ userId }),
        Date.now() + 86_400_000,
        Date.now(),
        Date.now(),
        acceptance,
      ),
      env.CATALOG.prepare(
        "INSERT INTO security_audit (id,actor_id,action,target_id,outcome,metadata,created_at) SELECT ?,?,?,?,'success','{}',? WHERE EXISTS(SELECT 1 FROM installation WHERE ownership_commit = ?)",
      ).bind(
        randomToken(18),
        principal.id,
        userId === transfer.source_id
          ? "installation.owner_transferred"
          : "installation.owner_received",
        userId,
        new Date().toISOString(),
        acceptance,
      ),
    ]),
  ]);
  if (!result[0].meta.changes)
    throw new HttpError(
      409,
      "Ownership changed while you were accepting. Ask the owner to start again.",
      "TRANSFER_CONFLICT",
    );
  return Response.json({ accepted: true, signInAgain: true });
}
