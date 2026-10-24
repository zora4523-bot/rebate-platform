// 共用夹具（B1-12y；BR-TEXT-20 细则「短信渠道登记与后台渠道开关」；编排裁定 D10-316 ①、D10-337 ①②、
// D10-339 ⑥）：短信按编码取登记、站长告警短信接真实通道的规则测试。
// - HTTP 只走 B1-12w 夹具的假 fetch（全局 fetch 换成一调用就失败的替身），不 listen、不出网。
// - notify_templates 的登记按 B1-12x 的列写入：在用登记（sms_sign_name / sms_template_code /
//   sms_template_type / sms_preview_text）四列同有同无；「待测试」登记（sms_pending_* 四列与测试状态、
//   测试时间）六列同有同无。
// - 期望值一律手写；号码、签名、模板 CODE、凭据都是明显的合成值。
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { AliyunSmsTemplate } from '../../../../apps/api/src/modules/notification/sms/index.ts';
import type { SmsConfig } from '../../../../apps/api/src/modules/platform/index.ts';

export {
  AT,
  ManualScheduler,
  OK_REPLY,
  flush,
  fullText,
  json,
  lowerHeaders,
  observe,
  queryOf,
  recomputedAuthorization,
  requestView,
  transport,
} from '../sms-aliyun/kit.ts';
export type { Reply, SentRequest } from '../sms-aliyun/kit.ts';

/** 部署配置：AccessKey 与 SMS_CODE 的兜底签名、模板 CODE（与任何登记都不同）。 */
export const CONFIG: SmsConfig = Object.freeze({
  accessKeyId: 'test-sms-id',
  accessKeySecret: 'test-sms-sentinel-value',
  signName: '部署签名',
  verifyCodeTemplate: 'SMS_900000001',
});

export const DEPLOY: AliyunSmsTemplate = Object.freeze({
  signName: CONFIG.signName,
  templateCode: CONFIG.verifyCodeTemplate,
});

export interface Registration {
  readonly signName: string;
  readonly templateCode: string;
  readonly type: 'verify' | 'notice';
  readonly preview: string;
}

export interface PendingRegistration extends Registration {
  readonly status: 'accepted' | 'failed' | 'not_sent_no_verify_phone';
}

export const VERIFY_REG: Registration = Object.freeze({
  signName: '登记签名',
  templateCode: 'SMS_100000001',
  type: 'verify',
  preview: '您的动态码为：{code}，请勿泄露！',
});

export const ALERT_REG: Registration = Object.freeze({
  signName: '凑狸',
  templateCode: 'SMS_200000001',
  type: 'notice',
  preview:
    '你的{platform_name}联盟授权将于{expires_at}到期，请登录后台重新授权，过期后新用户将无法下单。',
});

export const EXPIRED_REG: Registration = Object.freeze({
  signName: '凑狸',
  templateCode: 'SMS_200000002',
  type: 'notice',
  preview: '你的{platform_name}联盟授权已过期或失效，新用户暂时无法下单，请尽快登录后台重新授权。',
});

export const WD_DEFAULT_REG: Registration = Object.freeze({
  signName: '凑狸',
  templateCode: 'SMS_300000001',
  type: 'notice',
  preview: '你的提现打款未成功，{amount} 已退回余额，请在 App 内查看原因。',
});

export const WD_MANUAL_REG: Registration = Object.freeze({
  signName: '凑狸',
  templateCode: 'SMS_300000002',
  type: 'notice',
  preview: '你的提现未通过审核，{amount} 已退回余额，请在 App 内查看原因。',
});

/** 「待测试」登记：测试已受理，但还没有启用（永远不发正式短信）。 */
export const PENDING_REG: PendingRegistration = Object.freeze({
  signName: '待测签名',
  templateCode: 'SMS_400000001',
  type: 'notice',
  preview: '待测试的预览正文 {amount}',
  status: 'accepted',
});

/** 登记里签名与模板 CODE 两项，即 resolver 应给出的值。 */
export function templateOf(registration: Registration): AliyunSmsTemplate {
  return { signName: registration.signName, templateCode: registration.templateCode };
}

export function newAppId(prefix = 'sms-registry'): string {
  return `${prefix}-${randomUUID()}`;
}

export type Channel = 'inbox' | 'push' | 'sms';

export interface TemplateRow {
  readonly appId: string;
  readonly code: string;
  readonly variant?: string;
  readonly channels: readonly Channel[];
  readonly active?: Registration;
  readonly pending?: PendingRegistration;
}

/** notify_templates 一行（code × variant），登记列按给出的写入，其余为空。 */
export async function seedTemplate(db: Kysely<DB>, row: TemplateRow): Promise<void> {
  await db
    .insertInto('notify_templates')
    .values({
      app_id: row.appId,
      code: row.code,
      variant: row.variant ?? 'default',
      category: 'service',
      channels: [...row.channels],
      sms_sign_name: row.active?.signName ?? null,
      sms_template_code: row.active?.templateCode ?? null,
      sms_template_type: row.active?.type ?? null,
      sms_preview_text: row.active?.preview ?? null,
      sms_pending_sign_name: row.pending?.signName ?? null,
      sms_pending_template_code: row.pending?.templateCode ?? null,
      sms_pending_template_type: row.pending?.type ?? null,
      sms_pending_preview_text: row.pending?.preview ?? null,
      sms_test_status: row.pending?.status ?? null,
      sms_tested_at: row.pending === undefined ? null : new Date('2026-10-23T08:00:00.000Z'),
    })
    .execute();
}

/** 启用一行的登记（在用登记写入、「待测试」登记清空），模拟后台【启用新配置】之后的状态。 */
export async function enable(
  db: Kysely<DB>,
  where: { readonly appId: string; readonly code: string; readonly variant: string },
  registration: Registration,
): Promise<void> {
  await db
    .updateTable('notify_templates')
    .set({
      sms_sign_name: registration.signName,
      sms_template_code: registration.templateCode,
      sms_template_type: registration.type,
      sms_preview_text: registration.preview,
      sms_pending_sign_name: null,
      sms_pending_template_code: null,
      sms_pending_template_type: null,
      sms_pending_preview_text: null,
      sms_test_status: null,
      sms_tested_at: null,
    })
    .where('app_id', '=', where.appId)
    .where('code', '=', where.code)
    .where('variant', '=', where.variant)
    .execute();
}

/** 站长告警发送时 notify_logs 行的样子：已认领（failed、sent_at 空、row_version 1）。 */
export async function seedClaimedLog(
  db: Kysely<DB>,
  values: {
    readonly appId: string;
    readonly dedupeKey: string;
    readonly channel?: Channel;
    readonly code?: string;
  },
): Promise<void> {
  await db
    .insertInto('notify_logs')
    .values({
      id: randomUUID(),
      app_id: values.appId,
      user_id: null,
      code: values.code ?? 'UNION_AUTH_EXPIRING',
      channel: values.channel ?? 'sms',
      dedupe_key: values.dedupeKey,
      planned_at: new Date('2026-10-24T01:00:00.000Z'),
      sent_at: null,
      status: 'failed',
      row_version: 1,
    })
    .execute();
}

export function logRow(db: Kysely<DB>, appId: string, dedupeKey: string) {
  return db
    .selectFrom('notify_logs')
    .select(['channel', 'status', 'sent_at', 'row_version', 'sms_biz_id'])
    .where('app_id', '=', appId)
    .where('dedupe_key', '=', dedupeKey)
    .executeTakeFirstOrThrow();
}

/** 站长授权所属的联盟账号（站长告警渲染平台名用）。 */
export async function seedUnionAccount(
  db: Kysely<DB>,
  values: { readonly appId: string; readonly id: string; readonly expiresAt: Date },
): Promise<void> {
  await db
    .insertInto('union_accounts')
    .values({
      id: values.id,
      app_id: values.appId,
      platform: 'taobao',
      account_name: 'synthetic site',
      status: 'active',
      auth_status: 'expiring',
      auth_expires_at: values.expiresAt,
    })
    .execute();
}

/** memoryLogger 的行里 msg 等于 message 的那些（解析成对象）。 */
export function linesOf(lines: readonly string[], message: string): Record<string, unknown>[] {
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line['msg'] === message);
}

/** 用真实时间让出事件循环，直到 check() 为真或约 2 秒过去（数据库往返不在微任务里完成）。 */
export async function until(check: () => boolean): Promise<void> {
  for (let round = 0; round < 400 && !check(); round += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}
