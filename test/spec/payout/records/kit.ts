// Integration helpers only; no provisioning or production calls. All material is synthetic.
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Insertable } from 'kysely';
import { expect } from 'vitest';
import {
  fixture,
  ALIPAY_CONTEXT,
  BANK_CONTEXT,
  type Kit,
  type Response,
} from '../../identity/payout-account/kit.ts';

export const PATH = '/v1/withdrawals';
export const DETAIL_PATH = '/v1/withdrawals/{withdrawal_id}';
export const TIMEOUT = 60_000;

export async function client(kit: Kit, appId?: string) {
  // Per-test assertions, never a setup-hook or missing-module failure in the red stage.
  expect(kit.document.paths[PATH]!['get']).not.toHaveProperty('x-implementation');
  expect(kit.document.paths[DETAIL_PATH]!['get']).not.toHaveProperty('x-implementation');
  const owner = await fixture(kit, appId === undefined ? {} : { appId });
  const headers = {
    'content-type': 'application/json',
    'x-app-id': owner.appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  const device = await kit.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({ device_hash: randomBytes(32).toString('hex'), id_source: 'idfv' }),
  });
  expect(device.statusCode).toBe(200);
  const deviceId = device.json<{ data: { device_id: string } }>().data.device_id;
  const session = await kit.db
    .transaction()
    .execute((trx) =>
      kit.createSession(
        trx,
        { app_id: owner.appId, uid: owner.uid, device_id: deviceId, scp: 'full' },
        { clock: kit.clock, tokens: kit.tokens },
      ),
    );
  return {
    owner,
    subject: { appId: owner.appId, userId: owner.uid },
    async get(url = PATH, mode: 'app' | 'h5' | 'guest' = 'app') {
      const access =
        mode === 'h5'
          ? await kit.signScopedToken(kit.keys, {
              audience: 'h5',
              claims: {
                app_id: owner.appId,
                uid: owner.uid,
                sid: session.sid,
                device_id: deviceId,
                scp: 'read_only',
              },
              issuedAt: Math.floor(kit.clock.now().getTime() / 1000),
              ttlSeconds: 300,
            })
          : session.access_token;
      return kit.app.inject({
        method: 'GET',
        url,
        headers: {
          ...headers,
          'x-device-id': deviceId,
          ...(mode === 'guest' ? {} : { authorization: `Bearer ${access}` }),
        },
      });
    },
  };
}

export type Client = Awaited<ReturnType<typeof client>>;

export async function seedRecord(
  kit: Kit,
  subject: Client['subject'],
  patch: Partial<Insertable<DB['withdrawals']>> = {},
  rawAccount = 'zhangsan@example.com',
) {
  const method = patch.payout_method ?? 'alipay';
  const context = method === 'bank_card' ? BANK_CONTEXT : ALIPAY_CONTEXT;
  const status = patch.status ?? 'PENDING_REVIEW';
  const paid = status === 'PAID_API' || status === 'PAID_MANUAL';
  return kit.db
    .withSchema('app')
    .insertInto('withdrawals')
    .values({
      id: randomUUID(),
      app_id: subject.appId,
      user_id: subject.userId,
      amount_fen: 12300n,
      fee_fen: 123n,
      tax_fen: 80n,
      net_fen: 12097n,
      income_type: 'SERVICE_FEE',
      payout_method: method,
      payout_channel: method,
      payee_name: '合成姓名',
      payee_account_cipher: Buffer.from(kit.crypto.encrypt(rawAccount, context)),
      payee_hmac: kit.crypto.blindIndex(rawAccount, context),
      bank_name: method === 'bank_card' ? '合成银行' : null,
      status,
      out_biz_no: randomBytes(16).toString('hex'),
      reject_reason_code: status === 'REJECTED' ? 'USER_REQUEST' : null,
      fail_code: status === 'FAILED' ? 'PAYEE_NOT_EXIST' : null,
      paid_at: paid ? kit.clock.now() : null,
      manual_entry_by: status === 'PAID_MANUAL' ? randomUUID() : null,
      manual_confirm_by: status === 'PAID_MANUAL' ? randomUUID() : null,
      created_at: kit.clock.now(),
      updated_at: kit.clock.now(),
      ...patch,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export function contractResponse(kit: Kit, response: Response, detail: boolean, code = 0) {
  const status = code === 0 ? 200 : code === 30701 ? 404 : code === 10403 ? 403 : 400;
  expect(response.statusCode).toBe(status);
  const body = response.json<{ code: number; data?: unknown }>();
  expect(body.code).toBe(code);
  const route = kit.document.paths[detail ? DETAIL_PATH : PATH]!['get']!;
  const schema = route.responses[code === 0 ? '200' : '4XX']!.content['application/json']!.schema;
  const validate = kit.compile({ schema, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
}
