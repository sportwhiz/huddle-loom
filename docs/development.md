# Development

## Requirements

Use Node 22.16 or newer within Node 22 and pnpm 10.30.3. The Node package uses Node's SQLite API. Cloudflare builds use the pinned Wrangler version in the lockfile.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @whiteboard/web exec wrangler d1 migrations apply CATALOG --local --config wrangler.local.jsonc
pnpm dev
```

The development configuration uses a local sample owner and local storage. Never publish it. To use a different Wrangler configuration, set `WHITEBOARD_WRANGLER_CONFIG` to a path relative to `apps/web`.

## Check a change

```sh
pnpm typecheck
pnpm test
pnpm typecheck:node
pnpm build
pnpm exec wrangler deploy --dry-run
```

Both type-check commands regenerate `apps/web/tsconfig.blocksuite.json` from the installed BlockSuite packages. The paths are relative to the app and assume pnpm's default store layout, so the file only changes when those packages change. Commit it with the dependency update that changed it.

Frontend builds, Worker builds, and Node packages are separate outputs. A shared service change needs checks on both adapters.

## Integration tests

Some Node suites need disposable MySQL databases. Without their test URL variables, those suites skip. Use MySQL 8.4 and databases whose names end in `_test`; the suites refuse ordinary database names.

The Node workflow in `.github/workflows/node-hosting.yml` creates these databases and provides the variables. Follow it for a complete local run. It covers adapters, catalog migrations, ownership, installation namespaces, source startup, and packaged startup with a process restart.

The Cloudflare workflow also runs native authentication, revocation, restore, browser OAuth, MCP, and a PostgreSQL authentication-adapter harness. Tests use disposable credentials, never hosting credentials.

To test native owner onboarding locally, use the fixtures and `scripts/run-auth-tests.mjs` under `apps/web`. The script starts and tears down its own local test installation. Do not run reset-capable smoke scripts against an installation with important data.

## Node package

```sh
pnpm package:node
```

The ZIP appears at `apps/web/open-whiteboard-node.zip`. It contains the prebuilt editor and server, migrations, pinned production dependency lockfile, release identity, installation guide, and license notices. Credentials and `node_modules` are excluded. The public GitHub release attaches this ZIP and its SHA-256 checksum, plus an identical `huddle-loom-node.zip` compatibility copy with its own checksum file to preserve existing download links.

## Licenses and releases

Run `node scripts/licenses.mjs` after changing dependencies. It refreshes the public dependency inventory, notices, and corresponding theme source. Keep the checked-in upstream notices in `licenses/upstream` with it. Inspect new dependencies before publishing them.

Set matching root and app versions, commit reviewed source, and tag `vX.Y.Z`. The release workflow qualifies both hosts before attaching the Node ZIP and release manifest. [Updates](software-updates.md) explains the manifest and compatibility checks.

The release workflow defaults to a preview release. Preview releases are available for manual installation and are excluded from stable automatic updates. Publish a stable release only after completing the hosting checks for the supported platforms.
