# Connection operations

## Native sign-in

Native authentication is the default on both hosts. People can use a local account without an external identity provider. Cloudflare Access is not required.

Choose one canonical HTTPS origin and use it for the app and assistant connections. `AUTH_ORIGIN` controls that origin. Do not configure an assistant with a different hostname and expect its authorization issuer to match.

## MCP routes

Remote clients need to reach these application routes:

| Route | Purpose |
| --- | --- |
| `/mcp` and `/mcp/*` | Authenticated protocol requests and native export downloads |
| `/.well-known/oauth-protected-resource` | Resource metadata |
| `/.well-known/oauth-protected-resource/mcp` | Path-specific resource metadata |
| `/.well-known/oauth-authorization-server` | Authorization server metadata |
| `/oauth/register` | Client registration |
| `/oauth/token` | Code and refresh exchanges |
| `/oauth/revoke` | Token revocation |
| `/oauth/authorize` | Human sign-in and approval |

Tokens, scopes, and current content permissions are still checked by the app. An unauthenticated MCP request should return an authentication challenge; that is normal.

## Optional Cloudflare Access

If you add Access as another outer boundary, a remote assistant does not have the user's Access cookie. Its protocol and discovery requests must reach the application using an appropriate route policy. Keep interactive sign-in protected as intended and test the entire browser return flow.

Do not expose board REST routes or uploads just to solve a connector error. The native app is responsible for its own authentication even when an outer gateway is present.

## Troubleshooting

Open Connected apps and run its setup checker. It checks metadata from your browser; an external assistant connection still needs a real test.

- A configured-URL error usually means the request hostname differs from `AUTH_ORIGIN`.
- A return to the assistant followed by discovery failure means sign-in alone did not complete tool discovery. Check the `/mcp` response status and server error, not just the browser redirect.
- A rejected approval requires starting a new connection from the assistant so the app can validate its current request and CSRF protection.

When reporting a bug, include the version, client, canonical server URL, and sanitized response status. Never include authorization codes, tokens, cookie values, or a private invitation link.
