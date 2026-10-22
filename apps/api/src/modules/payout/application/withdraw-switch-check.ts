// B2-05d (Codex money r1): BR-WDR-03 ① — `withdraw.enabled=off` answers 30306 before ② step-up and
// the rest of the chain, and the refusal is stored with the key (BR-WDR-07 ⑧: 3xxxx results are
// persisted, so the same key replays 30306 after the switch is turned back on). The step-up
// token is judged in the idempotency post-miss phase (identity's stage ⑫), before the application
// use case runs, so the switch cannot wait for the use case: this check joins the post-miss list
// ahead of ⑫ (app.module's riskModule order) for POST /v1/withdrawals only, reads the switch on
// the claim's transaction and throws StoredRejection. A missing row is "on" (D-W02); an invalid
// value falls back to the default like readWithdrawLimits does.
//
// Also compiled by the `test` project: erasable syntax only.
import {
  idempotencyPostMissTransaction,
  StoredRejection,
  type IdempotencyPostMissCheck,
  type IdempotentRequest,
} from '../../platform/index.ts';
import { readWithdrawEnabled, type PayoutConfigPort } from './withdraw-rules.ts';

export const WITHDRAWALS_PATH = '/v1/withdrawals';
/** contracts/texts.default.json error.30306 */
const SWITCH_OFF_MSG = '提现功能暂时关闭，请稍后再试';

export interface WithdrawSwitchCheckOptions {
  config: PayoutConfigPort;
  logger: { warn(fields: Record<string, unknown>, message: string): void };
}

export function isWithdrawalApplication(
  request: Pick<IdempotentRequest, 'method' | 'path'>,
): boolean {
  return request.method === 'POST' && request.path === WITHDRAWALS_PATH;
}

export function createWithdrawSwitchCheck(
  options: WithdrawSwitchCheckOptions,
): IdempotencyPostMissCheck {
  return async (request) => {
    if (!isWithdrawalApplication(request)) return;
    const trx = idempotencyPostMissTransaction();
    if (trx === undefined) throw new Error('payout: the withdraw switch check needs the claim');
    const enabled = await readWithdrawEnabled(trx, request.appId, options);
    if (enabled) return;
    throw new StoredRejection(422, {
      code: 30306,
      msg: SWITCH_OFF_MSG,
      trace_id: request.traceId,
    });
  };
}
