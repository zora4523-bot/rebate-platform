// Shared values of the B2-06f rule tests. Synthetic credentials only: none of them is a real key.
import { inspect } from 'node:util';
import type {
  PayoutLiveCredentialEnvName,
  PayoutLiveCredentials,
} from '../../../../apps/api/src/modules/payout/payout-mode.ts';
import type { AppEnv } from '../../../../apps/api/src/modules/platform/config/index.ts';

export const APP_ENVS: readonly AppEnv[] = ['local', 'test', 'staging', 'prod'];
export const NON_PROD: readonly AppEnv[] = ['local', 'test', 'staging'];

/** The four variables live needs, in the order of PayoutLiveCredentials. */
export const CREDENTIAL_NAMES: readonly PayoutLiveCredentialEnvName[] = [
  'ALIPAY_APP_ID',
  'ALIPAY_APP_PRIVATE_KEY',
  'ALIPAY_PUBLIC_KEY',
  'ALIPAY_GATEWAY_URL',
];

export const LIVE_CREDENTIALS: PayoutLiveCredentials = {
  appId: 'test-only-app-id-b2-06f-41d7',
  privateKey: 'test-only-private-key-b2-06f-SENTINEL-7c1e9a2b',
  alipayPublicKey: 'test-only-alipay-public-key-b2-06f-SENTINEL-55f0',
  gatewayUrl: 'https://alipay.test.invalid/gateway.do',
};

/** PAYOUT_MODE=live with the four credential variables set (`overrides` replace values). */
export function liveEnv(
  overrides: Partial<PayoutLiveCredentials> = {},
): Record<string, string | undefined> {
  const c = { ...LIVE_CREDENTIALS, ...overrides };
  return {
    PAYOUT_MODE: 'live',
    ALIPAY_APP_ID: c.appId,
    ALIPAY_APP_PRIVATE_KEY: c.privateKey,
    ALIPAY_PUBLIC_KEY: c.alipayPublicKey,
    ALIPAY_GATEWAY_URL: c.gatewayUrl,
  };
}

/** The value `run` throws, or undefined when it returns. */
export function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Every text an error shows when it is logged, printed or serialised. */
export function textOf(error: unknown): string {
  if (!(error instanceof Error)) return inspect(error, { depth: 8 });
  const own: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(error)) {
    own[key] = (error as unknown as Record<string, unknown>)[key];
  }
  return [
    String(error),
    error.message,
    error.stack ?? '',
    JSON.stringify(own),
    inspect(error, { depth: 8 }),
  ].join('\n');
}
