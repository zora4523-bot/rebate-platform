import type { Logger } from 'pino';
import type { Clock } from '../../../platform/index.ts';
import type { JudgementLists } from '../../application/judgement.ts';
import type { QueryResult, TransferResult } from '../../domain/channel-result.ts';
import type { PayoutChannel, TransferRequest } from './payout-channel.ts';

export type ChannelTransport = (
  url: string,
  options: {
    method: 'POST';
    body: string;
    headers: Readonly<Record<string, string>>;
    signal: AbortSignal;
  },
) => Promise<{ status: number; body: string }>;

/** Node built-in fetch uses undici; the signal covers the response body as well. */
export function undiciTransport(
  url: string,
  options: Parameters<ChannelTransport>[1],
): ReturnType<ChannelTransport> {
  void url;
  void options;
  throw new Error('NotImplemented: undiciTransport');
}

export interface AlipayChannelOptions {
  credentials: {
    appId: string;
    privateKey: string;
    alipayPublicKey: string;
    gatewayUrl: string;
    appCertSn?: string;
    alipayRootCertSn?: string;
  };
  bizScene: string;
  lists: JudgementLists;
  clock: Clock;
  logger: Pick<Logger, 'info' | 'warn'>;
  /** Defaults to undiciTransport; tests always inject a transport or mock built-in fetch. */
  transport?: ChannelTransport;
}

/** Credentials are injected; this adapter never reads environment variables or key files. */
export class AlipayChannel implements PayoutChannel {
  constructor(options: AlipayChannelOptions) {
    void options;
    throw new Error('NotImplemented: AlipayChannel');
  }

  transfer(request: TransferRequest): Promise<TransferResult> {
    void request;
    throw new Error('NotImplemented: AlipayChannel.transfer');
  }

  query(outBizNo: string): Promise<QueryResult> {
    void outBizNo;
    throw new Error('NotImplemented: AlipayChannel.query');
  }
}
