# Software updates

## What owners get

Administration → Updates shows the installed version, the latest checked stable release, plain-text release notes, deployment progress and the last 20 deployments, including source builds and release rebuilds. Owners can install a release, opt into compatible security patches, or return to the previous release when its database schema and board format match. Administrators can inspect status; deployment and connection changes require the owner and fresh MFA. The existing same-origin CSRF protection applies to mutations.

Connected Cloudflare installations check daily. Automatic installation is off by default. When enabled, it accepts only a newer security patch within the current major/minor version, with identical schema and data-format versions. An unattended failure is never retried indefinitely. Feature releases require owner action.

## Installation and hosting authorization

Use these repository-root commands:

- Build: `pnpm run build`
- Production deployment: `pnpm run deploy`
- Preview deployment: `pnpm run deploy:preview`

The production script applies migration 0026 and registers the runner. In Workers Builds it attempts to create/reuse a deployment hook for `WORKERS_CI_BRANCH`. The build token needs **Workers CI Write**, in addition to existing deployment and storage permissions. Cloudflare's generated token may not include that permission. If automatic connection is unavailable, application deployment still succeeds and the owner sees connection instructions in Updates. Create a hook in Worker → Settings → Builds → Deploy Hooks for the production branch and paste it once. Manual hooks are encrypted with the installation key; automatic hooks are stored as the `SOFTWARE_UPDATE_HOOK` Worker secret. The full account deployment token never goes into the application.

This is hosting authorization, separate from local username/password sign-in. No GitHub OAuth application is required. Revoke a managed connection by removing its Worker secret and deleting the hook in Cloudflare; an already-running build must be cancelled separately. Disable automatic patches in Updates if retaining manual updates.

Preview deployments do not register the production runner. Production deployments set `SOFTWARE_UPDATE_RUNNER_ORIGIN` to the registered deployment address, separately from the login address in `AUTH_ORIGIN`. Changing the login address to a custom domain does not change updater identity. Source rebuilds and release builds read live settings and validate the catalog identity before retaining dashboard changes. Older installations without the separate variable keep the original origin check until their next production rebuild. Access policies that block deployment health checks must allow the hosting check or updates will remain unverified.

References: [Cloudflare deployment hooks](https://developers.cloudflare.com/workers/ci-cd/builds/deploy-hooks/), [hook creation and permission](https://developers.cloudflare.com/api/resources/workers_builds/subresources/deploy_hooks/methods/create/), [Workers Builds environment](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

## How a cloned installer obtains new code

A deploy hook only rebuilds the installed repository. It does not sync upstream source. Our production deployment runner reads the owner-approved release from D1, retrieves that exact commit from the fixed upstream GitHub repository, checks the commit, package version and migration digest, installs its lockfile, builds it, and deploys it using the installation's resource identities.

The runner reads live Worker settings to retain operator variables and pins existing D1/R2 identities. It retains the Worker name, authentication origin, routes, existing Durable Object classes, runtime secrets and related deployment settings. It takes application code and migration files from the new release. A change to required storage bindings, board-format version or updater protocol fails closed and needs a guided installer upgrade. Source customizations in a user's repository are not automatically merged into official releases; customized installations should manage deployments themselves.

After success, D1 records the installed release. Rebuilding the older installer repository continues to deploy that selected release, preventing a downgrade to its original code. Updating the bootstrap runner itself is a separate installer-repository upgrade when a future release requires a newer protocol.

## Release publication

Official releases come from [sportwhiz/huddle-loom](https://github.com/sportwhiz/huddle-loom/releases). Stable releases include a manifest that pins the reviewed source commit, package version, schema digest, board format, and updater protocol. Preview releases are not offered as stable updates.

Maintainer process:

1. Update root/application package versions and release notes; make an existing `vX.Y.Z` tag at the reviewed commit.
2. Run the **Publish Huddle Loom release** workflow with that tag, notes and the security-fix flag.
3. The qualification job runs `pnpm check`, verifies the tag/package/commit relationship, and creates `huddle-loom-release.json` with the commit, schema digest, data format, updater protocol and notes.
4. The separate publication job requires a public repository and attaches the manifest to the GitHub release. It never changes repository visibility. Use repository protections for release tags and the publishing workflow.

Trust is the fixed upstream GitHub repository over HTTPS plus pinned Git content identity and a migration digest. This does **not** claim independent publisher signatures or protect against a compromised authorized release maintainer. Never mark a release as a security patch without reviewing its migration and stored-data compatibility. For code-only rollback, the data-format number is a compatibility contract, not something inferred automatically from source code.

Before advertising unattended upgrades as qualified for a new hosting configuration, rehearse an installation upgrade and recovery there. Local checks cannot establish the behavior of every provider account or rollout policy.

## Failure and recovery

Requests, release rebuilds and native source deployments use the same database-enforced single active operation. A rebuild claims that operation before reading live settings or fetching source, and conditionally claims only the release pointer it observed. Source builds acquire ownership before migrations and publication; on a first installation they acquire it as soon as the migration creates the updater tables. The build must own the preparation record immediately before deployment. A timeout triggering the hook leaves the request pending because Cloudflare may already have accepted it. No automatic second build is started.

- **Preparation failed:** no release deployment occurred; inspect the build log and retry from Updates.
- **First updater rollout failed:** the previous application may not have an Updates screen yet. If the publishing child exits with a caught failure before runner registration, the script requeues its own source operation and clears its runner identity. In Cloudflare build history, retry the failed build at the same Git revision. The same operation, exact code, migration digest, and original checkpoint are retained; a different revision cannot take over. A running or abruptly interrupted build never requeues itself. For an interrupted first rollout, cancel the old Cloudflare build and wait until it has stopped, temporarily set the production deployment command to `pnpm run deploy -- --recover-source`, then retry the original build at its original commit. Restore `pnpm run deploy` afterwards. This hosting recovery flag works only before runner registration; it cannot override an operation on a registered installation, change its target, or discard its checkpoint. It requires no database edits. Once registered, use owner-confirmed recovery in Updates.
- **Preparation stalled:** after 20 minutes, cancel the old build in Cloudflare. The owner can then clear its preparation lock in Updates. The old runner is fenced from entering deployment. If this was recovery of an earlier publication, the operation remains uncertain so only that same deployment can be retried.
- **Deployment uncertain:** migrations or code publication may already have happened. Automatic retries and new updates stay blocked. Check Cloudflare build history. “Recheck deployment” succeeds only if the requested commit and schema are actually running and the catalog can be queried. If publication failed or the build stopped, the owner can confirm this in Cloudflare and choose **Retry the same deployment**. Running deployment phases must first be stalled for 20 minutes; explicitly failed, uncertain jobs can be retried once the build has stopped. Recovery requeues the same operation and exact release, fences the former runner, retains the original checkpoint, and resumes pending migrations. It never frees the operation for a different release or reverses data. A failed recovery attempt remains uncertain if publication previously began. Source deployment recovery must rebuild the same Git revision; a different revision fails closed. Owners need fresh MFA for recovery.
- **Incompatible rollback:** do not simply redeploy older code. Follow the data recovery runbook, review intervening user writes, and preserve current data before restoring anything.

Before deploying a requested update, the runner records a D1 Time Travel bookmark. Its retention is Cloudflare's database retention window. This is a catalog recovery checkpoint, **not** a full application backup: board state lives in Durable Objects and uploaded assets in R2. Neither is silently restored or deleted. Compatible code rollback never reverses board edits. If a migration fails partway, the operation stays uncertain; the previous code may still be serving against partially applied schema, so review the failure before any recovery.

Live data-format changes need their own migration/backup design and increase the data-format version. Release qualification must exercise recovery across all stores before advertising such an upgrade as supported.

## Node.js / GoDaddy

The manifest, version model, owner permissions, update history and UI are reusable. Cloudflare deployment hooks and D1 Time Travel are provider-specific. The Node package already includes its catalog adapters. Automatic GoDaddy updates still need a provider deployment and backup adapter. Use the dashboard ZIP replacement procedure for now. Do not store a GoDaddy account-wide deployment token in the Node runtime to shortcut this boundary.

## Local verification

- `pnpm check` covers real SQLite migrations, authentication and owner MFA, encrypted hook handling, duplicate requests, timeout/rejection behavior, security-patch policy, source/config preservation, deployment failures and post-deployment version verification.
- `HUDDLE_BUILD_TARGET=node pnpm --filter @whiteboard/web exec vite --host 127.0.0.1 --port 5194` starts a frontend-only UI preview.
- `node apps/web/scripts/update-ui-smoke.mjs` uses intercepted local API fixtures to check light/dark/mobile layouts, cancel/confirm behavior, CSRF headers and progress. It cannot deploy anything. Set `CHROMIUM_EXECUTABLE_PATH` if needed.

Cloudflare API permissions, live hook creation, a published-release fetch and a real remote upgrade/rollback still require provider qualification. Local tests use real SQL and filesystem operations with mocked external hosting operations.
