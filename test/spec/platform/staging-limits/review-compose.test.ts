import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { ENTRIES, asset, list, record, services, string } from '../../infra/staging/kit.ts';
import type { Entry, Probe } from './kit.ts';
import { REDIS_URL } from './kit.ts';
import { TLS_DATABASE_URLS, compileProbe } from './review-kit.ts';

async function interpolatedProbe(entry: Entry, healthy: boolean) {
  const health = record(record(services()[entry])['healthcheck']);
  const args = list(health['test']).map(string);
  expect(args.slice(0, 2)).toEqual(['CMD', 'node']);
  const evalIndex = args.findIndex((arg) => arg === '-e' || arg === '--eval');
  expect(evalIndex).toBeGreaterThan(1);
  const source = string(args[evalIndex + 1]);
  // Inline probes must be independent of the deployer's shell environment. Reject single
  // dollars (including ${dir}); consume each $$ exactly once, as Compose does before exec.
  expect(
    source.replace(/\$\$/g, ''),
    'Compose variables in Node code must escape $ as $$',
  ).not.toContain('$');
  const code = source.replace(/\$\$/g, '$');
  const check = vi.fn<Probe>(async () => healthy);
  const fs = {
    readFileSync(path: string) {
      if (path === '/proc/uptime') return '160 0';
      if (path === '/proc/1/stat')
        return `1 (node) ${[...Array<string>(19).fill('0'), '10000'].join(' ')}`;
      if (path === '/tmp/couli-starts') return 'start\n';
      throw new Error(`Unexpected healthcheck file read: ${path}`);
    },
    existsSync(path: string) {
      expect(path).toBe('/tmp/couli-settled');
      return true;
    },
  };
  const exited = Promise.withResolvers<number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<number>((resolve) => {
    timer = setTimeout(() => resolve(-1), 1000);
  });
  try {
    const execution: unknown = runInNewContext(
      `(async () => { ${compileProbe(code)} })()`,
      {
        exports: {},
        require(name: string) {
          if (name === 'node:fs' || name === 'fs') return fs;
          expect(name, 'Compose must load the built health probe after interpolation').toMatch(
            /(?:^|\/)apps\/api\/dist\/modules\/health\/staging-dependencies\.js$/,
          );
          return { checkStagingDependencies: check };
        },
        process: {
          env: {
            DATABASE_URL: TLS_DATABASE_URLS[entry],
            ...(entry === 'worker' ? { REDIS_URL } : {}),
          },
          getBuiltinModule(name: string) {
            expect(name).toBe('node:fs');
            return fs;
          },
          exit(code: number) {
            exited.resolve(code);
          },
        },
        setTimeout,
        clearTimeout,
        AbortSignal,
      },
      { timeout: 1000 },
    );
    const status = await Promise.race([
      exited.promise,
      Promise.resolve(execution).then(() => exited.promise),
      deadline,
    ]);
    expect(status, 'health command must explicitly exit').not.toBe(-1);
    return { status, check };
  } finally {
    clearTimeout(timer);
  }
}

it.each(['worker', 'payout'] as const)(
  '[AC-B1-01zzj-HEALTH#3] %s 的命令经 Compose 转义后仍探依赖并传递带 CA 的连接串',
  async (entry) => {
    for (const healthy of [false, true]) {
      const result = await interpolatedProbe(entry, healthy);
      expect(result.check).toHaveBeenCalledExactlyOnceWith(entry, {
        databaseUrl: TLS_DATABASE_URLS[entry],
        ...(entry === 'worker' ? { redisUrl: REDIS_URL } : {}),
      });
      if (healthy) expect(result.status).toBe(0);
      else expect(result.status).not.toBe(0);
    }
  },
);

it('[AC-B1-01zzj-README#1] 五个进程的资源取值表与 Compose 生效值一致', () => {
  const readme = asset('infra/staging/README.md');
  const rows = readme
    .split(/\r?\n/)
    .filter((line) => /^\s*\|/.test(line))
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => cell.replace(/`/g, '').trim()),
    );
  const keys = ['cpus', 'mem_limit', 'pids_limit'] as const;
  const headerIndex = rows.findIndex((row) => keys.every((key) => row.includes(key)));
  expect(headerIndex, 'README must document all three limits in a table').toBeGreaterThanOrEqual(0);
  const header = rows[headerIndex] ?? [];
  const body: string[][] = [];
  for (const row of rows.slice(headerIndex + 1)) {
    if (row.every((cell) => /^:?-+:?$/.test(cell))) continue;
    if (!row.some((cell) => ENTRIES.some((entry) => cell === entry))) break;
    body.push(row);
  }
  const all = services();
  for (const entry of ENTRIES) {
    const matching = body.filter((row) => row.includes(entry));
    expect(matching, `${entry} must have one row of limits`).toHaveLength(1);
    const row = matching[0] ?? [];
    const service = record(all[entry]);
    for (const key of keys) {
      expect(service[key], `${entry}.${key} must be configured`).toBeDefined();
      const documented = row[header.indexOf(key)];
      expect(documented, `${entry}.${key} must be documented`).toBeDefined();
      if (key === 'mem_limit') {
        expect(documented?.toLowerCase()).toBe(String(service[key]).toLowerCase());
      } else {
        expect(Number(documented)).toBe(Number(service[key]));
      }
    }
  }
});

it('[AC-B1-01zzj-README#2] 说明依赖不通会 unhealthy、payout 不探 Redis，删除旧的误导说明', () => {
  const readme = asset('infra/staging/README.md').replace(/`/g, '');
  const heading = /^#{2,6}[^\n]*依赖不通[^\n]*$/m.exec(readme);
  expect(heading, 'README must explain dependency outages in a dedicated section').not.toBeNull();
  const section =
    readme.slice((heading?.index ?? 0) + (heading?.[0].length ?? 0)).split(/\n#{2,6}\s/)[0] ?? '';
  expect(section).toMatch(/unhealthy/i);
  expect(section).toMatch(/worker[^。\n]*(?:PG|数据库|PostgreSQL)[^。\n]*Redis/i);
  expect(section).toMatch(/payout[^。\n]*(?:PG|数据库|PostgreSQL)/i);
  expect(section).toMatch(/payout[^。\n]*不(?:探测|探|连接|连|依赖|检查|读)\s*Redis/i);
  expect(readme).not.toContain('进程如果卡在等数据库连接而没有退出，这一步也会通过');
  expect(readme).not.toContain('健康检查只能看到「进程只启动过一次、连续活了 30 秒」');
});
