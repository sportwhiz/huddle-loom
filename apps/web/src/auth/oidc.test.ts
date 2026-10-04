import { afterEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { safeOidcPlugin, discoverOidc } from "./oidc";
import type { NativeEnv } from "./types";
const issuer = "https://identity.example.com";
const env = {
  AUTH_ORIGIN: "https://canvas.example.com",
  OIDC_ALLOWED_ORIGINS: issuer,
} as NativeEnv;
afterEach(() => vi.unstubAllGlobals());
describe("OIDC trust boundary", () => {
  it("checks signed ID tokens, issuer, audience, nonce, expiry and verified email", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const jwk = {
      ...(await exportJWK(publicKey)),
      kid: "fixture",
      alg: "ES256",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (input: URL | string) =>
          new Response(
            JSON.stringify(
              String(input).endsWith("/jwks")
                ? { keys: [jwk] }
                : {
                    issuer,
                    authorization_endpoint: `${issuer}/authorize`,
                    token_endpoint: `${issuer}/token`,
                    jwks_uri: `${issuer}/jwks`,
                    id_token_signing_alg_values_supported: ["ES256"],
                  },
            ),
          ),
      ),
    );
    const plugin = safeOidcPlugin(env, [
      {
        providerId: "oidc-fixture",
        clientId: "canvas",
        clientSecret: "fixture",
        discoveryUrl: `${issuer}/discovery`,
      },
    ]);
    const initialized = (await plugin.init!({
      socialProviders: [],
      logger: { error: () => {} },
      options: { baseURL: env.AUTH_ORIGIN },
      baseURL: `${env.AUTH_ORIGIN}/api/auth`,
    } as never)) as any;
    const provider = initialized.context.socialProviders[0];
    expect(provider.requiresIdTokenNonce).toBe(true);
    const jwt = async (overrides: Record<string, unknown> = {}) =>
      new SignJWT({
        sub: "subject-1",
        email: "user@example.com",
        email_verified: true,
        nonce: "nonce-1",
        iss: issuer,
        aud: "canvas",
        exp: Math.floor(Date.now() / 1000) + 120,
        ...overrides,
      })
        .setProtectedHeader({ alg: "ES256", kid: "fixture" })
        .sign(privateKey);
    expect(
      (
        await provider.getUserInfo({
          idToken: await jwt(),
          expectedIdTokenNonce: "nonce-1",
        })
      ).user.email,
    ).toBe("user@example.com");
    for (const overrides of [
      { iss: "https://evil.example.com" },
      { aud: "other-client" },
      { nonce: "wrong" },
      { exp: 1 },
      { email_verified: false },
    ])
      expect(
        await provider.getUserInfo({
          idToken: await jwt(overrides),
          expectedIdTokenNonce: "nonce-1",
        }),
      ).toBeNull();
    expect(
      await provider.getUserInfo({
        idToken: await jwt(),
        expectedIdTokenNonce: "wrong",
      }),
    ).toBeNull();
    const valid = await jwt();
    expect(
      await provider.getUserInfo({
        idToken: valid.slice(0, -8) + "AAAAAAAA",
        expectedIdTokenNonce: "nonce-1",
      }),
    ).toBeNull();
    expect(
      await provider.getUserInfo({
        accessToken: "opaque",
        expectedIdTokenNonce: "nonce-1",
      }),
    ).toBeNull();
  });
  it("rejects discovery endpoints outside the exact operator allowlist and redirects", async () => {
    const fetcher = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetcher);
    for (const uri of [
      "http://127.0.0.1/private",
      "https://169.254.169.254/metadata",
      "https://identity.example.com.evil.test/discovery",
    ])
      await expect(discoverOidc(env, uri)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockImplementation(
      async () =>
        new Response("", {
          status: 302,
          headers: { Location: "http://127.0.0.1/private" },
        }),
    );
    await expect(discoverOidc(env, `${issuer}/discovery`)).rejects.toThrow(
      "could not be reached",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
