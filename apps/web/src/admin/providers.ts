import type { NativeEnv } from "../auth/types";
import { canonicalOrigin, validatePublicHttps } from "../security/config";
import { HttpError } from "../security/errors";
import {
  discoverOidc,
  approvedOidcOrigins,
  validateOidcConfiguration,
} from "../auth/oidc";
import { configuredProviders } from "../auth/library";
import { mailReady } from "../mail/outbox";
import { seal } from "../security/secret-store";
import { auditStatement } from "../security/audit";
import { text } from "../security/primitives";
import { methodChangeGuard } from "../auth/method-change";
export async function providerInventory(env: NativeEnv) {
  const rows = await env.CATALOG.prepare(
    "SELECT id, public_config, enabled, tested_at, callback_verified_at, updated_at FROM auth_provider_config ORDER BY id",
  ).all<{
    id: string;
    public_config: string;
    enabled: number;
    tested_at: number | null;
    callback_verified_at: number | null;
    updated_at: string;
  }>();
  const providers = rows.results.map((row) => ({
    id: row.id,
    configuration: JSON.parse(row.public_config),
    enabled: Boolean(row.enabled),
    testedAt: row.tested_at,
    callbackVerifiedAt: row.callback_verified_at,
    updatedAt: row.updated_at,
    managedByDeployment: false,
  }));
  for (const [id, clientId, secret] of [
    ["github", env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET],
    ["google", env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET],
  ])
    if (clientId && secret) {
      const index = providers.findIndex((row) => row.id === id);
      const entry = {
        id: id!,
        configuration: { clientId },
        enabled: true,
        testedAt: null,
        callbackVerifiedAt: null,
        updatedAt: "",
        managedByDeployment: true,
      };
      if (index >= 0) providers[index] = entry;
      else providers.push(entry);
    }
  const deployedOidc = env.OIDC_CONFIG ? JSON.parse(env.OIDC_CONFIG) : [];
  if (!Array.isArray(deployedOidc))
    throw new HttpError(
      503,
      "OIDC configuration must be an array.",
      "AUTH_NOT_CONFIGURED",
    );
  for (const value of deployedOidc) {
    const config = validateOidcConfiguration(env, value);
    const entry = {
      id: config.providerId,
      configuration: {
        clientId: config.clientId,
        discoveryUrl: config.discoveryUrl,
      },
      enabled: true,
      testedAt: null,
      callbackVerifiedAt: null,
      updatedAt: "",
      managedByDeployment: true,
    };
    const index = providers.findIndex((row) => row.id === entry.id);
    if (index >= 0) providers[index] = entry;
    else providers.push(entry);
  }
  return {
    providers,
    callbacks: {
      github: `${canonicalOrigin(env)}/api/auth/callback/github`,
      google: `${canonicalOrigin(env)}/api/auth/callback/google`,
      oidc: `${canonicalOrigin(env)}/api/auth/callback/<provider-id>`,
    },
    allowedOidcOrigins: (env.OIDC_ALLOWED_ORIGINS ?? "")
      .split(",")
      .filter(Boolean),
  };
}
export async function saveProvider(
  env: NativeEnv,
  actorId: string,
  id: string,
  input: Record<string, unknown>,
) {
  if (
    !["github", "google"].includes(id) &&
    !/^oidc-[a-zA-Z0-9_-]{1,60}$/u.test(id)
  )
    throw new HttpError(
      400,
      "Choose GitHub, Google or a named OpenID provider.",
      "INVALID_PROVIDER",
    );
  if (
    (id === "github" && env.GITHUB_CLIENT_ID) ||
    (id === "google" && env.GOOGLE_CLIENT_ID) ||
    (id.startsWith("oidc-") &&
      env.OIDC_CONFIG &&
      JSON.parse(env.OIDC_CONFIG).some(
        (entry: { providerId?: string }) => entry.providerId === id,
      ))
  )
    throw new HttpError(
      409,
      "This provider is managed by deployment configuration.",
      "MANAGED_BY_DEPLOYMENT",
    );
  if (typeof input.enabled !== "boolean")
    throw new HttpError(
      400,
      "Choose whether this provider is enabled.",
      "INVALID_INPUT",
    );
  const existing = await env.CATALOG.prepare(
    "SELECT public_config, secret FROM auth_provider_config WHERE id = ?",
  )
    .bind(id)
    .first<{ public_config: string; secret: string }>();
  if (!input.enabled || existing) {
    const methods = await env.CATALOG.prepare(
      "SELECT providerId FROM auth_accounts WHERE userId = ?",
    )
      .bind(actorId)
      .all<{ providerId: string }>();
    const passkey = await env.CATALOG.prepare(
      "SELECT 1 FROM auth_passkeys WHERE userId = ? LIMIT 1",
    )
      .bind(actorId)
      .first();
    const enabled = await configuredProviders(env);
    const fallback =
      passkey ||
      methods.results.some(
        (method) =>
          method.providerId !== id &&
          (method.providerId === "credential"
            ? mailReady(env)
            : method.providerId === "github"
              ? enabled.github
              : method.providerId === "google"
                ? enabled.google
                : enabled.oidc?.some(
                    (value) => value.providerId === method.providerId,
                  )),
      );
    if (methods.results.some((method) => method.providerId === id) && !fallback)
      throw new HttpError(
        409,
        "Add another working sign-in method to the owner account before changing or disabling this provider.",
        "LAST_METHOD",
      );
  }
  const previous = existing
    ? (JSON.parse(existing.public_config) as Record<string, unknown>)
    : undefined;
  const clientId = text(
    input.clientId ?? previous?.clientId,
    "Client ID",
    1024,
  );
  let configuration: Record<string, unknown> = { clientId };
  if (!input.enabled && previous) {
    configuration = previous;
  } else if (id.startsWith("oidc-")) {
    const discovery = validatePublicHttps(
      text(input.discoveryUrl ?? previous?.discoveryUrl, "Discovery URL", 2048),
      approvedOidcOrigins(env),
    );
    const metadata = await discoverOidc(env, discovery.href);
    if (
      previous?.discoveryDigest &&
      previous.discoveryDigest !== metadata.issuer &&
      (await env.CATALOG.prepare(
        "SELECT 1 FROM auth_accounts WHERE providerId = ? LIMIT 1",
      )
        .bind(id)
        .first())
    )
      throw new HttpError(
        409,
        "This provider already has linked accounts. Add a new provider ID for a different issuer.",
        "PROVIDER_ISSUER_CHANGED",
      );
    configuration = {
      clientId,
      discoveryUrl: discovery.href,
      discoveryDigest: metadata.issuer,
    };
  }
  const encrypted =
    typeof input.clientSecret === "string" && input.clientSecret.trim()
      ? await seal(
          env,
          text(input.clientSecret, "Client secret", 4096),
          `provider:${id}`,
        )
      : existing?.secret;
  if (!encrypted)
    throw new HttpError(
      400,
      "A client secret is required for a new provider.",
      "INVALID_INPUT",
    );
  const guard = methodChangeGuard(env, actorId, { provider: id });
  await env.CATALOG.batch([
    guard.before,
    env.CATALOG.prepare(
      "INSERT INTO auth_provider_config (id, public_config, secret, enabled, tested_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET public_config = excluded.public_config, secret = excluded.secret, enabled = excluded.enabled, tested_at = excluded.tested_at, callback_verified_at = NULL, updated_at = excluded.updated_at, version = auth_provider_config.version + 1",
    ).bind(
      id,
      JSON.stringify(configuration),
      encrypted,
      input.enabled === true ? 1 : 0,
      input.enabled ? Date.now() : null,
      new Date().toISOString(),
    ),
    env.CATALOG.prepare(
      "UPDATE installation SET version = version + 1 WHERE id = 'instance'",
    ),
    auditStatement(
      env.CATALOG,
      actorId,
      "provider.configuration_changed",
      id,
      "success",
      { provider: id },
    ),
    guard.after,
  ]);
  return {
    saved: true,
    configurationValidated: Boolean(input.enabled),
    callbackVerified: false,
  };
}
