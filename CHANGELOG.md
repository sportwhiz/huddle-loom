# Changelog

## Unreleased

Selecting several sticky notes shows the note toolbar above them, so you can change their color, bold, duplicate or lock them together. This works when the selection also includes the arrows between the notes.

Sticky notes now hold formatted text. Select words while editing to make them bold, italic, underlined, struck through, or colored, from the toolbar or with ⌘B, ⌘I, ⌘U, and ⌘⇧X. Each note also has a font (sans, serif, mono, or handwriting), a text size, and an alignment. Selecting several notes applies any of these to all of them. Installations that have not updated show the word styles and colors, and show font, size, and alignment as the default.

## 0.3.2

Node downloads now use `open-whiteboard-node.zip`, with an identical `huddle-loom-node.zip` compatibility copy to preserve existing links.

Email setup now explains that GoDaddy includes a sender and email delivery without extra credentials or a custom domain; its delivery test is optional. Cloudflare setup gives the sender, test-inbox and confirmation steps. Invitation screens explain how to send a private link from your own email account while the Studio's email is unavailable. Confirming email setup refreshes the available invitation actions immediately.

The Node update guide explains the difference between GoDaddy's GitHub redeployments and automatic installation of Open Whiteboard releases. This release does not add automatic installation on GoDaddy. Existing storage, keys, update manifests, database schema and board format remain compatible.

## 0.3.1

The official GitHub repository is moving to `sportwhiz/open-whiteboard`. Release checks now use its permanent GitHub repository identity, so renaming it does not interrupt update discovery. The deployment runner and installation links use the new source URL.

Existing Worker addresses, storage, authentication keys, update manifests, and Node download filenames remain compatible. This release keeps the existing database schema and board format. Install it before the repository rename; existing installer repositories should also refresh their deployment runner's source URL.

## 0.3.0

Huddle Loom is now Open Whiteboard. The app has a new logo, a whiteboard look in light and dark themes, new illustrations, and the tagline "Work it out together." Patterns are now called Templates, Unravel is now History, the Huddle panel is now Workshop, and your thread color is now your marker color. The marker color presets are new; a color you picked before stays selected as a custom color.

Security: the authenticator lockout now applies however you signed in. After 10 incorrect authenticator or backup codes in a row, the account waits 15 minutes before it accepts another code. Previously this only applied to one sign-in flow. Requests rejected for other reasons, such as rate limits, do not count.

The Node.js server no longer stops when a client disconnects while a live board connection is being set up.

Installations keep their Worker, database, storage and release names, so updates and existing data are not affected. New authenticator and passkey enrollments show Open Whiteboard as the account name. This release keeps the existing database schema and board format.

## 0.2.0

Adds guides that point to the controls they describe, notices for important releases, editable demo templates, and a setting for how often protected changes ask you to confirm your identity again.

## 0.1.1

Fixes release checks and deployment-hook requests on Cloudflare Workers. The Updates screen now explains when no stable release is available and distinguishes release checking from the deployment connection needed to install updates.

This release keeps the existing database schema and board format.

## 0.1.0

First public release of Huddle Loom, with a fresh Git history.

Includes the collaborative whiteboard, Textile Studio interface, light and dark themes, native account onboarding and administration, guest sharing, the OAuth MCP server, Cloudflare deployment scripts, and a prebuilt Node.js hosting package.

Cloudflare is the primary hosting path. Node integration checks and a GoDaddy preview have been exercised; published GoDaddy environments still require the checks in the hosting guide.
