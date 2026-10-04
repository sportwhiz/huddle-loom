/** Native MySQL 8.4 catalog schema, reviewed against SQLite migrations 0001–0026.
 * Explicit static SQL: no runtime SQL text translation occurs in this module.
 * Every catalog operation MUST hold hl_catalog_mutex(id=1) in READ COMMITTED
 * until commit, including Better Auth writes, to preserve SQLite quota/guard semantics.
 * ISO date strings retain current D1 application contracts. Node auth normalizes Dates.
 */
import { createHash } from "node:crypto";
import type { Pool, PoolConnection } from "mysql2/promise";

export const CATALOG_TABLES = {
  access_identities: {
    columns: ["issuer", "subject", "user_id", "revoked_at"],
    primaryKey: ["issuer", "subject"],
    uniqueKeys: [["issuer", "subject"]],
  },
  account_security: {
    columns: [
      "user_id",
      "status",
      "auth_version",
      "recovery_required",
      "admitted_at",
      "deletion_requested_at",
      "created_at",
      "updated_at",
      "recovery_started_at",
      "onboarding_version",
      "onboarding_dismissed_at",
      "deletion_actor_id",
    ],
    primaryKey: ["user_id"],
    uniqueKeys: [["user_id"]],
  },
  active_connections: {
    columns: ["id", "user_id", "session_id", "board_id", "expires_at"],
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
  },
  asset_gc_locks: {
    columns: ["asset_key", "lease_key", "expires_at"],
    primaryKey: ["asset_key"],
    uniqueKeys: [["asset_key"]],
  },
  asset_references: {
    columns: [
      "board_id",
      "asset_key",
      "uploaded_by",
      "created_at",
      "byte_size",
    ],
    primaryKey: ["board_id", "asset_key"],
    uniqueKeys: [["board_id", "asset_key"]],
  },
  auth_accounts: {
    columns: [
      "id",
      "accountId",
      "providerId",
      "userId",
      "accessToken",
      "refreshToken",
      "idToken",
      "accessTokenExpiresAt",
      "refreshTokenExpiresAt",
      "scope",
      "password",
      "createdAt",
      "updatedAt",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["providerId", "accountId"], ["id"]],
  },
  auth_confirmation_uses: {
    columns: ["token_hash", "purpose", "consumed_at", "claim_id"],
    primaryKey: ["token_hash"],
    uniqueKeys: [["token_hash"]],
  },
  auth_email_proofs: {
    columns: [
      "user_id",
      "purpose",
      "token_hash",
      "auth_version",
      "new_email",
      "expires_at",
    ],
    primaryKey: ["user_id", "purpose"],
    uniqueKeys: [["user_id", "purpose"], ["token_hash"]],
  },
  auth_method_changes: {
    columns: [
      "id",
      "user_id",
      "excluded_account",
      "excluded_passkey",
      "excluded_provider",
      "deployed_providers",
      "password_enabled",
      "database_oidc_enabled",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
  },
  auth_passkeys: {
    columns: [
      "id",
      "name",
      "publicKey",
      "userId",
      "credentialID",
      "counter",
      "deviceType",
      "backedUp",
      "transports",
      "createdAt",
      "aaguid",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["credentialID"], ["id"]],
  },
  auth_provider_config: {
    columns: [
      "id",
      "public_config",
      "secret",
      "enabled",
      "tested_at",
      "updated_at",
      "callback_verified_at",
      "version",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
  },
  auth_return_intents: {
    columns: ["token_hash", "payload", "expires_at"],
    primaryKey: ["token_hash"],
    uniqueKeys: [["token_hash"]],
  },
  auth_sessions: {
    columns: [
      "id",
      "expiresAt",
      "token",
      "createdAt",
      "updatedAt",
      "ipAddress",
      "userAgent",
      "userId",
      "absoluteExpiresAt",
      "authenticatedAt",
      "assurance",
      "authVersion",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["token"], ["id"]],
  },
  auth_two_factors: {
    columns: [
      "id",
      "secret",
      "backupCodes",
      "userId",
      "verified",
      "failedVerificationCount",
      "lockedUntil",
      "enrolled_at",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["userId"], ["id"]],
  },
  auth_users: {
    columns: [
      "id",
      "name",
      "email",
      "emailVerified",
      "image",
      "createdAt",
      "updatedAt",
      "twoFactorEnabled",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["email"], ["id"]],
  },
  auth_verifications: {
    columns: [
      "id",
      "identifier",
      "value",
      "expiresAt",
      "createdAt",
      "updatedAt",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
  },
  boards: {
    columns: [
      "id",
      "workbook_id",
      "title",
      "favorite",
      "created_at",
      "updated_at",
      "last_opened_at",
      "deleted_at",
      "inheritance_disabled",
      "created_by",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
  },
  comment_subscriptions: {
    columns: ["thread_id", "board_id", "user_id", "muted", "updated_at"],
    primaryKey: ["thread_id", "user_id"],
    uniqueKeys: [["thread_id", "user_id"]],
  },
  content_transfer_operations: {
    columns: ["id", "source_id", "target_id", "resources"],
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
  },
  daily_usage: {
    columns: ["day", "kind", "count"],
    primaryKey: ["day", "kind"],
    uniqueKeys: [["day", "kind"]],
  },
  emergency_recovery: {
    columns: [
      "token_hash",
      "user_id",
      "expires_at",
      "used_at",
      "reason",
      "consumption_id",
    ],
    primaryKey: ["token_hash"],
    uniqueKeys: [["token_hash"]],
  },
  folders: {
    columns: [
      "id",
      "parent_id",
      "title",
      "sort_order",
      "created_at",
      "deleted_at",
      "owner_id",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
  },
  installation: {
    columns: [
      "id",
      "state",
      "setup_user_id",
      "owner_id",
      "title",
      "origin",
      "version",
      "consent_version",
      "setup_commit",
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
      "created_at",
      "ownership_commit",
      "dynamic_registration",
      "cache_namespace",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
  },
  installation_key_identity: {
    columns: ["id", "fingerprint"],
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
  },
  installation_mail: {
    columns: ["id", "sender", "recipient", "confirmed_at"],
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
  },
  installation_mail_tests: {
    columns: [
      "id",
      "actor_id",
      "sender",
      "recipient",
      "code_hash",
      "expires_at",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
  },
  instance_invitations: {
    columns: [
      "id",
      "token_hash",
      "email",
      "role",
      "invited_by",
      "created_at",
      "expires_at",
      "accepted_by",
      "accepted_at",
      "revoked_at",
      "acceptance_id",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["token_hash"], ["id"]],
  },
  instance_memberships: {
    columns: ["user_id", "role", "created_at"],
    primaryKey: ["user_id"],
    uniqueKeys: [["user_id"]],
  },
  invitations: {
    columns: [
      "id",
      "token_hash",
      "resource_type",
      "resource_id",
      "email",
      "role",
      "invited_by",
      "created_at",
      "expires_at",
      "accepted_at",
      "accepted_by",
      "revoked_at",
      "acceptance_id",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["token_hash"], ["id"]],
  },
  local_accounts: {
    columns: ["user_id", "username", "recovery_hash", "recovery_claim"],
    primaryKey: ["user_id"],
    uniqueKeys: [["username"], ["user_id"]],
  },
  local_invitations: {
    columns: [
      "id",
      "token_hash",
      "label",
      "role",
      "created_by",
      "created_at",
      "expires_at",
      "accepted_by",
      "revoked_at",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["token_hash"], ["id"]],
  },
  mail_delivery_receipts: {
    columns: ["provider_id", "status", "event_at", "received_at"],
    primaryKey: ["provider_id"],
    uniqueKeys: [["provider_id"]],
  },
  mail_suppressions: {
    columns: ["email", "reason", "created_at"],
    primaryKey: ["email"],
    uniqueKeys: [["email"]],
  },
  mail_webhook_events: {
    columns: ["id", "received_at"],
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
  },
  maintenance_cursors: {
    columns: ["name", "cursor", "updated_at"],
    primaryKey: ["name"],
    uniqueKeys: [["name"]],
  },
  mfa_replay: {
    columns: ["user_id", "code_hash", "expires_at"],
    primaryKey: ["user_id", "code_hash"],
    uniqueKeys: [["user_id", "code_hash"]],
  },
  notifications: {
    columns: [
      "id",
      "user_id",
      "board_id",
      "kind",
      "title",
      "body",
      "href",
      "event_key",
      "created_at",
      "read_at",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["event_key"], ["id"]],
  },
  oauth_authorization_requests: {
    columns: [
      "id",
      "client_id",
      "user_id",
      "redirect_uri",
      "state",
      "resource",
      "scopes",
      "code_challenge",
      "created_at",
      "expires_at",
      "consumed_at",
      "decision_id",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
  },
  oauth_clients: {
    columns: [
      "id",
      "name",
      "redirect_uris",
      "created_at",
      "auth_method",
      "secret_hash",
      "revoked_at",
      "trusted",
      "metadata_url",
      "metadata_expires_at",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
  },
  oauth_codes: {
    columns: [
      "code_hash",
      "client_id",
      "user_id",
      "redirect_uri",
      "resource",
      "scopes",
      "code_challenge",
      "created_at",
      "expires_at",
      "used_at",
      "grant_id",
      "exchange_id",
    ],
    primaryKey: ["code_hash"],
    uniqueKeys: [["code_hash"]],
  },
  oauth_families: {
    columns: ["id", "grant_id", "absolute_expires_at", "revoked_at"],
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
  },
  oauth_grants: {
    columns: [
      "id",
      "user_id",
      "client_id",
      "scopes",
      "resource_mode",
      "resources",
      "confirmed_version",
      "created_at",
      "last_used_at",
      "revoked_at",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
  },
  oauth_tokens: {
    columns: [
      "id",
      "access_hash",
      "refresh_hash",
      "client_id",
      "user_id",
      "resource",
      "scopes",
      "created_at",
      "expires_at",
      "refresh_expires_at",
      "revoked_at",
      "grant_id",
      "family_id",
      "parent_id",
      "rotated_at",
      "rotation_id",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["refresh_hash"], ["access_hash"], ["id"]],
  },
  operator_rehearsals: {
    columns: ["kind", "completed_at", "evidence"],
    primaryKey: ["kind"],
    uniqueKeys: [["kind"]],
  },
  owner_transfers: {
    columns: [
      "id",
      "source_id",
      "target_id",
      "token_hash",
      "expires_at",
      "accepted_at",
      "version",
      "acceptance_id",
      "revoked_at",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["token_hash"], ["id"]],
  },
  quota_reservations: {
    columns: ["id", "user_id", "kind", "amount", "resource_id", "expires_at"],
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
  },
  request_limits: {
    columns: ["key", "bucket", "count", "updated_at"],
    primaryKey: ["key", "bucket"],
    uniqueKeys: [["key", "bucket"]],
  },
  resource_grants: {
    columns: [
      "resource_type",
      "resource_id",
      "user_id",
      "role",
      "source",
      "expires_at",
      "created_at",
      "updated_at",
    ],
    primaryKey: ["resource_type", "resource_id", "user_id"],
    uniqueKeys: [["resource_type", "resource_id", "user_id"]],
  },
  resource_ownership_transfers: {
    columns: [
      "id",
      "resource_type",
      "resource_id",
      "source_id",
      "target_id",
      "source_auth_version",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
  },
  security_audit: {
    columns: [
      "id",
      "actor_id",
      "action",
      "target_id",
      "outcome",
      "metadata",
      "created_at",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
  },
  security_outbox: {
    columns: [
      "id",
      "kind",
      "payload",
      "expires_at",
      "next_attempt_at",
      "attempts",
      "status",
      "lease_until",
      "last_error",
      "created_at",
      "provider_id",
      "lease_key",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
  },
  setup_sessions: {
    columns: ["token_hash", "expires_at", "created_at"],
    primaryKey: ["token_hash"],
    uniqueKeys: [["token_hash"]],
  },
  software_update_settings: {
    columns: [
      "id",
      "hook_ciphertext",
      "automatic_security",
      "checked_at",
      "check_error",
      "available_release",
      "runner_seen_at",
      "runner_origin",
      "active_release",
      "check_lease_until",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
  },
  software_updates: {
    columns: [
      "id",
      "release",
      "previous_release",
      "version",
      "status",
      "actor_id",
      "created_at",
      "updated_at",
      "build_id",
      "runner_id",
      "checkpoint",
      "message",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
  },
  user_board_preferences: {
    columns: ["user_id", "board_id", "favorite", "last_opened_at"],
    primaryKey: ["user_id", "board_id"],
    uniqueKeys: [["user_id", "board_id"]],
  },
  user_profiles: {
    columns: ["user_id", "display_name", "color", "updated_at"],
    primaryKey: ["user_id"],
    uniqueKeys: [["user_id"]],
  },
  users: {
    columns: [
      "id",
      "issuer",
      "subject",
      "email",
      "display_name",
      "avatar_url",
      "color",
      "created_at",
      "updated_at",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["email"], ["issuer", "subject"], ["id"]],
  },
  workbooks: {
    columns: [
      "id",
      "folder_id",
      "title",
      "sort_order",
      "created_at",
      "deleted_at",
    ],
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
  },
  workspace_memberships: {
    columns: ["workspace_id", "user_id", "role", "created_at"],
    primaryKey: ["workspace_id", "user_id"],
    uniqueKeys: [["workspace_id", "user_id"]],
  },
  workspaces: {
    columns: ["id", "title", "created_at"],
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
  },
  guest_board_links: {
    columns: ["id", "board_id", "created_by", "token_hash", "token_ciphertext", "role", "password_hash", "expires_at", "revoked_at", "created_at"],
    primaryKey: ["id"], uniqueKeys: [["id"], ["token_hash"]],
  },
  guest_board_sessions: {
    columns: ["id", "link_id", "user_id", "token_hash", "expires_at", "created_at"],
    primaryKey: ["id"], uniqueKeys: [["id"], ["token_hash"]],
  },
  d1_migrations: {
    columns: ["id", "name", "applied_at"],
    primaryKey: ["id"],
    uniqueKeys: [["name"]],
  },
} as const;

export const CATALOG_DDL = [
  {
    name: "access_identities",
    sql: "CREATE TABLE IF NOT EXISTS `access_identities` (\n  `issuer` VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,\n  `subject` VARCHAR(512) NOT NULL,\n  `user_id` VARCHAR(255) NOT NULL,\n  `revoked_at` VARCHAR(32),\n  PRIMARY KEY (`issuer`, `subject`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "account_security",
    sql: "CREATE TABLE IF NOT EXISTS `account_security` (\n  `user_id` VARCHAR(255) NOT NULL,\n  `status` VARCHAR(64) NOT NULL,\n  `auth_version` BIGINT NOT NULL DEFAULT 1,\n  `recovery_required` BIGINT NOT NULL DEFAULT 0,\n  `admitted_at` VARCHAR(32),\n  `deletion_requested_at` VARCHAR(32),\n  `created_at` VARCHAR(32) NOT NULL,\n  `updated_at` VARCHAR(32) NOT NULL,\n  `recovery_started_at` VARCHAR(32),\n  `onboarding_version` BIGINT NOT NULL DEFAULT 0,\n  `onboarding_dismissed_at` VARCHAR(32),\n  `deletion_actor_id` LONGTEXT,\n  PRIMARY KEY (`user_id`),\n  CHECK (status IN ('pending_verification','pending_approval','active','suspended','deletion_pending','deleted')),\n  KEY `account_security_status` (`status`, `updated_at`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "active_connections",
    sql: "CREATE TABLE IF NOT EXISTS `active_connections` (\n  `id` VARCHAR(255) NOT NULL,\n  `user_id` VARCHAR(255) NOT NULL,\n  `session_id` VARCHAR(255) NOT NULL,\n  `board_id` LONGTEXT NOT NULL,\n  `expires_at` BIGINT NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `active_connections_session` (`session_id`, `expires_at`),\n  KEY `active_connections_user` (`user_id`, `expires_at`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "asset_gc_locks",
    sql: "CREATE TABLE IF NOT EXISTS `asset_gc_locks` (\n  `asset_key` VARCHAR(255) NOT NULL,\n  `lease_key` LONGTEXT NOT NULL,\n  `expires_at` BIGINT NOT NULL,\n  PRIMARY KEY (`asset_key`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "asset_references",
    sql: "CREATE TABLE IF NOT EXISTS `asset_references` (\n  `board_id` VARCHAR(255) NOT NULL,\n  `asset_key` VARCHAR(255) NOT NULL,\n  `uploaded_by` VARCHAR(255) NOT NULL,\n  `created_at` VARCHAR(32) NOT NULL,\n  `byte_size` BIGINT NOT NULL DEFAULT 0,\n  PRIMARY KEY (`board_id`, `asset_key`),\n  KEY `assets_uploaded_by` (`uploaded_by`, `byte_size`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "auth_accounts",
    sql: "CREATE TABLE IF NOT EXISTS `auth_accounts` (\n  `id` VARCHAR(255) NOT NULL,\n  `accountId` VARCHAR(512) NOT NULL,\n  `providerId` VARCHAR(255) NOT NULL,\n  `userId` VARCHAR(255) NOT NULL,\n  `accessToken` LONGTEXT,\n  `refreshToken` LONGTEXT,\n  `idToken` LONGTEXT,\n  `accessTokenExpiresAt` VARCHAR(32),\n  `refreshTokenExpiresAt` VARCHAR(32),\n  `scope` LONGTEXT,\n  `password` LONGTEXT,\n  `createdAt` VARCHAR(32) NOT NULL,\n  `updatedAt` VARCHAR(32) NOT NULL,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `auth_accounts_identity` (`providerId`, `accountId`),\n  KEY `auth_accounts_userId_idx` (`userId`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "auth_confirmation_uses",
    sql: "CREATE TABLE IF NOT EXISTS `auth_confirmation_uses` (\n  `token_hash` VARCHAR(255) NOT NULL,\n  `purpose` VARCHAR(64) NOT NULL,\n  `consumed_at` BIGINT NOT NULL,\n  `claim_id` LONGTEXT,\n  PRIMARY KEY (`token_hash`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "auth_email_proofs",
    sql: "CREATE TABLE IF NOT EXISTS `auth_email_proofs` (\n  `user_id` VARCHAR(255) NOT NULL,\n  `purpose` VARCHAR(64) NOT NULL,\n  `token_hash` VARCHAR(255) NOT NULL,\n  `auth_version` BIGINT NOT NULL,\n  `new_email` LONGTEXT,\n  `expires_at` BIGINT NOT NULL,\n  PRIMARY KEY (`user_id`, `purpose`),\n  KEY `auth_email_proof_expiry` (`expires_at`),\n  UNIQUE KEY `uniq_auth_email_proofs_1` (`token_hash`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "auth_method_changes",
    sql: "CREATE TABLE IF NOT EXISTS `auth_method_changes` (\n  `id` VARCHAR(255) NOT NULL,\n  `user_id` LONGTEXT NOT NULL,\n  `excluded_account` LONGTEXT,\n  `excluded_passkey` LONGTEXT,\n  `excluded_provider` LONGTEXT,\n  `deployed_providers` LONGTEXT NOT NULL,\n  `password_enabled` BIGINT NOT NULL,\n  `database_oidc_enabled` BIGINT NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "auth_passkeys",
    sql: "CREATE TABLE IF NOT EXISTS `auth_passkeys` (\n  `id` VARCHAR(255) NOT NULL,\n  `name` LONGTEXT,\n  `publicKey` LONGTEXT NOT NULL,\n  `userId` VARCHAR(255) NOT NULL,\n  `credentialID` VARCHAR(2048) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,\n  `counter` BIGINT NOT NULL,\n  `deviceType` LONGTEXT NOT NULL,\n  `backedUp` BIGINT NOT NULL,\n  `transports` LONGTEXT,\n  `createdAt` VARCHAR(32),\n  `aaguid` LONGTEXT,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `auth_passkeys_credential_unique` (`credentialID`),\n  KEY `auth_passkeys_credentialID_idx` (`credentialID`),\n  KEY `auth_passkeys_userId_idx` (`userId`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "auth_provider_config",
    sql: "CREATE TABLE IF NOT EXISTS `auth_provider_config` (\n  `id` VARCHAR(255) NOT NULL,\n  `public_config` LONGTEXT NOT NULL,\n  `secret` LONGTEXT NOT NULL,\n  `enabled` BIGINT NOT NULL DEFAULT 0,\n  `tested_at` BIGINT,\n  `updated_at` VARCHAR(32) NOT NULL,\n  `callback_verified_at` BIGINT,\n  `version` BIGINT NOT NULL DEFAULT 1,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "auth_return_intents",
    sql: "CREATE TABLE IF NOT EXISTS `auth_return_intents` (\n  `token_hash` VARCHAR(255) NOT NULL,\n  `payload` LONGTEXT NOT NULL,\n  `expires_at` BIGINT NOT NULL,\n  PRIMARY KEY (`token_hash`),\n  KEY `auth_return_intents_expiry` (`expires_at`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "auth_sessions",
    sql: "CREATE TABLE IF NOT EXISTS `auth_sessions` (\n  `id` VARCHAR(255) NOT NULL,\n  `expiresAt` VARCHAR(32) NOT NULL,\n  `token` VARCHAR(255) NOT NULL,\n  `createdAt` VARCHAR(32) NOT NULL,\n  `updatedAt` VARCHAR(32) NOT NULL,\n  `ipAddress` LONGTEXT,\n  `userAgent` LONGTEXT,\n  `userId` VARCHAR(255) NOT NULL,\n  `absoluteExpiresAt` VARCHAR(32) NOT NULL,\n  `authenticatedAt` VARCHAR(32) NOT NULL,\n  `assurance` LONGTEXT NOT NULL,\n  `authVersion` BIGINT NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `auth_sessions_userId_idx` (`userId`),\n  UNIQUE KEY `uniq_auth_sessions_1` (`token`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "auth_two_factors",
    sql: "CREATE TABLE IF NOT EXISTS `auth_two_factors` (\n  `id` VARCHAR(255) NOT NULL,\n  `secret` LONGTEXT NOT NULL,\n  `backupCodes` LONGTEXT NOT NULL,\n  `userId` VARCHAR(255) NOT NULL,\n  `verified` BIGINT,\n  `failedVerificationCount` BIGINT,\n  `lockedUntil` VARCHAR(32),\n  `enrolled_at` VARCHAR(32),\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `auth_two_factors_user_unique` (`userId`),\n  KEY `auth_two_factors_userId_idx` (`userId`),\n  KEY `auth_two_factors_secret_idx` (`secret`(191))\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "auth_users",
    sql: "CREATE TABLE IF NOT EXISTS `auth_users` (\n  `id` VARCHAR(255) NOT NULL,\n  `name` LONGTEXT NOT NULL,\n  `email` VARCHAR(320) NOT NULL,\n  `emailVerified` BIGINT NOT NULL,\n  `image` LONGTEXT,\n  `createdAt` VARCHAR(32) NOT NULL,\n  `updatedAt` VARCHAR(32) NOT NULL,\n  `twoFactorEnabled` BIGINT,\n  PRIMARY KEY (`id`),\n  `_email_lower` VARCHAR(320) GENERATED ALWAYS AS (LOWER(email)) STORED UNIQUE,\n  UNIQUE KEY `uniq_auth_users_1` (`email`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "auth_verifications",
    sql: "CREATE TABLE IF NOT EXISTS `auth_verifications` (\n  `id` VARCHAR(255) NOT NULL,\n  `identifier` LONGTEXT NOT NULL,\n  `value` LONGTEXT NOT NULL,\n  `expiresAt` VARCHAR(32) NOT NULL,\n  `createdAt` VARCHAR(32) NOT NULL,\n  `updatedAt` VARCHAR(32) NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `auth_verifications_identifier_idx` (`identifier`(191))\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "boards",
    sql: "CREATE TABLE IF NOT EXISTS `boards` (\n  `id` VARCHAR(255) NOT NULL,\n  `workbook_id` VARCHAR(255) NOT NULL,\n  `title` LONGTEXT NOT NULL,\n  `favorite` BIGINT NOT NULL DEFAULT 0,\n  `created_at` VARCHAR(32) NOT NULL,\n  `updated_at` VARCHAR(32) NOT NULL,\n  `last_opened_at` VARCHAR(32),\n  `deleted_at` VARCHAR(32),\n  `inheritance_disabled` BIGINT NOT NULL DEFAULT 0,\n  `created_by` VARCHAR(255),\n  PRIMARY KEY (`id`),\n  KEY `boards_created_by` (`created_by`, `deleted_at`),\n  KEY `idx_boards_workbook` (`workbook_id`, `updated_at`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "comment_subscriptions",
    sql: "CREATE TABLE IF NOT EXISTS `comment_subscriptions` (\n  `thread_id` VARCHAR(255) NOT NULL,\n  `board_id` VARCHAR(255) NOT NULL,\n  `user_id` VARCHAR(255) NOT NULL,\n  `muted` BIGINT NOT NULL DEFAULT 0,\n  `updated_at` VARCHAR(32) NOT NULL,\n  PRIMARY KEY (`thread_id`, `user_id`),\n  KEY `idx_comment_subscriptions_user` (`user_id`, `board_id`, `muted`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "content_transfer_operations",
    sql: "CREATE TABLE IF NOT EXISTS `content_transfer_operations` (\n  `id` VARCHAR(255) NOT NULL,\n  `source_id` LONGTEXT NOT NULL,\n  `target_id` LONGTEXT NOT NULL,\n  `resources` LONGTEXT NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "daily_usage",
    sql: "CREATE TABLE IF NOT EXISTS `daily_usage` (\n  `day` VARCHAR(255) NOT NULL,\n  `kind` VARCHAR(64) NOT NULL,\n  `count` BIGINT NOT NULL,\n  PRIMARY KEY (`day`, `kind`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "emergency_recovery",
    sql: "CREATE TABLE IF NOT EXISTS `emergency_recovery` (\n  `token_hash` VARCHAR(255) NOT NULL,\n  `user_id` VARCHAR(255) NOT NULL,\n  `expires_at` BIGINT NOT NULL,\n  `used_at` BIGINT,\n  `reason` LONGTEXT NOT NULL,\n  `consumption_id` LONGTEXT,\n  PRIMARY KEY (`token_hash`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "folders",
    sql: "CREATE TABLE IF NOT EXISTS `folders` (\n  `id` VARCHAR(255) NOT NULL,\n  `parent_id` VARCHAR(255),\n  `title` LONGTEXT NOT NULL,\n  `sort_order` BIGINT NOT NULL DEFAULT 0,\n  `created_at` VARCHAR(32) NOT NULL,\n  `deleted_at` VARCHAR(32),\n  `owner_id` VARCHAR(255),\n  PRIMARY KEY (`id`),\n  KEY `idx_folders_parent` (`parent_id`, `sort_order`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "installation",
    sql: "CREATE TABLE IF NOT EXISTS `installation` (\n  `id` VARCHAR(255) NOT NULL,\n  `state` LONGTEXT NOT NULL,\n  `setup_user_id` VARCHAR(255),\n  `owner_id` VARCHAR(255),\n  `title` LONGTEXT NOT NULL DEFAULT ('Canvas'),\n  `origin` LONGTEXT NOT NULL DEFAULT (''),\n  `version` BIGINT NOT NULL DEFAULT 1,\n  `consent_version` BIGINT NOT NULL DEFAULT 1,\n  `setup_commit` LONGTEXT,\n  `registration` LONGTEXT NOT NULL DEFAULT ('invite'),\n  `approval_required` BIGINT NOT NULL DEFAULT 0,\n  `mfa_required` BIGINT NOT NULL DEFAULT 0,\n  `magic_link` BIGINT NOT NULL DEFAULT 0,\n  `member_limit` BIGINT NOT NULL DEFAULT 25,\n  `guest_limit` BIGINT NOT NULL DEFAULT 100,\n  `board_limit` BIGINT NOT NULL DEFAULT 1000,\n  `storage_limit` BIGINT NOT NULL DEFAULT 5368709120,\n  `user_board_limit` BIGINT NOT NULL DEFAULT 100,\n  `user_storage_limit` BIGINT NOT NULL DEFAULT 1073741824,\n  `mail_limit` BIGINT NOT NULL DEFAULT 500,\n  `session_idle_seconds` BIGINT NOT NULL DEFAULT 604800,\n  `session_absolute_seconds` BIGINT NOT NULL DEFAULT 2592000,\n  `created_at` VARCHAR(32) NOT NULL,\n  `ownership_commit` LONGTEXT,\n  `dynamic_registration` BIGINT NOT NULL DEFAULT 1,\n  `cache_namespace` LONGTEXT NOT NULL DEFAULT (''),\n  PRIMARY KEY (`id`),\n  CHECK (id = 'instance'),\n  CHECK (state IN ('unclaimed','configuring','ready')),\n  CHECK (registration IN ('closed','invite','public'))\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "installation_key_identity",
    sql: "CREATE TABLE IF NOT EXISTS `installation_key_identity` (\n  `id` VARCHAR(255) NOT NULL,\n  `fingerprint` LONGTEXT NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "installation_mail",
    sql: "CREATE TABLE IF NOT EXISTS `installation_mail` (\n  `id` VARCHAR(255) NOT NULL,\n  `sender` LONGTEXT NOT NULL,\n  `recipient` LONGTEXT NOT NULL,\n  `confirmed_at` BIGINT,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "installation_mail_tests",
    sql: "CREATE TABLE IF NOT EXISTS `installation_mail_tests` (\n  `id` VARCHAR(255) NOT NULL,\n  `actor_id` VARCHAR(255) NOT NULL,\n  `sender` LONGTEXT NOT NULL,\n  `recipient` LONGTEXT NOT NULL,\n  `code_hash` LONGTEXT NOT NULL,\n  `expires_at` BIGINT NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "instance_invitations",
    sql: "CREATE TABLE IF NOT EXISTS `instance_invitations` (\n  `id` VARCHAR(255) NOT NULL,\n  `token_hash` VARCHAR(255) NOT NULL,\n  `email` VARCHAR(320) NOT NULL,\n  `role` VARCHAR(64) NOT NULL,\n  `invited_by` VARCHAR(255) NOT NULL,\n  `created_at` VARCHAR(32) NOT NULL,\n  `expires_at` VARCHAR(32) NOT NULL,\n  `accepted_by` VARCHAR(255),\n  `accepted_at` VARCHAR(32),\n  `revoked_at` VARCHAR(32),\n  `acceptance_id` LONGTEXT,\n  PRIMARY KEY (`id`),\n  CHECK (role IN ('admin','member','guest')),\n  KEY `instance_invitation_email` (`email`, `expires_at`),\n  UNIQUE KEY `uniq_instance_invitations_1` (`token_hash`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "instance_memberships",
    sql: "CREATE TABLE IF NOT EXISTS `instance_memberships` (\n  `user_id` VARCHAR(255) NOT NULL,\n  `role` VARCHAR(64) NOT NULL,\n  `created_at` VARCHAR(32) NOT NULL,\n  PRIMARY KEY (`user_id`),\n  CHECK (role IN ('owner','admin','member','guest')),\n  `_one_owner` TINYINT GENERATED ALWAYS AS (CASE WHEN role='owner' THEN 1 ELSE NULL END) STORED UNIQUE\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "invitations",
    sql: "CREATE TABLE IF NOT EXISTS `invitations` (\n  `id` VARCHAR(255) NOT NULL,\n  `token_hash` VARCHAR(255) NOT NULL,\n  `resource_type` VARCHAR(64) NOT NULL,\n  `resource_id` VARCHAR(255) NOT NULL,\n  `email` VARCHAR(320) NOT NULL,\n  `role` VARCHAR(64) NOT NULL,\n  `invited_by` VARCHAR(255) NOT NULL,\n  `created_at` VARCHAR(32) NOT NULL,\n  `expires_at` VARCHAR(32) NOT NULL,\n  `accepted_at` VARCHAR(32),\n  `accepted_by` VARCHAR(255),\n  `revoked_at` VARCHAR(32),\n  `acceptance_id` LONGTEXT,\n  PRIMARY KEY (`id`),\n  CHECK (resource_type IN ('workbook','board')),\n  CHECK (role IN ('editor','commenter','viewer')),\n  KEY `idx_invitations_email` (`email`, `expires_at`),\n  KEY `idx_invitations_resource` (`resource_type`, `resource_id`, `created_at`),\n  UNIQUE KEY `uniq_invitations_2` (`token_hash`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "local_accounts",
    sql: "CREATE TABLE IF NOT EXISTS `local_accounts` (\n  `user_id` VARCHAR(255) NOT NULL,\n  `username` VARCHAR(255) COLLATE utf8mb4_0900_as_ci NOT NULL,\n  `recovery_hash` LONGTEXT,\n  `recovery_claim` LONGTEXT,\n  PRIMARY KEY (`user_id`),\n  UNIQUE KEY `uniq_local_accounts_0` (`username`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "local_invitations",
    sql: "CREATE TABLE IF NOT EXISTS `local_invitations` (\n  `id` VARCHAR(255) NOT NULL,\n  `token_hash` VARCHAR(255) NOT NULL,\n  `label` LONGTEXT NOT NULL,\n  `role` VARCHAR(64) NOT NULL,\n  `created_by` VARCHAR(255) NOT NULL,\n  `created_at` BIGINT NOT NULL,\n  `expires_at` BIGINT NOT NULL,\n  `accepted_by` VARCHAR(255),\n  `revoked_at` BIGINT,\n  PRIMARY KEY (`id`),\n  CHECK (role IN ('member','guest')),\n  KEY `local_invitations_pending` (`expires_at`),\n  KEY `local_invitations_recent` (`created_at`),\n  UNIQUE KEY `uniq_local_invitations_2` (`token_hash`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "mail_delivery_receipts",
    sql: "CREATE TABLE IF NOT EXISTS `mail_delivery_receipts` (\n  `provider_id` VARCHAR(255) NOT NULL,\n  `status` VARCHAR(64) NOT NULL,\n  `event_at` VARCHAR(32) NOT NULL,\n  `received_at` BIGINT NOT NULL,\n  PRIMARY KEY (`provider_id`),\n  KEY `mail_receipts_time` (`received_at`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "mail_suppressions",
    sql: "CREATE TABLE IF NOT EXISTS `mail_suppressions` (\n  `email` VARCHAR(320) NOT NULL,\n  `reason` LONGTEXT NOT NULL,\n  `created_at` VARCHAR(32) NOT NULL,\n  PRIMARY KEY (`email`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "mail_webhook_events",
    sql: "CREATE TABLE IF NOT EXISTS `mail_webhook_events` (\n  `id` VARCHAR(255) NOT NULL,\n  `received_at` BIGINT NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "maintenance_cursors",
    sql: "CREATE TABLE IF NOT EXISTS `maintenance_cursors` (\n  `name` VARCHAR(255) NOT NULL,\n  `cursor` LONGTEXT,\n  `updated_at` VARCHAR(32) NOT NULL,\n  PRIMARY KEY (`name`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "mfa_replay",
    sql: "CREATE TABLE IF NOT EXISTS `mfa_replay` (\n  `user_id` VARCHAR(255) NOT NULL,\n  `code_hash` VARCHAR(255) NOT NULL,\n  `expires_at` BIGINT NOT NULL,\n  PRIMARY KEY (`user_id`, `code_hash`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "notifications",
    sql: "CREATE TABLE IF NOT EXISTS `notifications` (\n  `id` VARCHAR(255) NOT NULL,\n  `user_id` VARCHAR(255) NOT NULL,\n  `board_id` LONGTEXT,\n  `kind` VARCHAR(64) NOT NULL,\n  `title` LONGTEXT NOT NULL,\n  `body` LONGTEXT NOT NULL,\n  `href` LONGTEXT,\n  `event_key` VARCHAR(255),\n  `created_at` VARCHAR(32) NOT NULL,\n  `read_at` VARCHAR(32),\n  PRIMARY KEY (`id`),\n  KEY `idx_notifications_user` (`user_id`, `read_at`, `created_at`),\n  UNIQUE KEY `uniq_notifications_1` (`event_key`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "oauth_authorization_requests",
    sql: "CREATE TABLE IF NOT EXISTS `oauth_authorization_requests` (\n  `id` VARCHAR(255) NOT NULL,\n  `client_id` VARCHAR(2048) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,\n  `user_id` VARCHAR(255) NOT NULL,\n  `redirect_uri` LONGTEXT NOT NULL,\n  `state` LONGTEXT,\n  `resource` LONGTEXT NOT NULL,\n  `scopes` LONGTEXT NOT NULL,\n  `code_challenge` LONGTEXT NOT NULL,\n  `created_at` VARCHAR(32) NOT NULL,\n  `expires_at` VARCHAR(32) NOT NULL,\n  `consumed_at` VARCHAR(32),\n  `decision_id` LONGTEXT,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "oauth_clients",
    sql: "CREATE TABLE IF NOT EXISTS `oauth_clients` (\n  `id` VARCHAR(2048) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,\n  `name` LONGTEXT NOT NULL,\n  `redirect_uris` LONGTEXT NOT NULL,\n  `created_at` VARCHAR(32) NOT NULL,\n  `auth_method` LONGTEXT NOT NULL DEFAULT ('none'),\n  `secret_hash` LONGTEXT,\n  `revoked_at` VARCHAR(32),\n  `trusted` BIGINT NOT NULL DEFAULT 0,\n  `metadata_url` LONGTEXT,\n  `metadata_expires_at` VARCHAR(32),\n  PRIMARY KEY (`id`),\n  KEY `oauth_client_metadata_expiry` (`metadata_expires_at`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "oauth_codes",
    sql: "CREATE TABLE IF NOT EXISTS `oauth_codes` (\n  `code_hash` VARCHAR(255) NOT NULL,\n  `client_id` VARCHAR(2048) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,\n  `user_id` VARCHAR(255) NOT NULL,\n  `redirect_uri` LONGTEXT NOT NULL,\n  `resource` LONGTEXT NOT NULL,\n  `scopes` LONGTEXT NOT NULL,\n  `code_challenge` LONGTEXT NOT NULL,\n  `created_at` VARCHAR(32) NOT NULL,\n  `expires_at` VARCHAR(32) NOT NULL,\n  `used_at` VARCHAR(32),\n  `grant_id` VARCHAR(255),\n  `exchange_id` LONGTEXT,\n  PRIMARY KEY (`code_hash`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "oauth_families",
    sql: "CREATE TABLE IF NOT EXISTS `oauth_families` (\n  `id` VARCHAR(255) NOT NULL,\n  `grant_id` VARCHAR(255) NOT NULL,\n  `absolute_expires_at` VARCHAR(32) NOT NULL,\n  `revoked_at` VARCHAR(32),\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "oauth_grants",
    sql: "CREATE TABLE IF NOT EXISTS `oauth_grants` (\n  `id` VARCHAR(255) NOT NULL,\n  `user_id` VARCHAR(255) NOT NULL,\n  `client_id` VARCHAR(2048) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,\n  `scopes` LONGTEXT NOT NULL,\n  `resource_mode` LONGTEXT NOT NULL,\n  `resources` LONGTEXT NOT NULL DEFAULT ('[]'),\n  `confirmed_version` BIGINT NOT NULL,\n  `created_at` VARCHAR(32) NOT NULL,\n  `last_used_at` VARCHAR(32),\n  `revoked_at` VARCHAR(32),\n  PRIMARY KEY (`id`),\n  CHECK (resource_mode IN ('all','selected')),\n  KEY `oauth_grants_user` (`user_id`, `revoked_at`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "oauth_tokens",
    sql: "CREATE TABLE IF NOT EXISTS `oauth_tokens` (\n  `id` VARCHAR(255) NOT NULL,\n  `access_hash` VARCHAR(255) NOT NULL,\n  `refresh_hash` VARCHAR(255) NOT NULL,\n  `client_id` VARCHAR(2048) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,\n  `user_id` VARCHAR(255) NOT NULL,\n  `resource` LONGTEXT NOT NULL,\n  `scopes` LONGTEXT NOT NULL,\n  `created_at` VARCHAR(32) NOT NULL,\n  `expires_at` VARCHAR(32) NOT NULL,\n  `refresh_expires_at` VARCHAR(32) NOT NULL,\n  `revoked_at` VARCHAR(32),\n  `grant_id` VARCHAR(255),\n  `family_id` VARCHAR(255),\n  `parent_id` LONGTEXT,\n  `rotated_at` VARCHAR(32),\n  `rotation_id` LONGTEXT,\n  PRIMARY KEY (`id`),\n  KEY `idx_oauth_tokens_user` (`user_id`, `revoked_at`, `expires_at`),\n  UNIQUE KEY `uniq_oauth_tokens_1` (`refresh_hash`),\n  UNIQUE KEY `uniq_oauth_tokens_2` (`access_hash`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "operator_rehearsals",
    sql: "CREATE TABLE IF NOT EXISTS `operator_rehearsals` (\n  `kind` VARCHAR(64) NOT NULL,\n  `completed_at` VARCHAR(32) NOT NULL,\n  `evidence` LONGTEXT NOT NULL,\n  PRIMARY KEY (`kind`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "owner_transfers",
    sql: "CREATE TABLE IF NOT EXISTS `owner_transfers` (\n  `id` VARCHAR(255) NOT NULL,\n  `source_id` VARCHAR(255) NOT NULL,\n  `target_id` VARCHAR(255) NOT NULL,\n  `token_hash` VARCHAR(255) NOT NULL,\n  `expires_at` BIGINT NOT NULL,\n  `accepted_at` BIGINT,\n  `version` BIGINT NOT NULL,\n  `acceptance_id` LONGTEXT,\n  `revoked_at` BIGINT,\n  PRIMARY KEY (`id`),\n  KEY `pending_owner_transfers` (`source_id`, `accepted_at`, `revoked_at`, `expires_at`),\n  UNIQUE KEY `uniq_owner_transfers_1` (`token_hash`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "quota_reservations",
    sql: "CREATE TABLE IF NOT EXISTS `quota_reservations` (\n  `id` VARCHAR(255) NOT NULL,\n  `user_id` VARCHAR(255) NOT NULL,\n  `kind` VARCHAR(64) NOT NULL,\n  `amount` BIGINT NOT NULL,\n  `resource_id` LONGTEXT,\n  `expires_at` BIGINT NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `quota_reservations_active` (`kind`, `expires_at`, `user_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "request_limits",
    sql: "CREATE TABLE IF NOT EXISTS `request_limits` (\n  `key` VARCHAR(2048) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,\n  `bucket` BIGINT NOT NULL,\n  `count` BIGINT NOT NULL,\n  `updated_at` VARCHAR(32) NOT NULL,\n  PRIMARY KEY (`key`, `bucket`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "resource_grants",
    sql: "CREATE TABLE IF NOT EXISTS `resource_grants` (\n  `resource_type` VARCHAR(64) NOT NULL,\n  `resource_id` VARCHAR(255) NOT NULL,\n  `user_id` VARCHAR(255) NOT NULL,\n  `role` VARCHAR(64) NOT NULL,\n  `source` LONGTEXT NOT NULL DEFAULT ('direct'),\n  `expires_at` VARCHAR(32),\n  `created_at` VARCHAR(32) NOT NULL,\n  `updated_at` VARCHAR(32) NOT NULL,\n  PRIMARY KEY (`resource_type`, `resource_id`, `user_id`),\n  CHECK (resource_type IN ('workbook','board')),\n  CHECK (role IN ('owner','editor','commenter','viewer')),\n  KEY `idx_resource_grants_user` (`user_id`, `resource_type`, `expires_at`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "resource_ownership_transfers",
    sql: "CREATE TABLE IF NOT EXISTS `resource_ownership_transfers` (\n  `id` VARCHAR(255) NOT NULL,\n  `resource_type` VARCHAR(64) NOT NULL,\n  `resource_id` LONGTEXT NOT NULL,\n  `source_id` VARCHAR(255) NOT NULL,\n  `target_id` VARCHAR(255) NOT NULL,\n  `source_auth_version` BIGINT,\n  PRIMARY KEY (`id`),\n  CHECK (resource_type IN ('board','workbook'))\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "security_audit",
    sql: "CREATE TABLE IF NOT EXISTS `security_audit` (\n  `id` VARCHAR(255) NOT NULL,\n  `actor_id` VARCHAR(255),\n  `action` LONGTEXT NOT NULL,\n  `target_id` LONGTEXT,\n  `outcome` LONGTEXT NOT NULL,\n  `metadata` LONGTEXT NOT NULL DEFAULT ('{}'),\n  `created_at` VARCHAR(32) NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `security_audit_actor` (`actor_id`, `created_at`),\n  KEY `security_audit_time` (`created_at`, `id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "security_outbox",
    sql: "CREATE TABLE IF NOT EXISTS `security_outbox` (\n  `id` VARCHAR(255) NOT NULL,\n  `kind` VARCHAR(64) NOT NULL,\n  `payload` LONGTEXT NOT NULL,\n  `expires_at` BIGINT NOT NULL,\n  `next_attempt_at` BIGINT NOT NULL,\n  `attempts` BIGINT NOT NULL DEFAULT 0,\n  `status` VARCHAR(64) NOT NULL,\n  `lease_until` BIGINT,\n  `last_error` LONGTEXT,\n  `created_at` BIGINT NOT NULL,\n  `provider_id` LONGTEXT,\n  `lease_key` LONGTEXT,\n  PRIMARY KEY (`id`),\n  CHECK (kind IN ('mail','invalidate')),\n  KEY `security_outbox_pending` (`status`, `next_attempt_at`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "setup_sessions",
    sql: "CREATE TABLE IF NOT EXISTS `setup_sessions` (\n  `token_hash` VARCHAR(255) NOT NULL,\n  `expires_at` BIGINT NOT NULL,\n  `created_at` BIGINT NOT NULL,\n  PRIMARY KEY (`token_hash`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "software_update_settings",
    sql: "CREATE TABLE IF NOT EXISTS `software_update_settings` (\n  `id` VARCHAR(255) NOT NULL,\n  `hook_ciphertext` LONGTEXT,\n  `automatic_security` BIGINT NOT NULL DEFAULT 0,\n  `checked_at` BIGINT,\n  `check_error` LONGTEXT,\n  `available_release` LONGTEXT,\n  `runner_seen_at` BIGINT,\n  `runner_origin` LONGTEXT,\n  `active_release` LONGTEXT,\n  `check_lease_until` BIGINT NOT NULL DEFAULT 0,\n  PRIMARY KEY (`id`),\n  CHECK (id = 'instance'),\n  CHECK (automatic_security IN (0,1))\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "software_updates",
    sql: "CREATE TABLE IF NOT EXISTS `software_updates` (\n  `id` VARCHAR(255) NOT NULL,\n  `release` LONGTEXT NOT NULL,\n  `previous_release` LONGTEXT NOT NULL,\n  `version` LONGTEXT NOT NULL,\n  `status` VARCHAR(64) NOT NULL,\n  `actor_id` VARCHAR(255),\n  `created_at` BIGINT NOT NULL,\n  `updated_at` BIGINT NOT NULL,\n  `build_id` LONGTEXT,\n  `runner_id` LONGTEXT,\n  `checkpoint` LONGTEXT,\n  `message` LONGTEXT,\n  PRIMARY KEY (`id`),\n  CHECK (status IN ('queued','building','deploying','verifying','succeeded','failed','uncertain')),\n  `_one_active` TINYINT GENERATED ALWAYS AS (CASE WHEN status IN ('queued','building','deploying','verifying','uncertain') THEN 1 ELSE NULL END) STORED UNIQUE,\n  KEY `software_updates_history` (`created_at`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "user_board_preferences",
    sql: "CREATE TABLE IF NOT EXISTS `user_board_preferences` (\n  `user_id` VARCHAR(255) NOT NULL,\n  `board_id` VARCHAR(255) NOT NULL,\n  `favorite` BIGINT NOT NULL DEFAULT 0,\n  `last_opened_at` VARCHAR(32),\n  PRIMARY KEY (`user_id`, `board_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "user_profiles",
    sql: "CREATE TABLE IF NOT EXISTS `user_profiles` (\n  `user_id` VARCHAR(255) NOT NULL,\n  `display_name` LONGTEXT NOT NULL,\n  `color` LONGTEXT NOT NULL,\n  `updated_at` VARCHAR(32) NOT NULL,\n  PRIMARY KEY (`user_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "users",
    sql: "CREATE TABLE IF NOT EXISTS `users` (\n  `id` VARCHAR(255) NOT NULL,\n  `issuer` VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,\n  `subject` VARCHAR(512) NOT NULL,\n  `email` VARCHAR(320) NOT NULL,\n  `display_name` LONGTEXT NOT NULL,\n  `avatar_url` LONGTEXT,\n  `color` LONGTEXT NOT NULL,\n  `created_at` VARCHAR(32) NOT NULL,\n  `updated_at` VARCHAR(32) NOT NULL,\n  PRIMARY KEY (`id`),\n  `_email_lower` VARCHAR(320) GENERATED ALWAYS AS (LOWER(email)) STORED,\n  UNIQUE KEY `idx_users_email` (`_email_lower`),\n  UNIQUE KEY `uniq_users_1` (`issuer`, `subject`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "workbooks",
    sql: "CREATE TABLE IF NOT EXISTS `workbooks` (\n  `id` VARCHAR(255) NOT NULL,\n  `folder_id` VARCHAR(255),\n  `title` LONGTEXT NOT NULL,\n  `sort_order` BIGINT NOT NULL DEFAULT 0,\n  `created_at` VARCHAR(32) NOT NULL,\n  `deleted_at` VARCHAR(32),\n  PRIMARY KEY (`id`),\n  KEY `idx_workbooks_folder` (`folder_id`, `sort_order`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "workspace_memberships",
    sql: "CREATE TABLE IF NOT EXISTS `workspace_memberships` (\n  `workspace_id` VARCHAR(255) NOT NULL,\n  `user_id` VARCHAR(255) NOT NULL,\n  `role` VARCHAR(64) NOT NULL,\n  `created_at` VARCHAR(32) NOT NULL,\n  PRIMARY KEY (`workspace_id`, `user_id`),\n  CHECK (role IN ('owner','editor','commenter','viewer'))\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "workspaces",
    sql: "CREATE TABLE IF NOT EXISTS `workspaces` (\n  `id` VARCHAR(255) NOT NULL,\n  `title` LONGTEXT NOT NULL,\n  `created_at` VARCHAR(32) NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
  {
    name: "d1_migrations",
    sql: "CREATE TABLE IF NOT EXISTS `d1_migrations` (`id` BIGINT NOT NULL PRIMARY KEY, `name` VARCHAR(255) NOT NULL UNIQUE, `applied_at` VARCHAR(32) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  },
] as const;

export const CATALOG_FOREIGN_KEYS = [
  {
    table: "access_identities",
    name: "fk_access_identities_0",
    sql: "ALTER TABLE `access_identities` ADD CONSTRAINT `fk_access_identities_0` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "account_security",
    name: "fk_account_security_0",
    sql: "ALTER TABLE `account_security` ADD CONSTRAINT `fk_account_security_0` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "asset_references",
    name: "fk_asset_references_0",
    sql: "ALTER TABLE `asset_references` ADD CONSTRAINT `fk_asset_references_0` FOREIGN KEY (`uploaded_by`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "auth_accounts",
    name: "fk_auth_accounts_0",
    sql: "ALTER TABLE `auth_accounts` ADD CONSTRAINT `fk_auth_accounts_0` FOREIGN KEY (`userId`) REFERENCES `auth_users` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION",
  },
  {
    table: "auth_passkeys",
    name: "fk_auth_passkeys_0",
    sql: "ALTER TABLE `auth_passkeys` ADD CONSTRAINT `fk_auth_passkeys_0` FOREIGN KEY (`userId`) REFERENCES `auth_users` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION",
  },
  {
    table: "auth_sessions",
    name: "fk_auth_sessions_0",
    sql: "ALTER TABLE `auth_sessions` ADD CONSTRAINT `fk_auth_sessions_0` FOREIGN KEY (`userId`) REFERENCES `auth_users` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION",
  },
  {
    table: "auth_two_factors",
    name: "fk_auth_two_factors_0",
    sql: "ALTER TABLE `auth_two_factors` ADD CONSTRAINT `fk_auth_two_factors_0` FOREIGN KEY (`userId`) REFERENCES `auth_users` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION",
  },
  {
    table: "boards",
    name: "fk_boards_0",
    sql: "ALTER TABLE `boards` ADD CONSTRAINT `fk_boards_0` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "boards",
    name: "fk_boards_1",
    sql: "ALTER TABLE `boards` ADD CONSTRAINT `fk_boards_1` FOREIGN KEY (`workbook_id`) REFERENCES `workbooks` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "comment_subscriptions",
    name: "fk_comment_subscriptions_0",
    sql: "ALTER TABLE `comment_subscriptions` ADD CONSTRAINT `fk_comment_subscriptions_0` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "emergency_recovery",
    name: "fk_emergency_recovery_0",
    sql: "ALTER TABLE `emergency_recovery` ADD CONSTRAINT `fk_emergency_recovery_0` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "folders",
    name: "fk_folders_0",
    sql: "ALTER TABLE `folders` ADD CONSTRAINT `fk_folders_0` FOREIGN KEY (`owner_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "folders",
    name: "fk_folders_1",
    sql: "ALTER TABLE `folders` ADD CONSTRAINT `fk_folders_1` FOREIGN KEY (`parent_id`) REFERENCES `folders` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "installation",
    name: "fk_installation_0",
    sql: "ALTER TABLE `installation` ADD CONSTRAINT `fk_installation_0` FOREIGN KEY (`owner_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "installation",
    name: "fk_installation_1",
    sql: "ALTER TABLE `installation` ADD CONSTRAINT `fk_installation_1` FOREIGN KEY (`setup_user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "installation_mail_tests",
    name: "fk_installation_mail_tests_0",
    sql: "ALTER TABLE `installation_mail_tests` ADD CONSTRAINT `fk_installation_mail_tests_0` FOREIGN KEY (`actor_id`) REFERENCES `auth_users` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION",
  },
  {
    table: "instance_invitations",
    name: "fk_instance_invitations_0",
    sql: "ALTER TABLE `instance_invitations` ADD CONSTRAINT `fk_instance_invitations_0` FOREIGN KEY (`accepted_by`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "instance_invitations",
    name: "fk_instance_invitations_1",
    sql: "ALTER TABLE `instance_invitations` ADD CONSTRAINT `fk_instance_invitations_1` FOREIGN KEY (`invited_by`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "instance_memberships",
    name: "fk_instance_memberships_0",
    sql: "ALTER TABLE `instance_memberships` ADD CONSTRAINT `fk_instance_memberships_0` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "invitations",
    name: "fk_invitations_0",
    sql: "ALTER TABLE `invitations` ADD CONSTRAINT `fk_invitations_0` FOREIGN KEY (`accepted_by`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "invitations",
    name: "fk_invitations_1",
    sql: "ALTER TABLE `invitations` ADD CONSTRAINT `fk_invitations_1` FOREIGN KEY (`invited_by`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "local_accounts",
    name: "fk_local_accounts_0",
    sql: "ALTER TABLE `local_accounts` ADD CONSTRAINT `fk_local_accounts_0` FOREIGN KEY (`user_id`) REFERENCES `auth_users` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION",
  },
  {
    table: "local_invitations",
    name: "fk_local_invitations_0",
    sql: "ALTER TABLE `local_invitations` ADD CONSTRAINT `fk_local_invitations_0` FOREIGN KEY (`accepted_by`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "local_invitations",
    name: "fk_local_invitations_1",
    sql: "ALTER TABLE `local_invitations` ADD CONSTRAINT `fk_local_invitations_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "notifications",
    name: "fk_notifications_0",
    sql: "ALTER TABLE `notifications` ADD CONSTRAINT `fk_notifications_0` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "oauth_authorization_requests",
    name: "fk_oauth_authorization_requests_0",
    sql: "ALTER TABLE `oauth_authorization_requests` ADD CONSTRAINT `fk_oauth_authorization_requests_0` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "oauth_authorization_requests",
    name: "fk_oauth_authorization_requests_1",
    sql: "ALTER TABLE `oauth_authorization_requests` ADD CONSTRAINT `fk_oauth_authorization_requests_1` FOREIGN KEY (`client_id`) REFERENCES `oauth_clients` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "oauth_codes",
    name: "fk_oauth_codes_0",
    sql: "ALTER TABLE `oauth_codes` ADD CONSTRAINT `fk_oauth_codes_0` FOREIGN KEY (`grant_id`) REFERENCES `oauth_grants` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "oauth_codes",
    name: "fk_oauth_codes_1",
    sql: "ALTER TABLE `oauth_codes` ADD CONSTRAINT `fk_oauth_codes_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "oauth_codes",
    name: "fk_oauth_codes_2",
    sql: "ALTER TABLE `oauth_codes` ADD CONSTRAINT `fk_oauth_codes_2` FOREIGN KEY (`client_id`) REFERENCES `oauth_clients` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "oauth_families",
    name: "fk_oauth_families_0",
    sql: "ALTER TABLE `oauth_families` ADD CONSTRAINT `fk_oauth_families_0` FOREIGN KEY (`grant_id`) REFERENCES `oauth_grants` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "oauth_grants",
    name: "fk_oauth_grants_0",
    sql: "ALTER TABLE `oauth_grants` ADD CONSTRAINT `fk_oauth_grants_0` FOREIGN KEY (`client_id`) REFERENCES `oauth_clients` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "oauth_grants",
    name: "fk_oauth_grants_1",
    sql: "ALTER TABLE `oauth_grants` ADD CONSTRAINT `fk_oauth_grants_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "oauth_tokens",
    name: "fk_oauth_tokens_0",
    sql: "ALTER TABLE `oauth_tokens` ADD CONSTRAINT `fk_oauth_tokens_0` FOREIGN KEY (`family_id`) REFERENCES `oauth_families` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "oauth_tokens",
    name: "fk_oauth_tokens_1",
    sql: "ALTER TABLE `oauth_tokens` ADD CONSTRAINT `fk_oauth_tokens_1` FOREIGN KEY (`grant_id`) REFERENCES `oauth_grants` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "oauth_tokens",
    name: "fk_oauth_tokens_2",
    sql: "ALTER TABLE `oauth_tokens` ADD CONSTRAINT `fk_oauth_tokens_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "oauth_tokens",
    name: "fk_oauth_tokens_3",
    sql: "ALTER TABLE `oauth_tokens` ADD CONSTRAINT `fk_oauth_tokens_3` FOREIGN KEY (`client_id`) REFERENCES `oauth_clients` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "owner_transfers",
    name: "fk_owner_transfers_0",
    sql: "ALTER TABLE `owner_transfers` ADD CONSTRAINT `fk_owner_transfers_0` FOREIGN KEY (`target_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "owner_transfers",
    name: "fk_owner_transfers_1",
    sql: "ALTER TABLE `owner_transfers` ADD CONSTRAINT `fk_owner_transfers_1` FOREIGN KEY (`source_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "resource_grants",
    name: "fk_resource_grants_0",
    sql: "ALTER TABLE `resource_grants` ADD CONSTRAINT `fk_resource_grants_0` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "resource_ownership_transfers",
    name: "fk_resource_ownership_transfers_0",
    sql: "ALTER TABLE `resource_ownership_transfers` ADD CONSTRAINT `fk_resource_ownership_transfers_0` FOREIGN KEY (`target_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "resource_ownership_transfers",
    name: "fk_resource_ownership_transfers_1",
    sql: "ALTER TABLE `resource_ownership_transfers` ADD CONSTRAINT `fk_resource_ownership_transfers_1` FOREIGN KEY (`source_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "software_updates",
    name: "fk_software_updates_0",
    sql: "ALTER TABLE `software_updates` ADD CONSTRAINT `fk_software_updates_0` FOREIGN KEY (`actor_id`) REFERENCES `auth_users` (`id`) ON DELETE SET NULL ON UPDATE NO ACTION",
  },
  {
    table: "user_board_preferences",
    name: "fk_user_board_preferences_0",
    sql: "ALTER TABLE `user_board_preferences` ADD CONSTRAINT `fk_user_board_preferences_0` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "user_profiles",
    name: "fk_user_profiles_0",
    sql: "ALTER TABLE `user_profiles` ADD CONSTRAINT `fk_user_profiles_0` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "workbooks",
    name: "fk_workbooks_0",
    sql: "ALTER TABLE `workbooks` ADD CONSTRAINT `fk_workbooks_0` FOREIGN KEY (`folder_id`) REFERENCES `folders` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "workspace_memberships",
    name: "fk_workspace_memberships_0",
    sql: "ALTER TABLE `workspace_memberships` ADD CONSTRAINT `fk_workspace_memberships_0` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
  {
    table: "workspace_memberships",
    name: "fk_workspace_memberships_1",
    sql: "ALTER TABLE `workspace_memberships` ADD CONSTRAINT `fk_workspace_memberships_1` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
  },
] as const;

export const CATALOG_TRIGGERS = [
  {
    name: "active_grant_change",
    table: "resource_grants",
    sql: "CREATE TRIGGER `active_grant_change` BEFORE UPDATE ON `resource_grants` FOR EACH ROW\nBEGIN\n IF EXISTS(SELECT 1 FROM account_security WHERE user_id = NEW.user_id AND status IN ('suspended','deletion_pending','deleted'))\n AND (NEW.user_id <> OLD.user_id OR\n CASE NEW.role WHEN 'owner' THEN 4 WHEN 'editor' THEN 3 WHEN 'commenter' THEN 2 ELSE 1 END >\n CASE OLD.role WHEN 'owner' THEN 4 WHEN 'editor' THEN 3 WHEN 'commenter' THEN 2 ELSE 1 END) THEN\n SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ACCOUNT_UNAVAILABLE'; \n END IF;\nEND",
  },
  {
    name: "active_grant_recipient",
    table: "resource_grants",
    sql: "CREATE TRIGGER `active_grant_recipient` BEFORE INSERT ON `resource_grants` FOR EACH ROW\nBEGIN\n IF EXISTS(SELECT 1 FROM account_security WHERE user_id = NEW.user_id AND status IN ('suspended','deletion_pending','deleted')) THEN\n SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ACCOUNT_UNAVAILABLE'; \n END IF;\nEND",
  },
  {
    name: "asset_commit_gc_guard",
    table: "asset_references",
    sql: "CREATE TRIGGER `asset_commit_gc_guard` BEFORE INSERT ON `asset_references` FOR EACH ROW\nBEGIN\n IF EXISTS(SELECT 1 FROM asset_gc_locks WHERE asset_key = NEW.asset_key AND expires_at > UNIX_TIMESTAMP() * 1000) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ASSET_RETRY'; END IF;\n\nEND",
  },
  {
    name: "asset_growth_quota",
    table: "asset_references",
    sql: "CREATE TRIGGER `asset_growth_quota` BEFORE UPDATE ON `asset_references` FOR EACH ROW\nBEGIN\n IF (NOT (NEW.byte_size <=> OLD.byte_size)) AND ((SELECT state FROM installation) = 'ready' AND OLD.byte_size >= 0 AND NEW.byte_size > OLD.byte_size) THEN\n IF NEW.byte_size - OLD.byte_size + (SELECT COALESCE(SUM(GREATEST(byte_size,0)),0) FROM asset_references) + (SELECT COALESCE(SUM(amount),0) FROM quota_reservations WHERE kind = 'storage' AND expires_at > UNIX_TIMESTAMP() * 1000) > (SELECT storage_limit FROM installation) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STORAGE_LIMIT'; END IF;\n IF NEW.byte_size - OLD.byte_size + (SELECT COALESCE(SUM(GREATEST(a.byte_size,0)),0) FROM asset_references a JOIN boards b ON b.id = a.board_id WHERE b.created_by = (SELECT created_by FROM boards WHERE id = NEW.board_id)) + (SELECT COALESCE(SUM(amount),0) FROM quota_reservations WHERE kind = 'storage' AND user_id = (SELECT created_by FROM boards WHERE id = NEW.board_id) AND expires_at > UNIX_TIMESTAMP() * 1000) > (SELECT user_storage_limit FROM installation) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='USER_STORAGE_LIMIT'; END IF;\n\n END IF;\nEND",
  },
  {
    name: "bound_session_expiry",
    table: "auth_sessions",
    sql: "CREATE TRIGGER `bound_session_expiry` BEFORE UPDATE ON `auth_sessions` FOR EACH ROW\nBEGIN\n IF NEW.expiresAt > NEW.absoluteExpiresAt THEN\n SET NEW.expiresAt = NEW.absoluteExpiresAt;\n END IF;\nEND",
  },
  {
    name: "client_registry_limit",
    table: "oauth_clients",
    sql: "CREATE TRIGGER `client_registry_limit` BEFORE INSERT ON `oauth_clients` FOR EACH ROW\nBEGIN\n IF NOT EXISTS(SELECT 1 FROM oauth_clients WHERE id = NEW.id)\n AND (SELECT COUNT(*) FROM oauth_clients WHERE revoked_at IS NULL) >= 10000 THEN\n SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='CLIENT_LIMIT'; \n END IF;\nEND",
  },
  {
    name: "commit_asset_quota",
    table: "asset_references",
    sql: "CREATE TRIGGER `commit_asset_quota` BEFORE INSERT ON `asset_references` FOR EACH ROW\nBEGIN\n IF (SELECT state FROM installation) = 'ready' AND NOT EXISTS(SELECT 1 FROM asset_references WHERE board_id = NEW.board_id AND asset_key = NEW.asset_key) THEN\n IF NEW.byte_size < 0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STORAGE_INVENTORY_REQUIRED'; END IF;\n IF NEW.byte_size + (SELECT COALESCE(SUM(GREATEST(byte_size,0)),0) FROM asset_references) + (SELECT COALESCE(SUM(amount),0) FROM quota_reservations WHERE kind = 'storage' AND expires_at > UNIX_TIMESTAMP() * 1000) > (SELECT storage_limit FROM installation) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STORAGE_LIMIT'; END IF;\n IF NEW.byte_size + (SELECT COALESCE(SUM(GREATEST(a.byte_size,0)),0) FROM asset_references a JOIN boards b ON b.id = a.board_id WHERE b.created_by = (SELECT created_by FROM boards WHERE id = NEW.board_id)) + (SELECT COALESCE(SUM(amount),0) FROM quota_reservations WHERE kind = 'storage' AND user_id = (SELECT created_by FROM boards WHERE id = NEW.board_id) AND expires_at > UNIX_TIMESTAMP() * 1000) > (SELECT user_storage_limit FROM installation) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='USER_STORAGE_LIMIT'; END IF;\n\n END IF;\nEND",
  },
  {
    name: "email_changed_revoke",
    table: "auth_users",
    sql: "CREATE TRIGGER `email_changed_revoke` AFTER UPDATE ON `auth_users` FOR EACH ROW\nBEGIN\n IF (NOT (NEW.email <=> OLD.email)) AND (lower(NEW.email) <> lower(OLD.email)) THEN\n UPDATE users SET email = lower(NEW.email), updated_at = CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z') WHERE id = NEW.id;\n DELETE FROM auth_sessions WHERE userId = NEW.id;\n UPDATE account_security SET auth_version = auth_version + 1, updated_at = CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z') WHERE user_id = NEW.id;\n UPDATE oauth_tokens SET revoked_at = CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z') WHERE user_id = NEW.id AND revoked_at IS NULL;\n UPDATE oauth_grants SET revoked_at = CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z') WHERE user_id = NEW.id AND revoked_at IS NULL;\n INSERT INTO security_outbox(id,kind,payload,expires_at,next_attempt_at,attempts,status,created_at)\n VALUES (LOWER(HEX(RANDOM_BYTES(18))),'invalidate',json_object('userId',NEW.id),UNIX_TIMESTAMP()*1000+86400000,UNIX_TIMESTAMP()*1000,0,'pending',UNIX_TIMESTAMP()*1000);\n INSERT INTO security_audit(id,actor_id,action,target_id,outcome,metadata,created_at)\n VALUES (LOWER(HEX(RANDOM_BYTES(18))),NEW.id,'account.email_changed',NEW.id,'success','{}',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z'));\n\n END IF;\nEND",
  },
  {
    name: "installation_ready_audit",
    table: "installation",
    sql: "CREATE TRIGGER `installation_ready_audit` AFTER UPDATE ON `installation` FOR EACH ROW\nBEGIN\n IF (NOT (NEW.state <=> OLD.state)) AND (OLD.state = 'configuring' AND NEW.state = 'ready') THEN\n INSERT INTO security_audit(id,actor_id,action,target_id,outcome,metadata,created_at)\n VALUES (LOWER(HEX(RANDOM_BYTES(18))),NEW.owner_id,'installation.setup_completed','instance','success','{}',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z'));\n\n END IF;\nEND",
  },
  {
    name: "keep_designated_owner_delete",
    table: "instance_memberships",
    sql: "CREATE TRIGGER `keep_designated_owner_delete` BEFORE DELETE ON `instance_memberships` FOR EACH ROW\nBEGIN\n IF OLD.role = 'owner' AND EXISTS(SELECT 1 FROM installation WHERE state = 'ready' AND owner_id = OLD.user_id) THEN\n SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='LAST_OWNER'; \n END IF;\nEND",
  },
  {
    name: "keep_designated_owner_role",
    table: "instance_memberships",
    sql: "CREATE TRIGGER `keep_designated_owner_role` BEFORE UPDATE ON `instance_memberships` FOR EACH ROW\nBEGIN\n IF (NOT (NEW.role <=> OLD.role)) AND (OLD.role = 'owner' AND NEW.role <> 'owner' AND EXISTS(SELECT 1 FROM installation WHERE state = 'ready' AND owner_id = OLD.user_id)) THEN\n SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='LAST_OWNER'; \n END IF;\nEND",
  },
  {
    name: "keep_designated_owner_status",
    table: "account_security",
    sql: "CREATE TRIGGER `keep_designated_owner_status` BEFORE UPDATE ON `account_security` FOR EACH ROW\nBEGIN\n IF (NOT (NEW.status <=> OLD.status)) AND (NEW.status <> 'active' AND EXISTS(SELECT 1 FROM installation WHERE state = 'ready' AND owner_id = OLD.user_id)) THEN\n SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='LAST_OWNER'; \n END IF;\nEND",
  },
  {
    name: "keep_last_account",
    table: "auth_accounts",
    sql: "CREATE TRIGGER `keep_last_account` BEFORE DELETE ON `auth_accounts` FOR EACH ROW\nBEGIN\n IF EXISTS(SELECT 1 FROM account_security WHERE user_id = OLD.userId AND status = 'active')\n AND NOT EXISTS(SELECT 1 FROM auth_accounts WHERE userId = OLD.userId AND id <> OLD.id)\n AND NOT EXISTS(SELECT 1 FROM auth_passkeys WHERE userId = OLD.userId) THEN\n SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='LAST_METHOD'; \n END IF;\nEND",
  },
  {
    name: "keep_last_passkey",
    table: "auth_passkeys",
    sql: "CREATE TRIGGER `keep_last_passkey` BEFORE DELETE ON `auth_passkeys` FOR EACH ROW\nBEGIN\n IF EXISTS(SELECT 1 FROM account_security WHERE user_id = OLD.userId AND status = 'active' AND recovery_required = 0)\n AND NOT EXISTS(SELECT 1 FROM auth_passkeys WHERE userId = OLD.userId AND id <> OLD.id)\n AND (NOT EXISTS(SELECT 1 FROM auth_accounts WHERE userId = OLD.userId)\n OR (EXISTS(SELECT 1 FROM instance_memberships WHERE user_id = OLD.userId AND role IN ('owner','admin')) OR (SELECT mfa_required FROM installation) = 1)\n AND NOT EXISTS(SELECT 1 FROM auth_two_factors WHERE userId = OLD.userId AND verified = 1)) THEN\n SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='LAST_FACTOR'; \n END IF;\nEND",
  },
  {
    name: "keep_last_totp",
    table: "auth_two_factors",
    sql: "CREATE TRIGGER `keep_last_totp` BEFORE DELETE ON `auth_two_factors` FOR EACH ROW\nBEGIN\n IF EXISTS(SELECT 1 FROM account_security WHERE user_id = OLD.userId AND status = 'active' AND recovery_required = 0)\n AND (EXISTS(SELECT 1 FROM instance_memberships WHERE user_id = OLD.userId AND role IN ('owner','admin')) OR (SELECT mfa_required FROM installation) = 1)\n AND NOT EXISTS(SELECT 1 FROM auth_passkeys WHERE userId = OLD.userId) THEN\n SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='LAST_FACTOR'; \n END IF;\nEND",
  },
  {
    name: "mail_daily_quota",
    table: "security_outbox",
    sql: "CREATE TRIGGER `mail_daily_quota` BEFORE INSERT ON `security_outbox` FOR EACH ROW\nBEGIN\n IF NEW.kind = 'mail' THEN\n IF COALESCE((SELECT mail_limit FROM installation WHERE id='instance'),0) <= 0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='MAIL_LIMIT'; END IF;\n INSERT INTO daily_usage(day,kind,count) VALUES (DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d'),'mail',1) ON DUPLICATE KEY UPDATE count=count+1;\n IF (SELECT count FROM daily_usage WHERE day=DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d') AND kind='mail') > (SELECT mail_limit FROM installation WHERE id='instance') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='MAIL_LIMIT'; END IF;\n END IF;\nEND",
  },
  {
    name: "member_seat_change",
    table: "instance_memberships",
    sql: "CREATE TRIGGER `member_seat_change` BEFORE UPDATE ON `instance_memberships` FOR EACH ROW\nBEGIN\n IF (NOT (NEW.role <=> OLD.role)) AND ((OLD.role = 'guest') <> (NEW.role = 'guest') AND (SELECT COUNT(*) FROM instance_memberships WHERE (role = 'guest') = (NEW.role = 'guest') AND user_id <> NEW.user_id) >=\n (SELECT CASE WHEN NEW.role = 'guest' THEN guest_limit ELSE member_limit END FROM installation)) THEN\n SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='SEAT_LIMIT'; \n END IF;\nEND",
  },
  {
    name: "member_seat_limit",
    table: "instance_memberships",
    sql: "CREATE TRIGGER `member_seat_limit` BEFORE INSERT ON `instance_memberships` FOR EACH ROW\nBEGIN\n IF NEW.role <> 'owner' AND NOT EXISTS(SELECT 1 FROM instance_memberships WHERE user_id = NEW.user_id)\n AND (SELECT COUNT(*) FROM instance_memberships WHERE (role = 'guest') = (NEW.role = 'guest')) >=\n (SELECT CASE WHEN NEW.role = 'guest' THEN guest_limit ELSE member_limit END FROM installation) THEN\n SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='SEAT_LIMIT'; \n END IF;\nEND",
  },
  {
    name: "native_board_limit",
    table: "boards",
    sql: "CREATE TRIGGER `native_board_limit` BEFORE INSERT ON `boards` FOR EACH ROW\nBEGIN\n IF NEW.created_by IS NOT NULL AND EXISTS(SELECT 1 FROM account_security WHERE user_id = NEW.created_by) THEN\n IF NOT EXISTS(SELECT 1 FROM account_security WHERE user_id = NEW.created_by AND status = 'active') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ACCOUNT_UNAVAILABLE'; END IF;\n IF (SELECT COUNT(*) FROM boards WHERE deleted_at IS NULL) >= (SELECT board_limit FROM installation) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='BOARD_LIMIT'; END IF;\n IF (SELECT COUNT(*) FROM boards WHERE created_by = NEW.created_by AND deleted_at IS NULL) >= (SELECT user_board_limit FROM installation) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='USER_BOARD_LIMIT'; END IF;\n\n END IF;\nEND",
  },
  {
    name: "native_board_restore_limit",
    table: "boards",
    sql: "CREATE TRIGGER `native_board_restore_limit` BEFORE UPDATE ON `boards` FOR EACH ROW\nBEGIN\n IF (NOT (NEW.deleted_at <=> OLD.deleted_at)) AND (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL) THEN\n IF (SELECT COUNT(*) FROM boards WHERE deleted_at IS NULL) >= (SELECT board_limit FROM installation) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='BOARD_LIMIT'; END IF;\n IF (SELECT COUNT(*) FROM boards WHERE created_by = NEW.created_by AND deleted_at IS NULL) >= (SELECT user_board_limit FROM installation) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='USER_BOARD_LIMIT'; END IF;\n\n END IF;\nEND",
  },
  {
    name: "oauth_permissions_audit",
    table: "oauth_grants",
    sql: "CREATE TRIGGER `oauth_permissions_audit` AFTER UPDATE ON `oauth_grants` FOR EACH ROW\nBEGIN\n IF ((NOT (NEW.scopes <=> OLD.scopes) OR NOT (NEW.resource_mode <=> OLD.resource_mode) OR NOT (NEW.resources <=> OLD.resources) OR NOT (NEW.confirmed_version <=> OLD.confirmed_version)) OR JSON_OVERLAPS(COALESCE(@hl_catalog_update_columns, JSON_ARRAY()), JSON_ARRAY('scopes','resource_mode','resources','confirmed_version'))) THEN\n INSERT INTO security_audit(id,actor_id,action,target_id,outcome,metadata,created_at)\n VALUES (LOWER(HEX(RANDOM_BYTES(18))),NEW.user_id,'oauth.permissions_confirmed',NEW.id,'success',json_object('count',JSON_LENGTH(NEW.resources)),CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z'));\n\n END IF;\nEND",
  },
  {
    name: "password_added_revoke",
    table: "auth_accounts",
    sql: "CREATE TRIGGER `password_added_revoke` AFTER INSERT ON `auth_accounts` FOR EACH ROW\nBEGIN\n IF NEW.providerId = 'credential' AND NEW.password IS NOT NULL THEN\n DELETE FROM auth_sessions WHERE userId = NEW.userId;\n UPDATE account_security SET auth_version = auth_version + 1, updated_at = CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z') WHERE user_id = NEW.userId;\n UPDATE oauth_tokens SET revoked_at = CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z') WHERE user_id = NEW.userId AND revoked_at IS NULL;\n UPDATE oauth_grants SET revoked_at = CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z') WHERE user_id = NEW.userId AND revoked_at IS NULL;\n INSERT INTO security_outbox(id,kind,payload,expires_at,next_attempt_at,attempts,status,created_at)\n VALUES (LOWER(HEX(RANDOM_BYTES(18))),'invalidate',json_object('userId',NEW.userId),UNIX_TIMESTAMP()*1000+86400000,UNIX_TIMESTAMP()*1000,0,'pending',UNIX_TIMESTAMP()*1000);\n INSERT INTO security_audit(id,actor_id,action,target_id,outcome,metadata,created_at)\n VALUES (LOWER(HEX(RANDOM_BYTES(18))),NEW.userId,'account.password_added',NEW.userId,'success','{}',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z'));\n\n END IF;\nEND",
  },
  {
    name: "password_changed_revoke",
    table: "auth_accounts",
    sql: "CREATE TRIGGER `password_changed_revoke` AFTER UPDATE ON `auth_accounts` FOR EACH ROW\nBEGIN\n IF (NOT (NEW.password <=> OLD.password)) AND (NEW.providerId = 'credential' AND NEW.password IS NOT NULL AND NOT (NEW.password <=> OLD.password)) THEN\n DELETE FROM auth_sessions WHERE userId = NEW.userId;\n UPDATE account_security SET auth_version = auth_version + 1, updated_at = CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z') WHERE user_id = NEW.userId;\n UPDATE oauth_tokens SET revoked_at = CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z') WHERE user_id = NEW.userId AND revoked_at IS NULL;\n UPDATE oauth_grants SET revoked_at = CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z') WHERE user_id = NEW.userId AND revoked_at IS NULL;\n INSERT INTO security_outbox(id,kind,payload,expires_at,next_attempt_at,attempts,status,created_at)\n VALUES (LOWER(HEX(RANDOM_BYTES(18))),'invalidate',json_object('userId',NEW.userId),UNIX_TIMESTAMP()*1000+86400000,UNIX_TIMESTAMP()*1000,0,'pending',UNIX_TIMESTAMP()*1000);\n INSERT INTO security_audit(id,actor_id,action,target_id,outcome,metadata,created_at)\n VALUES (LOWER(HEX(RANDOM_BYTES(18))),NEW.userId,'account.password_changed',NEW.userId,'success','{}',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z'));\n\n END IF;\nEND",
  },
  {
    name: "replacement_factor_verified",
    table: "account_security",
    sql: "CREATE TRIGGER `replacement_factor_verified` BEFORE UPDATE ON `account_security` FOR EACH ROW\nBEGIN\n IF (NOT (NEW.recovery_required <=> OLD.recovery_required)) AND (OLD.recovery_required = 1 AND NEW.recovery_required = 0\n AND NOT EXISTS(SELECT 1 FROM auth_passkeys WHERE userId = OLD.user_id AND createdAt > OLD.recovery_started_at)\n AND NOT EXISTS(SELECT 1 FROM auth_two_factors WHERE userId = OLD.user_id AND verified = 1 AND enrolled_at > OLD.recovery_started_at)) THEN\n SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='REPLACEMENT_FACTOR_REQUIRED'; \n END IF;\nEND",
  },
  {
    name: "require_usable_login_method",
    table: "auth_method_changes",
    sql: "CREATE TRIGGER `require_usable_login_method` BEFORE INSERT ON `auth_method_changes` FOR EACH ROW\nBEGIN\n IF NEW.excluded_account IS NOT NULL AND NOT EXISTS(SELECT 1 FROM auth_accounts WHERE id = NEW.excluded_account AND userId = NEW.user_id) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='METHOD_CHANGED'; END IF;\n IF NEW.excluded_passkey IS NOT NULL AND NOT EXISTS(SELECT 1 FROM auth_passkeys WHERE id = NEW.excluded_passkey AND userId = NEW.user_id) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='METHOD_CHANGED'; END IF;\n IF (NEW.excluded_provider IS NULL OR EXISTS(SELECT 1 FROM auth_accounts WHERE userId = NEW.user_id AND providerId = NEW.excluded_provider))\n AND NOT EXISTS(SELECT 1 FROM auth_passkeys WHERE userId = NEW.user_id AND id <> COALESCE(NEW.excluded_passkey, ''))\n AND NOT EXISTS(\n   SELECT 1 FROM auth_accounts a WHERE a.userId = NEW.user_id\n   AND a.id <> COALESCE(NEW.excluded_account, '') AND a.providerId <> COALESCE(NEW.excluded_provider, '')\n   AND ((a.providerId = 'credential' AND a.password IS NOT NULL AND NEW.password_enabled = 1)\n     OR a.providerId IN (SELECT value COLLATE utf8mb4_0900_bin FROM JSON_TABLE(NEW.deployed_providers, '$[*]' COLUMNS (value VARCHAR(255) PATH '$')) AS deployed)\n     OR EXISTS(SELECT 1 FROM auth_provider_config p WHERE p.id = a.providerId AND p.enabled = 1 AND p.tested_at IS NOT NULL AND (p.id NOT LIKE 'oidc-%' OR NEW.database_oidc_enabled = 1)))\n ) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='LAST_METHOD'; END IF;\n\nEND",
  },
  {
    name: "reserve_asset_quota",
    table: "quota_reservations",
    sql: "CREATE TRIGGER `reserve_asset_quota` BEFORE INSERT ON `quota_reservations` FOR EACH ROW\nBEGIN\n IF NEW.kind = 'storage' THEN\n IF EXISTS(SELECT 1 FROM asset_gc_locks WHERE asset_key = NEW.resource_id AND expires_at > UNIX_TIMESTAMP() * 1000) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ASSET_RETRY'; END IF;\n IF (SELECT state FROM installation) = 'ready' AND EXISTS(SELECT 1 FROM asset_references WHERE byte_size < 0) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STORAGE_INVENTORY_REQUIRED'; END IF;\n IF (SELECT state FROM installation) = 'ready' AND NEW.amount + (SELECT COALESCE(SUM(GREATEST(byte_size,0)),0) FROM asset_references) + (SELECT COALESCE(SUM(amount),0) FROM quota_reservations WHERE kind = 'storage' AND expires_at > UNIX_TIMESTAMP() * 1000) > (SELECT storage_limit FROM installation) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STORAGE_LIMIT'; END IF;\n IF (SELECT state FROM installation) = 'ready' AND NEW.amount + (SELECT COALESCE(SUM(GREATEST(a.byte_size,0)),0) FROM asset_references a JOIN boards b ON b.id = a.board_id WHERE b.created_by = NEW.user_id) + (SELECT COALESCE(SUM(amount),0) FROM quota_reservations WHERE kind = 'storage' AND user_id = NEW.user_id AND expires_at > UNIX_TIMESTAMP() * 1000) > (SELECT user_storage_limit FROM installation) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='USER_STORAGE_LIMIT'; END IF;\n\n END IF;\nEND",
  },
  {
    name: "transfer_board_storage",
    table: "boards",
    sql: "CREATE TRIGGER `transfer_board_storage` BEFORE UPDATE ON `boards` FOR EACH ROW\nBEGIN\n IF (NOT (NEW.created_by <=> OLD.created_by)) AND (NOT (NEW.created_by <=> OLD.created_by) AND (SELECT state FROM installation) = 'ready') THEN\n IF (SELECT COALESCE(SUM(GREATEST(byte_size,0)),0) FROM asset_references WHERE board_id = NEW.id) + (SELECT COALESCE(SUM(GREATEST(a.byte_size,0)),0) FROM asset_references a JOIN boards b ON b.id = a.board_id WHERE b.created_by = NEW.created_by) > (SELECT user_storage_limit FROM installation) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='USER_STORAGE_LIMIT'; END IF;\n\n END IF;\nEND",
  },
  {
    name: "transferred_board_limit",
    table: "boards",
    sql: "CREATE TRIGGER `transferred_board_limit` BEFORE UPDATE ON `boards` FOR EACH ROW\nBEGIN\n IF (NOT (NEW.created_by <=> OLD.created_by)) AND (NEW.created_by IS NOT NULL AND NOT (NEW.created_by <=> OLD.created_by) AND NEW.deleted_at IS NULL) THEN\n IF (SELECT COUNT(*) FROM boards WHERE created_by = NEW.created_by AND deleted_at IS NULL) >= (SELECT user_board_limit FROM installation) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='USER_BOARD_LIMIT'; END IF;\n\n END IF;\nEND",
  },
  {
    name: "validate_content_transfer",
    table: "content_transfer_operations",
    sql: "CREATE TRIGGER `validate_content_transfer` BEFORE INSERT ON `content_transfer_operations` FOR EACH ROW\nBEGIN\n IF NEW.source_id = NEW.target_id OR NOT EXISTS(SELECT 1 FROM account_security s JOIN auth_users u ON u.id = s.user_id JOIN instance_memberships m ON m.user_id = s.user_id WHERE s.user_id = NEW.target_id AND s.status = 'active' AND s.recovery_required = 0 AND (u.emailVerified = 1 OR EXISTS(SELECT 1 FROM local_accounts WHERE user_id=u.id)) AND m.role <> 'guest') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='INVALID_RECIPIENT'; END IF;\n IF EXISTS(SELECT 1 FROM JSON_TABLE(NEW.resources, '$[*]' COLUMNS (value JSON PATH '$')) AS j WHERE\n   ((JSON_UNQUOTE(JSON_EXTRACT(j.value, '$.type')) COLLATE utf8mb4_0900_bin) = 'folder' AND NOT EXISTS(SELECT 1 FROM folders WHERE id = (JSON_UNQUOTE(JSON_EXTRACT(j.value, '$.id')) COLLATE utf8mb4_0900_bin) AND owner_id = NEW.source_id AND deleted_at IS NULL)) OR\n   ((JSON_UNQUOTE(JSON_EXTRACT(j.value, '$.type')) COLLATE utf8mb4_0900_bin) = 'board' AND NOT EXISTS(SELECT 1 FROM boards b JOIN resource_grants g ON g.resource_type = 'board' AND g.resource_id = b.id WHERE b.id = (JSON_UNQUOTE(JSON_EXTRACT(j.value, '$.id')) COLLATE utf8mb4_0900_bin) AND b.deleted_at IS NULL AND g.user_id = NEW.source_id AND g.role = 'owner')) OR\n   ((JSON_UNQUOTE(JSON_EXTRACT(j.value, '$.type')) COLLATE utf8mb4_0900_bin) = 'workbook' AND NOT EXISTS(SELECT 1 FROM workbooks w JOIN resource_grants g ON g.resource_type = 'workbook' AND g.resource_id = w.id WHERE w.id = (JSON_UNQUOTE(JSON_EXTRACT(j.value, '$.id')) COLLATE utf8mb4_0900_bin) AND w.deleted_at IS NULL AND g.user_id = NEW.source_id AND g.role = 'owner'))\n ) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='CONTENT_TRANSFER_CONFLICT'; END IF;\n\nEND",
  },
  {
    name: "validate_resource_ownership_transfer",
    table: "resource_ownership_transfers",
    sql: "CREATE TRIGGER `validate_resource_ownership_transfer` BEFORE INSERT ON `resource_ownership_transfers` FOR EACH ROW\nBEGIN\n IF NEW.source_id = NEW.target_id\n    OR NOT EXISTS(SELECT 1 FROM resource_grants WHERE resource_type = NEW.resource_type AND resource_id = NEW.resource_id AND user_id = NEW.source_id AND role = 'owner' AND (expires_at IS NULL OR expires_at > CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')))\n    OR NOT EXISTS(SELECT 1 FROM resource_grants WHERE resource_type = NEW.resource_type AND resource_id = NEW.resource_id AND user_id = NEW.target_id AND role <> 'owner' AND (expires_at IS NULL OR expires_at > CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')))\n    OR (NEW.resource_type = 'board' AND NOT EXISTS(SELECT 1 FROM boards b JOIN workbooks w ON w.id = b.workbook_id WHERE b.id = NEW.resource_id AND b.deleted_at IS NULL AND w.deleted_at IS NULL))\n    OR (NEW.resource_type = 'workbook' AND NOT EXISTS(SELECT 1 FROM workbooks WHERE id = NEW.resource_id AND deleted_at IS NULL))\n    THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='OWNERSHIP_TRANSFER_CONFLICT'; END IF;\n  IF EXISTS(SELECT 1 FROM account_security WHERE user_id IN (NEW.source_id, NEW.target_id) AND (status <> 'active' OR recovery_required = 1))\n    OR EXISTS(SELECT 1 FROM account_security WHERE user_id = NEW.source_id AND NEW.source_auth_version IS NOT NULL AND auth_version <> NEW.source_auth_version)\n    THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ACCOUNT_UNAVAILABLE'; END IF;\n\nEND",
  },
  {
    name: "verify_email_change_proof",
    table: "auth_users",
    sql: "CREATE TRIGGER `verify_email_change_proof` BEFORE UPDATE ON `auth_users` FOR EACH ROW\nBEGIN\n IF (NOT (NEW.email <=> OLD.email)) AND (lower(NEW.email) <> lower(OLD.email)\n AND NOT EXISTS(SELECT 1 FROM auth_email_proofs p JOIN account_security s ON s.user_id = p.user_id\n JOIN auth_confirmation_uses c ON c.token_hash = p.token_hash WHERE p.user_id = OLD.id AND p.purpose = 'change-email-verification'\n AND p.new_email = lower(NEW.email) AND p.auth_version = s.auth_version AND s.status = 'active' AND s.recovery_required = 0\n AND p.expires_at > UNIX_TIMESTAMP() * 1000)) THEN\n SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='EMAIL_PROOF_EXPIRED'; \n END IF;\nEND",
  },
  {
    name: "protect_active_auth_user_delete",
    table: "auth_users",
    sql: "CREATE TRIGGER `protect_active_auth_user_delete` BEFORE DELETE ON `auth_users` FOR EACH ROW BEGIN IF EXISTS(SELECT 1 FROM account_security WHERE user_id=OLD.id AND status='active') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='LAST_METHOD'; END IF; END",
  },
] as const;

export const CATALOG_SEED = [
  "INSERT INTO installation(id,state,created_at,cache_namespace) VALUES ('instance','unclaimed',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z'),LOWER(HEX(RANDOM_BYTES(16)))) ON DUPLICATE KEY UPDATE id=id",
  "INSERT INTO software_update_settings(id) VALUES ('instance') ON DUPLICATE KEY UPDATE id=id",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (1,'0001_catalog.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (2,'0002_collaboration.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (3,'0003_oauth.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (4,'0004_profiles_and_limits.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (5,'0005_native_auth_library.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (6,'0006_identity_policy.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (7,'0007_auth_operations.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (8,'0008_provider_validation.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (9,'0009_client_policy.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (10,'0010_security_invariants.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (11,'0011_authorization_and_onboarding.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (12,'0012_onboarding_intents.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (13,'0013_operations_invariants.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (14,'0014_content_transfer.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (15,'0015_mail_proofs.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (16,'0016_storage_reservations.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (17,'0017_asset_commit_invariants.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (18,'0018_operator_recovery.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (19,'0019_atomic_audit.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (20,'0020_usable_login_methods.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (21,'0021_password_revocation.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (22,'0022_resource_ownership_transfers.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (23,'0023_email_change_revocation.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (24,'0024_local_accounts.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (25,'0025_local_invitation_history.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
  "INSERT INTO d1_migrations(id,name,applied_at) VALUES (26,'0026_software_updates.sql',CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'), 'Z')) ON DUPLICATE KEY UPDATE name=name",
] as const;

export const CATALOG_SCHEMA_VERSION = "mysql-catalog-0026-v1";
export const CATALOG_SCHEMA_CHECKSUM =
  "8bd51fc8b8bb2939a4a6007e938e207112e4dfb2b115e72841a929d3ff9b19c3";
const initialSchemaChecksum = () =>
  createHash("sha256")
    .update(
      JSON.stringify([
        CATALOG_DDL,
        CATALOG_FOREIGN_KEYS,
        CATALOG_TRIGGERS,
        CATALOG_SEED,
      ]),
    )
    .digest("hex");

/** Caller holds the deployment advisory lock. DDL auto-commits; each step is restartable.
 * The completion marker is written only after every table, FK, trigger and seed succeeds.
 */
export async function installCatalogSchema(connection: PoolConnection) {
  if (initialSchemaChecksum() !== CATALOG_SCHEMA_CHECKSUM)
    throw new Error(
      "The frozen initial catalog changed. Add an append-only migration instead.",
    );
  await connection.execute(
    "CREATE TABLE IF NOT EXISTS hl_catalog_schema (id TINYINT PRIMARY KEY, version VARCHAR(64) NOT NULL, checksum CHAR(64) NOT NULL) ENGINE=InnoDB",
  );
  const [history] = await connection.execute(
    "SELECT version,checksum FROM hl_catalog_schema WHERE id=1",
  );
  const existing = (history as { version: string; checksum: string }[])[0];
  if (existing) {
    if (
      existing.version !== CATALOG_SCHEMA_VERSION ||
      existing.checksum !== CATALOG_SCHEMA_CHECKSUM
    )
      throw new Error(
        "Unsupported or changed MySQL catalog schema; refusing startup.",
      );
    return;
  }
  await connection.execute(
    "CREATE TABLE IF NOT EXISTS hl_catalog_mutex (id TINYINT PRIMARY KEY) ENGINE=InnoDB",
  );
  await connection.execute(
    "INSERT INTO hl_catalog_mutex(id) VALUES (1) ON DUPLICATE KEY UPDATE id=id",
  );
  for (const table of CATALOG_DDL) await connection.execute(table.sql);
  for (const foreignKey of CATALOG_FOREIGN_KEYS) {
    const [rows] = await connection.execute(
      "SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_NAME=?",
      [foreignKey.table, foreignKey.name],
    );
    if (!(rows as unknown[]).length) await connection.execute(foreignKey.sql);
  }
  for (const trigger of CATALOG_TRIGGERS) {
    await connection.query("DROP TRIGGER IF EXISTS `" + trigger.name + "`");
    await connection.query(trigger.sql);
  }
  for (const seed of CATALOG_SEED) await connection.execute(seed);
  await connection.execute(
    "INSERT INTO hl_catalog_schema(id,version,checksum) VALUES (1,?,?)",
    [CATALOG_SCHEMA_VERSION, CATALOG_SCHEMA_CHECKSUM],
  );
}

export interface CatalogMigrationStep {
  id: string;
  sql: string;
  /** SELECT exactly one row with applied=0 before, applied=1 after this step.
   * Verify the complete intended schema/data definition, not merely a name.
   * This closes the crash window between MySQL DDL auto-commit and our ledger. */
  applied: string;
}
export interface CatalogMigration {
  id: string;
  steps: readonly CatalogMigrationStep[];
}
/** Never edit a released entry. Append new migrations with independently resumable steps. */
// This guard verifies the complete new table, including constraints and indexes.
// If interrupted CREATE committed, it returns 1; malformed existing tables fail
// closed when CREATE reports that the table already exists.
function guestTableGuard(table: string, columns: [string, string, boolean][], indexes: [string, string, number][], foreignKeys: [string, string, string][], roleCheck = false) {
  const columnConditions = columns.map(([name, type, nullable]) => `(COLUMN_NAME='${name}' AND COLUMN_TYPE='${type}' AND IS_NULLABLE='${nullable ? "YES" : "NO"}' AND COLUMN_DEFAULT IS NULL AND EXTRA='' AND COLLATION_NAME='utf8mb4_0900_bin')`).join(' OR ');
  const indexConditions = indexes.map(([name, names, unique]) => `(INDEX_NAME='${name}' AND cols='${names}' AND NON_UNIQUE=${unique})`).join(' OR ');
  const fkConditions = foreignKeys.map(([column, target, name]) => `(k.CONSTRAINT_NAME='${name}' AND k.COLUMN_NAME='${column}' AND k.REFERENCED_TABLE_NAME='${target}' AND k.REFERENCED_COLUMN_NAME='id' AND r.DELETE_RULE='NO ACTION' AND r.UPDATE_RULE='NO ACTION')`).join(' OR ');
  return `SELECT (
    EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='${table}' AND ENGINE='InnoDB' AND TABLE_COLLATION='utf8mb4_0900_bin')
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='${table}')=${columns.length}
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='${table}' AND (${columnConditions}))=${columns.length}
    AND (SELECT COUNT(*) FROM (SELECT INDEX_NAME,NON_UNIQUE,GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) cols FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='${table}' GROUP BY INDEX_NAME,NON_UNIQUE) i)=${indexes.length}
    AND (SELECT COUNT(*) FROM (SELECT INDEX_NAME,NON_UNIQUE,GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) cols FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='${table}' AND SUB_PART IS NULL GROUP BY INDEX_NAME,NON_UNIQUE) i WHERE ${indexConditions})=${indexes.length}
    AND (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE k WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME='${table}' AND k.REFERENCED_TABLE_NAME IS NOT NULL)=${foreignKeys.length}
    AND (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME='${table}' AND (${fkConditions}))=${foreignKeys.length}
    AND (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='${table}' AND CONSTRAINT_TYPE='CHECK')=${roleCheck ? 1 : 0}
    ${roleCheck ? "AND EXISTS(SELECT 1 FROM information_schema.CHECK_CONSTRAINTS c JOIN information_schema.TABLE_CONSTRAINTS t ON t.CONSTRAINT_SCHEMA=c.CONSTRAINT_SCHEMA AND t.CONSTRAINT_NAME=c.CONSTRAINT_NAME WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_NAME='guest_board_links' AND t.ENFORCED='YES' AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(c.CHECK_CLAUSE,'`',''),' ',''),'(',''),')',''),'_utf8mb4',''),CHAR(92),'')='rolein''viewer'',''commenter'',''editor''')" : ''}
  ) AS applied`;
}
export const CATALOG_MIGRATIONS: readonly CatalogMigration[] = [{
  id: "0002_guest_board_links",
  steps: [{
    id: "0001_links",
    sql: `CREATE TABLE guest_board_links (
      id VARCHAR(255) PRIMARY KEY, board_id VARCHAR(255) NOT NULL,
      created_by VARCHAR(255) NOT NULL, token_hash VARCHAR(255) NOT NULL UNIQUE,
      token_ciphertext TEXT NOT NULL, role VARCHAR(64) NOT NULL,
      password_hash TEXT, expires_at VARCHAR(32), revoked_at VARCHAR(32), created_at VARCHAR(32) NOT NULL,
      CONSTRAINT guest_link_role CHECK (role IN ('viewer','commenter','editor')),
      CONSTRAINT fk_guest_links_board FOREIGN KEY(board_id) REFERENCES boards(id),
      CONSTRAINT fk_guest_links_creator FOREIGN KEY(created_by) REFERENCES users(id),
      INDEX guest_links_board_created(board_id,created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`,
    applied: guestTableGuard('guest_board_links', [
      ['id','varchar(255)',false],['board_id','varchar(255)',false],['created_by','varchar(255)',false],
      ['token_hash','varchar(255)',false],['token_ciphertext','text',false],['role','varchar(64)',false],
      ['password_hash','text',true],['expires_at','varchar(32)',true],['revoked_at','varchar(32)',true],['created_at','varchar(32)',false]
    ], [['PRIMARY','id',0],['token_hash','token_hash',0],['guest_links_board_created','board_id,created_at',1],['fk_guest_links_creator','created_by',1]], [['board_id','boards','fk_guest_links_board'],['created_by','users','fk_guest_links_creator']], true)
  }, {
    id: "0002_sessions",
    sql: `CREATE TABLE guest_board_sessions (
      id VARCHAR(255) PRIMARY KEY, link_id VARCHAR(255) NOT NULL, user_id VARCHAR(255) NOT NULL,
      token_hash VARCHAR(255) NOT NULL UNIQUE, expires_at VARCHAR(32) NOT NULL, created_at VARCHAR(32) NOT NULL,
      CONSTRAINT fk_guest_sessions_link FOREIGN KEY(link_id) REFERENCES guest_board_links(id),
      CONSTRAINT fk_guest_sessions_user FOREIGN KEY(user_id) REFERENCES users(id),
      INDEX guest_sessions_link_expiry(link_id,expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`,
    applied: guestTableGuard('guest_board_sessions', [['id','varchar(255)',false],['link_id','varchar(255)',false],['user_id','varchar(255)',false],['token_hash','varchar(255)',false],['expires_at','varchar(32)',false],['created_at','varchar(32)',false]], [['PRIMARY','id',0],['token_hash','token_hash',0],['guest_sessions_link_expiry','link_id,expires_at',1],['fk_guest_sessions_user','user_id',1]], [['link_id','guest_board_links','fk_guest_sessions_link'],['user_id','users','fk_guest_sessions_user']])
  }, {
    id: "0003_migration_marker",
    sql: "INSERT INTO d1_migrations(id,name,applied_at) VALUES (27,'0027_guest_board_links.sql',DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.000Z'))",
    applied: "SELECT EXISTS(SELECT 1 FROM d1_migrations WHERE id=27 AND name='0027_guest_board_links.sql') AS applied"
  }]
}, {
  id: "0003_guest_session_expiry_index",
  steps: [{
    id: "0001_expiry_index",
    sql: "CREATE INDEX guest_sessions_expiry ON guest_board_sessions(expires_at)",
    applied: "SELECT ((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='guest_board_sessions' AND INDEX_NAME='guest_sessions_expiry')=1 AND EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='guest_board_sessions' AND INDEX_NAME='guest_sessions_expiry' AND COLUMN_NAME='expires_at' AND SEQ_IN_INDEX=1 AND NON_UNIQUE=1 AND SUB_PART IS NULL AND IS_VISIBLE='YES')) AS applied"
  }]
}];
export const catalogMigrationChecksum = (migration: CatalogMigration) =>
  createHash("sha256").update(JSON.stringify(migration)).digest("hex");
const stepChecksum = (step: CatalogMigrationStep) =>
  createHash("sha256").update(JSON.stringify(step)).digest("hex");

export async function applyCatalogMigrations(
  connection: PoolConnection,
  migrations: readonly CatalogMigration[] = CATALOG_MIGRATIONS,
) {
  const validId = (id: string) =>
    id.length <= 128 && /^[0-9]{4}_[a-z0-9_]+$/.test(id);
  const ids = migrations.map((item) => item.id);
  if (
    ids.some((id) => !validId(id) || id <= "0001_initial") ||
    new Set(ids).size !== ids.length ||
    ids.some((id, index) => index > 0 && id <= ids[index - 1])
  )
    throw new Error("Invalid catalog migration ordering");
  for (const migration of migrations) {
    if (
      !migration.steps.length ||
      new Set(migration.steps.map((step) => step.id)).size !==
        migration.steps.length ||
      migration.steps.some(
        (step) =>
          !validId(step.id) || !step.sql || !/^\s*SELECT\b/i.test(step.applied),
      )
    )
      throw new Error("Invalid resumable catalog migration steps");
  }
  await installCatalogSchema(connection);
  await connection.query(
    "CREATE TABLE IF NOT EXISTS hl_catalog_migrations (id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)) ENGINE=InnoDB",
  );
  await connection.query(
    "CREATE TABLE IF NOT EXISTS hl_catalog_migration_steps (migration_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, step_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, checksum CHAR(64) NOT NULL, PRIMARY KEY(migration_id,step_id)) ENGINE=InnoDB",
  );
  await connection.query(
    "CREATE TABLE IF NOT EXISTS hl_catalog_migration_intents (id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, checksum CHAR(64) NOT NULL) ENGINE=InnoDB",
  );
  const [base] = await connection.execute(
    "SELECT checksum FROM hl_catalog_migrations WHERE id=?",
    ["0001_initial"],
  );
  if (
    (base as { checksum: string }[]).length &&
    (base as { checksum: string }[])[0].checksum !== CATALOG_SCHEMA_CHECKSUM
  )
    throw new Error("Initial migration history changed");
  if (!(base as unknown[]).length)
    await connection.execute(
      "INSERT INTO hl_catalog_migrations(id,checksum) VALUES(?,?)",
      ["0001_initial", CATALOG_SCHEMA_CHECKSUM],
    );
  const [history] = await connection.query(
    "SELECT id,checksum FROM hl_catalog_migrations WHERE id<>'0001_initial' ORDER BY id",
  );
  const applied = history as { id: string; checksum: string }[];
  for (let index = 0; index < applied.length; index++) {
    const expected = migrations[index];
    if (
      !expected ||
      applied[index].id !== expected.id ||
      applied[index].checksum !== catalogMigrationChecksum(expected)
    )
      throw new Error(
        "Unknown, newer or altered catalog migration; refusing startup",
      );
  }
  const [intentRows] = await connection.query(
    "SELECT id,checksum FROM hl_catalog_migration_intents",
  );
  const intents = intentRows as { id: string; checksum: string }[];
  for (const intent of intents) {
    const position = migrations.findIndex((item) => item.id === intent.id);
    if (
      position < 0 ||
      position > applied.length ||
      intent.checksum !== catalogMigrationChecksum(migrations[position])
    )
      throw new Error(
        "Unknown, newer or altered pending catalog migration; refusing startup",
      );
  }
  const [savedSteps] = await connection.query(
    "SELECT migration_id,step_id,checksum FROM hl_catalog_migration_steps",
  );
  const steps = savedSteps as {
    migration_id: string;
    step_id: string;
    checksum: string;
  }[];
  for (const recorded of steps) {
    const migration = migrations.find(
      (item) => item.id === recorded.migration_id,
    );
    const step = migration?.steps.find((item) => item.id === recorded.step_id);
    if (!step || recorded.checksum !== stepChecksum(step))
      throw new Error(
        "Unknown or altered catalog migration step; refusing startup",
      );
    const position = migrations.findIndex(
      (item) => item.id === recorded.migration_id,
    );
    if (position > applied.length)
      throw new Error("Catalog migration steps are out of order");
  }
  for (const migration of migrations) {
    const complete = applied.some((item) => item.id === migration.id);
    const intended = intents.some((item) => item.id === migration.id);
    if (complete && !intended)
      throw new Error("Completed catalog migration is missing its intent");
    // Durable intent precedes DDL: older code must refuse even if the process
    // exits after an ALTER auto-commits but before its completion is recorded.
    if (!intended)
      await connection.execute(
        "INSERT INTO hl_catalog_migration_intents(id,checksum) VALUES(?,?)",
        [migration.id, catalogMigrationChecksum(migration)],
      );
    for (const step of migration.steps) {
      const recorded = steps.some(
        (item) =>
          item.migration_id === migration.id && item.step_id === step.id,
      );
      if (complete && !recorded)
        throw new Error("Completed catalog migration is missing step history");
      if (complete) continue; // Later migrations may intentionally supersede this definition.
      const state = async () => {
        const [rows] = await connection.query(step.applied);
        const result = rows as { applied: unknown }[];
        if (
          result.length !== 1 ||
          ![0, 1, "0", "1"].includes(result[0].applied as string | number)
        )
          throw new Error("Invalid catalog migration verification result");
        return Number(result[0].applied) === 1;
      };
      let done = await state();
      if (recorded && !done)
        throw new Error(
          "Completed catalog migration step no longer matches its definition",
        );
      if (!done) {
        await connection.query(step.sql);
        done = await state();
      }
      if (!done) throw new Error("Catalog migration step failed verification");
      if (!recorded)
        await connection.execute(
          "INSERT INTO hl_catalog_migration_steps(migration_id,step_id,checksum) VALUES(?,?,?)",
          [migration.id, step.id, stepChecksum(step)],
        );
    }
    if (!complete)
      await connection.execute(
        "INSERT INTO hl_catalog_migrations(id,checksum) VALUES(?,?)",
        [migration.id, catalogMigrationChecksum(migration)],
      );
  }
}

/** Installation only: do not open the HTTP listener until this returns. */
export async function migrateCatalogSchema(
  pool: Pool,
  migrations: readonly CatalogMigration[] = CATALOG_MIGRATIONS,
) {
  const connection = await pool.getConnection();
  let locked = false;
  let reusable = true;
  try {
    const [databases] = await connection.query("SELECT DATABASE() AS name");
    const database = (databases as { name: string }[])[0]?.name;
    if (!database) throw new Error("Catalog requires a selected database.");
    const lock =
      "hl-catalog-" +
      createHash("sha256").update(database).digest("hex").slice(0, 48);
    const [rows] = await connection.execute(
      "SELECT GET_LOCK(?,30) AS acquired",
      [lock],
    );
    if (Number((rows as { acquired: number }[])[0]?.acquired) !== 1)
      throw new Error("Could not acquire catalog migration lock.");
    locked = true;
    try {
      await applyCatalogMigrations(connection, migrations);
    } finally {
      await connection.execute("SELECT RELEASE_LOCK(?)", [lock]);
      locked = false;
    }
  } catch (error) {
    if (locked) reusable = false;
    throw error;
  } finally {
    if (reusable) connection.release();
    else connection.destroy();
  }
}
