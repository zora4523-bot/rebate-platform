// 独立算术 oracle：只按 BR-CALC-02/04/05/08/13/24 用 bigint 乘除。
// 不导入 domain 或 money（包括类型），避免与被测实现共用计算路径。
interface Person {
  readonly user_id: string;
  readonly ratio_bp: bigint;
  readonly status: 'active' | 'forfeited';
}

interface Input {
  readonly n_base_fen: bigint;
  readonly reserve_bp: bigint;
  readonly tlj_deduct_fen: bigint;
  readonly order_type: 'self' | 'share';
  readonly indirect_enabled: boolean;
  readonly owner: Person;
  readonly direct?: Person | null;
  readonly indirect?: Person | null;
}

interface Share {
  role: 'self' | 'share' | 'direct' | 'indirect';
  user_id: string;
  ratio_bp: bigint;
  amount_fen: bigint;
}

/** 只用于合法输入；非法输入的错误类由独立规则测试检查。 */
export function splitReference(input: Input) {
  const positive = input.n_base_fen > 0n ? input.n_base_fen : 0n;
  const afterReserve = (positive * (10000n - input.reserve_bp)) / 10000n;
  const base = afterReserve > input.tlj_deduct_fen ? afterReserve - input.tlj_deduct_fen : 0n;
  const shares: Share[] = [];
  const warnings: 'INDIRECT_SAME_PERSON'[] = [];
  const append = (role: Share['role'], person: Person): void => {
    shares.push({
      role,
      user_id: person.user_id,
      ratio_bp: person.ratio_bp,
      amount_fen: person.status === 'forfeited' ? 0n : (base * person.ratio_bp) / 10000n,
    });
  };
  append(input.order_type, input.owner);
  if (input.direct != null) append('direct', input.direct);
  if (input.indirect_enabled && input.direct != null && input.indirect != null) {
    if (
      input.indirect.user_id === input.owner.user_id ||
      input.indirect.user_id === input.direct.user_id
    ) {
      warnings.push('INDIRECT_SAME_PERSON');
    } else {
      append('indirect', input.indirect);
    }
  }
  return {
    reserve_fen: positive - afterReserve,
    base_fen: base,
    shares,
    platform_retain_fen: base - shares.reduce((sum, share) => sum + share.amount_fen, 0n),
    warnings,
  };
}
