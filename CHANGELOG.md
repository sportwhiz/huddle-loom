# Changelog

## Unreleased

Huddle Loom is now Open Whiteboard. The app has a new logo, a whiteboard look in light and dark themes, and the tagline "Work it out together." Patterns are now called Templates, Unravel is now History, the Huddle panel is now Workshop, and your thread color is now your marker color. The marker color presets are new; a color you picked before stays selected as a custom color.

Installations keep their Worker, database, storage and release names, so updates and existing data are not affected. New authenticator and passkey enrollments show Open Whiteboard as the account name.

## 0.1.1

Fixes release checks and deployment-hook requests on Cloudflare Workers. The Updates screen now explains when no stable release is available and distinguishes release checking from the deployment connection needed to install updates.

This release keeps the existing database schema and board format.

## 0.1.0

First public release of Huddle Loom, with a fresh Git history.

Includes the collaborative whiteboard, Textile Studio interface, light and dark themes, native account onboarding and administration, guest sharing, the OAuth MCP server, Cloudflare deployment scripts, and a prebuilt Node.js hosting package.

Cloudflare is the primary hosting path. Node integration checks and a GoDaddy preview have been exercised; published GoDaddy environments still require the checks in the hosting guide.
