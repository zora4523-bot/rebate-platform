import { expect, expectTypeOf, it } from 'vitest';
import { createApiClient, type Schema } from './index.ts';

type OpenLinkResponse = Schema<'OpenLinkResponse'>;

const opened: OpenLinkResponse = {
  code: 0,
  msg: '',
  data: {
    jump: {
      primary: { type: 'sdk', value: 'https://s.click.example.test/t?e=abc' },
      fallbacks: [],
      expire_at: '2026-10-02T09:45:00+08:00',
    },
    price_changed: false,
    old_final_price_fen: 2990,
    new_final_price_fen: 2990,
    new_link_id: null,
    requote_failed: false,
    new_rebate_min_fen: 269,
    new_rebate_max_fen: 269,
    availability: 'ok',
    quoted_at: '2026-10-02T09:30:05+08:00',
  },
  trace_id: 'trace-3',
};

it('posts open with the path id, signature and idempotency headers', async () => {
  const seen: Request[] = [];
  const fakeFetch = (input: Request): Promise<Response> => {
    seen.push(input);
    return Promise.resolve(Response.json(opened));
  };
  const client = createApiClient('http://127.0.0.1:3100', { fetch: fakeFetch });

  const { data } = await client.POST('/v1/links/{link_id}/open', {
    params: {
      path: { link_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a70' },
      header: {
        'X-App-Id': 'couli',
        'X-Platform': 'ios',
        'X-App-Version': '1.0.0',
        'X-Device-Id': 'dev-1',
        'X-Timestamp': '1790000000',
        'X-Nonce': '0123456789abcdef0123456789abcdef',
        'X-Sign': 'a'.repeat(64),
        'Idempotency-Key': 'open-0001',
      },
    },
    body: { installed: 'unknown', no_rebate: false },
  });

  expectTypeOf(data).toEqualTypeOf<OpenLinkResponse | undefined>();
  // Amounts are integers (null on amount_unknown); rebate_basis is the closed 04 §8.3 set.
  expectTypeOf<Schema<'ProductCard'>['final_price_fen']>().toEqualTypeOf<number | null>();
  expectTypeOf<Schema<'ProductCard'>['rebate_basis']>().toEqualTypeOf<
    'normal' | 'price_compare_risk' | 'no_rebate' | 'amount_unknown' | 'login_required'
  >();
  expect(seen[0]?.method).toBe('POST');
  expect(seen[0]?.url).toBe(
    'http://127.0.0.1:3100/v1/links/0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a70/open',
  );
  expect(seen[0]?.headers.get('idempotency-key')).toBe('open-0001');
  expect(data?.data.old_final_price_fen).toBe(2990);
});

it('convert needs exactly one of product_key and url; a parse result needs card or error_code', () => {
  // Codex round-3 S1 (ConvertLinkRequest, ParseResult): the oneOf branches declare the property
  // they require, so the generated types reject a body or result that carries neither.
  // @ts-expect-error neither product_key nor url
  const neither: Schema<'ConvertLinkRequest'> = { platform: 'taobao', scene: 'h5' };
  const byUrl: Schema<'ConvertLinkRequest'> = {
    platform: 'taobao',
    scene: 'h5',
    url: 'https://item.taobao.com/item.htm?id=9',
  };
  // @ts-expect-error neither card nor error_code
  const empty: Schema<'ParseResult'> = { hit: { platform: 'taobao', kind: 'url', raw: 'x' } };
  const failed: Schema<'ParseResult'> = {
    hit: { platform: 'taobao', kind: 'url', raw: 'x' },
    error_code: 30132,
  };
  expect([neither, byUrl, empty, failed]).toHaveLength(4);
  expect(failed.error_code).toBe(30132);
});

it('abandon: original is null exactly when outcome is abandoned (04 §6.1)', () => {
  type Data = Schema<'AbandonIdempotencyKeyData'>;
  const abandoned: Data = { outcome: 'abandoned', original: null };
  const completed: Data = {
    outcome: 'completed',
    original: { code: 30412, msg: '有进行中的提现', data: { reason: 'x' } },
  };
  // @ts-expect-error an abandoned key has no stored result
  const abandonedWithResult: Data = { outcome: 'abandoned', original: { code: 0, msg: '' } };
  // @ts-expect-error a completed key returns its stored result
  const completedWithoutResult: Data = { outcome: 'completed', original: null };
  expectTypeOf<Schema<'AbandonIdempotencyKeyRequest'>['action']>().toEqualTypeOf<
    'withdraw' | 'payout_account_change' | 'phone_change' | 'account_deletion'
  >();
  expect([abandoned, completed, abandonedWithResult, completedWithoutResult]).toHaveLength(4);
  expect(completed.original?.code).toBe(30412);
});
