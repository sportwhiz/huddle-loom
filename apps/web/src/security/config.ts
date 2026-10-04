import type { NativeEnv } from "../auth/types";
import { HttpError } from "./errors";
import { validateEncryptionKeys } from "./secret-store";
export function isLocalOrigin(value: string) {
  const host = new URL(value).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}
export function canonicalOrigin(
  env: Pick<NativeEnv, "AUTH_ORIGIN" | "ENVIRONMENT">,
) {
  if (!env.AUTH_ORIGIN)
    throw new HttpError(
      503,
      "The operator must configure AUTH_ORIGIN before enabling sign-in.",
      "AUTH_NOT_CONFIGURED",
    );
  let url: URL;
  try {
    url = new URL(env.AUTH_ORIGIN);
  } catch {
    throw new HttpError(
      503,
      "The canonical application URL is invalid.",
      "AUTH_NOT_CONFIGURED",
    );
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        ["test", "development"].includes(env.ENVIRONMENT ?? "") &&
        isLocalOrigin(url.origin)
      ))
  )
    throw new HttpError(
      503,
      "Use an HTTPS application origin (HTTP is allowed only for explicit loopback tests).",
      "AUTH_NOT_CONFIGURED",
    );
  return url.origin;
}
export function nativeConfigured(env: NativeEnv) {
  canonicalOrigin(env);
  validateEncryptionKeys(env);
  if (
    !env.AUTH_SECRET ||
    env.AUTH_SECRET.length < 32 ||
    !env.AUTH_ENCRYPTION_KEYS
  )
    throw new HttpError(
      503,
      "Authentication secrets are missing. Follow the installation instructions.",
      "AUTH_NOT_CONFIGURED",
    );
  if (env.AUTH_SECRETS) {
    try {
      const ring = JSON.parse(env.AUTH_SECRETS);
      if (
        !Array.isArray(ring) ||
        !ring.length ||
        ring.some(
          (key) =>
            !Number.isSafeInteger(key?.version) ||
            key.version < 0 ||
            typeof key.value !== "string" ||
            key.value.length < 32,
        ) ||
        new Set(ring.map((key) => key.version)).size !== ring.length
      )
        throw new Error();
    } catch {
      throw new HttpError(
        503,
        "The authentication key ring is invalid. Retain the existing keys and correct the deployment configuration.",
        "AUTH_NOT_CONFIGURED",
      );
    }
  }
}
export function checkCanonicalRequest(request: Request, env: NativeEnv) {
  if (new URL(request.url).origin !== canonicalOrigin(env))
    throw new HttpError(
      421,
      "Use the configured application URL.",
      "WRONG_ORIGIN",
    );
}
export function validatePublicHttps(value: string, allowedOrigins?: string[]) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(
      400,
      "Enter a valid HTTPS URL.",
      "INVALID_PROVIDER_URL",
    );
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !host.includes(".") ||
    host.endsWith(".local") ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    /^\d+\.\d+\.\d+\.\d+$/u.test(host) ||
    host.includes(":") ||
    (allowedOrigins && !allowedOrigins.includes(url.origin))
  )
    throw new HttpError(
      400,
      "Use an approved public HTTPS origin.",
      "INVALID_PROVIDER_URL",
    );
  return url;
}
