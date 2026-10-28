// B2-06b: the scripted channel for PAYOUT_MODE=dry_run (rule tests and staging without sandbox
// credentials). It never touches the network, records every call, judges scripted responses with
// the same lists as the real adapter and answers unknown whenever the script has nothing to say
// (fail closed: no scripted success is ever repeated).
import { judgeQuery, judgeTransfer, type JudgementLists } from '../../application/judgement.ts';
import {
  PayoutBillUnavailableError,
  PayoutModeMustBeDryRunError,
  type ChannelBillLine,
  type ChannelRaw,
  type QueryResult,
  type TransferResult,
} from '../../domain/channel-result.ts';
import type { PayoutChannel, TransferRequest } from './payout-channel.ts';

export type FakeStep =
  | {
      kind: 'response';
      raw: ChannelRaw;
      status?: string;
      channelOrderId?: string;
      paidAt?: string;
    }
  | { kind: 'unknown' }
  | { kind: 'timeout' };

/** B2-07b: demo bills by our app id, then by accounting day (YYYY-MM-DD at +08:00). */
export type FakeBills = Readonly<
  Record<string, Readonly<Record<string, readonly ChannelBillLine[]>>>
>;

export interface FakeChannelOptions {
  mode: 'dry_run' | 'live';
  lists: JudgementLists;
  script: Readonly<Record<string, { transfer?: readonly FakeStep[]; query?: readonly FakeStep[] }>>;
  bills?: FakeBills;
}

export type FakeCall =
  | { kind: 'transfer'; request: TransferRequest }
  | { kind: 'query'; outBizNo: string }
  | { kind: 'bill'; appId: string; billDate: string };

const NO_SCRIPT: ChannelRaw = { code: 'FAKE_NO_SCRIPT' };

export class FakeChannel implements PayoutChannel {
  readonly calls: readonly FakeCall[];
  private readonly log: FakeCall[] = [];
  private readonly lists: JudgementLists;
  private readonly bills: FakeBills;
  private readonly queues = new Map<string, { transfer: FakeStep[]; query: FakeStep[] }>();

  constructor(options: FakeChannelOptions) {
    if (options.mode !== 'dry_run') throw new PayoutModeMustBeDryRunError();
    this.lists = options.lists;
    this.bills = options.bills ?? {};
    this.calls = this.log;
    for (const [outBizNo, steps] of Object.entries(options.script)) {
      this.queues.set(outBizNo, {
        transfer: [...(steps.transfer ?? [])],
        query: [...(steps.query ?? [])],
      });
    }
  }

  private next(outBizNo: string, operation: 'transfer' | 'query'): FakeStep | undefined {
    return this.queues.get(outBizNo)?.[operation].shift();
  }

  transfer(request: TransferRequest): Promise<TransferResult> {
    this.log.push({ kind: 'transfer', request });
    const step = this.next(request.outBizNo, 'transfer');
    if (step === undefined || step.kind === 'unknown') {
      return Promise.resolve({ kind: 'unknown', raw: NO_SCRIPT, latencyMs: 0 });
    }
    if (step.kind === 'timeout') {
      return Promise.reject(new DOMException('fake channel timeout', 'TimeoutError'));
    }
    const judged = judgeTransfer(step.raw, step.status, this.lists);
    const result: TransferResult = { ...judged, latencyMs: 0 };
    if (step.channelOrderId !== undefined) result.channelOrderId = step.channelOrderId;
    if (judged.kind === 'success' && step.paidAt !== undefined) result.paidAt = step.paidAt;
    return Promise.resolve(result);
  }

  query(outBizNo: string): Promise<QueryResult> {
    this.log.push({ kind: 'query', outBizNo });
    const step = this.next(outBizNo, 'query');
    if (step === undefined || step.kind === 'unknown') {
      return Promise.resolve({ kind: 'unknown', raw: NO_SCRIPT });
    }
    if (step.kind === 'timeout') {
      return Promise.reject(new DOMException('fake channel timeout', 'TimeoutError'));
    }
    const result: QueryResult = judgeQuery(step.raw, step.status, this.lists);
    if (step.status !== undefined) result.status = step.status;
    if (step.channelOrderId !== undefined) result.channelOrderId = step.channelOrderId;
    if (result.kind === 'success' && step.paidAt !== undefined) result.paidAt = step.paidAt;
    return Promise.resolve(result);
  }

  /**
   * B2-07b: the injected demo bill of (appId, billDate), unchanged and as often as asked (the next
   * day's run reads a bill again); the call is recorded. A day without an injected bill rejects
   * with PayoutBillUnavailableError; an injected [] is a bill without lines.
   */
  billDetails(appId: string, billDate: string): Promise<readonly ChannelBillLine[]> {
    this.log.push({ kind: 'bill', appId, billDate });
    const days = Object.hasOwn(this.bills, appId) ? this.bills[appId] : undefined;
    const lines = days !== undefined && Object.hasOwn(days, billDate) ? days[billDate] : undefined;
    if (lines === undefined) return Promise.reject(new PayoutBillUnavailableError());
    return Promise.resolve(lines.map((line) => ({ ...line })));
  }
}
