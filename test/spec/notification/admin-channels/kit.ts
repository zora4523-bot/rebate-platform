// 共用夹具（B1-12z；契约 CT-24t 的六个后台操作；08 BR-TEXT-20 细则「短信渠道登记与后台渠道开关」、
// BR-ID-45、BR-ID-05；编排裁定 D10-316 ①、D10-335、D10-337、D10-339、D10-341、D10-342）。
// - 真实后台入口（Fastify inject）+ 业务角色 PG，只在容器里跑 *.int.test.ts；用例、守卫、二次验证都不替换。
// - 测试短信只走后台入口在 test 环境挂在 notifySmsTestSenderToken() 下的假通道（不联网），按脚本给受理 /
//   拒绝 / 结果未知；outbox 记下每次尝试发出的号码、签名、模板 CODE 与变量。
// - notify_templates 每个 app 自建（app_id 随机），登记列按 B1-12x 的列写入；row_version 对一个编码的
//   全部变体行写同一个值（契约：一个编码一个版本）。
// - 期望值手写；号码、签名、模板 CODE 都是明显的合成值。变量集合只对 08 写明的编码手写（SMS_CODE、
//   站长告警），其余编码的变量取列表接口给出的 variables（契约：预览正文须恰好用这些变量）。
import { randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  notifySmsTestSenderToken,
  type FakeNotifySmsTestSender,
} from '../../../../apps/api/src/modules/notification/admin-channels/sms-test-sender.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  apiRequire,
  fixture,
  type Fixture,
  type Harness,
  type Response,
} from '../../admin/auth/kit.ts';
import { signIn as signInAccount } from '../../union/admin-accounts/kit.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const BASE = '/admin/v1/notify-channels';
/** 04 §11.2：读列表持 content.article 或 notify.channels 任一即可。 */
export const ARTICLE = 'content.article';
export const CHANNELS = 'notify.channels';
/** 资金类编码登记与启用另要的权限点（BR-TEXT-12 细则「资金术语键」）。 */
export const FUND = 'content.fund_terms';
/** BR-ID-05：6 位码 5 分钟有效。 */
export const CODE_TTL_SEC = 300;
export const ACTIONS = {
  switch: 'notify_channel_switch',
  register: 'notify_sms_register',
  discard: 'notify_sms_discard',
  test: 'notify_sms_test',
  enable: 'notify_sms_enable',
} as const;

/** 六个操作的 Fastify 路由模板（只在后台入口）。 */
export const ROUTES = [
  ['GET', BASE],
  ['PATCH', `${BASE}/:code`],
  ['PUT', `${BASE}/:code/sms`],
  ['DELETE', `${BASE}/:code/sms/pending`],
  ['POST', `${BASE}/:code/sms/pending/test`],
  ['POST', `${BASE}/:code/sms/pending/enable`],
] as const;

export type Op = 'list' | 'switch' | 'register' | 'discard' | 'retest' | 'enable';
const OPERATIONS: Readonly<Record<Op, readonly [string, string]>> = {
  list: [BASE, 'get'],
  switch: [`${BASE}/{code}`, 'patch'],
  register: [`${BASE}/{code}/sms`, 'put'],
  discard: [`${BASE}/{code}/sms/pending`, 'delete'],
  retest: [`${BASE}/{code}/sms/pending/test`, 'post'],
  enable: [`${BASE}/{code}/sms/pending/enable`, 'post'],
};

export type Item = Schema<'AdminNotifyChannelItem'>;
export type VariantRow = Schema<'AdminNotifySmsVariantRow'>;
export type SmsResult = Schema<'AdminNotifySmsResult'>;
export type Channel = 'inbox' | 'push' | 'sms';

export interface Registration {
  readonly signName: string;
  readonly templateCode: string;
  readonly type: 'verify' | 'notice';
  readonly preview: string;
}

export interface PendingRegistration extends Registration {
  readonly status: 'accepted' | 'failed' | 'not_sent_no_verify_phone';
}

/** 种子里「待测试」登记的测试时间。 */
export const SEEDED_TESTED_AT = new Date('2026-10-08T01:00:00.000Z');

export const SMS_CODE_ACTIVE: Registration = Object.freeze({
  signName: '凑狸',
  templateCode: 'SMS_510000001',
  type: 'verify',
  preview: '【凑狸】你的验证码是${code}，5分钟内有效，请勿泄露。',
});

export const SMS_CODE_PENDING: PendingRegistration = Object.freeze({
  signName: '凑狸',
  templateCode: 'SMS_510000002',
  type: 'verify',
  preview: '【凑狸】你的登录验证码是${code}，5分钟内有效。',
  status: 'accepted',
});

export const ALERT_ACTIVE: Registration = Object.freeze({
  signName: '凑狸',
  templateCode: 'SMS_530000001',
  type: 'notice',
  preview:
    '【凑狸】你的${platform_name}联盟授权将于${expires_at}到期，请登录后台重新授权，过期后新用户将无法下单。',
});

export const WD_FAILED_ACTIVE: Registration = Object.freeze({
  signName: '凑狸',
  templateCode: 'SMS_520000001',
  type: 'notice',
  preview: '【凑狸】你的提现打款未成功，${amount}已退回余额，请在App内查看原因。',
});

export const WD_FAILED_PENDING: PendingRegistration = Object.freeze({
  signName: '凑狸',
  templateCode: 'SMS_520000002',
  type: 'notice',
  preview: '【凑狸】你的提现打款未成功，${amount}已退回余额，可在App内查看原因。',
  status: 'failed',
});

export const WD_REJECTED_ACTIVE: Registration = Object.freeze({
  signName: '凑狸',
  templateCode: 'SMS_540000001',
  type: 'notice',
  preview: '【凑狸】你的提现未通过：${reason}，${amount}已退回余额。',
});

export const WD_REJECTED_NEGATIVE_ACTIVE: Registration = Object.freeze({
  signName: '凑狸',
  templateCode: 'SMS_540000002',
  type: 'notice',
  preview: '【凑狸】你的提现未通过：${reason}；抵扣后的余额以钱包显示为准。',
});

/** 同一登记作为「待测试」、带给定的测试结果。 */
export function pendingOf(
  registration: Registration,
  status: PendingRegistration['status'],
  templateCode = registration.templateCode,
): PendingRegistration {
  return { ...registration, templateCode, status };
}

/** 预览正文里的占位写法 `${name}`（与阿里云模板一致）。 */
export function placeholder(name: string): string {
  return `\${${name}}`;
}

/** 一段只用给定变量、不含禁用词、首句以「你的」开头的通知预览正文。 */
export function previewWith(variables: readonly string[], tail = '请在App内查看。'): string {
  return `【凑狸】你的提现结果有更新：${variables.map(placeholder).join('，')}，${tail}`;
}

/** BR-ID-33 展示脱敏：前 3 位与后 4 位。 */
export const masked = (phone: string) => `${phone.slice(0, 3)}****${phone.slice(7)}`;

/** 随机大陆手机号（^1[3-9][0-9]{9}$）。 */
export function mobile(): string {
  let rest = '';
  for (let i = 0; i < 9; i++) rest += String(randomInt(10));
  return `1${String(randomInt(3, 10))}${rest}`;
}

export const sorted = (values: readonly string[]) => [...values].sort();

interface InjectRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  payload?: string;
}

export interface CallOptions {
  /** undefined → 新取一枚 totp 档二次验证令牌；null → 不带 X-Step-Up-Token。 */
  token?: string | null;
  headers?: Record<string, string>;
  /** variant 查询参数；undefined → 不带（服务端按 default）。 */
  variant?: string;
}

function injector(f: Fixture) {
  return (input: InjectRequest) =>
    (f.app as unknown as { inject(request: InjectRequest): Promise<Response> }).inject(input);
}

/** 查询串（值原样；undefined 的键不发）。 */
export function query(values: Readonly<Record<string, string | number | undefined>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.append(key, String(value));
  }
  const text = params.toString();
  return text.length === 0 ? '' : `?${text}`;
}

/** 后台账号的验证手机号（BR-ID-45，admin_users.verify_phone_*）；null = 清掉。 */
export async function setVerifyPhone(
  h: Harness,
  appId: string,
  adminId: string,
  phone: string | null,
): Promise<void> {
  await h.db
    .updateTable('admin_users')
    .set(
      phone === null
        ? { verify_phone_cipher: null, verify_phone_hmac: null, verify_phone_set_at: null }
        : {
            verify_phone_cipher: Buffer.from(
              h.fields.encrypt(phone, `admin_users.verify_phone:${appId}:${adminId}`),
            ),
            verify_phone_hmac: h.fields.blindIndex(phone, 'admin_users.verify_phone'),
            verify_phone_set_at: new Date('2026-10-01T00:00:00.000Z'),
          },
    )
    .where('id', '=', adminId)
    .execute();
}

export interface AdminOptions {
  /** 授予的权限点；默认 notify.channels + content.fund_terms。 */
  readonly grants?: readonly string[];
  readonly isSuper?: boolean;
  /** 是否登记验证手机号；默认登记。 */
  readonly verifyPhone?: boolean;
}

/** `appId` 下一个已登录的后台账号（自己的 admin_token 与 totp 二次验证），带六个操作。 */
export async function signIn(h: Harness, f: Fixture, appId: string, options: AdminOptions = {}) {
  const grants = options.grants ?? [CHANNELS, FUND];
  const admin = await signInAccount(
    h,
    f,
    appId,
    options.isSuper === true ? { grants, isSuper: true } : { grants },
  );
  const phone = options.verifyPhone === false ? null : mobile();
  if (phone !== null) await setVerifyPhone(h, appId, admin.a.id, phone);
  const inject = injector(f);
  const send = (
    method: InjectRequest['method'],
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ) =>
    inject({
      method,
      url,
      headers: {
        ...admin.auth,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const stepUp = async (call: CallOptions) => {
    const token = call.token === undefined ? await admin.issue() : call.token;
    return { ...(token === null ? {} : { 'x-step-up-token': token }), ...call.headers };
  };
  const path = (code: string, suffix: string, variant?: string) =>
    `${BASE}/${encodeURIComponent(code)}${suffix}${query({ variant })}`;
  return {
    a: admin.a,
    auth: admin.auth,
    issue: admin.issue,
    /** 登记的验证手机号；null = 没有登记。 */
    phone,
    list: (headers: Record<string, string> = {}) => send('GET', BASE, undefined, headers),
    switchChannels: async (code: string, body: unknown, options: CallOptions = {}) =>
      send('PATCH', path(code, ''), body, await stepUp(options)),
    register: async (code: string, body: unknown, options: CallOptions = {}) =>
      send('PUT', path(code, '/sms', options.variant), body, await stepUp(options)),
    retest: async (code: string, body: unknown, options: CallOptions = {}) =>
      send('POST', path(code, '/sms/pending/test', options.variant), body, await stepUp(options)),
    enable: async (code: string, body: unknown, options: CallOptions = {}) =>
      send('POST', path(code, '/sms/pending/enable', options.variant), body, await stepUp(options)),
    /** DELETE …/sms/pending：不要二次验证，只带给定的查询参数与请求头。 */
    discard: (
      code: string,
      values: Readonly<Record<string, string | number | undefined>>,
      headers: Record<string, string> = {},
    ) =>
      send(
        'DELETE',
        `${BASE}/${encodeURIComponent(code)}/sms/pending${query(values)}`,
        undefined,
        headers,
      ),
  };
}
export type Admin = Awaited<ReturnType<typeof signIn>>;

/** 新 app、后台入口上一个后台账号；六个路由必须已挂上。 */
export async function setup(h: Harness, options: AdminOptions = {}) {
  const appId = `admin_notify_channels_${randomUUID().replaceAll('-', '')}`;
  const f = await fixture(h);
  const server = f.app.getHttpAdapter().getInstance() as unknown as {
    hasRoute(input: { method: string; url: string }): boolean;
  };
  for (const [method, url] of ROUTES) {
    expect(server.hasRoute({ method, url }), `${method} ${url} is registered`).toBe(true);
  }
  const admin = await signIn(h, f, appId, options);
  return { h, f, appId, inject: injector(f), ...admin };
}
export type Scenario = Awaited<ReturnType<typeof setup>>;
export type Where = Pick<Scenario, 'h' | 'f' | 'appId'>;

/** 后台入口 test 环境的测试短信假通道（每个入口实例一个）。 */
export function smsOf(f: Fixture): FakeNotifySmsTestSender {
  let result: FakeNotifySmsTestSender | undefined;
  expect(() => {
    result = f.app.get<FakeNotifySmsTestSender>(notifySmsTestSenderToken());
  }, '后台入口须在 test 环境提供测试短信的假通道').not.toThrow();
  expect(result).toBeDefined();
  return result!;
}

export interface TemplateRow {
  readonly code: string;
  readonly variant?: string;
  readonly category?: 'service' | 'subscription' | 'marketing';
  readonly channels: readonly Channel[];
  readonly active?: Registration;
  readonly pending?: PendingRegistration;
  readonly rowVersion?: number;
}

/** notify_templates 一行（code × variant），登记列按给出的写入，其余为空。 */
export async function seedTemplate(s: Where, row: TemplateRow): Promise<void> {
  await s.h.db
    .insertInto('notify_templates')
    .values({
      app_id: s.appId,
      code: row.code,
      variant: row.variant ?? 'default',
      category: row.category ?? 'service',
      channels: [...row.channels],
      row_version: row.rowVersion ?? 0,
      sms_sign_name: row.active?.signName ?? null,
      sms_template_code: row.active?.templateCode ?? null,
      sms_template_type: row.active?.type ?? null,
      sms_preview_text: row.active?.preview ?? null,
      sms_pending_sign_name: row.pending?.signName ?? null,
      sms_pending_template_code: row.pending?.templateCode ?? null,
      sms_pending_template_type: row.pending?.type ?? null,
      sms_pending_preview_text: row.pending?.preview ?? null,
      sms_test_status: row.pending?.status ?? null,
      sms_tested_at: row.pending === undefined ? null : SEEDED_TESTED_AT,
    })
    .execute();
}

/** 一个 app 的全部 notify_templates 行（按 code、variant）。 */
export function templateRows(s: Where) {
  return s.h.db
    .selectFrom('notify_templates')
    .selectAll()
    .where('app_id', '=', s.appId)
    .orderBy('code')
    .orderBy('variant')
    .execute();
}

/** 一行（code × variant）的渠道与两份登记。 */
export function templateRow(s: Where, code: string, variant = 'default') {
  return s.h.db
    .selectFrom('notify_templates')
    .select([
      'channels',
      'sms_sign_name',
      'sms_template_code',
      'sms_template_type',
      'sms_preview_text',
      'sms_pending_sign_name',
      'sms_pending_template_code',
      'sms_pending_template_type',
      'sms_pending_preview_text',
      'sms_test_status',
      'sms_tested_at',
    ])
    .where('app_id', '=', s.appId)
    .where('code', '=', code)
    .where('variant', '=', variant)
    .executeTakeFirstOrThrow();
}

/** 这个 app 的通知渠道审计行（action 以 notify 开头）。 */
export function audits(s: Where) {
  return s.h.db
    .selectFrom('audit_logs')
    .selectAll()
    .where('app_id', '=', s.appId)
    .where('action', 'like', 'notify%')
    .orderBy('id')
    .execute();
}

export async function snapshot(s: Where) {
  return { rows: await templateRows(s), audits: await audits(s) };
}

let documents: Promise<Record<string, Record<string, OperationDoc>>> | undefined;
interface OperationDoc {
  responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
}
async function paths() {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{ paths: Record<string, Record<string, OperationDoc>> }>;
  };
  documents ??= parser
    .dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
      resolve: { external: false },
    })
    .then((doc) => doc.paths);
  return documents;
}

/** 响应体按该操作在契约里对应状态段的响应 schema 校验。 */
export async function validate(response: Response, op: Op) {
  const [path, method] = OPERATIONS[op];
  const operation = (await paths())[path]?.[method];
  expect(operation, `${method} ${path} in contracts/openapi.yaml`).toBeDefined();
  const status =
    response.statusCode === 429
      ? '429'
      : response.statusCode < 400
        ? '200'
        : response.statusCode < 500
          ? '4XX'
          : '5XX';
  const schema = operation!.responses[status]?.content['application/json']?.schema;
  expect(schema, `${op} documents ${status}`).toBeDefined();
  const check = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
}

export async function accepted<T>(response: Response, op: Op): Promise<T> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json().code).toBe(0);
  await validate(response, op);
  return response.json<{ data: T }>().data;
}

const HTTP: Readonly<Record<number, number>> = {
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  20902: 409,
  50301: 503,
  50401: 504,
};

/** 错误响应：HTTP 状态、code、data（undefined = 不带 data）并过契约校验。 */
export async function rejected(response: Response, op: Op, code: number, data?: object) {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(HTTP[code] ?? 500);
  expect(response.json().code).toBe(code);
  if (data === undefined) expect(response.json()).not.toHaveProperty('data');
  else expect(response.json().data).toEqual(data);
  await validate(response, op);
}

export const DENIED = { reason: 'admin_permission_denied' } as const;
export const STEP_UP = { tier: 'totp' } as const;
export const LOCKED = 'notify_channel_locked';

/** GET 列表，200 且过契约。 */
export async function listed(admin: Pick<Admin, 'list'>): Promise<Item[]> {
  return (await accepted<{ items: Item[] }>(await admin.list(), 'list')).items;
}

/** 列表里 code 那一项（恰好一项）。 */
export async function itemOf(admin: Pick<Admin, 'list'>, code: string): Promise<Item> {
  const found = (await listed(admin)).filter((item) => item.code === code);
  expect(found, `${code} listed once`).toHaveLength(1);
  return found[0]!;
}

/** 一项里 variant 那一行（恰好一行）。 */
export function variantOf(item: Item, variant = 'default'): VariantRow {
  const found = item.sms_registrations.filter((row) => row.variant === variant);
  expect(found, `${item.code} × ${variant} listed once`).toHaveLength(1);
  return found[0]!;
}

/** 列表给出的某编码某变体的变量（非空）。 */
export async function variablesOf(
  admin: Pick<Admin, 'list'>,
  code: string,
  variant = 'default',
): Promise<string[]> {
  const variables = [...variantOf(await itemOf(admin, code), variant).variables];
  expect(variables.length, `${code} × ${variant} defines variables`).toBeGreaterThan(0);
  return variables;
}

export function ms(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return (typeof value === 'string' ? new Date(value) : value).getTime();
}

/** 读回的任何值的 JSON 文本（int8 id 写成十进制串）。 */
export function serialized(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}
