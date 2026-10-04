import {
  capabilitiesForRole,
  type Principal,
  type Role,
} from "./collaboration-types";
import { HttpError } from "./security/errors";

// Guest links follow their creator's current board ownership and account state.
// A transfer, suspension, board deletion or link expiry disables access.
export const LIVE_GUEST_LINK = `l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > ?)
  AND b.deleted_at IS NULL AND EXISTS(SELECT 1 FROM installation WHERE id='instance' AND state='ready')
  AND EXISTS(SELECT 1 FROM account_security security WHERE security.user_id=l.created_by AND security.status='active' AND security.recovery_required=0)
  AND EXISTS(SELECT 1 FROM resource_grants grant_row WHERE grant_row.user_id=l.created_by AND grant_row.role='owner' AND ((grant_row.resource_type='board' AND grant_row.resource_id=b.id) OR (b.inheritance_disabled=0 AND grant_row.resource_type='workbook' AND grant_row.resource_id=b.workbook_id)) AND (grant_row.expires_at IS NULL OR grant_row.expires_at > ?))`;

export function guestCapabilities(role: Role) {
  return {
    ...capabilitiesForRole(role),
    share: false,
    manage: false,
    export: false,
  };
}

export async function guestBoardAccess(
  database: D1Database,
  principal: Principal,
  boardId: string,
) {
  if (
    principal.authentication !== "guest" ||
    principal.resources?.length !== 1 ||
    principal.resources[0].id !== boardId
  )
    throw new HttpError(404, "Board not found.", "BOARD_NOT_FOUND");
  const now = new Date().toISOString();
  const row = await database
    .prepare(
      `SELECT l.role, b.title FROM guest_board_sessions s
    JOIN guest_board_links l ON l.id=s.link_id JOIN boards b ON b.id=l.board_id
    WHERE s.id=? AND s.user_id=? AND l.id=? AND b.id=? AND s.expires_at > ? AND ${LIVE_GUEST_LINK}`,
    )
    .bind(
      principal.sessionId,
      principal.id,
      principal.grantId,
      boardId,
      now,
      now,
      now,
    )
    .first<{ role: Exclude<Role, "owner">; title: string }>();
  if (!row)
    throw new HttpError(
      401,
      "This guest link has expired or been turned off. Ask the board owner for a new link.",
      "GUEST_ACCESS_ENDED",
    );
  return {
    capabilities: guestCapabilities(row.role),
    metadata: {
      title: row.title,
      workbookTitle: "Guest board",
      canCopy: false,
    },
  };
}
