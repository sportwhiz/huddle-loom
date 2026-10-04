# Open Whiteboard on GoDaddy Node.js Hosting

This package runs the same editor, accounts, administration, OAuth/MCP and board services as the Cloudflare application. Managed MySQL stores board state, uploads and private installation keys. GoDaddy’s durable private volume stores the SQLite account/catalog database, retaining its security triggers without requiring MySQL trigger privileges. Other Node hosts can use a full MySQL catalog. The Cloudflare build and deployment commands keep their existing behavior.

A GoDaddy preview has been tested with administrator onboarding, connected notes, comments, collaboration, a package upgrade, and a restart with board data preserved. Before using Publish for important work, verify email, MCP, backups, and the provider limits below. Installation uses a dashboard ZIP upload.

## Package

Download `huddle-loom-node.zip` from [Releases](https://github.com/sportwhiz/huddle-loom/releases). Maintainers can build it with `pnpm package:node` from the repository root. This produces `apps/web/huddle-loom-node.zip` and a SHA-256 checksum file. The archive has a root `package.json`, pinned production dependencies, prebuilt server and editor, and database migrations. It excludes development tools, credentials and `node_modules`.

Users upload this archive through the Node.js Hosting dashboard. They do not need to build the repository, install a CLI, or configure GitHub sign-in. GoDaddy installs the production dependencies, validates the package and starts the server using its assigned port.

## First installation

1. Create a Node.js Hosting app and enable its managed MySQL database. Use Node 22.16 or newer within Node 22. The host supplies `PORT` and the five `DB_*` connection settings; keep them in the hosting dashboard.
2. You may upload the package before these two settings are ready. The app serves a public installation guide instead of crashing for a missing or invalid canonical address or setup passphrase. It never accepts a passphrase, writes settings, or lets a visitor claim ownership. Set `AUTH_ORIGIN` to the exact public application origin, such as `https://your-app.example.com`, without a path or trailing slash. Set a private `SETUP_PASSWORD` of at least 16 characters. Select the intended Preview or Publish settings tab; each variant has its own settings. No GitHub OAuth credentials are needed. Keep the setup password private.
3. Upload `huddle-loom-node.zip`. Startup creates the database tables and private installation keys automatically once configured. The guide only handles address and setup-passphrase configuration; a missing database, unsupported permissions or conflicting active server prevents startup rather than exposing an incomplete app.
4. Open that application URL. Enter your setup password, create your administrator username and password, save the recovery code and enroll an authenticator. Finish the Studio setup.
5. Send a test email to your inbox from the setup screen. GoDaddy selects the sender. Enter the received code to confirm delivery. Private account invitation links work before email is confirmed.
6. Create a board, open it in two browser sessions and verify collaboration. From Connected apps, connect the production origin ending in `/mcp` to your assistant and try a workflow with connected sticky notes.

The default `HUDDLE_PLATFORM=godaddy` uses the qualified private catalog under `/private/huddle-loom` and enables the managed mail gateway. No extra storage setting is required. `node-mysql` selects the full MySQL catalog on other Node hosts; `node-private-volume` requires an explicitly configured persistent directory. Keep an existing installation’s backend and directory settings unchanged.

### Database security

TLS with certificate verification is the default. If GoDaddy supplies a private CA, configure `DB_CA`. Do not disable verification to work around an unexplained connection error. `DB_TLS=disabled` exists for disposable local tests and a host whose documented internal database contract requires plaintext; qualify that contract before using it.

The default GoDaddy catalog retains its security triggers in SQLite, so it does not require MySQL catalog trigger privileges. A full MySQL installation on another Node host needs foreign keys and trigger privileges; refuse unsupported privileges rather than removing security guards.

## Installation guide and readiness

The guide is available at `/` on the host-assigned port. It offers copy buttons for setting names and the browser’s HTTPS origin. Verify that origin against your hosting dashboard before saving it; request headers are never used as proof of ownership. Enter the setup passphrase only in the hosting dashboard’s private settings, then restart or redeploy. The normal owner setup screen appears after configuration succeeds.

While showing the guide, `/healthz` returns HTTP **503** with `{"ready":false,"status":"configuration_required"}`. `/` returns 200 so you can read the instructions. Board routes, account APIs, MCP and mutation requests remain unavailable. A platform readiness check aimed at `/healthz` will correctly keep this installation unready until configured; open the dashboard preview/root URL to read the guide, or set the values directly in the dashboard.

Database failures, missing installation keys, migration failures and ownership conflicts do not open an installer. They remain startup failures with sanitized diagnostics. A configuration guide must not become an account recovery or authentication bypass.

## Private catalog and legacy installations

GoDaddy’s in-dashboard storage guide describes durable private storage at `/private` and recommends it for file databases. Legacy installations can retain `HUDDLE_PLATFORM=node-private-volume`, `HUDDLE_DATA_DIRECTORY=/private/huddle-loom`, and `HUDDLE_MAIL_GATEWAY=godaddy`. It retains the original SQLite security triggers and uses managed MySQL for rooms, assets, keys and ownership. This avoids MySQL catalog trigger privileges. Verify the actual mount supports SQLite locking, journaling and persistence across a replacement before relying on it. Never move an existing populated catalog between backends by changing settings alone.

Both the private catalog and MySQL data are required for recovery. Take coordinated backups with the application stopped or a supported SQLite backup operation; do not copy only a live WAL-mode database file. Keep the private directory outside public assets and retain its private filesystem permissions.

## One active server per installation

One running Node application process owns an installation's database. It can serve many people and boards. A MySQL advisory lock rejects a second process before it changes the schema or serves traffic. If the lock's connection is lost, the app stops serving board writes, fails readiness and shuts down so the host can restart it.

This protects live collaboration from two servers keeping different in-memory states for the same board. It is not a one-user limit. It does mean this first Node implementation cannot run several app processes against the same installation or perform an overlapping rolling deployment. The Cloudflare runtime continues to use Durable Objects for board ownership.

Use separate installations for preview and production. `HUDDLE_DATABASE_NAMESPACE=preview` or `live` can separate supported Node installations inside a shared managed database. GoDaddy has separate Preview and Publish secrets/settings tabs and a “Sync from Preview” action; the managed database and private volume are shared. Configure each variant separately. For a new production installation, use the default `HUDDLE_PLATFORM=godaddy` and `HUDDLE_DATABASE_NAMESPACE=live` in Publish, while preserving the existing Preview backend, data directory and namespace settings. Do not blindly sync Preview settings into Publish, especially when Preview uses the legacy private SQLite catalog. Do not switch namespace values on an existing installation during updates: the value identifies its data, not the deployment label. For private SQLite catalogs, a nonempty namespace selects a matching subdirectory inside the private data directory; an unset namespace preserves the original catalog path. The namespace-aware runtime isolates MySQL tables, keys, assets and ownership locks; verify the intended variant settings before running both concurrently.

## Updates

1. Take a coordinated restorable backup of the private SQLite catalog and complete MySQL database, including installation keys, board state, history and uploaded assets. Full MySQL installations need that database alone. Test restores periodically.
2. Upload the new package to the same app. Keep `AUTH_ORIGIN`, the database connection and setup settings.
3. Stop the previous process before the replacement starts. Allow a brief interruption; open boards reconnect after the new server becomes ready. If the hosting rollout overlaps processes, configure stop/start deployment or obtain a provider-supported alternative before production use.
4. Startup obtains exclusive ownership and applies supported migrations. Applied migration checksums are verified; newer or altered histories are refused. Check `/healthz` and confirm your existing accounts, boards, uploads and MCP connection still work.
5. Use the Studio updates page to check the running version and build. The current Node package uses dashboard deployment. Cloudflare deployment hooks and automatic update controls are unavailable on Node.

An older package can refuse a database migrated by a newer version. Do not treat an old code upload as a guaranteed rollback. Restore the matching full database backup and code together in an isolated environment, or use a documented forward repair. Replacing private installation keys invalidates sessions and can make encrypted settings unreadable.

## Before a supported GoDaddy release

Verify on the actual hosting product:

- Node version, production dependency installation, assigned port and WebSocket upgrades.
- Managed MySQL version, verified TLS and connection limits; trigger privileges only for a full MySQL catalog.
- Preview/published database separation and whether process replacement overlaps.
- Private deployment-to-owner handoff and trusted canonical URL metadata. These determine whether the two setup settings above can be supplied automatically.
- Managed email delivery, custom domains, OAuth/MCP and passkeys.
- Database backups, recovery and an upgrade with real existing data.

The provider upload contract does not supply a public template button or a trusted first-owner handoff. Until those capabilities are available, the HTTPS address and setup password must be set privately in the hosting dashboard.

## Maintainer verification

Use disposable local MySQL 8.4 databases ending in `_test`. Run Cloudflare `pnpm check` and deployment dry run, Node type checking and adapter tests, then both source and packaged Node smoke tests. CI has separate Cloudflare and Node jobs. The Node smoke covers owner setup, MFA, guest access restrictions, board writes, WebSockets and persistence across a server restart.

### Provider references

- [GoDaddy app requirements](https://developer.godaddy.com/en/docs/api-users/hosting/app-requirements)
- [Hosting deployment contract](https://github.com/godaddy/nodejs-hosting-agent-skill/blob/main/skills/godaddy-nodejs-hosting/contract.md)
- [Managed email gateway](https://github.com/godaddy/nodejs-hosting-agent-skill/blob/main/skills/godaddy-nodejs-hosting/email.md)
- [Hosting concepts and preview/publish variants](https://developer.godaddy.com/en/docs/api-users/hosting/concepts)
