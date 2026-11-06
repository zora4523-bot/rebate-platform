// B2-12f skeleton (test phase; NotImplemented only): the worker entry's generation of the BR-FUND-12
// bad debt write-off candidates (application/bad-debt-writeoff.ts, conventions there). app.module
// calls forWorker once, on the worker entry only, and hands in identity's and content's ports.
import type { DynamicModule } from '@nestjs/common';
import type { BadDebtWriteoffPorts } from './application/bad-debt-writeoff.ts';

/** What app.module hands in on the worker entry. */
export interface LedgerBadDebtWriteoffWorkerOptions {
  readonly ports: BadDebtWriteoffPorts;
}

export class LedgerBadDebtWriteoffModule {
  static forWorker(options: LedgerBadDebtWriteoffWorkerOptions): DynamicModule {
    void options;
    throw new Error('NotImplemented: LedgerBadDebtWriteoffModule.forWorker');
  }
}
