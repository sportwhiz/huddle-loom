import type { NativeEnv } from "../auth/types";
import { canonicalOrigin } from "./config";
import { HttpError } from "./errors";
import { cookie, equal, hmac, randomToken } from "./primitives";
import { boundedBody } from "./primitives";

export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

// Call only after OAuth has matched the callback to the client's registration.
// Chrome applies form-action to the subsequent redirect as well as the POST.
export function consentContentSecurityPolicy(registeredCallback: string) {
  return CONTENT_SECURITY_POLICY.replace(
    "form-action 'self'",
    `form-action 'self' ${new URL(registeredCallback).origin}`,
  );
}

export async function csrfBootstrap(request: Request, env: NativeEnv) {
  const secure = canonicalOrigin(env).startsWith("https:");
  const name = secure ? "__Host-canvas-csrf" : "canvas-csrf";
  const nonce =
    cookie(request, name)?.match(/^[a-zA-Z0-9_-]{43}$/u)?.[0] ?? randomToken();
  return {
    token: `${nonce}.${await hmac(env.AUTH_SECRET!, `csrf:${nonce}`)}`,
    cookie: `${name}=${nonce}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}; Max-Age=2592000`,
  };
}
export async function requireCsrf(request: Request, env: NativeEnv) {
  const origin = canonicalOrigin(env);
  if (
    request.headers.get("Origin") !== origin ||
    request.headers.get("Sec-Fetch-Site") === "cross-site"
  )
    throw new HttpError(
      403,
      "This action must come from the application.",
      "CSRF_REJECTED",
    );
  const formToken =
    !request.headers.has("X-Canvas-CSRF") &&
    new URL(request.url).pathname === "/oauth/authorize" &&
    request.headers
      .get("Content-Type")
      ?.startsWith("application/x-www-form-urlencoded")
      ? new URLSearchParams(
          new TextDecoder().decode(await boundedBody(request.clone())),
        ).get("csrf")
      : null;
  const value = request.headers.get("X-Canvas-CSRF") ?? formToken ?? "";
  const [nonce, signature] = value.split(".");
  if (
    !nonce ||
    !signature ||
    nonce !==
      cookie(
        request,
        origin.startsWith("https:") ? "__Host-canvas-csrf" : "canvas-csrf",
      ) ||
    !equal(signature, await hmac(env.AUTH_SECRET!, `csrf:${nonce}`))
  )
    throw new HttpError(
      403,
      "Reload the page before trying this action.",
      "CSRF_REJECTED",
    );
}
export function protectResponse(response: Response, pathname: string) {
  if (response.status === 101) return response;
  const result = new Response(response.body, response);
  const headers = result.headers;
  headers.set("X-Content-Type-Options", "nosniff");
  // A no-referrer HTML form POST carries Origin: null. Consent must send its
  // same-origin Origin header for CSRF validation, without leaking the
  // authorization URL (or its state) to the assistant's external callback.
  headers.set(
    "Referrer-Policy",
    pathname === "/oauth/authorize" ? "same-origin" : "no-referrer",
  );
  headers.set("X-Frame-Options", "DENY");
  headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)",
  );
  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/oauth/") ||
    pathname.startsWith("/mcp")
  )
    headers.set("Cache-Control", "private, no-store");
  if (!headers.has("Content-Security-Policy"))
    headers.set(
      "Content-Security-Policy",
      CONTENT_SECURITY_POLICY,
    );
  return result;
}
