// BR-FUND-08 / BR-FUND-19 ④⑤: read-only nets of one sub-order, from ledger history only.
import type { DB } from '@couli/db';
import { addFen, subFen } from '@couli/money';
import type { Transaction } from 'kysely';
import { readOrderEntries, type OrderEntryRow } from '../infra/order-nets-store.ts';
import { LedgerError } from './errors.ts';

export interface OrderNetSelection {
  readonly appId: string;
  readonly orderKey: string;
}

export interface BeneficiaryOrderNet {
  readonly beneficiary_user_id: string;
  readonly role: 'self' | 'share' | 'direct' | 'indirect';
  readonly net_fen: bigint;
}

export interface OrderNets {
  /** BR-FUND-08 / 19④: complete beneficiary keys, including zero nets; unordered. */
  readonly beneficiaries: readonly BeneficiaryOrderNet[];
  /** Credit net of COMMISSION_REVENUE across all vouchers for this order. */
  readonly platform_net_fen: bigint;
  /** Debit net of UNION_RECEIVABLE for the order voucher kinds in BR-FUND-19⑤. */
  readonly union_receivable_net_fen: bigint;
}

type Role = BeneficiaryOrderNet['role'];

const ROLES: readonly string[] = ['self', 'share', 'direct', 'indirect'];

/**
 * BR-FUND-08 已入账净额 / BR-FUND-19 ④: the voucher kinds of a beneficiary key. ADMIN_ADJUST
 * counts only as a RESTORE voucher (see isRestore); REWARD, FORFEIT, UNION_RECEIPT and every
 * other kind do not.
 */
const BENEFICIARY_KINDS: readonly string[] = [
  'CREDIT',
  'SETTLE_ADJUST',
  'CLAWBACK',
  'REASSIGN_REV',
  'REASSIGN_CREDIT',
];

function isRole(value: string): value is Role {
  return ROLES.includes(value);
}

interface StoredEntry {
  readonly amount_fen: bigint;
  readonly ledger_type: string | null;
  readonly sub_type: string | null;
  readonly owner_type: string;
  readonly owner_id: string | null;
  readonly subject: string | null;
}

function isPlatformSubject(row: StoredEntry, subject: string): boolean {
  // Platform subjects may carry a dimension suffix (UNION_RECEIVABLE:{platform}, D7).
  return (
    row.owner_type === 'platform' &&
    row.subject !== null &&
    (row.subject === subject || row.subject.startsWith(`${subject}:`))
  );
}

interface VoucherGroup {
  readonly kind: string | null;
  readonly beneficiary_user_id: string | null;
  readonly role: string | null;
  readonly entries: StoredEntry[];
}

function groupByVoucher(rows: readonly OrderEntryRow[]): VoucherGroup[] {
  const groups = new Map<string, VoucherGroup>();
  for (const row of rows) {
    let group = groups.get(row.voucher_id);
    if (!group) {
      group = {
        kind: row.voucher_kind,
        beneficiary_user_id: row.beneficiary_user_id,
        role: row.role,
        entries: [],
      };
      groups.set(row.voucher_id, group);
    }
    // An entry row without an account in the same app_id (or a voucher without entries) adds
    // nothing to any total; the voucher itself still defines its beneficiary key.
    const { amount_fen, owner_type } = row;
    if (amount_fen !== null && owner_type !== null) {
      group.entries.push({
        amount_fen,
        ledger_type: row.ledger_type,
        sub_type: row.sub_type,
        owner_type,
        owner_id: row.owner_id,
        subject: row.subject,
      });
    }
  }
  return [...groups.values()];
}

/** ADMIN_ADJUST counts only when the voucher holds a RESTORE entry (BR-FUND-22, invariant 04). */
function isRestore(group: VoucherGroup): boolean {
  return (
    group.kind === 'ADMIN_ADJUST' &&
    group.entries.some((e) => e.ledger_type === 'ADMIN_ADJUST' && e.sub_type === 'RESTORE')
  );
}

function countsForBeneficiary(group: VoucherGroup): boolean {
  return (group.kind !== null && BENEFICIARY_KINDS.includes(group.kind)) || isRestore(group);
}

/**
 * BR-FUND-19 ⑤ order voucher kinds: the beneficiary kinds plus FORFEIT. Platform-level vouchers
 * (no beneficiary key: CREDIT:PLATFORM, platform CLAWBACK / SETTLE_ADJUST differences, the R13
 * platform RESTORE) count too; UNION_RECEIPT and non-order adjustments do not.
 */
function countsForReceivable(group: VoucherGroup): boolean {
  return countsForBeneficiary(group) || group.kind === 'FORFEIT';
}

/**
 * Pure aggregation of the order's stored entries (amount_fen: debit positive, credit negative).
 * - beneficiary net (BR-FUND-08 / 19④) = − Σ entries of the key's vouchers on the beneficiary's own
 *   USER_BALANCE account (both sub-accounts) and on BAD_DEBT; keys only from complete structured
 *   columns (beneficiary_user_id and role); kept when zero, never clamped at zero.
 * - platform net = − Σ COMMISSION_REVENUE entries of every voucher of the order (credit net).
 * - receivable net = Σ UNION_RECEIVABLE entries of the ⑤ order voucher kinds (debit net).
 * A complete key with a role outside the contract enum is refused (ORDER_HISTORY_INVALID) instead
 * of being dropped from or mislabelled in the nets.
 */
export function aggregateOrderNets(rows: readonly OrderEntryRow[]): OrderNets {
  const nets = new Map<string, { user: string; role: Role; net_fen: bigint }>();
  let platform = 0n;
  let receivable = 0n;
  for (const group of groupByVoucher(rows)) {
    for (const e of group.entries) {
      if (isPlatformSubject(e, 'COMMISSION_REVENUE')) {
        platform = subFen(platform, e.amount_fen);
      }
    }
    if (countsForReceivable(group)) {
      for (const e of group.entries) {
        if (isPlatformSubject(e, 'UNION_RECEIVABLE')) {
          receivable = addFen(receivable, e.amount_fen);
        }
      }
    }
    const user = group.beneficiary_user_id;
    const role = group.role;
    if (!countsForBeneficiary(group) || user === null || role === null) continue;
    if (!isRole(role)) {
      throw new LedgerError(
        'ORDER_HISTORY_INVALID',
        `voucher role ${role} is not a beneficiary role`,
      );
    }
    const id = `${user}\u0000${role}`;
    let net = nets.get(id);
    if (!net) {
      net = { user, role, net_fen: 0n };
      nets.set(id, net);
    }
    for (const e of group.entries) {
      const own = e.owner_type === 'user' && e.owner_id === user;
      if (own || isPlatformSubject(e, 'BAD_DEBT')) {
        net.net_fen = subFen(net.net_fen, e.amount_fen);
      }
    }
  }
  const beneficiaries = [...nets.values()]
    .sort((a, b) =>
      a.user === b.user ? ROLES.indexOf(a.role) - ROLES.indexOf(b.role) : a.user < b.user ? -1 : 1,
    )
    .map((n) => ({ beneficiary_user_id: n.user, role: n.role, net_fen: n.net_fen }));
  return { beneficiaries, platform_net_fen: platform, union_receivable_net_fen: receivable };
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LedgerError('INVALID_INPUT', `${name} must be a nonempty string`);
  }
  return value;
}

/**
 * Read only, using the caller's transaction and (app_id, order_key).
 * Only ledger tables and structured voucher metadata determine attribution.
 * No order/user lookup, key parsing, clock cutoff, new transaction or balance lock.
 * Empty history returns an empty beneficiary list and bigint zero totals.
 */
export async function getOrderNets(
  trx: Transaction<DB>,
  input: OrderNetSelection,
): Promise<OrderNets> {
  if (typeof input !== 'object' || input === null) {
    throw new LedgerError('INVALID_INPUT', 'input must be an object');
  }
  const appId = text(input.appId, 'appId');
  const orderKey = text(input.orderKey, 'orderKey');
  return aggregateOrderNets(await readOrderEntries(trx, appId, orderKey));
}
