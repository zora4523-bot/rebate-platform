// Local development stack (ADR-0001 §4.2 #12):
//
//   node scripts/dev-stack.ts up               compose up, bootstrap, migrate, partitions, seed,
//                                              then verify Redis and PostgreSQL settings
//   node scripts/dev-stack.ts down             stop and remove the containers, keep the volume
//   node scripts/dev-stack.ts down --volumes   also delete the data volume
//
// Needs Docker, so it only runs outside the Codex sandbox. MinIO, Prism and WireMock are not
// part of the stack yet (see the TODOs in infra/local/compose.yaml).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT } from '../src/testing/provision.ts';
import {
  APP_DATABASE,
  LOCAL_PG_HOST,
  LOCAL_PG_PORT,
  LOCAL_REDIS_PORT,
  localAdminUrl,
  localRoleUrl,
} from './local-env.ts';
import { cliArgs, fail, info, main } from './util.ts';

const SCRIPTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const COMPOSE_FILE = path.join(REPO_ROOT, 'infra', 'local', 'compose.yaml');

function compose(args: string[], capture = false): string {
  const result = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error !== undefined) {
    fail(`无法运行 docker compose：${result.error.message}。请先启动 Docker Desktop。`);
  }
  if (result.status !== 0) {
    fail(`docker compose ${args.join(' ')} 失败（退出码 ${String(result.status)}）。`);
  }
  return capture ? result.stdout : '';
}

function runScript(name: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, name)], {
    stdio: 'inherit',
    env,
  });
  if (result.status !== 0) {
    fail(
      `${name} 失败（退出码 ${String(result.status)}），本地栈保持运行，修好后可重跑 pnpm dev:stack。`,
    );
  }
}

function up(): void {
  const appEnv = process.env['APP_ENV'] ?? 'local';
  if (appEnv !== 'local') {
    fail(`dev:stack 只用于本地开发，当前 APP_ENV=${appEnv}。`);
  }

  info('启动本地栈（compose 项目 couli-local）…');
  compose(['up', '-d', '--wait']);

  // The local stack always uses its own URLs: whatever the shell has in PG_ADMIN_URL or
  // MIGRATOR_DATABASE_URL (another environment, perhaps) must not leak into these steps.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_ENV: 'local',
    PG_ADMIN_URL: localAdminUrl(),
    MIGRATOR_DATABASE_URL: localRoleUrl('couli_migrator'),
  };
  runScript('bootstrap.ts', env);
  runScript('migrate.ts', env);
  runScript('partitions.ts', env);
  runScript('seed.ts', env);

  const policy = compose(
    ['exec', '-T', 'redis', 'redis-cli', 'config', 'get', 'maxmemory-policy'],
    true,
  )
    .trim()
    .split('\n')
    .at(-1);
  if (policy !== 'noeviction') {
    fail(
      `Redis 的 maxmemory-policy 是 ${policy ?? '?'}，应为 noeviction（ADR-0001 §4.2 第 17 项）。`,
      1,
    );
  }
  const maxmemory = compose(
    ['exec', '-T', 'redis', 'redis-cli', 'config', 'get', 'maxmemory'],
    true,
  )
    .trim()
    .split('\n')
    .at(-1);
  if (maxmemory === undefined || !/^[1-9]\d*$/.test(maxmemory)) {
    fail(`Redis 没有设置 maxmemory（读到 ${maxmemory ?? '?'}）。`, 1);
  }
  const versionNum = compose(
    [
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      APP_DATABASE,
      '-Atc',
      'SHOW server_version_num',
    ],
    true,
  ).trim();
  const major = Math.floor(Number(versionNum) / 10_000);
  if (major !== 18) {
    fail(`PostgreSQL 主版本是 ${String(major)}（server_version_num=${versionNum}），应为 18。`, 1);
  }

  info(
    [
      '',
      '本地栈已就绪：',
      `  PostgreSQL ${String(major)}（server_version_num=${versionNum}）  ${LOCAL_PG_HOST}:${String(LOCAL_PG_PORT)}，库 ${APP_DATABASE}`,
      `  Redis  ${LOCAL_PG_HOST}:${String(LOCAL_REDIS_PORT)}，maxmemory-policy=${policy}，maxmemory=${maxmemory} 字节`,
      `  DATABASE_URL=postgres://couli_app:<COULI_DB_LOCAL_PASSWORD>@${LOCAL_PG_HOST}:${String(LOCAL_PG_PORT)}/${APP_DATABASE}`,
      `  DATABASE_READ_URL=postgres://couli_readonly:<COULI_DB_LOCAL_PASSWORD>@${LOCAL_PG_HOST}:${String(LOCAL_PG_PORT)}/${APP_DATABASE}（admin 入口必填）`,
      `  DATABASE_MAINT_URL=postgres://couli_maint:<COULI_DB_LOCAL_PASSWORD>@${LOCAL_PG_HOST}:${String(LOCAL_PG_PORT)}/${APP_DATABASE}（worker 入口读取）`,
      `  REDIS_URL=redis://${LOCAL_PG_HOST}:${String(LOCAL_REDIS_PORT)}`,
      '  停止：pnpm dev:stack:down（保留数据）',
    ].join('\n'),
  );
}

function down(volumes: boolean): void {
  compose(['down', '--remove-orphans', ...(volumes ? ['--volumes'] : [])]);
  info(volumes ? '本地栈已停止，数据卷已删除。' : '本地栈已停止，数据卷保留。');
}

await main(() => {
  const [command, ...rest] = cliArgs();
  const unknown = rest.filter((arg) => arg !== '--volumes');
  if (
    (command !== 'up' && command !== 'down') ||
    unknown.length > 0 ||
    (command === 'up' && rest.length > 0)
  ) {
    fail('用法：dev-stack.ts up | down [--volumes]');
  }
  if (command === 'up') {
    up();
  } else {
    down(rest.includes('--volumes'));
  }
});
