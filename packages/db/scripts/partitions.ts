// Ensures the current month and the next MONTHS_AHEAD months exist for every month-partitioned
// table (ADR-0001 §4.2 #4). Idempotent. Run after migrations at deploy time; at runtime the
// worker's scheduled job makes the same calls as couli_maint.
//
//   MIGRATOR_DATABASE_URL=postgres://couli_migrator:...@host:port/couli node scripts/partitions.ts
//
// TODO(ADR-0001 §4.2 #4): the worker's scheduled job (as couli_maint), the alert on rows in a
// DEFAULT partition and the removal of partitions past retention — blocked on B1-01.
import {
  MONTH_PARTITIONED_TABLES,
  MONTHS_AHEAD,
  monthStartDate,
  monthsToEnsure,
} from '../src/partitions.ts';
import { redactPgUrl } from '../src/pg-url.ts';
import { withClient } from '../src/testing/provision.ts';
import { info, main, requireEnv } from './util.ts';

await main(async () => {
  const url = requireEnv(
    'MIGRATOR_DATABASE_URL',
    '它是 couli_migrator（分区函数属主）的连接串；本地直接用 pnpm dev:stack。',
  );
  info(`预建分区：${redactPgUrl(url)}`);
  const months = monthsToEnsure(new Date(), MONTHS_AHEAD);
  await withClient(url, async (client) => {
    for (const table of MONTH_PARTITIONED_TABLES) {
      const names: string[] = [];
      for (const month of months) {
        const result = await client.query<{ name: string }>(
          'SELECT app.ensure_month_partition($1, $2::date) AS name',
          [table, monthStartDate(month)],
        );
        names.push(result.rows[0]?.name ?? '?');
      }
      info(`  ${table}：${names.join('、')}`);
      const stray = await client.query<{ n: string }>(
        // The table name comes from the constant list above, never from input.
        `SELECT count(*) AS n FROM app.${table}_default`,
      );
      if (stray.rows[0]?.n !== '0') {
        info(
          `  警告：app.${table}_default 里有 ${stray.rows[0]?.n ?? '?'} 行，说明曾经缺分区，需要处理。`,
        );
      }
    }
  });
});
