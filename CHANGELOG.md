# Changelog

## 0.2.1

Applies the authenticator lockout to every sign-in path. After ten incorrect codes in a row, the account waits fifteen minutes before it can try again. Previously this only applied to one sign-in flow.

Fixes a crash in the Node.js server when a client disconnected while a live board connection was being set up.

This release keeps the existing database schema and board format.

## 0.1.1

Fixes release checks and deployment-hook requests on Cloudflare Workers. The Updates screen now explains when no stable release is available and distinguishes release checking from the deployment connection needed to install updates.

This release keeps the existing database schema and board format.

## 0.1.0

First public release of Huddle Loom, with a fresh Git history.

Includes the collaborative whiteboard, Textile Studio interface, light and dark themes, native account onboarding and administration, guest sharing, the OAuth MCP server, Cloudflare deployment scripts, and a prebuilt Node.js hosting package.

Cloudflare is the primary hosting path. Node integration checks and a GoDaddy preview have been exercised; published GoDaddy environments still require the checks in the hosting guide.
