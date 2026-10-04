-- These short-lived guard rows are inserted and removed in the same mutation
-- batch. Checking current methods inside SQLite serializes provider changes and
-- credential removals, including requests from different Worker isolates.
CREATE TABLE auth_method_changes (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 excluded_account TEXT,
 excluded_passkey TEXT,
 excluded_provider TEXT,
 deployed_providers TEXT NOT NULL,
 password_enabled INTEGER NOT NULL,
 database_oidc_enabled INTEGER NOT NULL
);
CREATE TRIGGER require_usable_login_method BEFORE INSERT ON auth_method_changes
BEGIN
 SELECT (CASE WHEN NEW.excluded_account IS NOT NULL AND NOT EXISTS(SELECT 1 FROM auth_accounts WHERE id = NEW.excluded_account AND userId = NEW.user_id) THEN RAISE(ABORT, 'METHOD_CHANGED') END);
 SELECT (CASE WHEN NEW.excluded_passkey IS NOT NULL AND NOT EXISTS(SELECT 1 FROM auth_passkeys WHERE id = NEW.excluded_passkey AND userId = NEW.user_id) THEN RAISE(ABORT, 'METHOD_CHANGED') END);
 SELECT (CASE WHEN
 (NEW.excluded_provider IS NULL OR EXISTS(SELECT 1 FROM auth_accounts WHERE userId = NEW.user_id AND providerId = NEW.excluded_provider))
 AND NOT EXISTS(SELECT 1 FROM auth_passkeys WHERE userId = NEW.user_id AND id <> COALESCE(NEW.excluded_passkey, ''))
 AND NOT EXISTS(
   SELECT 1 FROM auth_accounts a WHERE a.userId = NEW.user_id
   AND a.id <> COALESCE(NEW.excluded_account, '') AND a.providerId <> COALESCE(NEW.excluded_provider, '')
   AND ((a.providerId = 'credential' AND a.password IS NOT NULL AND NEW.password_enabled = 1)
     OR a.providerId IN (SELECT value FROM json_each(NEW.deployed_providers))
     OR EXISTS(SELECT 1 FROM auth_provider_config p WHERE p.id = a.providerId AND p.enabled = 1 AND p.tested_at IS NOT NULL AND (p.id NOT LIKE 'oidc-%' OR NEW.database_oidc_enabled = 1)))
 ) THEN RAISE(ABORT, 'LAST_METHOD') END);
END;
