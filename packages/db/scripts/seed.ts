// Applies db/seeds/*.sql in file-name order as couli_migrator, each file in its own
// transaction. Seeds must be re-runnable (see db/seeds/README.md).
//
//   MIGRATOR_DATABASE_URL=postgres://couli_migrator:...@host:port/couli node scripts/seed.ts
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { redactPgUrl } from '../src/pg-url.ts';
import { DB_DIR, withClient } from '../src/testing/provision.ts';
import { info, main, requireEnv } from './util.ts';

await main(async () => {
  const seedsDir = path.join(DB_DIR, 'seeds');
  const files = readdirSync(seedsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  if (files.length === 0) {
    info('db/seeds 下还没有种子文件，跳过（见 db/seeds/README.md）。');
    return;
  }
  const url = requireEnv(
    'MIGRATOR_DATABASE_URL',
    '它是 couli_migrator 的连接串；本地直接用 pnpm dev:stack。',
  );
  info(`执行种子：${redactPgUrl(url)}`);
  await withClient(url, async (client) => {
    for (const name of files) {
      const sql = readFileSync(path.join(seedsDir, name), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`seed ${name} failed`, { cause: error });
      }
      info(`  已执行 ${name}`);
    }
  });
});
