// Applies pending migrations from db/migrations as couli_migrator (node-pg-migrate, one
// transaction, table public.pgmigrations).
//
//   MIGRATOR_DATABASE_URL=postgres://couli_migrator:...@host:port/couli node scripts/migrate.ts
import { redactPgUrl } from '../src/pg-url.ts';
import { runMigrations } from '../src/testing/provision.ts';
import { info, main, requireEnv } from './util.ts';

await main(async () => {
  const url = requireEnv(
    'MIGRATOR_DATABASE_URL',
    '它是 couli_migrator 的连接串；本地直接用 pnpm dev:stack，或设为 ' +
      'postgres://couli_migrator:<COULI_DB_LOCAL_PASSWORD>@127.0.0.1:54329/couli。',
  );
  info(`执行迁移：${redactPgUrl(url)}`);
  const applied = await runMigrations(url, (message) => {
    info(`  ${message}`);
  });
  info(
    applied.length === 0
      ? '没有待执行的迁移。'
      : `已执行 ${String(applied.length)} 个迁移：${applied.join('、')}`,
  );
});
