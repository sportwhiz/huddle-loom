import { HttpError } from "../security/errors";
import type { Installation, SecurityState } from "./types";

export function requiresStrongAuthentication(
  settings: Pick<Installation, "mfa_required">,
  account: Pick<SecurityState, "role">,
  twoFactorEnabled: boolean,
) {
  return (
    account.role === "owner" ||
    account.role === "admin" ||
    Boolean(settings.mfa_required) ||
    twoFactorEnabled
  );
}

export type SessionPolicy = {
  absoluteExpiresAt: number;
  expiresAt: number;
  authenticatedAt: number;
  authVersion: number;
  assurance: string;
};
export function sessionIsCurrent(
  account: Pick<SecurityState, "status" | "auth_version">,
  session: SessionPolicy,
  now: number,
) {
  return (
    [
      session.absoluteExpiresAt,
      session.expiresAt,
      session.authenticatedAt,
    ].every(Number.isFinite) &&
    session.absoluteExpiresAt > now &&
    session.expiresAt > now &&
    account.auth_version === session.authVersion &&
    !["suspended", "deleted", "deletion_pending"].includes(account.status)
  );
}

export function requireAdmission(
  settings: Pick<Installation, "state" | "mfa_required">,
  account: Pick<SecurityState, "status" | "role" | "recovery_required">,
  verified: boolean,
  twoFactorEnabled: boolean,
  assurance: string,
) {
  if (settings.state !== "ready")
    throw new HttpError(
      403,
      "Complete installation setup before opening boards.",
      "SETUP_REQUIRED",
    );
  if (!verified)
    throw new HttpError(
      403,
      "Verify your email address to continue.",
      "VERIFICATION_REQUIRED",
    );
  if (account.status !== "active" || !account.role)
    throw new HttpError(
      403,
      account.status === "pending_approval"
        ? "An administrator needs to approve your account."
        : "Accept your invitation to continue.",
      "ADMISSION_REQUIRED",
    );
  if (account.recovery_required || assurance === "recovery")
    throw new HttpError(
      403,
      "Replace your recovery factor before continuing.",
      "RECOVERY_REQUIRED",
    );
  if (
    requiresStrongAuthentication(settings, account, twoFactorEnabled) &&
    assurance !== "strong"
  )
    throw new HttpError(
      403,
      "Confirm your second factor to continue.",
      "MFA_REQUIRED",
    );
}
