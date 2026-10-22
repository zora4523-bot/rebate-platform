// Site (站长) union authorization alerts (B1-22b; BR-ID-24 ②, BR-TEXT-20 站长告警短信; 04 §3.2
// notify_logs). union's monitor decides when an alert is due; this port records and sends it.
//
// - plan(trx, plan): one notify_logs row per phone id on the caller's transaction (user_id null,
//   channel sms, code = template, status queued, planned_at = Clock). dedupe_key =
//   `union_auth:<union_account_id>:<auth_expires_at ISO | none>:<stage>:<phoneId>`, and for stage
//   `expired` one more segment, the ISO instant the account entered expired (D10-179: a later
//   re-entry alerts again, a rerun of the same entry does not). ON CONFLICT (app_id, dedupe_key)
//   DO NOTHING: a repeat or a concurrent plan adds nothing; the count of new rows is returned.
// - deliver(appId, unionAccountId, phones): the queued rows of exactly that account and app, one
//   transaction per row with FOR UPDATE SKIP LOCKED (two deliveries never send one row twice).
//   The phone is looked up by its id in the current list handed in; an id no longer configured
//   is failed. rejected → failed; accepted / unknown → success with sent_at. A failed row is never
//   sent again. Operational alerts: no user switch, no quiet hours (BR-TEXT-20).
// - Phones never reach notify_logs or the logs: a failure line carries the masked form only.
// - createFakeTemplateSmsSender: local / test only; renders the BR-TEXT-20 text strictly.
//   createTemplateSmsSender: the fake in local / test; elsewhere, until the provider adapter
//   exists, a sender that rejects every message, announced once with a warn (identity's
//   createSmsSender pattern).
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { newUuidV7, type Clock, type RootLogger } from '../../platform/index.ts';

export interface SiteAuthAlertPlan {
  appId: string;
  unionAccountId: string;
  /** The union platform code (taobao / jd / pdd); a plain string so notification never imports
   * union. union declares the port it needs itself (SiteAuthAlerts), matched structurally. */
  platform: string;
  authExpiresAt: Date | null;
  stage: string;
  code: 'UNION_AUTH_EXPIRING' | 'UNION_AUTH_EXPIRED';
  phoneIds: readonly string[];
}
export interface SiteAuthAlertPort {
  plan(trx: Transaction<DB>, plan: SiteAuthAlertPlan): Promise<number>;
  deliver(
    appId: string,
    unionAccountId: string,
    phones: readonly { phoneId: string; phone: string }[],
  ): Promise<void>;
  /** Accounts with queued alerts (oldest planned_at each), for the chain's self-heal. */
  pending?(): Promise<readonly SiteAuthPendingAlerts[]>;
}
export interface SiteAuthPendingAlerts {
  appId: string;
  unionAccountId: string;
  oldestPlannedAt: Date;
}
export type TemplateSmsResult = 'accepted' | 'rejected' | 'unknown';
export interface TemplateSmsMessage {
  appId: string;
  phone: string;
  template: string;
  params: Record<string, string>;
}
export interface TemplateSmsSender {
  send(m: TemplateSmsMessage): Promise<TemplateSmsResult>;
}
export interface FakeTemplateSmsSender extends TemplateSmsSender {
  outbox(): readonly {
    phone: string;
    template: string;
    params: Record<string, string>;
    text: string;
  }[];
  enqueueResult(r: TemplateSmsResult): void;
}
export interface SiteAuthAlertOptions {
  db: Kysely<DB>;
  clock: Clock;
  sms: TemplateSmsSender;
  logger: RootLogger;
}

const KEY_PREFIX = 'union_auth';
const OFFSET_MS = 8 * 3_600_000;
const PLATFORM_NAMES: Readonly<Record<string, string>> = Object.freeze({
  taobao: '淘宝',
  jd: '京东',
  pdd: '拼多多',
});
/** BR-TEXT-20 细则表（12_TEXT，SPEC_REF eabcf00）, verbatim. */
const TEMPLATES: Readonly<Record<string, string>> = Object.freeze({
  UNION_AUTH_EXPIRING:
    '【凑狸】你的{platform_name}联盟授权将于{expires_at}到期，请登录后台重新授权，过期后新用户将无法下单。',
  UNION_AUTH_EXPIRED:
    '【凑狸】你的{platform_name}联盟授权已过期或失效，新用户暂时无法下单，请尽快登录后台重新授权。',
});
/** Queued rows read per self-heal pass. */
const PENDING_LIMIT = 1000;
const RESULTS: ReadonlySet<unknown> = new Set(['accepted', 'rejected', 'unknown']);
const OUTBOX_LIMIT = 1000;
const ISO = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`;
const KEY_SHAPE = new RegExp(
  `^${KEY_PREFIX}:([^:]+):(none|${ISO}):([a-z0-9]+):([^:]+)(?::(${ISO}))?$`,
);

/** The dedupe key of one phone's alert (see the header). */
export function siteAuthAlertKey(plan: SiteAuthAlertPlan, phoneId: string, now: Date): string {
  const expires = plan.authExpiresAt === null ? 'none' : plan.authExpiresAt.toISOString();
  const base = `${KEY_PREFIX}:${plan.unionAccountId}:${expires}:${plan.stage}:${phoneId}`;
  return plan.stage === 'expired' ? `${base}:${now.toISOString()}` : base;
}

interface ParsedKey {
  readonly expiresAt: string | null;
  readonly stage: string;
  readonly phoneId: string;
}

function parseKey(key: string): ParsedKey | null {
  const match = KEY_SHAPE.exec(key);
  if (match === null) return null;
  return {
    expiresAt: match[2] === 'none' ? null : match[2]!,
    stage: match[3]!,
    phoneId: match[4]!,
  };
}

/** `YYYY-MM-DD HH:mm` at +08:00 (BR-TEXT-11 future time), from an ISO instant. */
function beijingMinute(iso: string, like: Date): string {
  const local = structuredClone(like);
  local.setTime(Date.parse(iso) + OFFSET_MS);
  const text = local.toISOString();
  return `${text.slice(0, 10)} ${text.slice(11, 16)}`;
}

/** 138****0000: the only form of a phone a log line may carry (BR-ID-33). */
export function maskPhone(phone: string): string {
  return phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : '****';
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function createSiteAuthAlertPort(o: SiteAuthAlertOptions): SiteAuthAlertPort {
  const { clock, sms, logger } = o;
  const db = o.db.withSchema('app');

  async function deliverRow(
    appId: string,
    unionAccountId: string,
    rowId: string,
    platform: string | null,
    phones: ReadonlyMap<string, string>,
  ): Promise<void> {
    await o.db.transaction().execute(async (trx) => {
      const t = trx.withSchema('app');
      const row = await t
        .selectFrom('notify_logs')
        .select(['id', 'code', 'dedupe_key'])
        .where('app_id', '=', appId)
        .where('id', '=', rowId)
        .where('status', '=', 'queued')
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (row === undefined) return;
      const parsed = parseKey(row.dedupe_key);
      const phone = parsed === null ? undefined : phones.get(parsed.phoneId);
      const name = platform === null ? undefined : PLATFORM_NAMES[platform];
      const now = clock.now();
      const fields = {
        app_id: appId,
        union_account_id: unionAccountId,
        platform,
        code: row.code,
        stage: parsed?.stage ?? null,
      };
      if (parsed === null || phone === undefined || name === undefined) {
        // The phone was removed meanwhile (or the row cannot be rendered): failed, never resent.
        await t
          .updateTable('notify_logs')
          .set({
            status: 'failed',
            updated_at: now,
            row_version: sql<number>`row_version + 1`,
          })
          .where('id', '=', row.id)
          .execute();
        logger.error(
          {
            ...fields,
            reason:
              parsed !== null && phone === undefined ? 'phone_not_configured' : 'unrenderable',
          },
          'union_auth_sms_failed',
        );
        return;
      }
      const params: Record<string, string> = { platform_name: name };
      if (row.code === 'UNION_AUTH_EXPIRING' && parsed.expiresAt !== null) {
        params['expires_at'] = beijingMinute(parsed.expiresAt, now);
      }
      const result = await sms.send({ appId, phone, template: row.code, params });
      const ok = result !== 'rejected';
      await t
        .updateTable('notify_logs')
        .set({
          status: ok ? 'success' : 'failed',
          sent_at: ok ? now : null,
          updated_at: now,
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', row.id)
        .execute();
      if (!ok) {
        logger.error(
          { ...fields, phone_masked: maskPhone(phone), reason: 'rejected' },
          'union_auth_sms_failed',
        );
      }
    });
  }

  return {
    async pending() {
      const rows = await db
        .selectFrom('notify_logs')
        .select(['app_id', 'dedupe_key', 'planned_at'])
        .where('channel', '=', 'sms')
        .where('status', '=', 'queued')
        .where('dedupe_key', 'like', `${KEY_PREFIX}:%`)
        .orderBy('planned_at')
        .limit(PENDING_LIMIT)
        .execute();
      const found = new Map<string, SiteAuthPendingAlerts>();
      for (const row of rows) {
        const unionAccountId = row.dedupe_key.split(':')[1];
        if (unionAccountId === undefined || unionAccountId === '') continue;
        const key = `${row.app_id}\u0000${unionAccountId}`;
        // Rows come oldest first: the first row of an account holds its oldest planned_at.
        if (!found.has(key)) {
          found.set(key, { appId: row.app_id, unionAccountId, oldestPlannedAt: row.planned_at });
        }
      }
      return [...found.values()];
    },

    async plan(trx, plan) {
      if (plan.phoneIds.length === 0) return 0;
      const now = clock.now();
      const ids = [...new Set(plan.phoneIds)];
      const inserted = await trx
        .withSchema('app')
        .insertInto('notify_logs')
        .values(
          ids.map((phoneId) => ({
            id: newUuidV7(now),
            app_id: plan.appId,
            user_id: null,
            code: plan.code,
            channel: 'sms',
            dedupe_key: siteAuthAlertKey(plan, phoneId, now),
            planned_at: now,
            sent_at: null,
            status: 'queued',
            created_at: now,
            updated_at: now,
          })),
        )
        .onConflict((oc) => oc.columns(['app_id', 'dedupe_key']).doNothing())
        .returning('id')
        .execute();
      return inserted.length;
    },

    async deliver(appId, unionAccountId, phones) {
      const rows = await db
        .selectFrom('notify_logs')
        .select('id')
        .where('app_id', '=', appId)
        .where('channel', '=', 'sms')
        .where('status', '=', 'queued')
        .where('dedupe_key', 'like', `${KEY_PREFIX}:${escapeLike(unionAccountId)}:%`)
        .orderBy('planned_at')
        .orderBy('dedupe_key')
        .execute();
      if (rows.length === 0) return;
      const account = await db
        .selectFrom('union_accounts')
        .select('platform')
        .where('app_id', '=', appId)
        .where('id', '=', unionAccountId)
        .executeTakeFirst();
      const byId = new Map(phones.map((p) => [p.phoneId, p.phone]));
      for (const row of rows) {
        await deliverRow(appId, unionAccountId, row.id, account?.platform ?? null, byId);
      }
    },
  };
}

function isFakeEnvironment(appEnv: string): boolean {
  return appEnv === 'local' || appEnv === 'test';
}

/** The BR-TEXT-20 text of `template`; an unknown template or a missing variable throws. */
export function renderSiteAuthSms(template: string, params: Record<string, string>): string {
  const text = TEMPLATES[template];
  if (text === undefined) throw new Error(`notification: unknown SMS template ${template}`);
  return text.replace(/\{([a-z_]+)\}/g, (_whole, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`notification: SMS variable ${name} missing`);
    return value;
  });
}

/** Only local/test may construct this adapter; default outcome accepted (identity's fake SMS). */
export function createFakeTemplateSmsSender(appEnv: string): FakeTemplateSmsSender {
  if (!isFakeEnvironment(appEnv)) {
    throw new Error('notification: the fake template SMS sender runs only in local or test');
  }
  const outcomes: TemplateSmsResult[] = [];
  const sent: { phone: string; template: string; params: Record<string, string>; text: string }[] =
    [];
  return Object.freeze({
    async send(m: TemplateSmsMessage): Promise<TemplateSmsResult> {
      const text = renderSiteAuthSms(m.template, m.params);
      const outcome = outcomes.shift() ?? 'accepted';
      if (outcome !== 'rejected') {
        sent.push(
          Object.freeze({ phone: m.phone, template: m.template, params: { ...m.params }, text }),
        );
        if (sent.length > OUTBOX_LIMIT) sent.splice(0, sent.length - OUTBOX_LIMIT);
      }
      return outcome;
    },
    enqueueResult(r: TemplateSmsResult): void {
      if (!RESULTS.has(r)) throw new TypeError('notification: unknown SMS result');
      outcomes.push(r);
    },
    outbox() {
      return Object.freeze([...sent]);
    },
  });
}

/**
 * The worker's sender: the fake in local / test; elsewhere, until the Aliyun template adapter
 * exists, a sender that definitely rejects (nothing is sent), announced once with a warn.
 */
export function createTemplateSmsSender(
  appEnv: string,
  logger: Pick<RootLogger, 'warn'>,
): TemplateSmsSender {
  if (isFakeEnvironment(appEnv)) return createFakeTemplateSmsSender(appEnv);
  logger.warn({ app_env: appEnv }, 'template_sms_sender_unconfigured');
  return Object.freeze({ send: async (): Promise<TemplateSmsResult> => 'rejected' });
}
