# Administration and recovery

## First owner

Native sign-in works without Cloudflare Access. Set a private `SETUP_PASSWORD` in the hosting dashboard, open the canonical application address, and complete owner setup. Save the recovery key and verify a passkey or authenticator before finishing.

The application creates private authentication and encryption keys automatically. Cloudflare stores them in the `INSTALLATION_KEYS` Durable Object. Node stores them in private MySQL records. The catalog records their fingerprint and refuses a replacement key ring after key loss. Preserve the keys and catalog together. Explicit operator-supplied keys take precedence over generated keys.

The setup password protects the initial claim; it does not replace the owner's account password. Redeployment does not reopen a claimed installation. The canonical HTTPS origin must remain consistent for sign-in, cookies, and OAuth.

## People and permissions

Owners manage registration, security policy, providers, limits, and designated ownership. Administrators manage permitted people, invitations, and operational activity. Their administrative role does not grant access to private boards.

Leave public registration closed until you have tested sign-in, recovery, and backups. Private, single-use invitation links work before email is connected. Local accounts receive a recovery key; replacing it invalidates the old one.

Use a clear role when inviting someone. Resource transfers require an active verified recipient, a reason, and fresh strong authentication. The last designated owner cannot be removed through ordinary account or membership changes.

## Email and sign-in providers

Email and external sign-in providers are optional. Local usernames and private invitation links let a small group get started without either.

Cloudflare Email Service requires an eligible account, a sending domain approved by Cloudflare, and the `EMAIL` binding. Follow the [sending-domain setup](https://developers.cloudflare.com/email-service/get-started/send-emails/). These account approvals still require the operator.

For Resend, configure `MAIL_PROVIDER=resend`, a verified `MAIL_FROM`, and a private `MAIL_API_KEY`. Configure `MAIL_WEBHOOK_SECRET` for signed delivery receipts at `/api/v1/mail/webhook`.

GoDaddy uses its managed email gateway. Other Node hosts can use TLS-required SMTP. The application uses a durable outbox and bounded provider timeouts. Send a test and confirm the received code before enabling email-dependent account flows. Provider acceptance is different from confirmed delivery. Bounced and complained-about addresses are suppressed.

Administration shows queue and delivery status. Correct the underlying problem before retrying a failed job. Do not remove the Cloudflare maintenance schedule: mail and cleanup work use it.

External providers must return a verified address and meet admission policy. Provider secrets are write-only. Keep a working authentication method before changing a provider, and test its real callback before opening registration. Add only trusted public HTTPS origins to OIDC discovery or client-metadata allowlists.

## Connected apps and revocation

Connected apps shows each assistant's scopes, allowed resources, expiry, and last use. Narrow or revoke access there. Increasing its reach needs a new consent flow.

HTTP and MCP requests check current account and grant state. Board connections recheck authorization on a five-second lease; protected broadcasts force a fresh check. A suspended, expired, or revoked identity cannot keep editing through an old socket. Database failures fail closed after the lease expires.

Password changes and secure account recovery revoke existing browser sessions and assistant grants. Signing out of one browser does not revoke separate assistant authorizations; manage those in Connected apps.

Unsynced edits and cached assets belong to the installation and original user. On voluntary sign-out, review the download, discard, or cancel options. A local recovery file creates a new board when imported and is not a complete server backup.

## Backups

A native board archive is useful for moving a board. It is not an installation backup.

For Cloudflare, preserve the D1 catalog, Durable Object board state and revisions, R2 assets, and installation keys. D1 Time Travel protects the catalog only. Do not assume it restores board rooms or uploaded files. An independent restore procedure for all stores is required before treating an installation as recoverable.

For GoDaddy's default adapter, back up the private SQLite catalog and the complete MySQL installation together. Stop the app or use a supported SQLite backup operation; copying only a live WAL-mode database file can lose data. Full-MySQL installations need the complete database, including keys, board data, and uploads.

Keep backups encrypted and outside public assets. Test a restore into isolated storage and a separate origin. Never start the restored app against live resources. Invalidate restored sessions, assistant grants, and pending identity proofs before admitting traffic.

For an isolated Cloudflare catalog restore, run from `apps/web`:

```sh
node scripts/operator.mjs invalidate-restored-sessions --remote --config YOUR_BUILT_CONFIG --expected-origin https://RESTORED_APP --execute
```

Review the intended configuration and origin first. This command changes credentials in the selected catalog. It does not restore storage or move an installation between origins.

## Emergency owner recovery on Cloudflare

Try ordinary account recovery before this operator procedure. It requires control of the deployment and an already configured owner. Run from `apps/web` with the built configuration for that installation:

```sh
node scripts/operator.mjs recover-owner --remote --config YOUR_BUILT_CONFIG --origin https://YOUR_APP --reason 'Lost owner authentication devices' --output /private/path/owner-recovery.txt --execute
```

Find the built configuration path in `.wrangler/deploy/config.json`. The output is a private, single-use link valid for ten minutes. Issuing it invalidates earlier emergency links and records an audit event. Using it revokes existing sessions and assistant grants and creates a restricted factor-replacement session. Enroll a replacement factor, finish recovery, and sign in again. Delete the link file after use.

The operator tool speaks to Cloudflare D1. Do not use it against a Node installation or edit account tables to bypass recovery.

## Explicit keys and rotation

Most installations should retain automatically generated keys. Operators choosing explicit keys can generate an owner-readable file outside the repository:

```sh
cd apps/web
node scripts/operator.mjs generate-secrets --output /private/path/huddle-secrets.json
pnpm exec wrangler secret bulk /private/path/huddle-secrets.json --config wrangler.native.jsonc
```

The generator refuses to overwrite an existing file. Keep a protected backup. Do not replace keys on a populated installation by importing a new unrelated ring.

There are two encryption systems: `AUTH_ENCRYPTION_KEYS` for configured secrets and queued proofs, and Better Auth's authentication secrets for its ciphertext. Rotation must retain old decrypt keys until data has been re-encrypted. Review `scripts/rekey.ts` and rehearse against an isolated restore before changing a live ring. Password verifiers and hashed assistant tokens do not require re-encryption.

## Incident handling

Restrict registration, suspend affected accounts or revoke assistant grants, and preserve sanitized audit records. Protect hosting credentials separately from application accounts. Rotate a compromised credential using its supported procedure and review the data it could access.

For a suspected product vulnerability, use [private reporting](https://github.com/sportwhiz/huddle-loom/security/advisories/new). Include the version and hosting adapter, with tokens and board content removed.

## Repeated identity checks

In **Administration → Sign-in settings → Registration and security**, the Studio owner can choose **Ask again for protected changes after**. The default is 30 minutes; choices range from five minutes to 12 hours. A longer window reduces interruptions when managing accounts, changing security settings or approving connected apps.

The window starts with the last successful identity check in that browser session. Password confirmation alone cannot satisfy a required second factor. New sign-ins still require MFA when the account or Studio policy requires it. Viewing linked login methods does not require a fresh check. Sign-out, account suspension, session expiry and credential revocation still invalidate access. A policy change applies to existing sessions on their next protected request.

This setting is separate from the inactivity and maximum session lifetime settings. Longer verification windows mean someone with access to an unlocked, signed-in browser has more time to make protected changes.
