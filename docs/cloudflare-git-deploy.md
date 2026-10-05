# Install on Cloudflare

## Deploy button

1. Open the [Deploy to Cloudflare form](https://deploy.workers.cloudflare.com/?url=https://github.com/sportwhiz/open-whiteboard).
2. Select your account and choose a Worker name. Enable Workers Paid and R2 in that account if you have not already done so.
3. Set `SETUP_PASSWORD` to a private passphrase of at least 16 characters. Keep it in a password manager. This protects the first administrator claim.
4. Finish deployment. The script provisions D1, R2, and Durable Objects, applies migrations, and discovers the app's workers.dev address. It creates persistent private authentication keys automatically.
5. Open the deployed address. Enter your setup password, create a username and password, save your recovery key, and enroll a passkey or authenticator. Finish the Studio setup.
6. Create a board and invite someone. You can use private invitation links before enabling email.

The deploy form connects a repository to Workers Builds. If the form asks for commands, use the settings below. It requires hosting authorization to your GitHub repository; this does not make GitHub sign-in a requirement for people using your whiteboards.

Password verification requires Workers Paid. The template sets a 30-second CPU ceiling for native authentication. Storage and other Cloudflare services are billed to your account. Check [Cloudflare's limits](https://developers.cloudflare.com/workers/platform/limits/) and account pricing before opening registration.

## Workers Builds settings

Use the repository root:

| Setting | Value |
| --- | --- |
| Root directory | `/` |
| Build command | `pnpm run build` |
| Deploy command | `pnpm run deploy` |
| Preview command | `pnpm run deploy:preview` |

Do not put the preview deployment command in the build field. The preview script prepares explicit storage bindings before calling Wrangler. A bare `wrangler preview` skips that preparation.

For an existing connection, add `SETUP_PASSWORD` as a runtime secret before the first native deployment. Use the production settings tab for production, and the preview settings for previews. Set it privately in the dashboard, never in the repository or build logs.

The build token needs access to Workers, D1, R2, and account metadata. Automatic update-hook creation also needs Workers CI Write. If that permission is unavailable, deployment still works; the owner can connect a deploy hook later from Administration → Updates.

## Preview branches

The template has separate preview storage settings. The preview script resolves or creates the catalog and bucket and supplies the binding IDs Wrangler needs. Use a private preview setup password and complete onboarding on its own URL.

Treat a preview as another installation. Do not manually point an untrusted branch at production storage. Check the resolved resource names in the deployment log before changing bindings. Keep a preview's canonical address consistent while testing authentication and MCP.

## Custom domain

Add the domain through the Worker dashboard. Set `AUTH_ORIGIN` to the exact HTTPS origin, for example `https://boards.example.com`, with no path or trailing slash. Rebuild so the installation configuration uses that address. Use the same address for sign-in and assistant connections.

After an installation has users, changing the canonical address requires a planned move. Authentication cookies and OAuth issuer identity belong to that origin. Test in a separate installation before changing a populated deployment.

## Email

You can create accounts and copy private invitation links without a sender. To send invitations and account messages, open the email setup in Administration and follow the installed provider's instructions.

The Cloudflare template includes the `EMAIL` binding. Cloudflare still requires account eligibility and an authorized sending domain. Those approvals cannot be created by application code. Send a test and confirm receipt in the app before enabling email-dependent registration.

Resend is also supported. Configure its verified sender and API key privately. See [Administration](security-operations.md#email-and-sign-in-providers).

## Terminal installation

The dashboard path does not require a local CLI. For a terminal installation:

```sh
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm --filter @whiteboard/web exec wrangler secret put SETUP_PASSWORD --config wrangler.native.jsonc
WHITEBOARD_WRANGLER_CONFIG=wrangler.native.jsonc pnpm run build
pnpm run deploy
```

Choose the intended account if Wrangler has access to several. For separate installations, change the Worker name in the selected template and retain its storage names after the first deploy. Explicitly bound existing resources are preserved by the deployment script.

## Confirm the installation

Open a board in two sessions, try an upload, sign out and in, and connect an assistant at `/mcp`. Check Administration for email and update status. Keep [a backup of all stores and installation keys](security-operations.md#backups) before upgrades.

If setup is unavailable, check the first failed line in the build log, the runtime setup secret, and the configured origin. Do not remove authentication guards to get past an installation error.
