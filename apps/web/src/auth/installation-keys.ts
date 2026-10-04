import type { NativeEnv } from "./types";
import { randomToken, sha256 } from "../security/primitives";
import { HttpError } from "../security/errors";

type Keys = { AUTH_SECRET: string; AUTH_ENCRYPTION_KEYS: string };

/** Private, per-deployment storage, separate from the catalog and board exports.
 * Cloudflare encrypts Durable Object storage at rest. Only the bound Worker can
 * address this object; it has no public route. Never log or return these keys.
 * Node hosting must implement the same stable server-side secret-store contract.
 */
export class InstallationKeys {
  constructor(private readonly state: DurableObjectState) {}
  async fetch(request: Request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/keys")
      return new Response(null, { status: 404 });
    const keys = await this.state.storage.transaction(async (storage) => {
      let keys = await storage.get<Keys>("keys-v1");
      if (!keys) {
        keys = {
          AUTH_SECRET: randomToken(48),
          AUTH_ENCRYPTION_KEYS: JSON.stringify([
            { id: "installation-v1", key: randomToken(32) },
          ]),
        };
        await storage.put("keys-v1", keys);
      }
      return keys;
    });
    return Response.json(keys, { headers: { "Cache-Control": "no-store" } });
  }
}

const cache = new WeakMap<object, Promise<NativeEnv>>();
export async function installationEnvironment<T extends NativeEnv>(
  env: T,
): Promise<T> {
  if (
    env.AUTH_MODE === "access" ||
    env.AUTH_MODE === "development" ||
    !env.INSTALLATION_KEYS
  )
    return env;
  // Existing explicit key deployments retain their identity across upgrades.
  // Never silently replace a partial/manual key ring with generated secrets.
  if (env.AUTH_SECRET || env.AUTH_ENCRYPTION_KEYS) return env;
  let pending = cache.get(env);
  if (!pending) {
    pending = (async () => {
      const object = env.INSTALLATION_KEYS!.get(
        env.INSTALLATION_KEYS!.idFromName("installation-v1"),
      );
      const response = await object.fetch(
        "https://installation.internal/keys",
        { method: "POST" },
      );
      if (!response.ok)
        throw new HttpError(
          503,
          "Preparing your Studio. Try again shortly.",
          "INSTALLATION_UNAVAILABLE",
        );
      const keys = await response.json<Keys>();
      const fingerprint = await sha256(
        keys.AUTH_SECRET + keys.AUTH_ENCRYPTION_KEYS,
      );
      await env.CATALOG.prepare(
        "INSERT OR IGNORE INTO installation_key_identity(id,fingerprint) SELECT 'automatic-v1',? WHERE NOT EXISTS(SELECT 1 FROM auth_users)",
      )
        .bind(fingerprint)
        .run();
      const existing = await env.CATALOG.prepare(
        "SELECT fingerprint FROM installation_key_identity WHERE id='automatic-v1'",
      ).first<{ fingerprint: string }>();
      if (existing?.fingerprint !== fingerprint)
        throw new HttpError(
          503,
          "The original installation keys are required. Restore the existing key store before continuing.",
          "KEY_STORE_MISMATCH",
        );
      return { ...env, ...keys };
    })();
    cache.set(env, pending);
    pending.catch(() => cache.delete(env));
  }
  return (await pending) as T;
}
