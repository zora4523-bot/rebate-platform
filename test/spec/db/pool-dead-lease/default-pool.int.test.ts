import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Report, Request } from './child.ts';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

function checkScenario(max: 1 | 2): void {
  const request: Request = {
    url: database.urlFor('couli_app'),
    applicationName: `b1-01zzc-${randomUUID()}`,
    max,
  };
  const result = spawnSync(
    process.execPath,
    ['--conditions=couli-src', fileURLToPath(new URL('./child.ts', import.meta.url))],
    {
      input: JSON.stringify(request),
      encoding: 'utf8',
      timeout: 50_000,
      killSignal: 'SIGKILL',
      // No inherited NODE_OPTIONS, PG settings or installed process exception handlers.
      env: {},
    },
  );
  if (result.error !== undefined) throw result.error;
  const lines = result.stdout.split('\n');
  const fatal = lines.find((line) => line.startsWith('B1-01zzc-fatal:'));
  if (fatal !== undefined) {
    const details = JSON.parse(fatal.slice('B1-01zzc-fatal:'.length)) as {
      name: string;
      message: string;
    };
    const error = new Error(details.message);
    error.name = details.name;
    throw error;
  }
  const diagnostic = `status=${String(result.status)}, signal=${String(result.signal)}\n${result.stderr}\n${result.stdout}`;
  expect(result.signal, diagnostic).toBeNull();
  expect(result.status, diagnostic).toBe(0);
  expect(result.stderr, diagnostic).not.toMatch(
    /Unhandled 'error' event|triggerUncaughtException|throw er; \/\/ Unhandled/,
  );
  const reports = lines.filter((line) => line.startsWith('B1-01zzc-result:'));
  expect(reports, diagnostic).toHaveLength(1);
  const report = JSON.parse(reports[0]!.slice('B1-01zzc-result:'.length)) as Report;
  expect(report.lease).toStrictEqual({
    deadPid: expect.any(Number),
    bigintBefore: true,
    queryError: {
      name: 'error',
      message: expect.any(String),
      code: '57P01',
      severity: 'FATAL',
    },
  });
  expect(report.lease.deadPid).toBeGreaterThan(0);
  expect(report.factories).toStrictEqual([
    {
      poolListeners: 0,
      clientListeners: 0,
      originalListenersPreserved: true,
      ownedCalls: 0,
      sameBackend: true,
      bigint: true,
    },
    {
      poolListeners: 1,
      clientListeners: 1,
      originalListenersPreserved: true,
      ownedCalls: 2,
      sameBackend: true,
      bigint: true,
    },
  ]);
  // Infrastructure/programming errors must not masquerade as the desired assertion red.
  if (
    report.recovery.error !== null &&
    (report.recovery.error.name !== 'Error' ||
      !/connection|client|socket/i.test(report.recovery.error.message))
  ) {
    const error = new Error(report.recovery.error.message);
    error.name = report.recovery.error.name;
    throw error;
  }
  expect(report.recovery.error, '归还死连接后，同池首次及后续查询都应成功').toBeNull();
  expect(report.recovery.facts).toStrictEqual({
    sequential: Array.from({ length: max + 1 }, () => 1),
    concurrent: Array.from({ length: max * 2 + 1 }, () => 1),
    distinctSlots: max,
    allBackendsLive: true,
    deadBackendReused: false,
    deadBackendPresent: false,
    withinMax: true,
    bigint: true,
  });
}

it('[AC-B1-01zzc#1] max=1：自终止查询的 FATAL 被捕获后正常归还，首次及后续查询成功，进程存活、工厂与 BigInt 不变', () => {
  checkScenario(1);
});

it('[AC-B1-01zzc#2] max=2：自终止查询的 FATAL 被捕获后正常归还，首次查询及所有槽位可用，进程存活、工厂与 BigInt 不变', () => {
  checkScenario(2);
});
