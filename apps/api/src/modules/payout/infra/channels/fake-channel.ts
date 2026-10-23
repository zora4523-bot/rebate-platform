import type { JudgementLists } from '../../application/judgement.ts';
import type { ChannelRaw, QueryResult, TransferResult } from '../../domain/channel-result.ts';
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

export interface FakeChannelOptions {
  mode: 'dry_run' | 'live';
  lists: JudgementLists;
  script: Readonly<Record<string, { transfer?: readonly FakeStep[]; query?: readonly FakeStep[] }>>;
}

export type FakeCall =
  { kind: 'transfer'; request: TransferRequest } | { kind: 'query'; outBizNo: string };

export class FakeChannel implements PayoutChannel {
  readonly calls!: readonly FakeCall[];

  constructor(options: FakeChannelOptions) {
    void options;
    throw new Error('NotImplemented: FakeChannel');
  }

  transfer(request: TransferRequest): Promise<TransferResult> {
    void request;
    throw new Error('NotImplemented: FakeChannel.transfer');
  }

  query(outBizNo: string): Promise<QueryResult> {
    void outBizNo;
    throw new Error('NotImplemented: FakeChannel.query');
  }
}
