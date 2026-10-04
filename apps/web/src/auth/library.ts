import { localAccounts } from "./local-accounts";
import { PRODUCT_NAME } from "../product";
import { operatorRecovery } from "./emergency";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { HttpError } from "../security/errors";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { magicLink, twoFactor } from "better-auth/plugins";
import {
  safeOidcPlugin,
  validateOidcConfiguration,
  type OidcConfiguration,
} from "./oidc";
import { passkey } from "@better-auth/passkey";
import type { NativeEnv } from "./types";
import { canonicalOrigin, nativeConfigured } from "../security/config";
import {
  derivePasswordHash,
  validatePassword,
  rejectCompromisedPassword,
  verifyPassword,
} from "./password";
import { consumeLimit } from "../security/limits";
import { hmac, sha256 } from "../security/primitives";
import {
  installation,
  mayRegister,
  provisionUser,
  securityState,
  synchronizeIdentity,
} from "./policy";
import { mailReady, queueMail } from "../mail/outbox";
import { authenticateLegacy } from "./access";
import { queueEmailProof } from "./email-proof";
import { open } from "../security/secret-store";

type Providers = {
  github?: { clientId: string; clientSecret: string };
  google?: { clientId: string; clientSecret: string };
  oidc?: OidcConfiguration[];
};
export function libraryOptions(
  env: NativeEnv,
  providers: Providers = {},
  hooks: BetterAuthOptions["databaseHooks"] = {},
  database: BetterAuthOptions["database"] = env.AUTH_DATABASE ?? env.CATALOG,
  settings?: Pick<import("./types").Installation, "session_idle_seconds">,
): BetterAuthOptions {
  const origin = canonicalOrigin(env);
  return {
    appName: PRODUCT_NAME,
    baseURL: origin,
    basePath: "/api/auth",
    secret: env.AUTH_SECRET,
    database,
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (
          context.path === "/sign-in/email" &&
          typeof context.body?.password === "string" &&
          new TextEncoder().encode(context.body.password).byteLength > 512
        ) {
          throw new APIError("BAD_REQUEST", {
            message: "The password is too long.",
            code: "INVALID_PASSWORD_LENGTH",
          });
        }
        const field =
          context.path === "/sign-up/email"
            ? "password"
            : ["/change-password", "/reset-password", "/set-password"].includes(
                  context.path,
                )
              ? "newPassword"
              : null;
        if (!field || typeof context.body?.[field] !== "string") return;
        try {
          validatePassword(context.body[field]);
          await rejectCompromisedPassword(context.body[field]);
        } catch (error) {
          if (error instanceof HttpError)
            throw new APIError(
              error.status === 400 ? "BAD_REQUEST" : "SERVICE_UNAVAILABLE",
              { message: error.message, code: error.code },
            );
          throw error;
        }
      }),
    },
    ...(env.AUTH_SECRETS
      ? {
          secrets: JSON.parse(env.AUTH_SECRETS) as {
            version: number;
            value: string;
          }[],
        }
      : {}),
    user: {
      modelName: "auth_users",
      changeEmail: {
        enabled: mailReady(env),
        sendChangeEmailConfirmation: async ({ user, url }) => {
          const token = new URL(url).searchParams.get("token");
          if (!token) throw new Error("missing email confirmation token");
          await queueEmailProof(
            env,
            user,
            token,
            "Confirm your Open Whiteboard email change",
            "Confirm this request from your current address. A second message will verify the new address.",
          );
        },
      },
      deleteUser: { enabled: false },
    },
    session: {
      modelName: "auth_sessions",
      expiresIn: settings?.session_idle_seconds ?? 604800,
      updateAge: Math.min(
        86400,
        Math.floor((settings?.session_idle_seconds ?? 604800) / 4),
      ),
      freshAge: 300,
      cookieCache: { enabled: false },
      additionalFields: {
        absoluteExpiresAt: {
          type: "date",
          required: true,
          input: false,
          returned: false,
        },
        authenticatedAt: {
          type: "date",
          required: true,
          input: false,
          returned: false,
        },
        assurance: {
          type: "string",
          required: true,
          defaultValue: "weak",
          input: false,
          returned: false,
        },
        authVersion: {
          type: "number",
          required: true,
          defaultValue: 1,
          input: false,
          returned: false,
        },
      },
    },
    account: {
      modelName: "auth_accounts",
      encryptOAuthTokens: true,
      storeStateStrategy: "database",
      updateAccountOnSignIn: false,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: false,
        allowUnlinkingAll: true,
        updateUserInfoOnLink: false,
      },
    },
    verification: {
      modelName: "auth_verifications",
      storeIdentifier: "hashed",
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 15,
      maxPasswordLength: 512,
      requireEmailVerification: true,
      autoSignIn: false,
      password: {
        hash: async (value) => {
          try {
            return await derivePasswordHash(value);
          } catch (error) {
            if (error instanceof HttpError)
              throw new APIError(
                error.status === 400 ? "BAD_REQUEST" : "SERVICE_UNAVAILABLE",
                { message: error.message, code: error.code },
              );
            throw error;
          }
        },
        verify: verifyPassword,
      },
      resetPasswordTokenExpiresIn: 1800,
      sendResetPassword: async ({ user, url }) => {
        const source = new URL(url);
        const link = `${origin}/recover#token=${encodeURIComponent(source.searchParams.get("token") ?? source.pathname.split("/").at(-1)!)}`;
        await queueMail(
          env,
          user.email,
          "Reset your Open Whiteboard password",
          "Use this link to choose a new password. Your other sessions and connected apps will be signed out.",
          link,
          Date.now() + 1800_000,
        );
      },
      // D1 migration 0021 revokes sessions and grants inside the credential
      // write, including resets, direct changes and server-only setPassword.
    },
    emailVerification: {
      sendOnSignUp: true,
      expiresIn: 86400,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }) => {
        const source = new URL(url);
        await queueEmailProof(
          env,
          user,
          source.searchParams.get("token")!,
          "Verify your Open Whiteboard email",
          "Confirm this email address to continue to Open Whiteboard.",
        );
      },
      afterEmailVerification: async (user) => {
        await synchronizeIdentity(env, user);
      },
    },
    socialProviders: {
      ...(providers.github
        ? {
            github: { ...providers.github, scope: ["read:user", "user:email"] },
          }
        : {}),
      ...(providers.google ? { google: { ...providers.google } } : {}),
    },
    plugins: [
      localAccounts(env),
      twoFactor({
        issuer: PRODUCT_NAME,
        twoFactorTable: "auth_two_factors",
        allowPasswordless: true,
        twoFactorCookieMaxAge: 300,
        trustDeviceMaxAge: 0,
        backupCodeOptions: {
          amount: 10,
          length: 20,
          allowPasswordless: true,
          storeBackupCodes: {
            encrypt: async (value) =>
              JSON.stringify(
                await Promise.all(
                  (JSON.parse(value) as string[]).map((code) =>
                    code.startsWith("r1:")
                      ? code
                      : sha256(code).then((hash) => `r1:${hash}`),
                  ),
                ),
              ),
            decrypt: async (value) => value,
          },
        },
        schema: { twoFactor: { modelName: "auth_two_factors" } },
      }),
      passkey({
        rpID: new URL(origin).hostname,
        rpName: PRODUCT_NAME,
        origin,
        authenticatorSelection: { userVerification: "required" },
        registration: {
          afterVerification: async ({ verification }) => {
            if (!verification.registrationInfo?.userVerified)
              throw new APIError("UNAUTHORIZED", {
                message:
                  "Verify with your device PIN or biometrics to add this passkey.",
              });
          },
        },
        authentication: {
          afterVerification: async ({ verification }) => {
            if (!verification.authenticationInfo.userVerified)
              throw new APIError("UNAUTHORIZED", {
                message: "User verification is required.",
              });
          },
        },
        schema: { passkey: { modelName: "auth_passkeys" } },
      }),
      safeOidcPlugin(env, providers.oidc ?? []),
      operatorRecovery(env),
      magicLink({
        disableSignUp: false,
        expiresIn: 600,
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }) => {
          const settings = await installation(env);
          if (!settings.magic_link)
            throw new APIError("FORBIDDEN", {
              message: "Magic links are disabled.",
            });
          const source = new URL(url);
          await queueMail(
            env,
            email,
            "Sign in to Open Whiteboard",
            "Confirm this sign-in request in Open Whiteboard.",
            `${origin}/magic#token=${encodeURIComponent(source.searchParams.get("token")!)}`,
            Date.now() + 600_000,
          );
        },
      }),
      {
        id: "canvas-access-exchange",
        endpoints: {
          signInAccess: createAuthEndpoint(
            "/sign-in/access",
            { method: "POST" },
            async (ctx) => {
              if (!env.ACCESS_INTEGRATION || env.ACCESS_INTEGRATION === "off")
                throw new APIError("FORBIDDEN", {
                  message: "Access sign-in is disabled.",
                });
              if (!ctx.request?.headers.has("Cf-Access-Jwt-Assertion"))
                throw new APIError("UNAUTHORIZED", {
                  message: "An Access identity is required.",
                });
              const legacy = await authenticateLegacy(ctx.request, env);
              const linked = await env.CATALOG.prepare(
                "SELECT user_id FROM access_identities WHERE issuer = ? AND subject = ? AND revoked_at IS NULL",
              )
                .bind(legacy.issuer, legacy.subject)
                .first<{ user_id: string }>();
              if (!linked)
                throw new APIError("FORBIDDEN", {
                  message:
                    "This Access identity has not been migrated. Ask the owner to migrate it.",
                });
              const user = await ctx.context.internalAdapter.findUserById(
                linked.user_id,
              );
              if (!user)
                throw new APIError("FORBIDDEN", {
                  message: "This account is unavailable.",
                });
              const verified = await ctx.context.internalAdapter.updateUser(
                user.id,
                { emailVerified: true },
              );
              const session = await ctx.context.internalAdapter.createSession(
                user.id,
              );
              await setSessionCookie(ctx, { session, user: verified });
              return ctx.json({ success: true });
            },
          ),
        },
      },
    ],
    trustedOrigins: [origin],
    advanced: {
      useSecureCookies: origin.startsWith("https:"),
      cookiePrefix: origin.startsWith("https:") ? "__Host-canvas" : "canvas",
      defaultCookieAttributes: {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: origin.startsWith("https:"),
      },
      trustedProxyHeaders: false,
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      database: {
        generateId: ({ model }) =>
          `${model === "user" ? "user" : model}:${crypto.randomUUID()}`,
        validateSchema: true,
      },
    },
    rateLimit: {
      enabled: true,
      max: 100,
      window: 60,
      customStorage: {
        consume: async (key, rule) =>
          consumeLimit(
            env.CATALOG,
            `auth:${await hmac(env.AUTH_SECRET!, key)}`,
            rule.max,
            rule.window,
          ),
      },
      customRules: {
        "/sign-in/email": { max: 20, window: 600 },
        "/two-factor/*": { max: 6, window: 300 },
        "/request-password-reset": { max: 20, window: 3600 },
      },
    },
    databaseHooks: hooks,
    logger: { disabled: true }, // Public errors and the reviewed audit fields replace raw library request logging.
  };
}
export async function configuredProviders(env: NativeEnv): Promise<Providers> {
  const providers: Providers = {};
  for (const id of ["github", "google"] as const) {
    const upper = id.toUpperCase();
    const clientId =
      env[`${upper}_CLIENT_ID` as "GITHUB_CLIENT_ID" | "GOOGLE_CLIENT_ID"];
    const clientSecret =
      env[
        `${upper}_CLIENT_SECRET` as
          | "GITHUB_CLIENT_SECRET"
          | "GOOGLE_CLIENT_SECRET"
      ];
    if (clientId && clientSecret) providers[id] = { clientId, clientSecret };
    else {
      const row = await env.CATALOG.prepare(
        "SELECT public_config, secret FROM auth_provider_config WHERE id = ? AND enabled = 1 AND tested_at IS NOT NULL",
      )
        .bind(id)
        .first<{ public_config: string; secret: string }>();
      if (row)
        providers[id] = {
          ...JSON.parse(row.public_config),
          clientSecret: await open(env, row.secret, `provider:${id}`),
        };
    }
  }
  const deployedOidc: OidcConfiguration[] = [];
  if (env.OIDC_CONFIG) {
    const configs: unknown = JSON.parse(env.OIDC_CONFIG);
    if (!Array.isArray(configs) || configs.length > 20)
      throw new HttpError(
        503,
        "OIDC_CONFIG must contain up to 20 providers.",
        "AUTH_NOT_CONFIGURED",
      );
    deployedOidc.push(
      ...configs.map((config) => validateOidcConfiguration(env, config)),
    );
  }
  const deployedIds = new Set(deployedOidc.map((provider) => provider.providerId));
  const rows = await env.CATALOG.prepare(
    "SELECT id, public_config, secret FROM auth_provider_config WHERE id LIKE 'oidc-%' AND enabled = 1 AND tested_at IS NOT NULL",
  ).all<{ id: string; public_config: string; secret: string }>();
  // Match the administration inventory: deployment configuration overrides the
  // same provider ID, while other providers added in the app remain usable.
  providers.oidc = [
    ...deployedOidc,
    ...(await Promise.all(
      rows.results
        .filter((row) => !deployedIds.has(row.id))
        .map(async (row) =>
          validateOidcConfiguration(env, {
            ...JSON.parse(row.public_config),
            providerId: row.id,
            clientSecret: await open(env, row.secret, `provider:${row.id}`),
          }),
        ),
    )),
  ];
  return providers;
}
const authInstances = new WeakMap<
  object,
  {
    version: number;
    expiresAt: number;
    promise: Promise<ReturnType<typeof betterAuth>>;
  }
>();
export async function nativeAuth(
  env: NativeEnv,
  database?: BetterAuthOptions["database"],
) {
  nativeConfigured(env);
  const settings = await installation(env);
  const cached = !database && authInstances.get(env);
  if (
    cached &&
    cached.version === settings.version &&
    cached.expiresAt > Date.now()
  )
    return cached.promise;
  const promise = (async () =>
    betterAuth(
      libraryOptions(
        env,
        await configuredProviders(env),
        {
          user: {
            create: {
              before: async (user, context) => {
                if (
                  !(await mayRegister(
                    env,
                    user.email.toLowerCase(),
                    context?.request,
                  ))
                )
                  throw new APIError("FORBIDDEN", {
                    message:
                      "Registration is unavailable. Ask for an invitation.",
                  });
              },
              after: async (user, context) => {
                try {
                  await provisionUser(env, user, context?.request);
                } catch (error) {
                  if (error instanceof HttpError)
                    throw new APIError("CONFLICT", {
                      message: error.message,
                      code: error.code,
                    });
                  throw error;
                }
              },
            },
            update: { after: async (user) => synchronizeIdentity(env, user) },
          },
          session: {
            create: {
              before: async (session, context) => {
                const state = await securityState(env.CATALOG, session.userId);
                if (
                  !state ||
                  ["suspended", "deleted", "deletion_pending"].includes(
                    state.status,
                  )
                )
                  throw new APIError("UNAUTHORIZED", {
                    message: "This account is unavailable.",
                  });
                const settings = await installation(env);
                const now = new Date();
                const path = context?.path ?? "";
                return {
                  data: {
                    ...session,
                    authVersion: state.auth_version,
                    absoluteExpiresAt: new Date(
                      now.getTime() + settings.session_absolute_seconds * 1000,
                    ),
                    authenticatedAt: now,
                    expiresAt: new Date(
                      now.getTime() + settings.session_idle_seconds * 1000,
                    ),
                    assurance:
                      path.includes("verify-authentication") ||
                      path.includes("verify-totp")
                        ? "strong"
                        : path.includes("verify-backup-code")
                          ? "recovery"
                          : "weak",
                  },
                };
              },
            },
            update: {
              before: async (session) => {
                if (
                  session.absoluteExpiresAt &&
                  session.expiresAt &&
                  new Date(session.expiresAt).getTime() >
                    new Date(session.absoluteExpiresAt as Date).getTime()
                )
                  return {
                    data: {
                      ...session,
                      expiresAt: new Date(session.absoluteExpiresAt as Date),
                    },
                  };
              },
            },
          },
        },
        database,
        settings,
      ),
    ))();
  // Discovery can be temporarily unavailable during plugin initialization.
  // Retry it without requiring the operator to redeploy or edit a provider.
  if (!database)
    authInstances.set(env, {
      version: settings.version,
      expiresAt: Date.now() + 60_000,
      promise,
    });
  try {
    return await promise;
  } catch (error) {
    if (!database) authInstances.delete(env);
    throw error;
  }
}
