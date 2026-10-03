// Rule tests: a connection the server ends never crashes the process (ADR-0001 §4.2 第 11 项;
// ADR-0002 §5「切换时旧主库上的连接被强制断开……出错后重建连接」; 规划/02 §14 PostgreSQL 主库一行
// 「各进程断线后自动重连」; contract section 5 of apps/api/src/modules/platform/db/index.ts).
// Each entry runs in a plain Node child process (child.ts), where an unheard 'error' event ends
// the process: the child must exit 0 with exactly one JSON reply on stdout and nothing on
// stderr, the log lines must be exactly one `db_pool_error` per ended session, and the child must
// exit promptly after closing (no timer or socket left behind). Top-level it() only (规划/11 §4.3).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ChildReply, ChildRequest } from './child.ts';
import { ENTRIES, envFor, line, reduceLine, type Entry } from './kit.ts';

const CHILD = fileURLToPath(new URL('./child.ts', import.meta.url));

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

function runChild(request: ChildRequest): {
  status: number | null;
  signal: string | null;
  stderr: string;
  stdout: string;
  wallMs: number;
} {
  const began = performance.now();
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const result = spawnSync(process.execPath, ['--conditions=couli-src', CHILD], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: 45_000,
    env,
  });
  return {
    status: result.status,
    signal: result.signal,
    stderr: result.stderr,
    stdout: result.stdout,
    wallMs: performance.now() - began,
  };
}

for (const entry of ENTRIES) {
  const handles = entry === 'admin' ? ['db', 'dbRead'] : ['db'];
  it(`[ADR-0001 §4.2 #11; ADR-0002 §5; 规划/02 §14] ${entry}：服务端结束会话（${handles.join('、')} 各一次在池中空闲时、一次在事务中两条查询之间）进程不退出；每次确切一行 error db_pool_error（pool、code 57P01），不带错误对象与口令；之后的查询换新连接照常；事务被拒绝；关闭后进程及时退出`, () => {
    const role = entry === 'payout' ? 'couli_payout' : 'couli_app';
    const request: ChildRequest = {
      entry,
      env: envFor(entry as Entry, {
        DATABASE_URL: database.urlFor(role),
        DATABASE_READ_URL: database.urlFor('couli_readonly'),
        REDIS_URL: 'redis://127.0.0.1:1/0',
      }),
      killers: {
        db: database.urlFor(role),
        dbRead: entry === 'admin' ? database.urlFor('couli_readonly') : null,
      },
    };
    const result = runChild(request);
    let reply: ChildReply | string;
    try {
      reply = JSON.parse(result.stdout) as ChildReply;
    } catch {
      reply = `stdout is not JSON: ${result.stdout}`;
    }
    const seen =
      typeof reply === 'string' || 'error' in reply
        ? { reply }
        : {
            lines: reply.lines.map((raw) => reduceLine(raw, reply.pid)),
            steps: reply.steps,
            exitedPromptly: result.wallMs - reply.uptimeMs < 2500,
          };
    const steps = {
      idle: 'new connection',
      transaction: 'rejected',
      afterTransaction: 'new connection',
    };
    expect({
      status: result.status,
      signal: result.signal,
      stderr: result.stderr,
      stdoutIsOneReply: typeof reply !== 'string' && JSON.stringify(reply) === result.stdout,
      ...seen,
    }).toStrictEqual({
      status: 0,
      signal: null,
      stderr: '',
      stdoutIsOneReply: true,
      lines: handles.flatMap((pool) => [
        line(entry as Entry, 'error', { pool, code: '57P01' }, 'db_pool_error'),
        line(entry as Entry, 'error', { pool, code: '57P01' }, 'db_pool_error'),
      ]),
      steps: Object.fromEntries(handles.map((pool) => [pool, steps])),
      exitedPromptly: true,
    });
  });
}
