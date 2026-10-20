// growth's invite page read (task B1-11j; 08 BR-INV-18, BR-INV-19, BR-INV-16, BR-INV-02). Service
// layer of GET /v1/invites/me (getMyInvite); the route only maps the result to the envelope.
//
// read(subject) samples the injected Clock once (BR-INV-19: the judging instant is the request's
// server instant) and reads, on one transaction of its own, uncached:
//   1. the caller's users row (invite_code, status, phone_hmac); a missing row is a programming
//      error (the token guard has resolved the user), so it throws (50001);
//   2. the verified birth date (identity's realname reader through the injected port; null when no
//      verified record). Verified and under 18 at the instant (isAtLeastAge, BR-ID-26) → 'minor'
//      (the route answers 30413 data.reason=self_minor), before anything else is judged;
//      unverified users count as adults;
//   3. otherwise inviter_unavailable(self) (packages/domain, the one function shared with the
//      binding core and the admin parent change) over risk's fresh state, the deletion stage
//      (identity's deletion-stage reader through the injected port, B1-15c: cooling / processing /
//      done → unavailable; read after risk), the phone binding and verified_minor;
//   4. direct_count (BR-INV-16): direct children of this app not deleted, counted live (cooling,
//      processing (users.status=deleting), banned and frozen children included); no child field is
//      ever read;
//   5. landing_url = `https://{share_domains[0]}/i/{invite_code}` from config_items share_domains
//      (bare domains); a missing, empty or non-array value, or a first item that is not a bare
//      domain → landing_url null and one warn carrying config_key only (never the second item, never
//      an invented domain). can_invite is not affected.
// can_invite=false → invite_code, landing_url and poster_url null, direct_count still returned.
// poster_url is always null for now.
// TODO(规划/11 §2.3): 服务端出图 — blocked on TECH-13
//
// The real name and birth date never reach a log or the result.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators, no Nest.
import type { DB } from '@couli/db';
import { inviterUnavailable, isAtLeastAge } from '@couli/domain';
import type { Kysely, Transaction } from 'kysely';
import type { Clock, RootLogger } from '../../platform/index.ts';
import type { RiskStateSnapshot } from '../../risk/index.ts';
import type { InviteDeletionStage, InviteSubject } from './invite-binder.ts';

/** BR-INV-19 / BR-ID-26: a verified user under this age gets 30413 on the invite page. */
const INVITER_MIN_AGE = 18;
/** config_items key of the share domains (bare domains; content's client config uses the same). */
export const SHARE_DOMAINS_KEY = 'share_domains';

export interface MyInviteDeps {
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly db: Kysely<DB>;
  /** config_items read on the given transaction, uncached (a domain switch applies at once). */
  readonly config: {
    configValue(
      appId: string,
      key: string,
      trx: Transaction<DB>,
    ): Promise<{ readonly value: unknown; readonly version: number } | null>;
  };
  /** The assembler uses risk's readRiskState(subject, { fresh: true }) on this trx. */
  readonly readRisk: (trx: Transaction<DB>, subject: InviteSubject) => Promise<RiskStateSnapshot>;
  /** identity's realname reader: the verified birth date (YYYY-MM-DD), or null. */
  readonly verifiedBirthDate: (
    trx: Transaction<DB>,
    subject: InviteSubject,
  ) => Promise<string | null>;
  /** identity's deletion-stage reader (B1-15c) on this trx; app.module wires it (growthReadPorts). */
  readonly readDeletionStage: (
    trx: Transaction<DB>,
    subject: InviteSubject,
  ) => Promise<InviteDeletionStage>;
}

export interface MyInvite {
  readonly can_invite: boolean;
  readonly invite_code: string | null;
  readonly landing_url: string | null;
  readonly poster_url: null;
  readonly direct_count: number;
}

export type MyInviteResult =
  { readonly result: 'minor' } | { readonly result: 'ok'; readonly invite: MyInvite };

export interface MyInviteReader {
  read(subject: InviteSubject): Promise<MyInviteResult>;
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
/** A bare host name of at least two labels: no scheme, port, path, query, user info or space. */
const BARE_DOMAIN = new RegExp(`^(?=.{1,253}$)(?:${LABEL}\\.)+${LABEL}$`, 'i');

/** The first share domain when it is a bare domain, else null. Exported for unit tests. */
export function firstShareDomain(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const first: unknown = value[0];
  if (typeof first !== 'string' || !BARE_DOMAIN.test(first)) return null;
  // The last label must not be all digits: an IPv4 address is not a share domain.
  if (/\.\d+$/.test(first)) return null;
  return first.toLowerCase();
}

export function createMyInviteReader(deps: MyInviteDeps): MyInviteReader {
  const { clock, logger, db, config, readRisk, verifiedBirthDate, readDeletionStage } = deps;

  async function readOn(trx: Transaction<DB>, subject: InviteSubject): Promise<MyInviteResult> {
    const at = clock.now();
    const user = await trx
      .withSchema('app')
      .selectFrom('users')
      .select(['invite_code', 'status', 'phone_hmac'])
      .where('app_id', '=', subject.app_id)
      .where('id', '=', subject.user_id)
      .executeTakeFirst();
    if (user === undefined) throw new Error('growth: invite page subject not found');

    const birthDate = await verifiedBirthDate(trx, subject);
    const verifiedMinor = birthDate !== null && !isAtLeastAge(birthDate, INVITER_MIN_AGE, at);
    if (verifiedMinor) return { result: 'minor' };

    const risk = await readRisk(trx, subject);
    const stage = await readDeletionStage(trx, subject);
    const unavailable = inviterUnavailable({
      risk_state: risk.state,
      deletion_status: stage === 'none' ? null : stage,
      phone_bound: user.phone_hmac !== null,
      verified_minor: verifiedMinor,
    });

    // A done deletion always leaves the users row as a tombstone (status = deleted, BR-ID-28), so
    // excluding deleted excludes done; cooling and processing children still count (B1-15c).
    const counted = await trx
      .withSchema('app')
      .selectFrom('users')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('app_id', '=', subject.app_id)
      .where('parent_id', '=', subject.user_id)
      .where('status', '<>', 'deleted')
      .executeTakeFirstOrThrow();
    const directCount = Number(counted.count);

    if (unavailable) {
      return {
        result: 'ok',
        invite: {
          can_invite: false,
          invite_code: null,
          landing_url: null,
          poster_url: null,
          direct_count: directCount,
        },
      };
    }

    const domains = await config.configValue(subject.app_id, SHARE_DOMAINS_KEY, trx);
    const domain = firstShareDomain(domains?.value);
    if (domain === null) {
      // No user field: config_key only (E25).
      logger.warn({ config_key: SHARE_DOMAINS_KEY }, 'invite_share_domain_unavailable');
    }
    const code = user.invite_code;
    return {
      result: 'ok',
      invite: {
        can_invite: true,
        invite_code: code,
        landing_url: domain === null ? null : `https://${domain}/i/${encodeURIComponent(code)}`,
        poster_url: null,
        direct_count: directCount,
      },
    };
  }

  return Object.freeze({
    read: (subject: InviteSubject) => db.transaction().execute((trx) => readOn(trx, subject)),
  });
}
