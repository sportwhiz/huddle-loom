import { updateRoutes } from "../src/updates/routes";
import { nativeAuth } from "../src/auth/library";
import { invitationRoutes } from "../src/auth/invitations";
import { createWorkbookInvitation } from "../src/collaboration.server";
import { authenticateOAuth } from "../src/oauth.server";
import { sha256 } from "../src/security/primitives";
import { accountRoutes } from "../src/auth/account-routes";
import { adminRoutes } from "../src/admin/routes";
import { mailSetupRoutes, mailEnvironment } from "../src/mail/setup";
import {
  InstallationKeys,
  installationEnvironment,
} from "../src/auth/installation-keys";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityRoutes } from "../src/auth/routes";
import { nativePrincipal } from "../src/auth/session";
import type { NativeEnv } from "../src/auth/types";

const origin = "https://canvas.example.com";
const migrationDirectory = new URL("../migrations/", import.meta.url);

function totp(uri: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...new URL(uri).searchParams.get("secret")!]
    .map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0"))
    .join("");
  const key = Buffer.from(
    (bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  return ((digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1000000)
    .toString()
    .padStart(6, "0");
}

// Exercise Better Auth's real D1 dialect, application hooks and SQL constraints.
// Only the D1 transport and external GitHub responses are local fixtures.
function fixtureDatabase(db: DatabaseSync) {
  const prepare = (sql: string, values: SQLInputValue[] = []) => {
    const execute = () => {
      const results = db.prepare(sql).all(...values);
      const meta = db
        .prepare(
          "SELECT changes() AS changes, last_insert_rowid() AS last_row_id",
        )
        .get();
      return { success: true, results, meta };
    };
    return {
      bind: (...next: SQLInputValue[]) => prepare(sql, next),
      first: async () => db.prepare(sql).get(...values) ?? null,
      all: async () => execute(),
      run: async () => execute(),
      execute,
    };
  };
  return {
    prepare,
    exec: async (sql: string) => db.exec(sql),
    batch: async (statements: ReturnType<typeof prepare>[]) => {
      db.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.execute());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

describe("fresh native owner setup with GitHub", () => {
  let db: DatabaseSync;
  let env: NativeEnv;
  let cookies: Map<string, string>;
  let csrf: string;
  let setupCookie: string;
  let verified: boolean;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const name of readdirSync(migrationDirectory)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      db.exec(readFileSync(new URL(name, migrationDirectory), "utf8"));
    env = {
      CATALOG: fixtureDatabase(db),
      AUTH_MODE: "native",
      AUTH_ORIGIN: origin,
      AUTH_SECRET: "isolated-native-setup-test-secret-never-deploy",
      AUTH_BOOTSTRAP_SECRET: "isolated-native-setup-bootstrap-never-deploy",
      AUTH_ENCRYPTION_KEYS: JSON.stringify([
        { id: "fixture", key: Buffer.alloc(32, 7).toString("base64url") },
      ]),
      ACCESS_INTEGRATION: "off",
      GITHUB_CLIENT_ID: "fixture-client",
      GITHUB_CLIENT_SECRET: "fixture-secret",
    };
    cookies = new Map();
    csrf = "";
    setupCookie = "";
    verified = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.hostname === "api.pwnedpasswords.com")
          return new Response("00000000000000000000000000000000000:0");
        if (url.href === "https://github.com/login/oauth/access_token")
          return Response.json({
            access_token: "fixture-token",
            token_type: "bearer",
            scope: "read:user,user:email",
          });
        if (url.href === "https://api.github.com/user")
          return Response.json({
            id: 12345,
            login: "fixture",
            name: "Fixture Owner",
            email: "owner@example.com",
            avatar_url: null,
          });
        if (url.href === "https://api.github.com/user/emails")
          return Response.json([
            {
              email: "owner@example.com",
              primary: true,
              verified,
              visibility: "public",
            },
          ]);
        throw new Error(
          `Unexpected external request: ${url.origin}${url.pathname}`,
        );
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  function request(path: string, body?: unknown, crossSite = false) {
    // A provider's top-level GET sends Lax cookies, but not Strict cookies.
    const sent = [...cookies].filter(
      ([name]) =>
        !crossSite ||
        name !== "canvas-setup" ||
        setupCookie.includes("SameSite=Lax"),
    );
    return new Request(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Cookie: sent.map(([key, value]) => `${key}=${value}`).join("; "),
        Origin: origin,
        "Sec-Fetch-Site": crossSite ? "cross-site" : "same-origin",
        ...(body === undefined
          ? {}
          : { "Content-Type": "application/json", "X-Canvas-CSRF": csrf }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function call(path: string, body?: unknown, crossSite = false) {
    const response = ((await identityRoutes(
      request(path, body, crossSite),
      env,
    )) ??
      (await updateRoutes(request(path, body, crossSite), env)) ??
      (await mailSetupRoutes(request(path, body, crossSite), env)) ??
      (await accountRoutes(request(path, body, crossSite), env)) ??
      (await adminRoutes(request(path, body, crossSite), env)))!;
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(";")[0];
      const index = pair.indexOf("=");
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
      if (pair.startsWith("canvas-setup=")) setupCookie = value;
    }
    if (path === "/api/v1/auth/bootstrap")
      csrf = (await response.clone().json()).csrf;
    return response;
  }
  async function begin(unlock = true) {
    await call("/api/v1/auth/bootstrap");
    if (unlock) {
      const response = await call("/api/v1/setup/unlock", {
        secret: env.AUTH_BOOTSTRAP_SECRET,
      });
      expect(response.status).toBe(200);
      expect(setupCookie).toContain("HttpOnly");
      expect(setupCookie).toContain("; Secure");
      expect(setupCookie).not.toContain("Domain=");
    }
    const response = await call("/api/auth/sign-in/social", {
      provider: "github",
      callbackURL: "/",
      errorCallbackURL: "/login",
      disableRedirect: true,
    });
    expect(response.status).toBe(200);
    return new URL((await response.json()).url).searchParams.get("state")!;
  }
  async function callback(state: string) {
    return call(
      `/api/auth/callback/github?state=${encodeURIComponent(state)}&code=fixture-code`,
      undefined,
      true,
    );
  }

  it("reuses provider discovery after guided email setup and refreshes changed senders", async () => {
    db.prepare(
      "INSERT INTO installation_mail(id,sender,recipient,confirmed_at) VALUES('instance','sender@example.com','owner@example.com',1)",
    ).run();
    const fetcher = vi.fn(async () =>
      Response.json({
        issuer: "https://identity.example.com",
        authorization_endpoint: "https://identity.example.com/authorize",
        token_endpoint: "https://identity.example.com/token",
        jwks_uri: "https://identity.example.com/keys",
        id_token_signing_alg_values_supported: ["RS256"],
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    env = {
      ...env,
      EMAIL: { send: async () => ({ messageId: "fixture" }) },
      OIDC_ALLOWED_ORIGINS: "https://identity.example.com",
      OIDC_CONFIG: JSON.stringify([
        {
          providerId: "oidc-demo",
          clientId: "demo",
          clientSecret: "fixture-secret",
          discoveryUrl:
            "https://identity.example.com/.well-known/openid-configuration",
        },
      ]),
    };
    const environments = await Promise.all([
      mailEnvironment(env),
      mailEnvironment(env),
    ]);
    await Promise.all(
      environments.map(async (value) => (await nativeAuth(value)).$context),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(environments[0].MAIL_FROM).toBe("sender@example.com");
    expect(env.MAIL_FROM).toBeUndefined();

    // Simulate confirmation on a different isolate: no in-process invalidation.
    db.prepare(
      "UPDATE installation_mail SET sender='replacement@example.com'",
    ).run();
    const replacement = await mailEnvironment(env);
    expect(replacement.MAIL_FROM).toBe("replacement@example.com");
    await (
      await nativeAuth(replacement)
    ).$context;
    await (
      await nativeAuth(await mailEnvironment(env))
    ).$context;
    expect(fetcher).toHaveBeenCalledTimes(2);

    db.prepare("DELETE FROM installation_mail").run();
    expect((await mailEnvironment(env)).MAIL_FROM).toBeUndefined();
    // Explicit configuration is never replaced by a database sender.
    const managed = { ...env, MAIL_FROM: "managed@example.com" };
    expect(await mailEnvironment(managed)).toBe(managed);
  });

  it("restores an unlinked password through recovery and requires a replacement factor", async () => {
    const owner = await localOwner();
    const id = (await nativePrincipal(request("/api/v1/catalog"), env)).user.id;
    // The account has linked another usable provider before removing its password.
    const at = new Date().toISOString();
    db.prepare(
      "INSERT INTO auth_accounts(id,accountId,providerId,userId,createdAt,updatedAt) VALUES('linked','external-id','github',?,?,?)",
    ).run(id, at, at);
    env = {
      ...env,
      GITHUB_CLIENT_ID: "fixture-client",
      GITHUB_CLIENT_SECRET: "fixture-secret",
    };
    const credential = db
      .prepare("SELECT id FROM auth_accounts WHERE providerId='credential'")
      .get()!;
    expect(
      (await call("/api/auth/unlink-account", { accountId: credential.id }))
        .status,
    ).toBe(200);
    await call("/api/auth/sign-out", {});
    const newPassword = "brand new testing phrase 729!";
    expect(
      (
        await call("/api/auth/recover/local", {
          username: "owner",
          code: "x".repeat(43),
          newPassword,
        })
      ).status,
    ).toBe(401);
    expect(
      db
        .prepare("SELECT id FROM auth_accounts WHERE providerId='credential'")
        .get(),
    ).toBeUndefined();
    const response = await call("/api/auth/recover/local", {
      username: "owner",
      code: owner.recoveryCode,
      newPassword,
    });
    expect(response.status).toBe(200);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM auth_accounts WHERE userId=? AND providerId='credential'",
        )
        .get(id)!.n,
    ).toBe(1);
    expect(
      db.prepare("SELECT id FROM auth_accounts WHERE id='linked'").get(),
    ).toBeDefined();
    await expect(
      nativePrincipal(request("/api/v1/catalog"), env),
    ).rejects.toThrow();
    const enrollment = await (
      await call("/api/auth/two-factor/enable", { password: newPassword })
    ).json();
    expect(enrollment).toHaveProperty("totpURI");
    expect(
      (
        await call("/api/auth/two-factor/verify-totp", {
          code: totp(enrollment.totpURI),
        })
      ).status,
    ).toBe(200);
    expect((await call("/api/v1/account/recovery-complete", {})).status).toBe(
      200,
    );
    expect(
      (
        await call("/api/auth/sign-in/local", {
          username: "owner",
          password: newPassword,
        })
      ).status,
    ).toBe(200);
    expect(await (await call("/api/v1/auth/bootstrap")).json()).toMatchObject({
      account: { needsMfa: true, assurance: "weak" },
    });
  });

  it("locks authenticator checks made from a password session", async () => {
    env = {
      ...env,
      GITHUB_CLIENT_ID: undefined,
      GITHUB_CLIENT_SECRET: undefined,
      SETUP_PASSWORD: "our private installation phrase",
    };
    const payload = {
      name: "Local Owner",
      username: "studio-owner",
      password: "distinct test account phrase 471!",
    };
    await call("/api/v1/auth/bootstrap");
    await call("/api/v1/setup/unlock", { secret: env.SETUP_PASSWORD });
    expect((await call("/api/auth/setup/local", payload)).status).toBe(200);
    const enrollment = await (
      await call("/api/auth/two-factor/enable", { password: payload.password })
    ).json();
    expect(
      (
        await call("/api/auth/two-factor/verify-totp", {
          code: totp(enrollment.totpURI),
        })
      ).status,
    ).toBe(200);
    expect(
      (await call("/api/v1/setup/complete", { title: "Our Studio" })).status,
    ).toBe(200);
    await call("/api/auth/sign-out", {});
    expect((await call("/api/auth/sign-in/local", payload)).status).toBe(200);
    const verify = async (code: string) => {
      try {
        return (await call("/api/auth/two-factor/verify-totp", { code }))
          .status;
      } catch (error) {
        return (error as { status: number }).status;
      }
    };
    const counter = () =>
      db
        .prepare(
          "SELECT failedVerificationCount AS count, lockedUntil AS until FROM auth_two_factors",
        )
        .get()!;
    const wrong = String(
      (Number(totp(enrollment.totpURI)) + 500000) % 1000000,
    ).padStart(6, "0");
    const statuses = [];
    for (let attempt = 0; attempt < 8; attempt++)
      statuses.push(await verify(wrong));
    // better-auth's per-address limit rejects the later attempts. Those
    // rejections must not use up the account's budget.
    expect(statuses).toContain(429);
    expect(counter().count).toBe(statuses.filter((code) => code === 401).length);

    db.exec("DELETE FROM request_limits");
    db.prepare("UPDATE auth_two_factors SET failedVerificationCount = 9").run();
    expect(await verify(wrong)).toBe(401);
    expect(counter().count).toBe(10);
    expect(counter().until).toBeTruthy();
    db.exec("DELETE FROM mfa_replay");
    expect(await verify(totp(enrollment.totpURI))).toBe(429);

    // A lock in the MySQL driver's format is compared as a date.
    db.prepare(
      "UPDATE auth_two_factors SET lockedUntil = '2000-01-01 00:00:00'",
    ).run();
    db.exec("DELETE FROM request_limits; DELETE FROM mfa_replay");
    expect(await verify(totp(enrollment.totpURI))).toBe(200);
    expect(counter()).toEqual({ count: 0, until: null });
  });

  it("creates a local owner without email or OAuth, then requires MFA on every login", async () => {
    env = {
      ...env,
      GITHUB_CLIENT_ID: undefined,
      GITHUB_CLIENT_SECRET: undefined,
      SETUP_PASSWORD: "our private installation phrase",
    };
    await call("/api/v1/auth/bootstrap");
    const payload = {
      name: "Local Owner",
      username: "studio-owner",
      password: "distinct test account phrase 471!",
    };
    expect((await call("/api/auth/setup/local", payload)).status).toBe(403);
    await call("/api/v1/setup/unlock", { secret: env.SETUP_PASSWORD });
    const created = await call("/api/auth/setup/local", payload);
    expect(created.status).toBe(200);
    expect((await created.json()).recoveryCode).toHaveLength(43);
    expect(
      db.prepare("SELECT emailVerified FROM auth_users").get()!.emailVerified,
    ).toBe(0);
    expect(await (await call("/api/v1/auth/bootstrap")).json()).toMatchObject({
      email: false,
      localAccounts: true,
      account: {
        localUsername: "studio-owner",
        verified: true,
        emailVerified: false,
      },
    });
    await expect(call("/api/v1/setup/complete", {})).rejects.toThrow();
    const enrollment = await (
      await call("/api/auth/two-factor/enable", { password: payload.password })
    ).json();
    expect(enrollment.backupCodes).toHaveLength(10);
    expect(
      (
        await call("/api/auth/two-factor/verify-totp", {
          code: totp(enrollment.totpURI),
        })
      ).status,
    ).toBe(200);
    expect(
      (await call("/api/v1/setup/complete", { title: "Our Studio" })).status,
    ).toBe(200);
    expect(
      (await nativePrincipal(request("/api/v1/catalog"), env)).state.role,
    ).toBe("owner");
    await call("/api/auth/sign-out", {});
    expect(
      (
        await call("/api/auth/sign-in/local", {
          username: payload.username,
          password: "wrong password",
        })
      ).status,
    ).toBe(401);
    expect((await call("/api/auth/sign-in/local", payload)).status).toBe(200);
    expect(await (await call("/api/v1/auth/bootstrap")).json()).toMatchObject({
      account: { needsMfa: true, assurance: "weak" },
    });
    await expect(
      nativePrincipal(request("/api/v1/catalog"), env),
    ).rejects.toThrow();
    expect(
      (
        await call("/api/auth/setup/local", {
          ...payload,
          username: "intruder",
        })
      ).status,
    ).toBe(403);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM local_accounts").get()!.n,
    ).toBe(1);
  });

  it("shows the setup-password instruction when an existing deployment has no claim credential", async () => {
    env = {
      ...env,
      AUTH_BOOTSTRAP_SECRET: undefined,
      SETUP_PASSWORD: undefined,
    };
    expect(await (await call("/api/v1/auth/bootstrap")).json()).toMatchObject({
      setupPassword: true,
      setupCredentialConfigured: false,
    });
    await expect(
      call("/api/v1/setup/unlock", { secret: "an arbitrary visitor phrase" }),
    ).rejects.toThrow("setup password");
  });

  async function localOwner() {
    env = {
      ...env,
      GITHUB_CLIENT_ID: undefined,
      GITHUB_CLIENT_SECRET: undefined,
    };
    await call("/api/v1/auth/bootstrap");
    await call("/api/v1/setup/unlock", { secret: env.AUTH_BOOTSTRAP_SECRET });
    const password = "distinct account creation phrase 672!";
    const created = await (
      await call("/api/auth/setup/local", {
        name: "Owner",
        username: "owner",
        password,
      })
    ).json();
    const enrollment = await (
      await call("/api/auth/two-factor/enable", { password })
    ).json();
    await call("/api/auth/two-factor/verify-totp", {
      code: totp(enrollment.totpURI),
    });
    await call("/api/v1/setup/complete", { title: "Our Studio" });
    return {
      password,
      recoveryCode: created.recoveryCode,
      backupCode: enrollment.backupCodes[0],
    };
  }
  it("protects update controls with owner permission and fresh MFA", async () => {
    await localOwner();
    const hook =
      "https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/11111111-1111-1111-1111-111111111111";
    expect((await call("/api/v1/admin/updates")).status).toBe(200);
    const connected = await call("/api/v1/admin/updates/connection", { hook });
    expect(connected.status).toBe(200);
    expect(JSON.stringify(await connected.json())).not.toContain(hook);
    db.prepare("UPDATE auth_sessions SET authenticatedAt=?").run(
      new Date(Date.now() - 1800000).toISOString(),
    );
    await expect(
      call("/api/v1/admin/updates/connection", { hook }),
    ).rejects.toThrow("Confirm your identity");
    await expect(
      call("/api/v1/admin/updates/retry-deployment", {
        id: "stopped-job",
        cancelledBuild: true,
      }),
    ).rejects.toThrow("Confirm your identity");
  });
  it("does not expose update metadata or controls to ordinary members", async () => {
    await localOwner();
    const invitation = await (
      await call("/api/v1/admin/local-invitations", {
        label: "Member",
        role: "member",
      })
    ).json();
    await call("/api/auth/sign-out", {});
    await call("/api/auth/setup/local", {
      name: "Member",
      username: "updates-member",
      password: "a distinct member passphrase 714!",
      invitation: invitation.token,
    });
    await expect(call("/api/v1/admin/updates")).rejects.toThrow(
      "Administrator permission",
    );
    await expect(call("/api/v1/admin/updates/check", {})).rejects.toThrow(
      "Administrator permission",
    );
    await expect(
      call("/api/v1/admin/updates/retry-deployment", {
        id: "stopped-job",
        cancelledBuild: true,
      }),
    ).rejects.toThrow("Administrator permission");
  });
  it("admits a second local account with a single-use invitation, preserving private content", async () => {
    await localOwner();
    const invitation = await (
      await call("/api/v1/admin/local-invitations", {
        label: "Teammate",
        role: "member",
      })
    ).json();
    const owner = (await nativePrincipal(request("/api/v1/catalog"), env))
      .principal;
    cookies = new Map();
    await call("/api/v1/auth/bootstrap");
    const response = await call("/api/auth/setup/local", {
      name: "Teammate",
      username: "teammate",
      password: "another distinct testing phrase 739!",
      invitation: invitation.token,
    });
    expect(response.status).toBe(200);
    const identity = await nativePrincipal(request("/api/v1/catalog"), env);
    expect(identity.state.role).toBe("member");
    expect(identity.user.emailVerified).toBe(false);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM resource_grants WHERE user_id=? AND resource_id NOT LIKE ?",
        )
        .get(identity.user.id, `%${identity.user.id}%`)!.n,
    ).toBe(0);
    await expect(
      call("/api/v1/admin/local-invitations", { label: "Unauthorized" }),
    ).rejects.toThrow();
    const workbook = `workbook:${owner.id}:ideas`;
    const shared = await createWorkbookInvitation(
      env.CATALOG,
      workbook,
      owner,
      { email: "teammate", role: "editor" },
    );
    const accepted = await invitationRoutes(
      request("/api/v1/invitations/accept", { token: shared.token }),
      env,
    );
    expect(accepted?.status).toBe(200);
    expect(
      db
        .prepare(
          "SELECT role FROM resource_grants WHERE resource_id=? AND user_id=?",
        )
        .get(workbook, identity.user.id)!.role,
    ).toBe("editor");
    await call("/api/auth/sign-out", {});
    expect(
      (
        await call("/api/auth/setup/local", {
          name: "Replay",
          username: "replay",
          password: "another distinct testing phrase 738!",
          invitation: invitation.token,
        })
      ).status,
    ).toBe(409);
    expect(db.prepare("SELECT COUNT(*) n FROM auth_users").get()!.n).toBe(2);
  });
  it("deletes an invited guest without reviving their consumed invitation", async () => {
    await localOwner();
    const invitation = await (
      await call("/api/v1/admin/local-invitations", {
        label: "Guest",
        role: "guest",
      })
    ).json();
    await call("/api/auth/sign-out", {});
    const signup = {
      name: "Guest",
      username: "guest",
      password: "another distinct testing phrase 932!",
      invitation: invitation.token,
    };
    expect((await call("/api/auth/setup/local", signup)).status).toBe(200);
    const id = (await nativePrincipal(request("/api/v1/catalog"), env)).user.id;
    expect(
      (await call("/api/v1/account/delete", { confirm: "guest" })).status,
    ).toBe(200);
    expect(
      db.prepare("SELECT id FROM auth_users WHERE id=?").get(id),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT user_id FROM local_accounts WHERE user_id=?").get(id),
    ).toBeUndefined();
    expect(
      db
        .prepare("SELECT accepted_by FROM local_invitations WHERE id=?")
        .get(invitation.id)!.accepted_by,
    ).toBe(id);
    expect(
      (await call("/api/auth/setup/local", { ...signup, username: "replay" }))
        .status,
    ).toBe(409);
  });

  it("rejects revoked or expired invitations without creating orphan accounts", async () => {
    await localOwner();
    const invitation = await (
      await call("/api/v1/admin/local-invitations", { label: "Revoked" })
    ).json();
    await call(`/api/v1/admin/local-invitations/${invitation.id}/revoke`, {});
    await call("/api/auth/sign-out", {});
    const payload = {
      name: "Guest",
      username: "guest",
      password: "another distinct testing phrase 932!",
      invitation: invitation.token,
    };
    expect((await call("/api/auth/setup/local", payload)).status).toBe(409);
    db.prepare(
      "UPDATE local_invitations SET revoked_at=NULL,expires_at=0",
    ).run();
    expect((await call("/api/auth/setup/local", payload)).status).toBe(409);
    expect(db.prepare("SELECT COUNT(*) n FROM auth_users").get()!.n).toBe(1);
  });
  it("enforces the account limit and preserves an invitation after a username conflict", async () => {
    await localOwner();
    const invitation = await (
      await call("/api/v1/admin/local-invitations", { label: "Friend" })
    ).json();
    await call("/api/auth/sign-out", {});
    const payload = {
      name: "Friend",
      username: "owner",
      password: "another distinct testing phrase 932!",
      invitation: invitation.token,
    };
    expect((await call("/api/auth/setup/local", payload)).status).toBe(409);
    expect(
      db.prepare("SELECT accepted_by FROM local_invitations").get()!
        .accepted_by,
    ).toBeNull();
    db.prepare("UPDATE installation SET member_limit=1").run();
    expect(
      (await call("/api/auth/setup/local", { ...payload, username: "friend" }))
        .status,
    ).toBe(409);
    expect(db.prepare("SELECT COUNT(*) n FROM auth_users").get()!.n).toBe(1);
    db.prepare("UPDATE installation SET member_limit=25").run();
    expect(
      (await call("/api/auth/setup/local", { ...payload, username: "friend" }))
        .status,
    ).toBe(200);
  });

  it("recovers without email, consumes the recovery key and blocks boards until a replacement factor", async () => {
    const owner = await localOwner();
    const replacement = await (
      await call("/api/v1/account/local-recovery-key", {})
    ).json();
    await call("/api/auth/sign-out", {});
    const credentialId = db
      .prepare("SELECT id FROM auth_accounts WHERE providerId='credential'")
      .get()!.id;
    const newPassword = "replacement testing phrase 968!";
    expect(
      (
        await call("/api/auth/recover/local", {
          username: "owner",
          code: owner.recoveryCode,
          newPassword,
        })
      ).status,
    ).toBe(401);
    owner.recoveryCode = replacement.recoveryCode;
    const recovered = await call("/api/auth/recover/local", {
      username: "owner",
      code: owner.recoveryCode,
      newPassword,
    });
    expect(recovered.status).toBe(200);
    expect(
      db
        .prepare("SELECT id FROM auth_accounts WHERE providerId='credential'")
        .get()!.id,
    ).toBe(credentialId);
    expect((await recovered.json()).recoveryCode).toHaveLength(43);
    await expect(
      nativePrincipal(request("/api/v1/catalog"), env),
    ).rejects.toThrow();
    await expect(call("/api/v1/account/recovery-complete", {})).rejects.toThrow(
      "replacement factor",
    );
    expect(
      (
        await call("/api/auth/recover/local", {
          username: "owner",
          code: owner.recoveryCode,
          newPassword,
        })
      ).status,
    ).toBe(401);
    const enrollment = await (
      await call("/api/auth/two-factor/enable", { password: newPassword })
    ).json();
    expect(enrollment, JSON.stringify(enrollment)).toHaveProperty("totpURI");
    expect(
      (
        await call("/api/auth/two-factor/verify-totp", {
          code: totp(enrollment.totpURI),
        })
      ).status,
    ).toBe(200);
    expect((await call("/api/v1/account/recovery-complete", {})).status).toBe(
      200,
    );
    expect(
      (
        await call("/api/auth/sign-in/local", {
          username: "owner",
          password: owner.password,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call("/api/auth/sign-in/local", {
          username: "owner",
          password: newPassword,
        })
      ).status,
    ).toBe(200);
  });
  it("confirms received email before enabling a sender and preserves it after a failed change", async () => {
    await localOwner();
    let text = "";
    env = {
      ...env,
      EMAIL: {
        send: async (message) => {
          text = message.text;
          return { messageId: "fixture" };
        },
      },
    };
    const test = await (
      await call("/api/v1/installation/email/test", {
        sender: "huddle@example.com",
        recipient: "owner@example.net",
      })
    ).json();
    expect((await mailEnvironment(env)).MAIL_FROM).toBeUndefined();
    await expect(
      call("/api/v1/installation/email/confirm", {
        attempt: test.attempt,
        code: "incorrect",
      }),
    ).rejects.toThrow();
    await call("/api/v1/installation/email/confirm", {
      attempt: test.attempt,
      code: text.match(/\b\d{6}\b/)![0],
    });
    expect((await mailEnvironment(env)).MAIL_FROM).toBe("huddle@example.com");
    env = {
      ...env,
      EMAIL: {
        send: async () => {
          throw new Error("provider failure");
        },
      },
    };
    await expect(
      call("/api/v1/installation/email/test", {
        sender: "other@example.com",
        recipient: "owner@example.net",
      }),
    ).rejects.toThrow("could not send");
    expect((await mailEnvironment(env)).MAIL_FROM).toBe("huddle@example.com");
  });
  it("verifies managed email delivery without requesting a sender", async () => {
    await localOwner();
    let text = "";
    env = {
      ...env,
      MAIL_PROVIDER: "godaddy",
      MANAGED_MAIL: {
        send: async (message) => {
          text = message.text;
          return { providerId: "gateway-test" };
        },
      },
    };
    const before = await (await call("/api/v1/installation/email")).json();
    expect(before).toMatchObject({
      available: true,
      confirmed: false,
      managed: true,
      automaticSender: true,
    });
    const test = await (
      await call("/api/v1/installation/email/test", {
        recipient: "owner@example.net",
      })
    ).json();
    expect(
      (await (await call("/api/v1/installation/email")).json()).confirmed,
    ).toBe(false);
    await call("/api/v1/installation/email/confirm", {
      attempt: test.attempt,
      code: text.match(/\b\d{6}\b/)![0],
    });
    expect(
      (await (await call("/api/v1/installation/email")).json()).confirmed,
    ).toBe(true);
    expect(await mailEnvironment(env)).toBe(env);
    env.MANAGED_MAIL = {
      send: async () => {
        throw new Error("provider private diagnostics");
      },
    };
    await expect(
      call("/api/v1/installation/email/test", {
        recipient: "owner@example.net",
      }),
    ).rejects.toThrow("GoDaddy could not send");
    expect(
      (await (await call("/api/v1/installation/email")).json()).confirmed,
    ).toBe(true);
  });
  it("allows scoped MCP tokens for local accounts and rejects them during recovery", async () => {
    await localOwner();
    const user = db
      .prepare("SELECT user_id FROM local_accounts WHERE username='owner'")
      .get()!.user_id;
    const at = new Date().toISOString(),
      expires = new Date(Date.now() + 3600000).toISOString();
    db.prepare(
      "INSERT INTO oauth_clients(id,name,redirect_uris,created_at) VALUES('client','Test client','[]',?)",
    ).run(at);
    db.prepare(
      "INSERT INTO oauth_grants(id,user_id,client_id,scopes,resource_mode,confirmed_version,created_at) VALUES('grant',?,'client','[\"boards:read\"]','selected',1,?)",
    ).run(user, at);
    db.prepare(
      "INSERT INTO oauth_families(id,grant_id,absolute_expires_at) VALUES('family','grant',?)",
    ).run(expires);
    db.prepare(
      "INSERT INTO oauth_tokens(id,access_hash,refresh_hash,client_id,user_id,resource,scopes,created_at,expires_at,refresh_expires_at,grant_id,family_id) VALUES('token',?,'fixture-refresh','client',?,?,'[\"boards:read\"]',?,?,?,'grant','family')",
    ).run(
      await sha256("fixture-local-token"),
      user,
      `${origin}/mcp`,
      at,
      expires,
      expires,
    );
    const request = new Request(`${origin}/mcp`, {
      headers: { Authorization: "Bearer fixture-local-token" },
    });
    const principal = await authenticateOAuth(request, env.CATALOG, env);
    expect(principal.id).toBe(user);
    expect(principal.scopes).toEqual(["boards:read"]);
    db.prepare(
      "UPDATE account_security SET recovery_required=1 WHERE user_id=?",
    ).run(user);
    await expect(authenticateOAuth(request, env.CATALOG, env)).rejects.toThrow(
      "no longer authorized",
    );
  });

  it("can enroll a replacement authenticator after using an MFA backup code", async () => {
    const owner = await localOwner();
    await call("/api/auth/sign-out", {});
    await call("/api/auth/sign-in/local", {
      username: "owner",
      password: owner.password,
    });
    expect(
      (
        await call("/api/auth/two-factor/verify-backup-code", {
          code: owner.backupCode,
        })
      ).status,
    ).toBe(200);
    await expect(
      nativePrincipal(request("/api/v1/catalog"), env),
    ).rejects.toThrow();
    const enrollment = await (
      await call("/api/auth/two-factor/enable", { password: owner.password })
    ).json();
    expect(enrollment, JSON.stringify(enrollment)).toHaveProperty("totpURI");
    expect(
      (
        await call("/api/auth/two-factor/verify-totp", {
          code: totp(enrollment.totpURI),
        })
      ).status,
    ).toBe(200);
    expect((await call("/api/v1/account/recovery-complete", {})).status).toBe(
      200,
    );
  });

  it("retains automatic keys across restarts and refuses replacement after key-store loss", async () => {
    const values = new Map<string, unknown>();
    const storage = {
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => {
        values.set(key, value);
      },
      transaction: async (task: (s: unknown) => Promise<unknown>) =>
        task(storage),
    };
    const object = new InstallationKeys({
      storage,
    } as unknown as DurableObjectState);
    const automatic = {
      ...env,
      AUTH_SECRET: undefined,
      AUTH_ENCRYPTION_KEYS: undefined,
      INSTALLATION_KEYS: {
        idFromName: () => "private",
        get: () => ({
          fetch: (url: string, init: RequestInit) =>
            object.fetch(new Request(url, init)),
        }),
      } as unknown as DurableObjectNamespace,
    };
    const first = await installationEnvironment(automatic);
    const next = await installationEnvironment({ ...automatic });
    expect(first.AUTH_SECRET).toBe(next.AUTH_SECRET);
    expect(first.AUTH_ENCRYPTION_KEYS).toBe(next.AUTH_ENCRYPTION_KEYS);
    values.clear();
    await expect(installationEnvironment({ ...automatic })).rejects.toThrow(
      "original installation keys",
    );
  });

  it("retains setup across the provider redirect and requires MFA before owner admission", async () => {
    const state = await begin();
    const response = await callback(state);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`${origin}/`);
    const bootstrap = await (await call("/api/v1/auth/bootstrap")).json();
    expect(bootstrap).toMatchObject({
      mode: "native",
      unlocked: true,
      setup: true,
      setupReserved: true,
      access: false,
      email: false,
    });
    expect(bootstrap.account).toMatchObject({
      setupUser: true,
      verified: true,
      assurance: "weak",
    });
    await expect(
      nativePrincipal(request("/api/v1/catalog"), env),
    ).rejects.toThrow();
    await expect(call("/api/v1/setup/complete", {})).rejects.toThrow();
    expect(
      db.prepare("SELECT owner_id, state FROM installation").get(),
    ).toMatchObject({ owner_id: null, state: "configuring" });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM access_identities").get()!.n,
    ).toBe(0);
    // Replay of the same OAuth state must not create another user or session.
    const replay = await callback(state);
    expect(replay.headers.get("Location")).toContain("error=");
    expect(db.prepare("SELECT COUNT(*) AS n FROM auth_users").get()!.n).toBe(1);
    const enrollment = await (
      await call("/api/auth/two-factor/enable", {})
    ).json();
    expect(enrollment.backupCodes).toHaveLength(10);
    expect(
      (
        await call("/api/auth/two-factor/verify-totp", {
          code: totp(enrollment.totpURI),
        })
      ).status,
    ).toBe(200);
    expect(
      (await call("/api/v1/setup/complete", { title: "Fresh Canvas" })).status,
    ).toBe(200);
    expect(
      (await nativePrincipal(request("/api/v1/catalog"), env)).state.role,
    ).toBe("owner");
    // Reconstructing the Worker environment must not reopen setup.
    env = { ...env };
    expect(await (await call("/api/v1/auth/bootstrap")).json()).toMatchObject({
      setup: false,
      unlocked: false,
      title: "Fresh Canvas",
    });
    await expect(
      call("/api/v1/setup/unlock", { secret: env.AUTH_BOOTSTRAP_SECRET }),
    ).rejects.toThrow("Setup has already been completed");
    await call("/api/auth/sign-out", {});
    env = { ...env, AUTH_BOOTSTRAP_SECRET: undefined };
    expect((await callback(await begin(false))).status).toBe(302);
    expect(await (await call("/api/v1/auth/bootstrap")).json()).toMatchObject({
      setup: false,
      account: { verified: true, twoFactorEnabled: true, needsMfa: true },
    });
    await expect(
      nativePrincipal(request("/api/v1/catalog"), env),
    ).rejects.toThrow();
  });

  it("does not create an owner without the deployment bootstrap proof", async () => {
    const response = await callback(await begin(false));
    expect(response.status).toBe(403);
    expect(db.prepare("SELECT COUNT(*) AS n FROM auth_users").get()!.n).toBe(0);
    expect(
      db.prepare("SELECT setup_user_id FROM installation").get()!.setup_user_id,
    ).toBeNull();
  });

  it("rejects a callback from a browser that did not start the OAuth flow", async () => {
    const state = await begin();
    cookies = new Map([...cookies].filter(([name]) => name === "canvas-setup"));
    const response = await callback(state);
    expect(response.headers.get("Location")).toContain("error=");
    expect(db.prepare("SELECT COUNT(*) AS n FROM auth_users").get()!.n).toBe(0);
  });

  it("does not admit a provider identity with an unverified email", async () => {
    verified = false;
    await callback(await begin());
    await expect(
      nativePrincipal(request("/api/v1/catalog"), env),
    ).rejects.toThrow();
    await expect(call("/api/v1/setup/complete", {})).rejects.toThrow();
    expect(
      db.prepare("SELECT state, owner_id FROM installation").get(),
    ).toMatchObject({ owner_id: null });
  });
});
