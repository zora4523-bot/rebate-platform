// B1-10c: claim evidence inside the acceptance transaction (08 BR-ATTR-17 "随后立即计算证据",
// BR-ATTR-18; orchestrator 口径 1～10, J-5). After the claim and its items are written as submitted,
// each item is judged (domain/claim-evidence.ts) over linking's raw reads on the same transaction,
// claim_items.evidence / evidence_link_log_ids are written, and the claim moves from submitted to
// auto_matched / manual_review through transitionClaim(evidenceEvent(levels)) with evidence_level
// the weakest item's. Any read error rejects and the whole acceptance rolls back (no claim, no
// failure count, 50001 for the caller). The ports come from app.module (linking's reader, the
// product-key derivation over catalog's platforms); orders never reads linking's or catalog's
// tables itself. claim.auto_approve_strong is not implemented (J-21): decisions stay empty.
import type { DB } from '@couli/db';
import { evidenceEvent, transitionClaim } from '@couli/domain';
import type { Transaction } from 'kysely';
import type { ContentReader } from '../../content/index.ts';
import type { ClaimEvidenceReader } from '../../linking/index.ts';
import type { Clock } from '../../platform/index.ts';
import {
  backfillWindowHours,
  backfillWindowStart,
  judgeClaimEvidence,
  weakestEvidence,
  type ClaimEvidenceLevel,
} from '../domain/claim-evidence.ts';
import { writeClaimEvidence } from '../infra/claim-store.ts';
import type { OrderSubject } from './order-queries.ts';

export interface ClaimEvidencePorts {
  readonly reads: ClaimEvidenceReader;
  /**
   * BR-PROD-03 product key of an order whose product_key column is empty: null when it cannot be
   * derived (that item can then be weak at best); a rejection is a read error (50001).
   */
  deriveProductKey(input: {
    readonly platform: string;
    readonly raw_item_id: string;
  }): Promise<string | null>;
}
/** The evidence ports over the acceptance transaction `trx` (app.module assembles them). */
export type ClaimEvidenceFactory = (trx: Transaction<DB>, clock: Clock) => ClaimEvidencePorts;

const WINDOW_KEY = 'attr.backfill_window_hours';

/** Read before acquiring the acceptance connection; invalid or unreadable config defaults to 360. */
export async function readClaimEvidenceWindow(
  config: ContentReader,
  appId: string,
): Promise<number> {
  let value: unknown;
  try {
    value = (await config.configValue(appId, WINDOW_KEY))?.value;
  } catch {
    value = undefined;
  }
  return backfillWindowHours(value);
}

/** One accepted item as the evidence step needs it. */
export interface ClaimEvidenceItem {
  readonly id: string;
  readonly attr_at: Date;
  readonly product_key: string | null;
  readonly shop_id: string | null;
  readonly raw_item_id: string;
}

export interface ClaimEvidenceOutcome {
  /** The claim's status after the evidence transition (auto_matched / manual_review). */
  readonly status: string;
  readonly counts: Readonly<Record<ClaimEvidenceLevel, number>>;
}

/**
 * Judges every item of the claim `claimId` (already written as submitted on `trx`) and writes the
 * result on `trx`. Items are judged against their own attr_at; bindings and conflicts are read
 * once for the claim (same applicant and platform).
 */
export async function settleClaimEvidence(
  trx: Transaction<DB>,
  ports: ClaimEvidencePorts,
  input: {
    readonly claimId: string;
    readonly subject: OrderSubject;
    readonly platform: string;
    readonly windowHours: number;
    readonly now: Date;
    readonly items: readonly ClaimEvidenceItem[];
  },
): Promise<ClaimEvidenceOutcome> {
  const scope = {
    appId: input.subject.app_id,
    userId: input.subject.user_id,
    platform: input.platform,
  };
  const bindings = await ports.reads.bindings(scope);
  const conflicts = await ports.reads.conflicts(scope);
  const judged: { readonly id: string; readonly evidence: ClaimEvidenceLevel; ids: bigint[] }[] =
    [];
  for (const item of input.items) {
    const productKey =
      item.product_key !== null && item.product_key !== ''
        ? item.product_key
        : await ports.deriveProductKey({ platform: input.platform, raw_item_id: item.raw_item_id });
    const logs = await ports.reads.linkLogs({
      ...scope,
      from: backfillWindowStart(item.attr_at, input.windowHours),
      to: item.attr_at,
    });
    const result = judgeClaimEvidence({
      ...scope,
      attrAt: item.attr_at,
      productKey,
      shopId: item.shop_id,
      windowHours: input.windowHours,
      logs,
      bindings,
      conflicts,
    });
    judged.push({ id: item.id, evidence: result.evidence, ids: [...result.evidence_link_log_ids] });
  }
  const levels = judged.map((row) => row.evidence);
  const moved = transitionClaim('submitted', evidenceEvent(levels));
  if (!moved.ok) throw new Error('orders: claim state machine refuses the evidence event');
  const status = await writeClaimEvidence(trx, {
    claimId: input.claimId,
    subject: input.subject,
    status: moved.to,
    evidenceLevel: weakestEvidence(levels),
    now: input.now,
    items: judged.map((row) => ({ id: row.id, evidence: row.evidence, linkLogIds: row.ids })),
  });
  const counts = { strong: 0, weak: 0, none: 0 };
  for (const level of levels) counts[level] += 1;
  return { status, counts };
}
