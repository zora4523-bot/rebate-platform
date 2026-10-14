// B1-01zp §9: exercise the public createDb API against real PostgreSQL, without mocks
// or default-pool instrumentation. All cases must be red on the original implementation
// because an unhandled client/pool error terminates the plain Node child.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Request, Scenario } from './child.ts';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

function checkScenario(scenario: Scenario): void {
  const request: Request = {
    scenario,
    url: database.urlFor('couli_app'),
    applicationName: `b1-01zp-${scenario}-${randomUUID().slice(0, 12)}`,
  };
  const result = spawnSync(
    process.execPath,
    ['--conditions=couli-src', fileURLToPath(new URL('./child.ts', import.meta.url))],
    {
      input: JSON.stringify(request),
      encoding: 'utf8',
      timeout: 50_000,
      killSignal: 'SIGKILL',
      // Do not inherit NODE_OPTIONS (which could install an exception handler) or PG
      // settings. The child only receives the disposable couli_app URL over stdin.
      env: {},
    },
  );
  const diagnostic = `child status=${String(result.status)}, signal=${String(result.signal)}\n${result.stderr}\n${result.stdout}`;
  expect(result.error, diagnostic).toBeUndefined();
  expect(result.signal, diagnostic).toBeNull();
  expect(result.status, diagnostic).toBe(0);
  // Logging is unconstrained; only Node's fatal exception diagnostics are forbidden.
  expect(result.stderr, diagnostic).not.toMatch(
    /Unhandled 'error' event|triggerUncaughtException|throw er; \/\/ Unhandled/,
  );
  const reports = result.stdout.split('\n').filter((line) => line.startsWith('B1-01zp-result:'));
  expect(reports, diagnostic).toHaveLength(1);
  const report: unknown = JSON.parse(reports[0]!.slice('B1-01zp-result:'.length));
  expect(report, diagnostic).toStrictEqual({
    scenario,
    factories: [
      {
        before: 0,
        afterCreate: 0,
        afterQuery: 0,
        originalListenerPreserved: true,
        bigint: true,
      },
      {
        before: 1,
        afterCreate: 1,
        afterQuery: 1,
        originalListenerPreserved: true,
        bigint: true,
      },
    ],
    bigintBefore: true,
    terminated: true,
    backendGone: true,
    victimRejected: scenario !== 'idle',
    otherQueryUnaffected: scenario === 'active',
    recovery: {
      nextSucceeded: true,
      nextUsesLiveBackend: true,
      concurrentValues: [1, 1],
      distinctBackends: 2,
      deadBackendReused: false,
      withinMax: true,
      deadBackendPresent: false,
      bigint: true,
    },
    destroyed: true,
    closedSessionsGone: true,
  });
}

it('[AC-B1-01zp#1] 借出连接查询中断开：错误拒绝且进程存活，另一条进行中的查询成功；同一实例恢复两条连接、BigInt 与工厂监听不变、正常关闭', () => {
  checkScenario('active');
});

it('[AC-B1-01zp#2] 空闲连接断开：进程存活、坏连接被丢弃；同一实例恢复两条连接、BigInt 与工厂监听不变、正常关闭', () => {
  checkScenario('idle');
});

it('[AC-B1-01zp#3] 连接借出且两次查询之间断开：客户端错误不崩溃、后续查询拒绝；同一实例恢复两条连接、BigInt 与工厂监听不变、正常关闭', () => {
  checkScenario('borrowed');
});
