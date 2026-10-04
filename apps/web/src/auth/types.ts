export type NativeEnv = {
  CATALOG: D1Database;
  /** Native hosting supplies a real provider adapter; Cloudflare continues using D1. */
  AUTH_DATABASE?: import("better-auth").BetterAuthOptions["database"];
  BLOBS?: R2Bucket;
  BOARD_ROOMS?: DurableObjectNamespace;
  HOSTING_PLATFORM?: "cloudflare" | "godaddy" | "node";
  AUTH_MODE?: "native" | "access" | "development";
  ENVIRONMENT?: string;
  AUTH_ORIGIN?: string;
  SETUP_PASSWORD?: string;
  SOFTWARE_UPDATE_HOOK?: string;
  SOFTWARE_UPDATE_RUNNER_ORIGIN?: string;
  INSTALLATION_KEYS?: DurableObjectNamespace;
  AUTH_SECRET?: string;
  AUTH_SECRETS?: string;
  AUTH_ENCRYPTION_KEYS?: string;
  AUTH_BOOTSTRAP_SECRET?: string;
  ACCESS_INTEGRATION?: "off" | "migration" | "provider";
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  INITIAL_OWNER_EMAIL?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  OIDC_CONFIG?: string;
  OIDC_ALLOWED_ORIGINS?: string;
  MAIL_FROM?: string;
  MAIL_FROM_SOURCE?: "installation";
  MAIL_PROVIDER?: "cloudflare" | "resend" | "test" | "godaddy";
  MAIL_API_KEY?: string;
  MAIL_WEBHOOK_SECRET?: string;
  MANAGED_MAIL?: {
    send(message: {
      to: string;
      subject: string;
      text: string;
      html: string;
    }): Promise<{ providerId: string }>;
  };
  EMAIL?: {
    send(message: {
      from: string;
      to: string;
      subject: string;
      text: string;
      html: string;
    }): Promise<unknown>;
  };
  CIMD_ALLOWED_ORIGINS?: string;
};
export type InstanceRole = "owner" | "admin" | "member" | "guest";
export type AccountStatus =
  | "pending_verification"
  | "pending_approval"
  | "active"
  | "suspended"
  | "deletion_pending"
  | "deleted";
export type Installation = {
  id: string;
  state: "unclaimed" | "configuring" | "ready";
  setup_user_id: string | null;
  owner_id: string | null;
  title: string;
  origin: string;
  version: number;
  registration: "closed" | "invite" | "public";
  approval_required: number;
  mfa_required: number;
  magic_link: number;
  member_limit: number;
  guest_limit: number;
  board_limit: number;
  storage_limit: number;
  user_board_limit: number;
  user_storage_limit: number;
  mail_limit: number;
  session_idle_seconds: number;
  session_absolute_seconds: number;
  created_at: string;
  cache_namespace: string;
  consent_version: number;
  dynamic_registration: number;
};
export type SecurityState = {
  user_id: string;
  status: AccountStatus;
  auth_version: number;
  role: InstanceRole | null;
  recovery_required: number;
  admitted_at: string | null;
  onboarding_version: number;
};
