import type { NativeEnv } from "./types";
import { nativePrincipal } from "./session";
import { installation, needsStrong } from "./policy";
import { starterStatements } from "./content";
import {
  acceptInvitation,
  acceptInvitationById,
} from "../collaboration.server";
import { HttpError } from "../security/errors";
import { json, randomToken, sha256 } from "../security/primitives";
import { auditStatement } from "../security/audit";

export async function invitationRoutes(request: Request, env: NativeEnv) {
  const url = new URL(request.url);
  const byId = url.pathname.match(/^\/api\/v1\/invitations\/([^/]+)\/accept$/u);
  if (
    request.method !== "POST" ||
    (!byId &&
      !["/api/v1/invitations/accept", "/api/v1/membership/accept"].includes(
        url.pathname,
      ))
  )
    return null;
  const identity = await nativePrincipal(request, env, true);
  if (
    !identity.user.emailVerified &&
    (url.pathname === "/api/v1/membership/accept" || !identity.localUsername)
  )
    throw new HttpError(
      403,
      "Verify the address this invitation was sent to.",
      "VERIFICATION_REQUIRED",
    );
  const settings = await installation(env);
  if (settings.state !== "ready" || identity.state.recovery_required)
    throw new HttpError(403, "Finish account setup first.", "SETUP_REQUIRED");
  if (
    needsStrong(settings, identity.state, identity.user.twoFactorEnabled) &&
    identity.policy.assurance !== "strong"
  )
    throw new HttpError(
      403,
      "Confirm your second factor first.",
      "MFA_REQUIRED",
    );
  const body = await json(request);
  if (url.pathname === "/api/v1/membership/accept") {
    if (typeof body.token !== "string" || body.token.length > 256)
      throw new HttpError(400, "Invalid invitation.", "INVALID_INVITATION");
    const invite = await env.CATALOG.prepare(
      "SELECT * FROM instance_invitations WHERE token_hash = ?",
    )
      .bind(await sha256(body.token))
      .first<{
        id: string;
        email: string;
        role: string;
        invited_by: string;
        accepted_by: string | null;
        revoked_at: string | null;
        expires_at: string;
      }>();
    if (
      !invite ||
      invite.revoked_at ||
      invite.expires_at <= new Date().toISOString()
    )
      throw new HttpError(
        410,
        "The invitation has expired or was revoked. Ask for a new link.",
        "INVALID_INVITATION",
      );
    if (invite.email.toLowerCase() !== identity.user.email.toLowerCase())
      throw new HttpError(
        403,
        "Sign in with the address this invitation was sent to.",
        "INVITATION_IDENTITY_MISMATCH",
      );
    if (invite.accepted_by) {
      if (
        invite.accepted_by === identity.user.id &&
        identity.state.status === "active" &&
        identity.state.role
      )
        return Response.json({ accepted: true, role: identity.state.role });
      throw new HttpError(
        409,
        "This invitation cannot restore removed access. Ask for a new invitation.",
        "INVITATION_ACCEPTED",
      );
    }
    const at = new Date().toISOString();
    const marker = randomToken(18);
    const results = await env.CATALOG.batch([
      env.CATALOG.prepare(
        `UPDATE instance_invitations SET accepted_by = ?, accepted_at = ?, acceptance_id = ? WHERE id = ? AND accepted_by IS NULL AND revoked_at IS NULL AND expires_at > ?
        AND EXISTS(SELECT 1 FROM instance_memberships m JOIN account_security s ON s.user_id = m.user_id WHERE m.user_id = invited_by AND s.status = 'active' AND (m.role = 'owner' OR (m.role = 'admin' AND instance_invitations.role <> 'admin')))
        AND EXISTS(SELECT 1 FROM account_security WHERE user_id = ? AND status IN ('pending_verification','pending_approval','active'))
        AND (EXISTS(SELECT 1 FROM instance_memberships WHERE user_id = ?) OR (SELECT COUNT(*) FROM instance_memberships WHERE (role = 'guest') = (? = 'guest')) < (SELECT CASE WHEN ? = 'guest' THEN guest_limit ELSE member_limit END FROM installation))`,
      ).bind(
        identity.user.id,
        at,
        marker,
        invite.id,
        at,
        identity.user.id,
        identity.user.id,
        invite.role,
        invite.role,
      ),
      env.CATALOG.prepare(
        "INSERT OR IGNORE INTO instance_memberships (user_id, role, created_at) SELECT ?, ?, ? WHERE EXISTS(SELECT 1 FROM instance_invitations WHERE id = ? AND acceptance_id = ?) ON CONFLICT(user_id) DO UPDATE SET role = CASE WHEN instance_memberships.role IN ('owner','admin') THEN instance_memberships.role WHEN excluded.role = 'admin' THEN 'admin' WHEN instance_memberships.role = 'member' OR excluded.role = 'member' THEN 'member' ELSE 'guest' END",
      ).bind(identity.user.id, invite.role, at, invite.id, marker),
      env.CATALOG.prepare(
        "UPDATE account_security SET status = 'active', admitted_at = COALESCE(admitted_at, ?), updated_at = ? WHERE user_id = ? AND EXISTS(SELECT 1 FROM instance_invitations WHERE id = ? AND acceptance_id = ?)",
      ).bind(at, at, identity.user.id, invite.id, marker),
      ...starterStatements(env.CATALOG, identity.user.id),
      auditStatement(
        env.CATALOG,
        identity.user.id,
        "invitation.membership_accepted",
        invite.id,
        "attempted",
        { role: invite.role },
      ),
    ]);
    if (!results[0].meta.changes)
      throw new HttpError(
        409,
        "The invitation, inviter, or account limit changed. Ask an administrator to review it.",
        "INVITATION_CONFLICT",
      );
    return Response.json({ accepted: true, role: invite.role });
  }
  return Response.json(
    byId
      ? await acceptInvitationById(
          env.CATALOG,
          identity.principal,
          decodeURIComponent(byId[1]),
        )
      : await acceptInvitation(env.CATALOG, identity.principal, body.token),
  );
}
