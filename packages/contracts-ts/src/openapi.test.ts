import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, expectTypeOf, it } from 'vitest';
import { createApiClient, type Schema } from './index.ts';

type OpenLinkResponse = Schema<'OpenLinkResponse'>;

const opened: OpenLinkResponse = {
  code: 0,
  msg: '',
  data: {
    attempt_id: 'attempt-1',
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

it('step-up takes exactly one way; an oauth attempt for step_up names the action (BR-ID-04, BR-ID-08)', () => {
  const bySms: Schema<'StepUpRequest'> = { action: 'withdraw', code: '123456' };
  const byApple: Schema<'StepUpRequest'> = {
    action: 'account_deletion',
    provider: 'apple',
    attempt_id: 'a-1',
    identity_token: 'token',
    authorization_code: 'code',
  };
  const mixed: Schema<'StepUpRequest'> = {
    action: 'account_deletion',
    provider: 'wechat',
    attempt_id: 'a-1',
    // @ts-expect-error a WeChat re-authorization carries the WeChat code, not Apple's fields
    authorization_code: 'code',
  };
  const loginAttempt: Schema<'CreateOauthAttemptRequest'> = {
    provider: 'huawei',
    purpose: 'login',
  };
  // @ts-expect-error purpose=step_up needs the action
  const stepUpAttempt: Schema<'CreateOauthAttemptRequest'> = {
    provider: 'wechat',
    purpose: 'step_up',
  };
  expectTypeOf<Schema<'RegisterDeviceRequest'>['id_source']>().toEqualTypeOf<
    'idfv' | 'android_id' | 'oaid' | 'odid'
  >();
  expect([bySms, byApple, mixed, loginAttempt, stepUpAttempt]).toHaveLength(5);
});

it('logins and refresh return the session scope (04 §5 受限会话)', () => {
  expectTypeOf<Schema<'TokenPair'>['session_scope']>().toEqualTypeOf<'full' | 'deletion_only'>();
  expectTypeOf<Schema<'H5TokenData'>['scope']>().toEqualTypeOf<'standard' | 'read_only'>();
  // @ts-expect-error session_scope is required
  const pair: Schema<'TokenPair'> = {
    access_token: 'a',
    access_expires_at: '2026-10-02T11:30:00+08:00',
    refresh_token: 'r',
    refresh_expires_at: '2026-11-01T09:30:00+08:00',
  };
  expect(pair.access_token).toBe('a');
});

it('auth-url carries exactly one of auth_methods and auth_jump (04 §6.3)', () => {
  const taobao: Schema<'UnionAuthUrlData'> = {
    auth_url: 'https://auth.example.test/authorize',
    state: 'st',
    auth_methods: ['web_code'],
  };
  // @ts-expect-error one of auth_methods and auth_jump is required
  const neither: Schema<'UnionAuthUrlData'> = {
    auth_url: 'https://auth.example.test/a',
    state: 'st',
  };
  const pdd: Schema<'UnionAuthUrlData'> = {
    auth_url: 'https://auth.example.test/authorize',
    state: 'st',
    auth_jump: {
      primary: { type: 'h5', value: 'https://auth.example.test/h5' },
      fallbacks: [],
      expire_at: '2026-10-04T12:00:00+08:00',
    },
  };
  expect([taobao, neither, pdd]).toHaveLength(3);
});

it('order list and detail (04 §6.4)', () => {
  expectTypeOf<Schema<'OrderStatusGroup'>>().toEqualTypeOf<
    'all' | 'estimating' | 'credited' | 'no_rebate'
  >();
  expectTypeOf<Schema<'OrderTimelineItem'>['node']>().toEqualTypeOf<Schema<'OrderTimelineNode'>>();
  expectTypeOf<Schema<'OrderDetail'>['timeline']>().toEqualTypeOf<Schema<'OrderTimelineItem'>[]>();
  expectTypeOf<Schema<'OrderDetail'>['order_id']>().toEqualTypeOf<
    Schema<'OrderSummary'>['order_id']
  >();
  const group: Schema<'OrderStatusGroup'> = 'no_rebate';
  expect(group).toBe('no_rebate');
});

it('me: invite_backfill, tips and deletion (04 §6.1)', () => {
  expectTypeOf<Schema<'Me'>['invite_backfill']>().toEqualTypeOf<Schema<'InviteBackfill'>>();
  expectTypeOf<Schema<'TipKey'>>().toEqualTypeOf<'jump_tip' | 'inviter_before_buy'>();
  expectTypeOf<Schema<'ResettableTipKey'>>().toEqualTypeOf<'jump_tip'>();
  expectTypeOf<Schema<'DeletionResponse'>['data']>().toEqualTypeOf<Schema<'Deletion'> | null>();
  const tips: Schema<'TipsData'> = {
    jump_tip: { taobao: '2026-10-02T09:30:00+08:00', jd: null },
    inviter_before_buy: null,
  };
  expect(tips.inviter_before_buy).toBeNull();
});

it('payout account: masked GET, PUT body by method (04 §6.1)', () => {
  expectTypeOf<Schema<'PayoutAccountBankCard'>['bank_name']>().toEqualTypeOf<string>();
  const alipay: Schema<'SavePayoutAccountRequest'> = {
    payout_method: 'alipay',
    alipay_logon_id: 'zhangsan@example.com',
    payee_name: '张三',
  };
  // @ts-expect-error a bank card needs card_no and bank_name
  const card: Schema<'SavePayoutAccountRequest'> = {
    payout_method: 'bank_card',
    payee_name: '张三',
  };
  expect([alipay, card]).toHaveLength(2);
});

it('content: notices, update check, inbox message (04 §6.2, §6.4)', () => {
  expectTypeOf<Schema<'NoticeArticleSummary'>['notice']>().toEqualTypeOf<Schema<'NoticeItem'>>();
  expectTypeOf<Schema<'InboxMessage'>['route']>().toEqualTypeOf<Schema<'RouteTarget'> | null>();
  const stores: Schema<'AppVersionCheck'>['stores'] = [{ store: 'huawei', listed_version: null }];
  expect(stores).toHaveLength(1);
});

it('withdrawals and wallet (04 §6.4)', () => {
  expectTypeOf<Schema<'Withdrawal'>['channel_order_id']>().toEqualTypeOf<string | null>();
  expectTypeOf<Schema<'WithdrawRules'>['quick_amounts_fen']>().toEqualTypeOf<number[]>();
  const entry: Schema<'LedgerEntry'> = {
    ledger_type: 'WITHDRAW_PAID',
    sub_type: null,
    amount_fen: -100,
    accounting_date: '2026-10-01',
    link_type: 'withdrawal',
    link_id: 'w',
    masked: false,
    balance_after_fen: null,
    fee_fen: 0,
    tax_fen: 0,
  };
  expect(entry.balance_after_fen).toBeNull();
});

it('the WITHDRAW_PAID summary entry has a null balance_after_fen (04 §6.4)', () => {
  expectTypeOf<Schema<'LedgerWithdrawPaidEntry'>['balance_after_fen']>().toEqualTypeOf<null>();
  expect(true).toBe(true);
});

it('link landing and share page: card subset without rebate fields (04 §6.3)', () => {
  expectTypeOf<Schema<'LinkKind'>>().toEqualTypeOf<'share' | 'other'>();
  expectTypeOf<Schema<'LinkLandingData'>['product_card']>().toEqualTypeOf<
    Schema<'SharedProductCard'>
  >();
  expectTypeOf<Schema<'SharePageData'>['tpwd_ticket']>().toEqualTypeOf<string | null>();
  expectTypeOf<Schema<'SharePageData'>['open_in_app_url']>().toEqualTypeOf<string | null>();
  expectTypeOf<Schema<'ShareTpwdRequest'>>().toEqualTypeOf<{ ticket: string }>();
  expectTypeOf<Schema<'ShareTpwdData'>>().toEqualTypeOf<{ tpwd: string }>();
  const card: Schema<'SharedProductCard'> = {
    product_key: 'tb:7Kq9LmN3pQ',
    item_ref: null,
    platform: 'taobao',
    title: 't',
    image: null,
    price_fen: 3990,
    coupon_fen: 1000,
    final_price_fen: 2990,
    benefit_tags: [],
    is_presale: false,
    link_id: 'l',
    stale: false,
    age_sec: 1,
    source: 'taobao_union',
    disclaimer_keys: [],
    availability: 'ok',
    // @ts-expect-error the shared card carries no rebate amount (BR-PRICE-06)
    rebate_max_fen: 0,
  };
  expect(card.platform).toBe('taobao');
});

it('earnings dashboard: signed credited_fen, referral nullable without count (04 §6.4)', () => {
  expectTypeOf<
    Schema<'EarningsSummary'>['referral']
  >().toEqualTypeOf<Schema<'ReferralEarnings'> | null>();
  expectTypeOf<Schema<'EarningsSummary'>['self']>().toEqualTypeOf<Schema<'EarningsColumn'>>();
  expectTypeOf<keyof Schema<'ReferralEarnings'>>().toEqualTypeOf<'this_month' | 'last_month'>();
  const period: Schema<'EarningsPeriod'> = { paid_count: 0, est_fen: 0, credited_fen: -520 };
  // @ts-expect-error the referral column has no paid_count (BR-FUND-25)
  const referral: Schema<'ReferralEarningsPeriod'> = { paid_count: 1, est_fen: 0, credited_fen: 0 };
  expect([period, referral]).toHaveLength(2);
});

// Reuse the API workspace's installed contract validator (ADR-0001 §4.2 #15).
// This test-only loader adds no runtime dependency from contracts-ts to the API.
const apiRequire = createRequire(new URL('../../../apps/api/package.json', import.meta.url));
const testRequire = createRequire(import.meta.url);
interface ContractValidator {
  addFormat(name: string, format: { type: 'number'; validate: (value: number) => boolean }): void;
  compile(schema: object): (data: unknown) => boolean;
}
const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
  Ajv2020: new (options: { strict: true; allErrors: true }) => ContractValidator;
};
const addFormats = apiRequire('ajv-formats') as (ajv: ContractValidator) => void;
const { dereference } = apiRequire('@readme/openapi-parser') as {
  dereference(path: string): Promise<unknown>;
};
const { parseYamlLite } = testRequire('../../../tools/lib/yaml-lite.ts') as {
  parseYamlLite(text: string): unknown;
};

type ContractOperation = {
  description: string;
  security: Record<string, string[]>[];
  parameters: { name: string; in: string }[];
  requestBody: { required: boolean; content: { 'application/json': { schema: object } } };
  responses: Record<string, { content: { 'application/json': { schema: object } } }>;
  'x-auth': string;
  'x-signed': boolean;
  'x-idempotent': boolean;
  'x-min-version-gate': boolean | 'conditional';
  'x-session-scopes': string[];
};
type ContractDocument = {
  paths: Record<string, { post: ContractOperation }>;
  components: { schemas: Record<string, object & { enum?: string[] }> };
};
let contract: ContractDocument;
let validateConsent: (data: unknown) => boolean;
let validateOauthAttempt: (data: unknown) => boolean;
let validateLogout: (data: unknown) => boolean;

beforeAll(async () => {
  contract = (await dereference(
    fileURLToPath(new URL('../../../contracts/openapi.yaml', import.meta.url)),
  )) as ContractDocument;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value) => Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
  validateConsent = ajv.compile(contract.components.schemas['RecordConsentRequest']!);
  validateOauthAttempt = ajv.compile(contract.components.schemas['CreateOauthAttemptRequest']!);
  validateLogout = ajv.compile(
    contract.paths['/v1/auth/logout']!.post.responses['200']!.content['application/json'].schema,
  );
});

it('logout requires bearer login without signing, idempotency or a version gate (04 §6.1, BR-ID-01)', () => {
  const logout = contract.paths['/v1/auth/logout']!.post;
  expect(logout['x-auth']).toBe('login');
  expect(logout.security).toEqual([{ bearerAuth: [] }]);
  expect(logout['x-signed']).toBe(false);
  expect(logout['x-idempotent']).toBe(false);
  expect(logout['x-min-version-gate']).toBe(false);
  expect(logout['x-session-scopes']).toContain('deletion_only');
  const headers = logout.parameters
    .filter((p) => p.in === 'header')
    .map((p) => p.name.toLowerCase());
  for (const name of ['x-timestamp', 'x-nonce', 'x-sign', 'idempotency-key']) {
    expect(headers).not.toContain(name);
  }
});

it('logout 200 has an empty data object (04 §6.1)', () => {
  const response = { code: 0, msg: '', data: {}, trace_id: 'logout-trace' };
  expect(validateLogout(response)).toBe(true);
  for (const data of [null, [], '', { session_id: 'unexpected' }]) {
    expect(validateLogout({ ...response, data }), JSON.stringify(data)).toBe(false);
  }
  const withoutData: Record<string, unknown> = { ...response };
  delete withoutData['data'];
  expect(validateLogout(withoutData)).toBe(false);
});

const consentSample = {
  type: 'privacy',
  version: 1,
  accepted: true,
  channel: 'first_launch',
  client_at: '2026-10-05T09:30:00+08:00',
};

it('consents accepts the five client types and five channels, including withdrawals (BR-ID-12)', () => {
  const operation = contract.paths['/v1/consents']!.post;
  expect(operation.requestBody.required).toBe(true);
  expect(operation.requestBody.content['application/json'].schema).toEqual(
    contract.components.schemas['RecordConsentRequest'],
  );
  for (const type of [
    'privacy',
    'agreement',
    'ai_third_party',
    'id_verification',
    'personalization',
  ]) {
    for (const channel of [
      'first_launch',
      'login_page',
      'agent_sheet',
      'realname_sheet',
      'privacy_center',
    ]) {
      for (const accepted of [true, false]) {
        const body = { ...consentSample, type, channel, accepted };
        expect(validateConsent(body), JSON.stringify(body)).toBe(true);
      }
    }
  }
});

it('consents rejects labor agreements and server-written channels (BR-ID-12, 04 §6.1)', () => {
  expect(validateConsent({ ...consentSample, type: 'labor_agreement' })).toBe(false);
  for (const channel of ['login_merge', 'h5_landing', 'withdraw_flow']) {
    expect(validateConsent({ ...consentSample, channel }), channel).toBe(false);
  }
});

it('consents requires a positive integer version (BR-ID-12)', () => {
  for (const version of [0, -1, 1.5, '1']) {
    expect(validateConsent({ ...consentSample, version }), String(version)).toBe(false);
  }
  expect(validateConsent({ ...consentSample, version: 2 })).toBe(true);
});

it('consents requires every field and rejects additional fields (BR-ID-12)', () => {
  for (const field of ['type', 'version', 'accepted', 'channel', 'client_at']) {
    const body: Record<string, unknown> = { ...consentSample };
    delete body[field];
    expect(validateConsent(body), `missing ${field}`).toBe(false);
  }
  for (const extra of [
    { unexpected: true },
    { subject_type: 'user' },
    { user_id: 'another-user' },
    { device_id: 'another-device' },
    { server_at: consentSample.client_at },
  ]) {
    expect(validateConsent({ ...consentSample, ...extra }), JSON.stringify(extra)).toBe(false);
  }
});

it('consents allows anonymous or bearer requests with conditional version and session gates (04 §6.1, BR-ID-01)', () => {
  const operation = contract.paths['/v1/consents']!.post;
  expect(operation['x-auth']).toBe('optional');
  expect(operation.security).toHaveLength(2);
  expect(operation.security).toEqual(expect.arrayContaining([{}, { bearerAuth: [] }]));
  expect(operation['x-min-version-gate']).toBe('conditional');
  expect(operation['x-session-scopes']).toEqual(['full', 'deletion_only']);
  // These extensions store the conditional rules in prose (OpenAPI info.description).
  const description = operation.description.replace(/\s+/g, ' ');
  expect(description).toMatch(
    /Version gate \(conditional\): not applied to accepted=false of any type, nor to type privacy or agreement; applied otherwise/,
  );
  expect(description).toMatch(
    /deletion_only session is accepted only for the same requests \(any withdrawal, and privacy or agreement records\)/,
  );
});

it('payout_bind attempts accept only WeChat without action (04 §6.1, CT-20a)', () => {
  expect(validateOauthAttempt({ provider: 'wechat', purpose: 'payout_bind' })).toBe(true);
  for (const provider of ['apple', 'huawei']) {
    expect(validateOauthAttempt({ provider, purpose: 'payout_bind' }), provider).toBe(false);
  }
  for (const action of ['withdraw', 'payout_account_change', 'phone_change', 'account_deletion']) {
    expect(
      validateOauthAttempt({ provider: 'wechat', purpose: 'payout_bind', action }),
      action,
    ).toBe(false);
  }
});

it('OauthAttemptPurpose matches identity.yaml oauth_attempt_purpose (04 §6.1, CT-20a)', () => {
  const identity = parseYamlLite(
    readFileSync(new URL('../../../contracts/enums/identity.yaml', import.meta.url), 'utf8'),
  ) as { enums: { oauth_attempt_purpose: { values: Record<string, string> } } };
  const purposes = contract.components.schemas['OauthAttemptPurpose']!.enum;
  expect(purposes).toBeDefined();
  expect([...(purposes ?? [])].sort()).toEqual(
    Object.keys(identity.enums.oauth_attempt_purpose.values).sort(),
  );
  expect(purposes).toContain('payout_bind');
});
