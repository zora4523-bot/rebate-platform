import { readFileSync } from 'node:fs';
import type {
  CommissionBeneficiary,
  CommissionShare,
  SplitCommissionInput,
  SplitCommissionResult,
} from '@couli/domain';

export function person(
  user_id: string,
  ratio_bp: bigint,
  status: CommissionBeneficiary['status'] = 'active',
): CommissionBeneficiary {
  return { user_id, ratio_bp, status };
}

export function example(overrides: Partial<SplitCommissionInput> = {}): SplitCommissionInput {
  return {
    n_base_fen: 1234n,
    reserve_bp: 0n,
    tlj_deduct_fen: 0n,
    order_type: 'self',
    indirect_enabled: true,
    owner: person('owner', 5000n),
    direct: person('parent', 1000n),
    indirect: person('grandparent', 500n),
    ...overrides,
  };
}

export function freezeInput(input: SplitCommissionInput): SplitCommissionInput {
  Object.freeze(input.owner);
  if (input.direct != null) Object.freeze(input.direct);
  if (input.indirect != null) Object.freeze(input.indirect);
  return Object.freeze(input);
}

interface CsvExample {
  id: string;
  source: string;
  rule: string;
  note: string;
  quote: boolean;
  input: SplitCommissionInput;
  expected: SplitCommissionResult;
  expectedAmounts: readonly bigint[];
}

/** 本表只含无引号、无英文逗号的字段；说明行以 # 开头，不作为算例。 */
export function readExamples(): CsvExample[] {
  const lines = readFileSync(
    new URL('../../../../specs/commission-examples.csv', import.meta.url),
    'utf8',
  )
    .trim()
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('#'));
  const header = lines.shift()?.split(',');
  if (header === undefined) throw new Error('Missing commission CSV header');
  return lines.map((line) => {
    const values = line.split(',');
    if (values.length !== header.length) throw new Error('Commission CSV column mismatch');
    const fields = Object.fromEntries(header.map((key, index) => [key, values[index]]));
    const field = (key: string): string => {
      const value = fields[key];
      if (value === undefined || value === '') throw new Error(`Missing CSV field: ${key}`);
      return value;
    };
    const bool = (key: string): boolean => {
      const value = field(key);
      if (value !== 'true' && value !== 'false') throw new Error(`Invalid CSV boolean: ${key}`);
      return value === 'true';
    };
    const status = (key: string): CommissionBeneficiary['status'] => {
      const value = field(key);
      if (value !== 'active' && value !== 'forfeited') throw new Error('Invalid CSV status');
      return value;
    };
    const orderType = field('order_type');
    if (orderType !== 'self' && orderType !== 'share') throw new Error('Invalid CSV order type');
    const same = field('same_person');
    if (!['none', 'owner', 'direct'].includes(same)) throw new Error('Invalid same_person');
    const input: SplitCommissionInput = {
      n_base_fen: BigInt(field('n_base_fen')),
      reserve_bp: BigInt(field('reserve_bp')),
      tlj_deduct_fen: BigInt(field('tlj_deduct_fen')),
      order_type: orderType,
      indirect_enabled: bool('indirect_enabled'),
      owner: person('owner', BigInt(field('r_own_bp')), status('owner_status')),
      direct: bool('has_direct')
        ? person('parent', BigInt(field('r_direct_bp')), status('direct_status'))
        : null,
      indirect: bool('has_indirect')
        ? person(
            same === 'owner' ? 'owner' : same === 'direct' ? 'parent' : 'grandparent',
            BigInt(field('r_indirect_bp')),
            status('indirect_status'),
          )
        : null,
    };
    const shares: CommissionShare[] = [];
    const append = (role: CommissionShare['role'], p: CommissionBeneficiary, key: string) => {
      shares.push({
        role,
        user_id: p.user_id,
        ratio_bp: p.ratio_bp,
        amount_fen: BigInt(field(key)),
      });
    };
    append(orderType, input.owner, 'expected_own_fen');
    if (input.direct != null) append('direct', input.direct, 'expected_direct_fen');
    const hasIndirect = input.indirect_enabled && input.direct != null && input.indirect != null;
    if (hasIndirect && same === 'none' && input.indirect != null)
      append('indirect', input.indirect, 'expected_indirect_fen');
    return {
      id: field('id'),
      source: field('source'),
      rule: field('rule'),
      note: field('note'),
      quote: bool('quote'),
      input,
      expectedAmounts: [
        BigInt(field('expected_own_fen')),
        BigInt(field('expected_direct_fen')),
        BigInt(field('expected_indirect_fen')),
      ],
      expected: {
        reserve_fen: BigInt(field('expected_reserve_fen')),
        base_fen: BigInt(field('expected_base_fen')),
        shares,
        platform_retain_fen: BigInt(field('expected_platform_retain_fen')),
        warnings: hasIndirect && same !== 'none' ? ['INDIRECT_SAME_PERSON'] : [],
      },
    };
  });
}
