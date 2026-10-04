import type { Principal } from "./collaboration-types";
import type { NativeEnv } from "./auth/types";
import { authenticateLegacy } from "./auth/access";
import { securityState } from "./auth/policy";
import { nativePrincipal } from "./auth/session";
import { checkCanonicalRequest } from "./security/config";
import { HttpError, invariantError } from "./security/errors";
export { HttpError } from "./security/errors";
export { localSessionResponse } from "./auth/access";
export type AuthEnv = Omit<NativeEnv, "CATALOG" | "BOARD_ROOMS">;
export async function authenticate(
  request: Request,
  env: AuthEnv & { CATALOG: D1Database },
): Promise<Principal> {
  if (env.AUTH_MODE === "access") {
    if (!request.headers.has("Cf-Access-Jwt-Assertion"))
      throw new HttpError(
        401,
        "Sign in through Cloudflare Access.",
        "AUTHENTICATION_REQUIRED",
      );
    const principal = await authenticateLegacy(request, env);
    const state = await securityState(env.CATALOG, principal.id);
    if (state && (state.status !== "active" || state.recovery_required))
      throw new HttpError(
        401,
        "Your access has changed. Contact your administrator.",
        "SESSION_REVOKED",
      );
    return {
      ...principal,
      ...(state ? { authVersion: state.auth_version } : {}),
    };
  }
  if (env.AUTH_MODE === "development") return authenticateLegacy(request, env);
  checkCanonicalRequest(request, env);
  return (await nativePrincipal(request, env)).principal;
}
export function authErrorResponse(error: unknown) {
  error = invariantError(error) ?? error;
  if (error instanceof HttpError)
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  return Response.json(
    {
      error: "The service could not complete this request. Try again shortly.",
      code: "SERVICE_UNAVAILABLE",
    },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
