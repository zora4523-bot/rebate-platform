import type { RunSink } from '../stream/run/index.ts';

/** Remember a disconnect even if it happens before RunManager registers its listener. */
export function trackSink(raw: RunSink & { end(): void }): RunSink & { end(): void } {
  let closed = false;
  let ended = false;
  const listeners = new Set<() => void>();
  function close(): void {
    if (closed) return;
    closed = true;
    for (const listener of listeners) listener();
    listeners.clear();
  }
  raw.onClose(close);
  return {
    onClose(listener) {
      if (closed) listener();
      else listeners.add(listener);
    },
    write(chunk) {
      // A failed write must stay failed: RunManager uses it to track actual card delivery.
      if (closed || ended) throw new Error('Agent stream closed');
      try {
        raw.write(chunk);
      } catch (error) {
        close();
        throw error;
      }
    },
    end() {
      if (ended) return;
      ended = true;
      listeners.clear();
      if (closed) return;
      try {
        raw.end();
      } catch {
        close();
      }
    },
  };
}
