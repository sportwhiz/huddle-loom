import type { BetterAuthPlugin } from "better-auth";
import { genericOAuth } from "better-auth/plugins";
import { createRemoteJWKSet, customFetch, decodeJwt } from "jose";
import type { NativeEnv } from "./types";
import { canonicalOrigin, validatePublicHttps } from "../security/config";
import { boundedBody } from "../security/primitives";
import { HttpError } from "../security/errors";

export type OidcConfiguration = {
  providerId: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl: string;
  discoveryDigest?: string;
};
export function approvedOidcOrigins(env: NativeEnv) {
  const origins = (env.OIDC_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!origins.length)
    throw new HttpError(
      503,
      "The operator must approve the OIDC provider origins.",
      "OIDC_ORIGIN_REQUIRED",
    );
  return origins;
}
async function providerFetch(
  env: NativeEnv,
  input: string | URL | Request,
  init: RequestInit = {},
) {
  const url = validatePublicHttps(
    input instanceof Request ? input.url : input.toString(),
    approvedOidcOrigins(env),
  );
  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok)
    throw new HttpError(
      503,
      "The sign-in provider could not be reached.",
      "PROVIDER_UNAVAILABLE",
    );
  const bytes = await boundedBody(response, 65536);
  return new Response(bytes, {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
}
export async function discoverOidc(
  env: NativeEnv,
  discoveryUrl: string,
  expectedIssuer?: string,
) {
  const response = await providerFetch(env, discoveryUrl, {
    headers: { Accept: "application/json" },
  });
  let metadata: Record<string, unknown>;
  try {
    metadata = (await response.json()) as Record<string, unknown>;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
      throw new Error("Expected provider metadata");
  } catch {
    throw new HttpError(
      400,
      "Provider discovery returned invalid metadata.",
      "PROVIDER_TEST_FAILED",
    );
  }
  for (const field of [
    "issuer",
    "authorization_endpoint",
    "token_endpoint",
    "jwks_uri",
  ]) {
    if (typeof metadata[field] !== "string")
      throw new HttpError(
        400,
        `Provider discovery requires ${field}.`,
        "PROVIDER_TEST_FAILED",
      );
    validatePublicHttps(metadata[field] as string, approvedOidcOrigins(env));
  }
  if (metadata.userinfo_endpoint)
    validatePublicHttps(
      String(metadata.userinfo_endpoint),
      approvedOidcOrigins(env),
    );
  if (expectedIssuer && metadata.issuer !== expectedIssuer)
    throw new HttpError(
      503,
      "The provider issuer changed. Review its configuration before signing in.",
      "PROVIDER_ISSUER_CHANGED",
    );
  const algorithms = Array.isArray(
    metadata.id_token_signing_alg_values_supported,
  )
    ? (metadata.id_token_signing_alg_values_supported.filter((value) =>
        ["RS256", "PS256", "ES256", "ES384", "EdDSA"].includes(String(value)),
      ) as string[])
    : [];
  if (!algorithms.length)
    throw new HttpError(
      400,
      "The provider must support signed ID tokens.",
      "PROVIDER_TEST_FAILED",
    );
  return {
    ...metadata,
    issuer: metadata.issuer as string,
    authorization_endpoint: metadata.authorization_endpoint as string,
    token_endpoint: metadata.token_endpoint as string,
    jwks_uri: metadata.jwks_uri as string,
    algorithms,
  };
}
export function validateOidcConfiguration(
  env: NativeEnv,
  value: unknown,
): OidcConfiguration {
  const config = value as OidcConfiguration;
  if (
    !config ||
    !/^oidc-[a-zA-Z0-9_-]{1,60}$/u.test(config.providerId) ||
    typeof config.clientId !== "string" ||
    !config.clientId ||
    typeof config.clientSecret !== "string" ||
    !config.clientSecret ||
    typeof config.discoveryUrl !== "string"
  )
    throw new HttpError(
      503,
      "An OIDC provider configuration is invalid.",
      "AUTH_NOT_CONFIGURED",
    );
  validatePublicHttps(config.discoveryUrl, approvedOidcOrigins(env));
  // Only reviewed options are copied. Deployment JSON cannot disable PKCE or nonce checks.
  return {
    providerId: config.providerId,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    discoveryUrl: config.discoveryUrl,
    discoveryDigest: config.discoveryDigest,
  };
}
export function safeOidcPlugin(
  env: NativeEnv,
  configuration: OidcConfiguration[],
): BetterAuthPlugin {
  return {
    id: "canvas-verified-oidc",
    async init(ctx) {
      const attempts = await Promise.allSettled(
        configuration.map(async (config) => ({
          config,
          metadata: await discoverOidc(
            env,
            config.discoveryUrl,
            config.discoveryDigest,
          ),
        })),
      );
      const configured = attempts.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const plugin = genericOAuth({
        config: configured.map(({ config, metadata }) => ({
          providerId: config.providerId,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          authorizationUrl: metadata.authorization_endpoint,
          tokenUrl: metadata.token_endpoint,
          scopes: ["openid", "email", "profile"],
          pkce: true,
          requireEmailVerification: true,
          disableProviderLogout: true,
          accountSubject: ({ profile }) =>
            typeof profile.sub === "string" ? profile.sub : "",
          async getToken({ code, redirectURI, codeVerifier }) {
            if (
              redirectURI !==
                `${canonicalOrigin(env)}/api/auth/callback/${config.providerId}` ||
              !codeVerifier
            )
              throw new HttpError(
                400,
                "The provider callback could not be confirmed.",
                "INVALID_CALLBACK",
              );
            const body = new URLSearchParams({
              grant_type: "authorization_code",
              code,
              redirect_uri: redirectURI,
              code_verifier: codeVerifier,
              client_id: config.clientId,
              client_secret: config.clientSecret,
            });
            const response = await providerFetch(env, metadata.token_endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
              },
              body: body.toString(),
            });
            const token = (await response.json()) as Record<string, unknown>;
            if (
              typeof token.access_token !== "string" ||
              typeof token.id_token !== "string" ||
              token.access_token.length > 16384 ||
              token.id_token.length > 32768 ||
              String(token.token_type).toLowerCase() !== "bearer"
            )
              throw new HttpError(
                400,
                "The provider returned an invalid token response.",
                "INVALID_CALLBACK",
              );
            const seconds =
              typeof token.expires_in === "number" &&
              Number.isFinite(token.expires_in) &&
              token.expires_in > 0
                ? Math.min(token.expires_in, 86400)
                : 3600;
            return {
              accessToken: token.access_token,
              idToken: token.id_token,
              refreshToken:
                typeof token.refresh_token === "string"
                  ? token.refresh_token
                  : undefined,
              accessTokenExpiresAt: new Date(Date.now() + seconds * 1000),
              scopes: ["openid", "email", "profile"],
            };
          },
          async getUserInfo(tokens) {
            if (!tokens.idToken) return null;
            // The provider below verifies signature, issuer, audience, expiry and nonce
            // before this mapping runs. Userinfo never causes another unguarded fetch.
            const profile = decodeJwt(tokens.idToken);
            if (
              typeof profile.sub !== "string" ||
              typeof profile.email !== "string" ||
              profile.email_verified !== true
            )
              return null;
            return {
              ...profile,
              id: profile.sub,
              email: profile.email,
              name:
                typeof profile.name === "string"
                  ? profile.name.slice(0, 80)
                  : profile.email.split("@")[0],
              emailVerified: true,
            };
          },
        })),
      });
      const result = await plugin.init(ctx);
      for (const provider of result.context.socialProviders) {
        const entry = configured.find(
          (value) => value.config.providerId === provider.id,
        );
        if (!entry) continue;
        provider.idToken = {
          issuer: entry.metadata.issuer,
          audience: entry.config.clientId,
          algorithms: entry.metadata.algorithms,
          jwks: createRemoteJWKSet(new URL(entry.metadata.jwks_uri), {
            [customFetch]: (input, init) => providerFetch(env, input, init),
          }),
        };
        provider.requiresIdTokenNonce = true;
      }
      return result;
    },
  };
}
