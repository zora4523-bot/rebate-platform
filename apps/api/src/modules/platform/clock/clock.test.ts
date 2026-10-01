import { describe, expect, it } from 'vitest';
import { FixedClock, OffsetClock, SystemClock, clockFromConfig } from './clock.ts';

describe('OffsetClock', () => {
  it('starts at the given instant and advances with the monotonic source', () => {
    let monotonic = 5_000;
    const clock = new OffsetClock(new Date('2026-10-31T15:59:59.999Z'), () => monotonic);
    expect(clock.now().toISOString()).toBe('2026-10-31T15:59:59.999Z');
    monotonic += 1;
    expect(clock.now().toISOString()).toBe('2026-10-31T16:00:00.000Z');
    monotonic += 86_400_000;
    expect(clock.now().toISOString()).toBe('2026-11-01T16:00:00.000Z');
  });

  it('does not depend on the wall clock: equal monotonic readings give equal instants', () => {
    const clock = new OffsetClock(new Date('2020-02-29T00:00:00Z'), () => 42);
    expect(clock.now().getTime()).toBe(clock.now().getTime());
    expect(clock.now().toISOString()).toBe('2020-02-29T00:00:00.000Z');
  });

  it('with the default source never goes backwards and stays near the start instant', () => {
    const start = new Date('2030-01-01T00:00:00Z');
    const clock = new OffsetClock(start);
    const first = clock.now().getTime();
    const second = clock.now().getTime();
    expect(first).toBeGreaterThanOrEqual(start.getTime());
    expect(second).toBeGreaterThanOrEqual(first);
    expect(second - start.getTime()).toBeLessThan(60_000);
  });

  it('rejects an invalid start instant', () => {
    expect(() => new OffsetClock(new Date('not a date'))).toThrow(/valid instant/);
  });
});

describe('FixedClock', () => {
  it('returns the same instant until moved, as a fresh Date each time', () => {
    const clock = new FixedClock('2026-10-01T04:00:00.000Z');
    const first = clock.now();
    first.setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe('2026-10-01T04:00:00.000Z');
    clock.advanceMs(1_500);
    expect(clock.now().toISOString()).toBe('2026-10-01T04:00:01.500Z');
    clock.set(new Date('2026-11-01T00:00:00+08:00'));
    expect(clock.now().toISOString()).toBe('2026-10-31T16:00:00.000Z');
  });

  it('rejects invalid input', () => {
    expect(() => new FixedClock('yesterday')).toThrow(/valid instant/);
    expect(() => new FixedClock('2026-10-01T00:00:00Z').advanceMs(Number.NaN)).toThrow(/finite/);
  });
});

describe('clockFromConfig', () => {
  it('uses the system clock when CLOCK_NOW is unset', () => {
    const clock = clockFromConfig({ clockNow: undefined });
    expect(clock).toBeInstanceOf(SystemClock);
    const before = Date.now();
    const now = clock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now - before).toBeLessThan(60_000);
  });

  it('starts an offset clock at the CLOCK_NOW instant, honouring its offset', () => {
    let monotonic = 0;
    const clock = clockFromConfig({ clockNow: '2026-10-01T12:00:00+08:00' }, () => monotonic);
    expect(clock).toBeInstanceOf(OffsetClock);
    expect(clock.now().toISOString()).toBe('2026-10-01T04:00:00.000Z');
    monotonic = 250;
    expect(clock.now().toISOString()).toBe('2026-10-01T04:00:00.250Z');
  });
});
