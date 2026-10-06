import type { WhitescreenReport } from './index.ts';

/** TODO(规划/11 §5.1): Connect the approved reporting channel — blocked on Sentry / analytics approval. */
export function defaultReport(event: WhitescreenReport): void {
  void event;
  throw new Error('NotImplemented: defaultReport');
}
