// [AC-B1-31#5] fail-open bookkeeping of the trace exporter (05 B1-31: traces only for
// troubleshooting): a failed export is counted, reported by at most one warn line a minute
// (`otel_export_failed`, error_name + count), and never thrown into a request or a job.
// [AC-B1-31#10] the warn line carries no error message or stack (an exporter error may quote
// headers or bodies). Unit tests: the clock is a FixedClock, nothing is exported.
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { RootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import { createExportHealth } from '../../../../apps/api/src/modules/platform/tracing/export-health.ts';
import { memoryLogger } from './kit.ts';

const START = '2031-05-06T09:00:00.000Z';

class OTLPExporterError extends Error {
  override name = 'OTLPExporterError';
}

function warnLines(records: ReturnType<ReturnType<typeof memoryLogger>['records']>) {
  return records.filter((record) => record.msg === 'otel_export_failed');
}

it('[AC-B1-31#5] the first failure logs one warn otel_export_failed with error_name and count 1', () => {
  const { logger, records } = memoryLogger('api');
  const health = createExportHealth({ logger, clock: new FixedClock(START) });
  health.recordFailure(new OTLPExporterError('Request Timeout'));
  expect(health.failures()).toBe(1);
  const lines = warnLines(records());
  expect(lines).toHaveLength(1);
  expect(lines[0]?.level).toBe(40);
  expect(lines[0]?.['error_name']).toBe('OTLPExporterError');
  expect(lines[0]?.['count']).toBe(1);
});

it('[AC-B1-31#5] further failures within a minute are only counted; after a minute one more line with the total', () => {
  const { logger, records } = memoryLogger('api');
  const clock = new FixedClock(START);
  const health = createExportHealth({ logger, clock });
  health.recordFailure(new OTLPExporterError('first'));
  for (let i = 0; i < 5; i += 1) {
    clock.advanceMs(10_000);
    health.recordFailure(new TypeError('fetch failed'));
  }
  // 59.999 s after the first line, 7 failures, still one line.
  clock.advanceMs(9_999);
  health.recordFailure(new TypeError('fetch failed'));
  expect(health.failures()).toBe(7);
  expect(warnLines(records())).toHaveLength(1);
  // 60.001 s after the first line: the second line, with the running total.
  clock.advanceMs(2);
  health.recordFailure(new TypeError('fetch failed'));
  const lines = warnLines(records());
  expect(lines).toHaveLength(2);
  expect(lines[1]?.['error_name']).toBe('TypeError');
  expect(lines[1]?.['count']).toBe(8);
  expect(health.failures()).toBe(8);
  // And again at most one in the next minute.
  clock.advanceMs(59_998);
  health.recordFailure(new OTLPExporterError('again'));
  expect(warnLines(records())).toHaveLength(2);
  expect(health.failures()).toBe(9);
});

it('[AC-B1-31#10] the warn line has no error message, stack or error object, whatever was thrown', () => {
  const { logger, lines, records } = memoryLogger('api');
  const clock = new FixedClock(START);
  const health = createExportHealth({ logger, clock });
  const secret = 'Bearer fake-bearer-secret-token-for-test';
  const error = new OTLPExporterError(`401 for authorization: ${secret}`);
  health.recordFailure(error);
  clock.advanceMs(61_000);
  health.recordFailure(`thrown string ${secret}`);
  clock.advanceMs(61_000);
  health.recordFailure({ headers: { authorization: secret } });
  expect(health.failures()).toBe(3);
  const warned = warnLines(records());
  expect(warned).toHaveLength(3);
  for (const line of warned) {
    expect(typeof line['error_name']).toBe('string');
    expect(line).not.toHaveProperty('err');
    expect(line).not.toHaveProperty('error');
    expect(line).not.toHaveProperty('stack');
  }
  expect(lines.join('\n')).not.toContain('fake-bearer-secret-token-for-test');
  expect(lines.join('\n')).not.toContain('401 for authorization');
});

it('[AC-B1-31#5] recordFailure never throws, even when the logger does, and still counts', () => {
  const throwing = {
    warn: () => {
      throw new Error('log sink down');
    },
  } as unknown as RootLogger;
  const clock = new FixedClock(START);
  const health = createExportHealth({ logger: throwing, clock });
  expect(() => health.recordFailure(new OTLPExporterError('x'))).not.toThrow();
  clock.advanceMs(61_000);
  expect(() => health.recordFailure(undefined)).not.toThrow();
  expect(() => health.recordFailure(null)).not.toThrow();
  expect(health.failures()).toBe(3);
});

it('[AC-B1-31#5] no failure, no line', () => {
  const { logger, lines } = memoryLogger('api');
  const health = createExportHealth({ logger, clock: new FixedClock(START) });
  expect(health.failures()).toBe(0);
  expect(lines).toEqual([]);
});
