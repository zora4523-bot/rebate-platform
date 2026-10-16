// GET /v1/me (04 §6.1; task B1-02z): the current user's view, read-only, by the token's app_id and
// uid only. Cross-module ports are assembled by app.module.
//
// - identity_level from the database (BR-ID-01): phone when users.phone_hmac is set, else member;
//   realname_status none until the real-name task (BR-ID-25).
// - invite_code null when banned, or appealing with a processing account appeal whose
//   prev_risk_state is banned (BR-INV-18); inviter_bound = parent_id set.
// - invite_backfill per BR-INV-07 (a)(b)(c) and growth.invite_bind.enabled (BR-INV-21);
//   deadline_at = created_at + invite.backfill_hours when eligible, else null.
// - balance through MeBalancePort (ledger, B2; zero default assembled by app.module).
// - union_bindings taobao then pdd through MeUnionBindingsPort (linking's binding projection).
// - need_reconsent per BR-ID-12: the user-level current state of privacy or agreement is not
//   accepted, or its version is below legal.privacy.version / legal.agreement.version.
// - risk: risk's readRiskState snapshot.
import type { components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type { RiskStateService } from '../../risk/index.ts';
import type { SmsConfigReader } from './sms-codes.ts';
import { instantPlus } from './config-seconds.ts';
import { currentStates } from '../domain/login.ts';
import { userConsentRecords } from '../infra/consent-records.ts';
import { meUser, hasDirectChildren, hasBannedAccountAppeal } from '../infra/me-reads.ts';
import type { InviteBackfillActivityPort, MeSubject } from '../ports/invite-backfill-activity.ts';
export type { InviteBackfillActivityPort, MeSubject } from '../ports/invite-backfill-activity.ts';

export type Me = components['schemas']['Me'];
export type MeBalance = components['schemas']['MeBalance'];
export type MeUnionBindingStatus = components['schemas']['UnionBindingState']['status'];
export type MeUnionPlatform = 'taobao' | 'pdd';

/** The single-balance summary (ADD-06); ledger owns it. */
export interface MeBalancePort {
  balanceOf(subject: MeSubject): Promise<MeBalance>;
}

/** linking's read-only binding projection (BR-ID-17 细则「授权管理页」); no row → unbound. */
export interface MeUnionBindingsPort {
  statusOf(subject: MeSubject, platform: MeUnionPlatform): Promise<MeUnionBindingStatus>;
}

export interface MeServiceOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly config: SmsConfigReader;
  readonly risk: Pick<RiskStateService, 'readRiskState'>;
  readonly balance: MeBalancePort;
  readonly unionBindings: MeUnionBindingsPort;
  readonly activity: InviteBackfillActivityPort;
}

export interface MeService {
  read(subject: MeSubject): Promise<Me>;
}

/** Ports assembled outside identity; risk uses the same instance as the request guard. */
export type MeReadPorts = Pick<MeServiceOptions, 'risk' | 'balance' | 'unionBindings' | 'activity'>;

function configuredNumber(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`identity: invalid ${key}`);
  }
  return value;
}

export function createMeService(options: MeServiceOptions): MeService {
  const { clock, config, risk, balance, unionBindings, activity } = options;
  const db = options.db.withSchema('app');
  return {
    async read(subject) {
      const user = await meUser(db, subject);
      const [hoursConfig, bindConfig, privacyConfig, agreementConfig] = await Promise.all(
        [
          'invite.backfill_hours',
          'growth.invite_bind.enabled',
          'legal.privacy.version',
          'legal.agreement.version',
        ].map((key) => config.configValue(subject.appId, key)),
      );
      const hours =
        hoursConfig == null ? 168 : configuredNumber(hoursConfig.value, 'invite.backfill_hours');
      const bindValue = bindConfig?.value ?? true;
      if (bindValue !== true && bindValue !== false && bindValue !== 'on' && bindValue !== 'off') {
        throw new Error('identity: invalid growth.invite_bind.enabled');
      }
      const deadline = instantPlus(user.created_at, hours * 3_600_000);
      if (!Number.isFinite(deadline.getTime())) {
        throw new Error('identity: invalid invite.backfill_hours deadline');
      }
      const [snapshot, records, summary, taobao, pdd] = await Promise.all([
        risk.readRiskState({ app_id: subject.appId, user_id: subject.userId }),
        userConsentRecords(db, subject.appId, subject.userId),
        balance.balanceOf(subject),
        unionBindings.statusOf(subject, 'taobao'),
        unionBindings.statusOf(subject, 'pdd'),
      ]);
      let eligible =
        user.parent_id === null &&
        !user.self_bind_used &&
        clock.now().getTime() < deadline.getTime() &&
        bindValue !== false &&
        bindValue !== 'off';
      if (eligible) {
        const [orders, claims, children] = await Promise.all([
          activity.orderCount(subject),
          activity.hasClaims(subject),
          hasDirectChildren(db, subject),
        ]);
        eligible = orders === 0 && !claims && !children;
      }
      const banned =
        snapshot.state === 'banned' ||
        (snapshot.state === 'appealing' && (await hasBannedAccountAppeal(db, subject)));
      const current = currentStates(records);
      const needReconsent = (
        [
          ['privacy', privacyConfig],
          ['agreement', agreementConfig],
        ] as const
      ).some(([type, item]) => {
        const version = item == null ? null : configuredNumber(item.value, `legal.${type}.version`);
        const state = current.get(type);
        return state?.accepted !== true || (version !== null && state.version < version);
      });
      const phoneBound = user.phone_hmac !== null;
      return {
        user_id: subject.userId,
        nickname: user.nickname,
        avatar_url: user.avatar,
        invite_code: banned ? null : user.invite_code,
        inviter_bound: user.parent_id !== null,
        invite_backfill: { eligible, deadline_at: eligible ? deadline.toISOString() : null },
        identity_level: phoneBound ? 'phone' : 'member',
        phone_bound: phoneBound,
        balance: summary,
        union_bindings: [
          { platform: 'taobao', status: taobao },
          { platform: 'pdd', status: pdd },
        ],
        // TODO(规划/11 §2.3): 实名状态与 realname 等级 — blocked on 实名任务（BR-ID-25）
        realname_status: 'none',
        need_reconsent: needReconsent,
        risk: {
          state: snapshot.state,
          reason_category: snapshot.reason_category,
          frozen_until: snapshot.frozen_until?.toISOString() ?? null,
        },
      };
    },
  };
}
