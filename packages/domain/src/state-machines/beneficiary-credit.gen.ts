// B2-04d test 阶段骨架；实现阶段由 YAML 生成器替换。
export type BeneficiaryCreditState = 'open' | 'done' | 'forfeited' | 'voided';
export type BeneficiaryCreditEvent = 'OPEN' | 'COMPLETE' | 'FORFEIT' | 'VOID';

export type BeneficiaryCreditTransitionResult =
  | { ok: true; to: BeneficiaryCreditState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionBeneficiaryCredit(
  from: BeneficiaryCreditState | null,
  event: BeneficiaryCreditEvent,
): BeneficiaryCreditTransitionResult {
  void from;
  void event;
  throw new Error('NotImplemented: transitionBeneficiaryCredit');
}
