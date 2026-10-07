import type { Scheduler } from '../../../platform/index.ts';
import { ModelProtocolError } from '../openai-compat/index.ts';

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
    const stop = (kind: 'aborted' | 'timeout'): void => {
      if (settled) return;
      const error = new ModelProtocolError(kind, 'Model attempt interrupted');
      // 先定终态，再通知传输，避免传输的 abort 回调改变结果。
      finish(() => reject(error));
      upstream.abort(error);
    };
    const cancel = (): void => stop('aborted');
    const timeout = (): void => stop(callerSignal.aborted ? 'aborted' : 'timeout');
    const accept = (settle: () => void): void => {
      if (callerSignal.aborted) cancel();
      else if (governorSignal.aborted || scheduler.now() >= deadline) timeout();
      else finish(settle);
    };
    if (callerSignal.aborted) return cancel();
    if (governorSignal.aborted || remainingMs <= 0) return timeout();
    governorSignal.addEventListener('abort', timeout, { once: true });
    callerSignal.addEventListener('abort', cancel, { once: true });
    if (Number.isFinite(remainingMs)) {
      void scheduler.sleep(remainingMs, timer.signal).then(timeout, (error: unknown) => {
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
