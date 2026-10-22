// Site (站长) union authorization alerts (B1-22b; BR-ID-24 ②, BR-TEXT-20 站长告警短信; 04 §3.2
// notify_logs). union's monitor decides when an alert is due; this port records and sends it.
//
// - plan(trx, plan): one notify_logs row per phone id on the caller's transaction (user_id null,
//   channel sms, code = template, status queued, planned_at = Clock). dedupe_key =
//   `union_auth:<union_account_id>:<auth_expires_at ISO | none>:<stage>:<phoneId>`, and for stage
//   `expired` one more segment, the ISO instant the account entered expired (D10-179: a later
//   re-entry alerts again, a rerun of the same entry does not). ON CONFLICT (app_id, dedupe_key)
//   DO NOTHING: a repeat or a concurrent plan adds nothing; the count of new rows is returned.
// - deliver(appId, unionAccountId, phones): the deliverable rows of exactly that account and
//   app — queued, or claims left unconfirmed for 10 minutes. Per row: claim and commit first
//   (FOR UPDATE SKIP LOCKED; failed ∧ sent_at null ∧ row_version 1, see V_* below), then send with
//   the dedupe key as outId. accepted / unknown → success with sent_at; rejected → failed for
//   good (row_version 2, error line); a throwing sender → back to queued and deliver rejects so
//   the queue retries; a phone no longer configured → failed for good. A claim left unconfirmed
//   (process died after claiming) is recovered: sms.query when the sender has it (sent → success,
//   not_sent → send, unknown → look again later), else sent again (decisions.md: a rare
//   duplicate rather than a lost alert). Operational alerts: no user switch, no quiet hours
//   (BR-TEXT-20).
// - Phones never reach notify_logs or the logs: a failure line carries the masked form only.
// - createFakeTemplateSmsSender: local / test only; renders the BR-TEXT-20 text strictly.
//   createTemplateSmsSender: the fake in local / test; elsewhere, until the provider adapter
//   exists, a sender that rejects every message, announced once with a warn (identity's
//   createSmsSender pattern).
import type { DB } from '@couli/db';
import type { ExpressionBuilder, Kysely, Transaction } from 'kysely';
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
  /**
   * Accounts with deliverable alerts (queued, or claims unconfirmed for 10 minutes; oldest
   * planned_at each), for the chain's self-heal.
   */
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
  /** Stable id of this alert (its notify_logs dedupe_key), for a provider's own dedupe. */
  outId?: string;
}
/** What a provider knows of an earlier send of `outId`. */
export type TemplateSmsQueryResult = 'sent' | 'not_sent' | 'unknown';
export interface TemplateSmsSender {
  send(m: TemplateSmsMessage): Promise<TemplateSmsResult>;
  /** Optional: look up an earlier send by its outId (used for claims left unconfirmed). */
  query?(m: { appId: string; outId: string; phone: string }): Promise<TemplateSmsQueryResult>;
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
// row_version of a union_auth SMS row tells the states status alone cannot (no new column or
// status value: the table is not this task's). Set to these values, not incremented:
// V_OPEN queued (new rows default 0; a row handed back after a throwing send is reset to 0);
// V_CLAIMED failed ∧ sent_at null — claimed and committed, send attempted or about to be, no
// outcome yet (recoverable after UNCONFIRMED_MS); V_DONE concluded — success, or failed for good
// (rejected, phone removed, unrenderable), never sent again.
const V_OPEN = 0;
const V_CLAIMED = 1;
const V_DONE = 2;
const UNCONFIRMED_MS = 10 * 60_000;
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

/** A Date of the same kind as `like` at `ms` (no wall clock, no `new Date`). */
function dateAt(like: Date, ms: number): Date {
  const result = structuredClone(like);
  result.setTime(ms);
  return result;
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

  /** The open rows (queued) or the claims left unconfirmed past UNCONFIRMED_MS. */
  function deliverable(now: Date) {
    const cutoff = dateAt(now, now.getTime() - UNCONFIRMED_MS);
    return (eb: ExpressionBuilder<DB, 'notify_logs'>) =>
      eb.or([
        eb('status', '=', 'queued'),
        eb.and([
          eb('status', '=', 'failed'),
          eb('sent_at', 'is', null),
          eb('row_version', '=', V_CLAIMED),
          eb('updated_at', '<=', cutoff),
        ]),
      ]);
  }

  /**
   * Claims one row and commits: queued (or a claim unconfirmed for UNCONFIRMED_MS) → failed with
   * sent_at null and row_version V_CLAIMED, updated_at now. FOR UPDATE SKIP LOCKED plus the same
   * conditions on the UPDATE: two deliveries never hold one claim. null when nothing was claimed.
   */
  async function claim(
    appId: string,
    rowId: string,
  ): Promise<{ id: string; code: string; dedupe_key: string; recovered: boolean } | null> {
    return o.db.transaction().execute(async (trx) => {
      const t = trx.withSchema('app');
      const now = clock.now();
      const row = await t
        .selectFrom('notify_logs')
        .select(['id', 'code', 'dedupe_key', 'status'])
        .where('app_id', '=', appId)
        .where('id', '=', rowId)
        .where(deliverable(now))
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (row === undefined) return null;
      await t
        .updateTable('notify_logs')
        .set({ status: 'failed', sent_at: null, row_version: V_CLAIMED, updated_at: now })
        .where('app_id', '=', appId)
        .where('id', '=', row.id)
        .where(deliverable(now))
        .execute();
      return {
        id: row.id,
        code: row.code,
        dedupe_key: row.dedupe_key,
        recovered: row.status !== 'queued',
      };
    });
  }

  /** Concludes a claim (only while it is still the open claim: failed ∧ sent_at null ∧ V_CLAIMED). */
  async function settle(
    appId: string,
    rowId: string,
    to: 'success' | 'failed' | 'reopen',
  ): Promise<void> {
    const now = clock.now();
    await db
      .updateTable('notify_logs')
      .set(
        to === 'success'
          ? { status: 'success', sent_at: now, row_version: V_DONE, updated_at: now }
          : to === 'failed'
            ? { row_version: V_DONE, updated_at: now }
            : { status: 'queued', row_version: V_OPEN, updated_at: now },
      )
      .where('app_id', '=', appId)
      .where('id', '=', rowId)
      .where('status', '=', 'failed')
      .where('sent_at', 'is', null)
      .where('row_version', '=', V_CLAIMED)
      .execute();
  }

  /**
   * One row: claim (committed), then send with the dedupe key as outId. A recovered claim
   * (unconfirmed for 10 minutes: the process died after claiming, or the outcome was lost) asks
   * sms.query first when there is one: sent → success, unknown → kept for the next look,
   * not_sent → sent now; without query it is sent again (a rare duplicate rather than a lost
   * alert, decisions.md). Returns true when a throwing sender handed the row back to queued.
   */
  async function deliverRow(
    appId: string,
    unionAccountId: string,
    rowId: string,
    platform: string | null,
    phones: ReadonlyMap<string, string>,
  ): Promise<boolean> {
    const claimed = await claim(appId, rowId);
    if (claimed === null) return false;
    const parsed = parseKey(claimed.dedupe_key);
    const phone = parsed === null ? undefined : phones.get(parsed.phoneId);
    const name = platform === null ? undefined : PLATFORM_NAMES[platform];
    const fields = {
      app_id: appId,
      union_account_id: unionAccountId,
      platform,
      code: claimed.code,
      stage: parsed?.stage ?? null,
    };
    if (parsed === null || phone === undefined || name === undefined) {
      // The phone was removed meanwhile (or the row cannot be rendered): failed for good.
      await settle(appId, claimed.id, 'failed');
      logger.error(
        {
          ...fields,
          reason: parsed !== null && phone === undefined ? 'phone_not_configured' : 'unrenderable',
        },
        'union_auth_sms_failed',
      );
      return false;
    }
    const masked = maskPhone(phone);
    if (claimed.recovered) {
      if (sms.query !== undefined) {
        let state: TemplateSmsQueryResult;
        try {
          state = await sms.query({ appId, outId: claimed.dedupe_key, phone });
        } catch {
          state = 'unknown';
        }
        if (state === 'sent') {
          await settle(appId, claimed.id, 'success');
          return false;
        }
        if (state === 'unknown') {
          // Still unconfirmed: the claim stays (updated_at now), looked at again in 10 minutes.
          logger.warn({ ...fields, phone_masked: masked }, 'union_auth_sms_unconfirmed');
          return false;
        }
      } else {
        logger.warn({ ...fields, phone_masked: masked }, 'union_auth_sms_resent');
      }
    }
    const params: Record<string, string> = { platform_name: name };
    if (claimed.code === 'UNION_AUTH_EXPIRING' && parsed.expiresAt !== null) {
      params['expires_at'] = beijingMinute(parsed.expiresAt, clock.now());
    }
    let result: TemplateSmsResult;
    try {
      result = await sms.send({
        appId,
        phone,
        template: claimed.code,
        params,
        outId: claimed.dedupe_key,
      });
    } catch (error) {
      // Not sent as far as we know (a transient error before the provider answered): back to
      // queued (row_version V_OPEN), so the job's retry or the next heal sends it.
      await settle(appId, claimed.id, 'reopen');
      logger.warn(
        {
          ...fields,
          phone_masked: masked,
          error_name: error instanceof Error ? error.name : typeof error,
        },
        'union_auth_sms_retry',
      );
      return true;
    }
    if (result === 'rejected') {
      await settle(appId, claimed.id, 'failed');
      logger.error(
        { ...fields, phone_masked: masked, reason: 'rejected' },
        'union_auth_sms_failed',
      );
      return false;
    }
    await settle(appId, claimed.id, 'success');
    return false;
  }

  return {
    async pending() {
      const rows = await db
        .selectFrom('notify_logs')
        .select(['app_id', 'dedupe_key', 'planned_at'])
        .where('channel', '=', 'sms')
        .where(deliverable(clock.now()))
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
        .where(deliverable(clock.now()))
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
      let reopened = 0;
      for (const row of rows) {
        if (await deliverRow(appId, unionAccountId, row.id, account?.platform ?? null, byId)) {
          reopened += 1;
        }
      }
      // Rows handed back to queued: reject so the queue retries this job (with its backoff); the
      // chain's heal (pending()) picks them up as well should the retries run out.
      if (reopened > 0) {
        throw new Error(`notification: ${reopened} site auth SMS handed back for retry`);
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
  /** outIds of the accepted / unknown sends (what query answers sent for). */
  const sentIds = new Set<string>();
  return Object.freeze({
    async send(m: TemplateSmsMessage): Promise<TemplateSmsResult> {
      const text = renderSiteAuthSms(m.template, m.params);
      const outcome = outcomes.shift() ?? 'accepted';
      if (outcome !== 'rejected') {
        sent.push(
          Object.freeze({ phone: m.phone, template: m.template, params: { ...m.params }, text }),
        );
        if (sent.length > OUTBOX_LIMIT) sent.splice(0, sent.length - OUTBOX_LIMIT);
        if (m.outId !== undefined) sentIds.add(m.outId);
      }
      return outcome;
    },
    async query(m: { appId: string; outId: string; phone: string }) {
      return sentIds.has(m.outId) ? ('sent' as const) : ('not_sent' as const);
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
