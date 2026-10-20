import { sql } from 'kysely';
import { expect, it } from 'vitest';

import {
  TABLES,
  TOTALS,
  columns,
  harness,
  insert,
  ready,
  recon,
  snapshot,
  sqlState,
} from './kit.ts';

const h = harness();

it('[AC-B2-04b#21] couli_app 仅有读、插入和更新所需权限，无删除或管理权限', async () => {
  await ready(h.app);
  const identity =
    await sql`SELECT current_user, current_setting('is_superuser') AS superuser`.execute(h.app);
  expect(identity.rows).toEqual([{ current_user: 'couli_app', superuser: 'off' }]);
  for (const table of TABLES) {
    for (const privilege of ['SELECT', 'INSERT', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      const granted = ['SELECT', 'INSERT'].includes(privilege);
      const result =
        await sql`SELECT has_table_privilege('couli_app', ${`app.${table}`}, ${privilege}) AS granted`.execute(
          h.app,
        );
      expect(result.rows, `${table}/${privilege}`).toEqual([{ granted }]);
    }
    for (const { name } of await columns(h.app, table)) {
      for (const privilege of ['SELECT', 'INSERT', 'REFERENCES']) {
        const column =
          await sql`SELECT has_column_privilege('couli_app', ${`app.${table}`}, ${name}, ${privilege}) AS granted`.execute(
            h.app,
          );
        expect(column.rows, `${table}/${name}/${privilege}`).toEqual([
          { granted: privilege !== 'REFERENCES' },
        ]);
      }
    }
    const mutable =
      table === 'recon_diffs'
        ? ['status', 'handler_id', 'closed_at', 'dedupe_key', 'resolution']
        : ['waiting_comparable'];
    const amounts =
      table === 'recon_diffs'
        ? ['expected_fen', 'actual_fen', 'diff_fen']
        : [...TOTALS, 'union_receivable_fen'];
    // 不限定整表 UPDATE 的授权形式，只检查各列的最终有效权限。
    for (const name of [...mutable, ...amounts]) {
      const result =
        await sql`SELECT has_column_privilege('couli_app', ${`app.${table}`}, ${name}, 'UPDATE') AS granted`.execute(
          h.app,
        );
      expect(result.rows, `${table}/${name}/UPDATE`).toEqual([{ granted: mutable.includes(name) }]);
    }
  }
});

it('[AC-B2-04b#22] 应用账号实际 DELETE、TRUNCATE、ALTER 均被拒绝且原数据保留', async () => {
  await ready(h.app);
  for (const [table, row] of [
    ['recon_diffs', recon()],
    ['asset_snapshots', snapshot()],
  ] as const) {
    expect(await sqlState(insert(h.app, table, row))).toBe('ok');
    expect(
      await sqlState(
        sql`DELETE FROM ${sql.table(`app.${table}`)} WHERE app_id = ${row['app_id']}`.execute(
          h.app,
        ),
      ),
    ).toBe('42501');
    expect(await sqlState(sql`TRUNCATE ${sql.table(`app.${table}`)}`.execute(h.app))).toBe('42501');
    expect(
      await sqlState(
        sql`ALTER TABLE ${sql.table(`app.${table}`)} ADD COLUMN unauthorized text`.execute(h.app),
      ),
    ).toBe('42501');
    const stored = await sql`SELECT count(*) AS n FROM ${sql.table(`app.${table}`)}
      WHERE app_id = ${row['app_id']}`.execute(h.app);
    expect(stored.rows).toEqual([{ n: 1n }]);
  }
});
