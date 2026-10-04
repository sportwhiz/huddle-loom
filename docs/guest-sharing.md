# Boards for guests

A board owner can open **Share → Anyone with the link → Create guest link**. Choose **Can view**, **Can comment**, or **Can edit**, an expiry, and an optional board password. Copy the guest link and send it to your guests. They enter a display name and open that board without creating an account. Ordinary board URLs continue to require account access.

Guest links are off by default. Anyone who receives a link can forward it. Use a password for an additional check, or turn the link off to end access. Changing permissions, expiry or password ends existing sessions; guests can open the updated link again. Guest sessions last up to eight hours and end sooner if the link expires. There can be ten active links per board. Active anonymous sessions are capped by the installation’s **Guests** limit; registered guest accounts retain their existing account quota.

Guests can access the shared board, its comments and board assets. They cannot browse the Studio, manage sharing, use MCP, open other boards, or download server archives and version history. Guests who can edit may use notes, shapes, connectors, images and session tools. Guest names are labelled in the participant list and comments. Names are self-reported, so they do not verify someone’s identity. People who can view a board can still copy visible information or take screenshots.

Links also stop working when their creator loses effective board ownership, the creator’s account is suspended or requires recovery, or the board is deleted. Workbook ownership counts when the board inherits workbook access. Turning a link off closes its guest connections and releases its sessions. Existing signed-in accounts keep their own permissions.

## Hosting

Both runtimes use the same board permissions and guest API. Cloudflare applies D1 migration `0027_guest_board_links.sql`; Node SQLite applies the same migration, and the MySQL catalog has append-only equivalents. Installation sign-in must be enabled. If Cloudflare Access still protects the hostname, it will block anonymous guests before they reach the application.

Guest tokens are stored as hashes. The owner’s recoverable link is encrypted with the installation key. The shared token stays in the URL fragment, and each board link uses its own HttpOnly session cookie. A view link and an edit link can remain open in separate tabs without replacing each other’s sessions. Existing board cookies are supported and promoted when the link is opened. Mutations check the application origin and a session-specific CSRF token. Authorization is checked against current link and ownership state for HTTP requests and live board activity. A changed or expired session stops editing and keeps unsaved changes available for recovery before rejoining.

## Local qualification

The Node smoke suite includes login-free view/comment/edit, passwords, CSRF, isolation, concurrent joins, revocation, permission changes, and session persistence after restart. It can run against both disposable MySQL and SQLite catalogs, using the source or packaged runtime. See `godaddy-nodejs-installation.md` for local fixture settings.

For Cloudflare, use a fresh isolated local state directory:

```sh
cd apps/web
pnpm run build
pnpm exec wrangler d1 migrations apply CATALOG --local --config tests/wrangler.guest-local.jsonc --persist-to /tmp/huddle-guest-cf-state
pnpm exec wrangler dev --config tests/wrangler.guest-local.jsonc --port 5186 --persist-to /tmp/huddle-guest-cf-state
```

In another terminal in `apps/web`, run `pnpm run test:guest-cloudflare`. It refuses an already claimed installation. This fixture uses public test-only keys, creates a disposable local owner, and writes its browser-test details to `/tmp/huddle-guest-browser-fixture.json` with private file permissions. Never deploy the test configuration or point it at a real database.
