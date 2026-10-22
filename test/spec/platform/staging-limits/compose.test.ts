import { expect, it } from 'vitest';
import {
  ENTRIES,
  asset,
  envFiles,
  record,
  services,
  sourceLines,
  string,
} from '../../infra/staging/kit.ts';
import { DATABASE_URLS, REDIS_URL, composeProbe } from './kit.ts';

function limits(service: Record<string, unknown>): void {
  // No allocation numbers are invented here: the implementation records measured capacity
  // and its allocation in README. Require effective service-level caps, not reservations.
  const cpus = service['cpus'];
  expect(typeof cpus === 'number' || typeof cpus === 'string').toBe(true);
  expect(String(cpus)).toMatch(/^(?:\d+(?:\.\d+)?|\.\d+)$/);
  expect(Number.isFinite(Number(cpus))).toBe(true);
  expect(Number(cpus)).toBeGreaterThan(0);
  const memory = String(service['mem_limit']);
  expect(memory).toMatch(/^\d+(?:\.\d+)?(?:[bkmg](?:b)?)?$/i);
  expect(Number.parseFloat(memory)).toBeGreaterThan(0);
  expect(Number.isSafeInteger(service['pids_limit'])).toBe(true);
  expect(service['pids_limit']).toBeGreaterThan(0);
}

it.each(ENTRIES)('[AC-B1-01zzj-LIMIT#1] %s 有 CPU、内存和 PID 硬上限', (entry) => {
  limits(record(services()[entry]));
});

it.each(['worker', 'payout'] as const)(
  '[AC-B1-01zzj-HEALTH#1] %s 的实际 Compose 命令将依赖故障映射到非零退出码',
  async (entry) => {
    for (const settled of [false, true]) {
      const result = await composeProbe(entry, false, { age: 60, starts: 1, settled });
      expect(result.status, '存活时间和 settled 标记均不能掩盖依赖故障').not.toBe(0);
      expect(result.check).toHaveBeenCalledExactlyOnceWith(entry, {
        databaseUrl: DATABASE_URLS[entry],
        ...(entry === 'worker' ? { redisUrl: REDIS_URL } : {}),
      });
    }
    const service = record(services()[entry]);
    expect(service['restart']).toBe('unless-stopped');
    expect(envFiles(service['env_file'])).toEqual([
      entry === 'payout' ? '/etc/couli/staging-payout.env' : '/etc/couli/staging.env',
    ]);
    const health = record(service['healthcheck']);
    expect(string(health['timeout'])).toMatch(/^[1-9]\d*(?:ms|s)$/);
    expect(health['retries']).toBeGreaterThan(0);
  },
);

it.each(['worker', 'payout'] as const)(
  '[AC-B1-01zzj-HEALTH#2] %s 依赖恢复后可健康，但仍保留 30 秒和首次启动保护',
  async (entry) => {
    const healthy = await composeProbe(entry, true);
    expect(healthy.check).toHaveBeenCalledOnce();
    expect(healthy.status).toBe(0);
    const young = await composeProbe(entry, true, { age: 29, starts: 1, settled: false });
    expect(young.status).not.toBe(0);
    const restarted = await composeProbe(entry, true, { age: 60, starts: 2, settled: false });
    expect(restarted.status).not.toBe(0);
    const settled = await composeProbe(entry, true, { age: 60, starts: 2, settled: true });
    expect(settled.status).toBe(0);
    expect(settled.check).toHaveBeenCalledOnce();
    const settledYoung = await composeProbe(entry, true, { age: 29, starts: 2, settled: true });
    expect(settledYoung.status).not.toBe(0);
  },
);

it('[AC-B1-01zzj-DEPLOY#1] 带资源上限的五个服务仍在迁移完成后统一重建', () => {
  const all = services();
  expect(Object.keys(all).sort()).toEqual([...ENTRIES].sort());
  for (const entry of ENTRIES) limits(record(all[entry]));
  // Preserve the existing direct-shell deployment contract; never execute deploy.sh here.
  // The pre-existing staging/deploy.test.ts covers its migration failure and rollback gates.
  const lines = sourceLines(asset('infra/staging/deploy.sh'));
  const migration = lines.findIndex((line) =>
    /^docker\s+run\b.*\bnode\s+packages\/db\/scripts\/migrate\.ts$/.test(line),
  );
  expect(migration).toBeGreaterThanOrEqual(0);
  const switches = lines.flatMap((line, index) =>
    /\bdocker\s+compose\b.*\bup\b/.test(line) ? [{ line, index }] : [],
  );
  expect(switches.length).toBeGreaterThan(0);
  for (const { line, index } of switches) {
    expect(index).toBeGreaterThan(migration);
    expect(line).toContain('--force-recreate');
    expect(line).toContain('--wait');
    expect(line).not.toMatch(/(?:^|\s)(?:api|stream|worker|admin|payout)(?:\s|$)/);
    expect(line).not.toMatch(/--no-recreate|--no-start/);
  }
});
