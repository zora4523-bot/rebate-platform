import type { Scheduler } from '../../../platform/index.ts';
import { ModelProtocolError } from '../openai-compat/index.ts';

/** run 剩余时限耗尽不是厂商故障，不计入条目熔断。 */
export class RunDeadlineError extends ModelProtocolError {
  constructor() {
    super('timeout', 'Run model time budget exhausted');
    this.name = 'RunDeadlineError';
  }
}

/** Governor 管单次时限；这里补上调用方取消与更短的 run 剩余时限。 */
export function withinRun<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  governorSignal: AbortSignal,
  callerSignal: AbortSignal,
  scheduler: Scheduler,
  remainingMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const upstream = new AbortController();
    const timer = new AbortController();
    const deadline = scheduler.now() + remainingMs;
    let settled = false;
    const cleanup = (): void => {
      governorSignal.removeEventListener('abort', timeout);
      callerSignal.removeEventListener('abort', cancel);
      timer.abort();
    };
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      settle();
    };
    const stop = (kind: 'aborted' | 'timeout', runDeadline = false): void => {
      if (settled) return;
      const error = runDeadline
        ? new RunDeadlineError()
        : new ModelProtocolError(kind, 'Model attempt interrupted');
      // 先定终态，再通知传输，避免传输的 abort 回调改变结果。
      finish(() => reject(error));
      upstream.abort(error);
    };
    const cancel = (): void => stop('aborted');
    const timeout = (): void => stop(callerSignal.aborted ? 'aborted' : 'timeout');
    const runTimeout = (): void => {
      if (callerSignal.aborted) cancel();
      else stop('timeout', true);
    };
    const accept = (settle: () => void): void => {
      if (callerSignal.aborted) cancel();
      else if (scheduler.now() >= deadline) runTimeout();
      else if (governorSignal.aborted) timeout();
      else finish(settle);
    };
    if (callerSignal.aborted) return cancel();
    if (remainingMs <= 0) return runTimeout();
    if (governorSignal.aborted) return timeout();
    governorSignal.addEventListener('abort', timeout, { once: true });
    callerSignal.addEventListener('abort', cancel, { once: true });
    if (Number.isFinite(remainingMs)) {
      void scheduler.sleep(remainingMs, timer.signal).then(runTimeout, (error: unknown) => {
        if (!settled) {
          finish(() => reject(error));
          upstream.abort();
        }
      });
    }
    try {
      // 两个分支均挂处理器：不响应取消的端口也不会制造未处理的迟到拒绝。
      void operation(upstream.signal).then(
        (value) => accept(() => resolve(value)),
        (error: unknown) => accept(() => reject(error)),
      );
    } catch (error) {
      accept(() => reject(error));
    }
  });
}
