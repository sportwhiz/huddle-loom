# Open Whiteboard on GoDaddy Node.js Hosting

Upload the ready-made ZIP to GoDaddy, add two app settings, and open your board. GoDaddy installs the dependencies and supplies the managed MySQL connection and server port. Open Whiteboard creates its tables and private sign-in keys when it starts.

You can start with GoDaddy's Preview address. Choose a custom domain when you are ready to publish.

## Create your app

1. Download `huddle-loom-node.zip` from [Open Whiteboard releases](https://github.com/sportwhiz/open-whiteboard/releases).
2. In **GoDaddy Node.js Hosting**, create an app and upload the ZIP. Use GoDaddy's managed MySQL database and Node 22.16 or newer within Node 22.
3. On **Add secrets**, add `SETUP_PASSWORD` with a private passphrase of at least 16 characters. If GoDaddy has not shown you an app address yet, leave `AUTH_ORIGIN` out for now. You can add it after GoDaddy creates the app.
4. Open the app's **Preview** link. Open Whiteboard shows a setup guide with that app's address. Copy the displayed address, then add it as `AUTH_ORIGIN` in the app's **Preview** secrets/settings.
5. Save the settings and restart or redeploy the Preview. Open its link again, enter your setup passphrase, and create your administrator account. Save your recovery code and enroll an authenticator to finish setting up your Studio.

These are the two settings you enter:

| Setting | Value |
| --- | --- |
| `AUTH_ORIGIN` | The app's HTTPS address from GoDaddy's Preview link or the Open Whiteboard setup page. |
| `SETUP_PASSWORD` | Your own private setup passphrase, at least 16 characters. You use it to create the first administrator account. |

**`AUTH_ORIGIN` means “the address people use to open this app.”** Copy the actual address GoDaddy gives you. Use `https://` and the hostname, without a path or trailing slash. For example, if you open `https://my-board.example.com/settings/account`, enter `https://my-board.example.com`. The example is not an address to enter for your app.

Keep your setup passphrase in your password manager. Enter it in GoDaddy's secrets and, after restart, on the administrator setup screen. The first public guide only explains the settings; it does not ask you to enter a password.

GoDaddy handles dependency installation, the port and database connection settings. Open Whiteboard handles table creation, storage and sign-in keys. You do not need terminal commands, a source build, a GitHub sign-in app, or hand-created database tables for this setup.

You can create boards and invite people once your Studio is ready. The setup screen also lets you send a test email and confirm delivery. Connect an assistant later from **Connected apps**.

## Publish when you are ready

GoDaddy keeps **Preview** and **Publish** settings separate. In Publish settings, set `AUTH_ORIGIN` to the published HTTPS address GoDaddy gives you, or your connected custom domain. Set the private `SETUP_PASSWORD` there too.

For a **new** published Studio, also set `HUDDLE_DATABASE_NAMESPACE=live` in Publish settings. This gives that Studio separate data from the existing Preview. Keep Preview's current settings. If your published Studio already has boards, keep its existing namespace and storage settings when you update it. Changing them selects different data.

Select your hosting plan and publish through GoDaddy. Open the published address to finish its administrator setup. Check [GoDaddy's upload instructions](https://www.godaddy.com/en-ca/help/upload-my-ai-generated-app-to-godaddy-nodejs-hosting-42987) for the hosting screens.

## Update an existing app

Download the new release ZIP and upload it to the **same GoDaddy app**. Keep its address, secrets, database and namespace settings. Use GoDaddy's Preview or Publish action for the variant you are updating. After it starts, check your version under **Administration → Updates** and open an existing board.

Open Whiteboard can check for new releases on Node.js Hosting. You install them through GoDaddy's dashboard; the app does not deploy the ZIP for you. Before replacing a Studio you rely on, follow the backup and process-replacement notes below.

## Hosting reference

The details below cover database security, backups and other Node hosts. They are separate from the GoDaddy setup steps above.

Open Whiteboard uses managed MySQL for board state, uploads and private installation keys. On GoDaddy it keeps the SQLite account/catalog database in the durable private directory under `/private/huddle-loom`. The default `HUDDLE_PLATFORM=godaddy` also enables the managed mail gateway; you do not need an extra storage setting for a new GoDaddy app. Other Node hosts can select a full MySQL catalog with `node-mysql`, or configure a persistent directory with `node-private-volume`.

A GoDaddy Preview has been exercised with administrator setup, collaboration, a package update, and a restart that retained board data. Verify email, assistant connections, backups and the hosting limits before relying on a published Studio for important work.

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

## Backup and replacement details

1. Take a coordinated restorable backup of the private SQLite catalog and complete MySQL database, including installation keys, board state, history and uploaded assets. Full MySQL installations need that database alone. Test restores periodically.
2. Upload the new package to the same app. Keep `AUTH_ORIGIN`, the database connection and setup settings.
3. Stop the previous process before the replacement starts. Allow a brief interruption; open boards reconnect after the new server becomes ready. If the hosting rollout overlaps processes, configure stop/start deployment or obtain a provider-supported alternative before production use.
4. Startup obtains exclusive ownership and applies supported migrations. Applied migration checksums are verified; newer or altered histories are refused. Check `/healthz` and confirm your existing accounts, boards, uploads and MCP connection still work.
5. Use the Studio updates page to check the running version and build. The current Node package uses dashboard deployment. Cloudflare deployment hooks and automatic update controls are unavailable on Node.

An older package can refuse a database migrated by a newer version. Do not treat an old code upload as a guaranteed rollback. Restore the matching full database backup and code together in an isolated environment, or use a documented forward repair. Replacing private installation keys invalidates sessions and can make encrypted settings unreadable.

## Maintainer qualification

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
