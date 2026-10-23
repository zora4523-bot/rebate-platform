import { generateKeyPairSync, sign } from 'node:crypto';
import { vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/clock.ts';
import type { JudgementLists } from '../../../../apps/api/src/modules/payout/application/judgement.ts';
import type {
  AlipayChannelOptions,
  ChannelTransport,
} from '../../../../apps/api/src/modules/payout/infra/channels/alipay-channel.ts';
import type { TransferRequest } from '../../../../apps/api/src/modules/payout/infra/channels/payout-channel.ts';

// Synthetic protocol fixtures, NOT captured Alipay responses or verified error mappings.
export const EMPTY_LISTS: JudgementLists = {
  definiteFailCodes: [],
  payerSideCodes: [],
  queryStatusMap: { SUCCESS: 'success' },
};

export const VERIFIED_TEST_LISTS: JudgementLists = {
  definiteFailCodes: ['TEST_CONFIRMED_FAIL'],
  payerSideCodes: ['TEST_PAYER_SIDE'],
  queryStatusMap: { SUCCESS: 'success', TEST_FINAL_FAIL: 'fail', TEST_PENDING: 'unknown' },
};

export const REQUEST: TransferRequest = {
  outBizNo: 'wd_test_001',
  netFen: 1234n,
  payee: { identity: '13812345678', name: '测试收款人' },
  channel: 'alipay',
};

let testKeys: { privateKey: string; publicKey: string } | undefined;
export function keys() {
  testKeys ??= generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return testKeys;
}

export function signedEnvelope(
  method: 'transfer' | 'query',
  node: string,
  signature = sign('RSA-SHA256', Buffer.from(node), keys().privateKey).toString('base64'),
): string {
  const name =
    method === 'transfer'
      ? 'alipay_fund_trans_uni_transfer_response'
      : 'alipay_fund_trans_common_query_response';
  return `{${JSON.stringify(name)}:${node},"sign":${JSON.stringify(signature)}}`;
}

export function fixture(transport?: ChannelTransport) {
  const clock = new FixedClock('2026-10-23T12:34:56+08:00');
  const logger = { info: vi.fn(), warn: vi.fn() };
  const send = vi.fn<ChannelTransport>(
    transport ??
      (async () => ({
        status: 200,
        body: signedEnvelope('transfer', '{"code":"10000","order_id":"test_order"}'),
      })),
  );
  const options: AlipayChannelOptions = {
    credentials: {
      appId: 'test_app_id',
      privateKey: keys().privateKey,
      alipayPublicKey: keys().publicKey,
      gatewayUrl: 'https://alipay.test.invalid/gateway.do',
    },
    bizScene: 'TEST_COMMISSION_SCENE',
    lists: EMPTY_LISTS,
    clock,
    logger,
    transport: send,
  };
  return { options, send, clock, logger };
}
