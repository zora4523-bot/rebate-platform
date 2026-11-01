// B2-15k: the environment of the real collection channels (task §9.8; BR-PAY-08; NotImplemented
// skeleton; the rule tests are test/spec/payment/channels/config.test.ts). The contract is
// loadConfig(env, entry): it fills AppConfig.payChannels from readPayChannelsConfig and merges its
// problems. Pure: looks only at the given object, reads no file, never echoes a value; the key
// files are read once at startup through ./startup-secret-file.ts by the payment module's factory.
// - loadConfig(env), without an entry, reads none of these (payChannels is null, a PAY_* written
//   wrong does not throw): tracing/boot.ts calls it so. bootstrap.ts and entry.ts pass the entry.
// - local / test: fake channels; the credential names go into PAY_CREDENTIAL_ENV_NAMES
//   (./credential-env.ts), so setting one refuses to start.
// - staging / prod: only the api, worker and admin entries read these variables; stream and payout
//   never do (BR-PAY-08 ①).
// - PAY_CHANNEL_IMPL accepts only `fake`, and prod refuses it. PAY_NOTIFY_BASE_URL must be https.
// - prod: the gateway is the documented official one; PAY_ALIPAY_GATEWAY set there refuses to start.
// - not prod: WeChat Pay needs PAY_WECHAT_TEST_MERCHANT=1, Alipay needs PAY_ALIPAY_GATEWAY other
//   than the production gateway; otherwise that channel is unavailable (BR-PAY-08 ②).
import type { EntryName } from '../entries.ts';
import type { AppEnv } from './app-env.ts';

export interface PayWechatEnv {
  readonly appId: string | null;
  readonly mchId: string | null;
  readonly merchantSerial: string | null;
  readonly privateKeyFile: string | null;
  readonly apiV3KeyFile: string | null;
  readonly publicKeyFile: string | null;
  readonly publicKeyId: string | null;
  readonly testMerchant: boolean;
}

export interface PayAlipayEnv {
  readonly appId: string | null;
  readonly sellerId: string | null;
  readonly privateKeyFile: string | null;
  readonly publicKeyFile: string | null;
  readonly appCertFile: string | null;
  readonly publicCertFile: string | null;
  readonly rootCertFile: string | null;
  readonly gateway: string | null;
}

/** Names and paths only, never a key. Absent on the stream and payout entries. */
export interface PayChannelsConfig {
  readonly appId: string | null;
  readonly impl: 'fake' | null;
  readonly notifyBaseUrl: string | null;
  readonly wechat: PayWechatEnv;
  readonly alipay: PayAlipayEnv;
}

export function readPayChannelsConfig(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
  entry: EntryName,
): { readonly payChannels: PayChannelsConfig | null; readonly problems: readonly string[] } {
  void appEnv;
  void env;
  void entry;
  throw new Error('NotImplemented: readPayChannelsConfig');
}
