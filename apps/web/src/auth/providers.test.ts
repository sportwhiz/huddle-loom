import { describe, expect, it } from 'vitest';
import { configuredProviders } from './library';
import { methodChangeGuard } from './method-change';
import { seal } from '../security/secret-store';
import type { NativeEnv } from './types';

const provider = (id: string) => ({
  providerId: id,
  clientId: `client-${id}`,
  clientSecret: 'isolated-provider-fixture',
  discoveryUrl: 'https://identity.example.com/discovery',
});

describe('mixed provider configuration', () => {
  it.each([undefined, '[]', JSON.stringify([provider('oidc-deployed')])])(
    'keeps administration providers usable with deployment configuration %s',
    async configuration => {
      const env = {
        OIDC_CONFIG: configuration,
        OIDC_ALLOWED_ORIGINS: 'https://identity.example.com',
        AUTH_ENCRYPTION_KEYS: JSON.stringify([{ id: 'fixture', key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }]),
      } as NativeEnv;
      const managed = provider('oidc-managed');
      const secret = await seal(env, managed.clientSecret, 'provider:oidc-managed');
      const bindings: unknown[][] = [];
      env.CATALOG = {
        prepare: () => ({
          bind: (...values: unknown[]) => {
            bindings.push(values);
            return { first: async () => null };
          },
          all: async () => ({ results: [
            { id: 'oidc-managed', public_config: JSON.stringify({ clientId: managed.clientId, discoveryUrl: managed.discoveryUrl }), secret },
            // An overridden entry must not require a retired decryption key.
            ...(configuration?.includes('oidc-deployed') ? [{ id: 'oidc-deployed', public_config: '{}', secret: 'retired.ciphertext' }] : []),
          ] }),
        }),
      } as unknown as D1Database;
      const configured = await configuredProviders(env);
      expect(configured.oidc).toEqual([
        ...(configuration?.includes('oidc-deployed') ? [provider('oidc-deployed')] : []),
        managed,
      ]);
      // The last-method guard must make the same availability decision as login.
      methodChangeGuard(env, 'owner', { account: 'credential' });
      const guard = bindings.find(values => values[1] === 'owner')!;
      expect(guard[7]).toBe(1);
      expect(JSON.parse(guard[5] as string)).toEqual(configuration?.includes('oidc-deployed') ? ['oidc-deployed'] : []);
    },
  );
});
