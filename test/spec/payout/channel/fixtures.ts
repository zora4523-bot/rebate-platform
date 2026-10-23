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

// Neither a phone number nor an e-mail, so the platform free-text net cannot hide a leak.
export const LOGON_ID = 'logon_user_2026';
// First 3 and last 2 kept, every middle character replaced by one '*'.
export const MASKED_LOGON_ID = 'log**********26';

export const REQUEST: TransferRequest = {
  outBizNo: 'wd_test_001',
  netFen: 1234n,
  payee: { identity: LOGON_ID, name: '测试收款人' },
  channel: 'alipay',
};

type KeyPair = { privateKey: string; publicKey: string };

function generate(): KeyPair {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

let applicationKeys: KeyPair | undefined;
let platformKeys: KeyPair | undefined;

/** Merchant application key pair: the adapter signs requests with its private half. */
export function appKeys(): KeyPair {
  applicationKeys ??= generate();
  return applicationKeys;
}

/** Alipay platform key pair: responses are signed with its private half (never given to the adapter). */
export function alipayKeys(): KeyPair {
  platformKeys ??= generate();
  return platformKeys;
}

export function signNode(node: string, privateKey = alipayKeys().privateKey): string {
  return sign('RSA-SHA256', Buffer.from(node), privateKey).toString('base64');
}

export function signedEnvelope(
  method: 'transfer' | 'query',
  node: string,
  signature = signNode(node),
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
        body: signedEnvelope(
          'transfer',
          '{"code":"10000","status":"SUCCESS","order_id":"test_order"}',
        ),
      })),
  );
  const options: AlipayChannelOptions = {
    credentials: {
      appId: 'test_app_id',
      privateKey: appKeys().privateKey,
      alipayPublicKey: alipayKeys().publicKey,
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

export const TIMEOUT_MS = 10_000;

/**
 * Node's native AbortSignal.timeout does not use JS fake timers: adapt that primitive only.
 * Returns the restore function; callers also restore real timers.
 */
export function fakeAbortTimeout(): () => void {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('test deadline', 'TimeoutError')), ms);
    return controller.signal;
  });
  return () => {
    timeout.mockRestore();
    vi.useRealTimers();
  };
}
