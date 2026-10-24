// B1-12y · The SMS template of a code, from the channel registration of notify_templates
// (BR-TEXT-20 细则「短信渠道登记与后台渠道开关」; orchestrator rulings D10-316 ①, D10-337 ①②,
// D10-339 ⑥). The signature name and template CODE every Aliyun SendSms request carries.
//
// resolve({ appId, code, variant }) — variant 'default' when absent; the rows are read on every
// call (no cache: a registration enabled in the console takes effect on the next send):
//   - the row (app_id, code, variant) has its in-use registration (sms_sign_name and
//     sms_template_code set), its channels contain 'sms', and every variant row of that app and
//     code has its in-use registration → { signName: sms_sign_name, templateCode:
//     sms_template_code };
//   - code 'SMS_CODE' whose row has no in-use registration (or no row) → deployVerifyCode (the
//     deployment's SMS_SIGN_NAME / SMS_TEMPLATE_VERIFY_CODE); undefined when that is absent too;
//   - any other code without an in-use registration, or whose channels lack 'sms' → undefined
//     (not sent; the deployment configuration never stands in for it);
//   - channels contain 'sms' but some variant of the code has no in-use registration yet (未就绪,
//     D10-339 ⑥) → undefined, and one log line `sms_not_ready` with app_id and code (never a
//     phone number);
//   - the pending registration (sms_pending_*, 「待测试」 / 「测试失败」) never sends a real SMS
//     and never replaces the deployment configuration of SMS_CODE (D10-337 ①).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { RootLogger } from '../../platform/index.ts';
import type { AliyunSmsTemplate } from './aliyun-channel.ts';

export interface RegisteredTemplateQuery {
  readonly appId: string;
  readonly code: string;
  /** notify_templates.variant; 'default' when absent. */
  readonly variant?: string;
}

export interface RegisteredTemplateResolver {
  resolve(query: RegisteredTemplateQuery): Promise<AliyunSmsTemplate | undefined>;
}

export interface RegisteredTemplateResolverDeps {
  readonly db: Kysely<DB>;
  /** SMS_CODE's fallback from the deployment configuration; absent when it is not configured. */
  readonly deployVerifyCode?: AliyunSmsTemplate;
  readonly logger: Pick<RootLogger, 'info' | 'warn' | 'error'>;
}

/** The verification code key: the only code the deployment configuration stands in for. */
const VERIFY_CODE = 'SMS_CODE';
const DEFAULT_VARIANT = 'default';

interface RegistrationRow {
  readonly variant: string;
  readonly channels: readonly string[];
  readonly sms_sign_name: string | null;
  readonly sms_template_code: string | null;
}

/** The in-use registration of a row (both columns set); the pending columns are never read. */
function inUse(row: RegistrationRow): AliyunSmsTemplate | undefined {
  const signName = row.sms_sign_name;
  const templateCode = row.sms_template_code;
  if (signName === null || signName.trim() === '') return undefined;
  if (templateCode === null || templateCode.trim() === '') return undefined;
  return { signName, templateCode };
}

export function createRegisteredTemplateResolver(
  deps: RegisteredTemplateResolverDeps,
): RegisteredTemplateResolver {
  const { logger } = deps;
  const db = deps.db.withSchema('app');
  const fallback =
    deps.deployVerifyCode === undefined
      ? undefined
      : Object.freeze({
          signName: deps.deployVerifyCode.signName,
          templateCode: deps.deployVerifyCode.templateCode,
        });
  return {
    async resolve(query) {
      const variant = query.variant ?? DEFAULT_VARIANT;
      // Every variant of the code, read on each call (a registration enabled in the console takes
      // effect on the next send; no cache).
      const rows: readonly RegistrationRow[] = await db
        .selectFrom('notify_templates')
        .select(['variant', 'channels', 'sms_sign_name', 'sms_template_code'])
        .where('app_id', '=', query.appId)
        .where('code', '=', query.code)
        .execute();
      const row = rows.find((candidate) => candidate.variant === variant);
      const registration = row === undefined ? undefined : inUse(row);
      const allVariants = rows.every((candidate) => inUse(candidate) !== undefined);

      if (query.code === VERIFY_CODE) {
        // SMS_CODE's channel cannot be closed (BR-TEXT-20): the registration when every variant
        // has one, otherwise the deployment configuration (D10-337 ②), else nothing.
        return registration !== undefined && allVariants ? registration : fallback;
      }
      if (row === undefined || !row.channels.includes('sms')) return undefined;
      if (registration !== undefined && allVariants) return registration;
      // The default channels hold SMS but some variant has no in-use registration yet (未就绪,
      // D10-339 ⑥): no SMS, one log line (never a phone number).
      logger.info({ app_id: query.appId, code: query.code, variant }, 'sms_not_ready');
      return undefined;
    },
  };
}
