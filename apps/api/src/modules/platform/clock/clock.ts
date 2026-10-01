// Process clock (ADR-0001 §4.2 #10). Application code reads time only through `Clock`.
// This directory is the only place in apps/api allowed to call `new Date()` / `Date.now()`.
// Overriding the clock per request (through a header) is not supported.

export interface Clock {
  now(): Date;
}

/** Nest injection token for the process `Clock`. */
export const CLOCK = Symbol('CLOCK');

/** Real wall-clock time. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Milliseconds from a monotonic source (unaffected by wall-clock adjustments). */
export type MonotonicMs = () => number;

const hrtimeMs: MonotonicMs = () => Number(process.hrtime.bigint() / 1_000_000n);

/**
 * Starts at a given instant and advances with real elapsed time (CLOCK_NOW semantics:
 * process clock = that instant + time elapsed since the clock was created).
 */
export class OffsetClock implements Clock {
  private readonly startEpochMs: number;
  private readonly startedAtMs: number;
  private readonly monotonicMs: MonotonicMs;

  constructor(start: Date, monotonicMs: MonotonicMs = hrtimeMs) {
    const startEpochMs = start.getTime();
    if (Number.isNaN(startEpochMs)) throw new Error('OffsetClock: start is not a valid instant');
    this.startEpochMs = startEpochMs;
    this.monotonicMs = monotonicMs;
    this.startedAtMs = monotonicMs();
  }

  now(): Date {
    return new Date(this.startEpochMs + (this.monotonicMs() - this.startedAtMs));
  }
}

/** Test clock: returns the same instant until it is moved explicitly. */
export class FixedClock implements Clock {
  private epochMs: number;

  constructor(instant: Date | string) {
    this.epochMs = FixedClock.toEpochMs(instant);
  }

  now(): Date {
    return new Date(this.epochMs);
  }

  set(instant: Date | string): void {
    this.epochMs = FixedClock.toEpochMs(instant);
  }

  advanceMs(deltaMs: number): void {
    if (!Number.isFinite(deltaMs)) throw new Error('FixedClock: deltaMs must be finite');
    this.epochMs += deltaMs;
  }

  private static toEpochMs(instant: Date | string): number {
    const epochMs = new Date(instant).getTime();
    if (Number.isNaN(epochMs)) throw new Error('FixedClock: not a valid instant');
    return epochMs;
  }
}

/**
 * `clockNow` unset: real time. Set (already validated as an ISO-8601 instant with offset by
 * the config schema, and refused in prod by the startup assertions): offset clock.
 */
export function clockFromConfig(
  config: { readonly clockNow: string | undefined },
  monotonicMs?: MonotonicMs,
): Clock {
  if (config.clockNow === undefined) return new SystemClock();
  return new OffsetClock(new Date(config.clockNow), monotonicMs);
}
