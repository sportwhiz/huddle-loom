import type { NativeEnv } from "./types";
import { randomToken } from "../security/primitives";

/** Put both statements around the mutation in one D1 batch. */
export function methodChangeGuard(
  env: NativeEnv,
  userId: string,
  excluded: { account?: string; passkey?: string; provider?: string },
) {
  const deployed = [
    ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? ["github"] : []),
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? ["google"] : []),
    ...(env.OIDC_CONFIG
      ? JSON.parse(env.OIDC_CONFIG).map(
          (entry: { providerId: string }) => entry.providerId,
        )
      : []),
  ];
  const id = randomToken(18);
  return {
    before: env.CATALOG.prepare(
      "INSERT INTO auth_method_changes (id,user_id,excluded_account,excluded_passkey,excluded_provider,deployed_providers,password_enabled,database_oidc_enabled) VALUES (?,?,?,?,?,?,?,?)",
    ).bind(
      id,
      userId,
      excluded.account ?? null,
      excluded.passkey ?? null,
      excluded.provider ?? null,
      JSON.stringify(deployed),
      1,
      // Database providers remain available alongside deployment-managed IDs.
      1,
    ),
    after: env.CATALOG.prepare(
      "DELETE FROM auth_method_changes WHERE id = ?",
    ).bind(id),
  };
}
