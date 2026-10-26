// B2-04rb（编排 D10-280 ①）：settle_jobs_job_check 同名重建，在原四个 job 之外只加 'supplement'，
// 供补充批次（BR-FUND-04 ⑧）改用独立 job。只验证迁移后的存储，不执行补充批次业务。
// 迁移按行为与目录核对，不固定迁移号或文件名（落地时按迁移槽改号）。
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

type Row = Record<string, unknown>;
// 0066 的原四值（02 §11 任务名）。
const ORIGINAL_JOBS = ['bill', 'settle_adjust', 'recon_union', 'recon_monthly'] as const;
const JOBS = [...ORIGINAL_JOBS, 'supplement'] as const;
// 0066 在 settle_jobs 上建的全部具名约束；本迁移只同名重建 job CHECK，其余不动。
const CONSTRAINTS = [
  'settle_jobs_counts_check',
  'settle_jobs_finished_check',
  'settle_jobs_job_check',
  'settle_jobs_pkey',
  'settle_jobs_platform_check',
  'settle_jobs_run_key',
  'settle_jobs_status_check',
] as const;
const AT = new Date('2032-07-24T01:00:00.000Z');
const LATER = new Date('2032-07-24T02:00:00.000Z');

let database: TestDatabase | undefined;
let app: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
}, 60_000);

afterAll(async () => {
  if (app) await destroyDb(app);
  if (database) await database.drop();
}, 60_000);

function job(values: Row = {}): Row {
  return {
    id: randomUUID(),
    app_id: `b2_04rb_${randomUUID()}`,
    job: 'supplement',
    platform: 'taobao',
    run_at: AT,
    status: 'running',
    processed_count: 0,
    skipped_count: 0,
    started_at: AT,
    finished_at: null,
    ...values,
  };
}

async function insert(row: Row): Promise<Row[]> {
  const names = Object.keys(row);
  return (
    await sql<Row>`INSERT INTO app.settle_jobs
      (${sql.join(names.map((name) => sql.ref(name)))})
      VALUES (${sql.join(names.map((name) => row[name]))})
      RETURNING id, app_id, job, platform, run_at, status`.execute(app)
  ).rows;
}

async function stored(row: Row): Promise<Row[]> {
  return (
    await sql<Row>`SELECT id, app_id, job, platform, run_at, status FROM app.settle_jobs
      WHERE app_id = ${row['app_id']} AND id = ${row['id']}`.execute(app)
  ).rows;
}

function visible(row: Row): Row {
  return {
    id: row['id'],
    app_id: row['app_id'],
    job: row['job'],
    platform: row['platform'],
    run_at: row['run_at'],
    status: row['status'],
  };
}

async function jobCheck() {
  return (
    await sql<{ kind: string; valid: boolean; columns: string[]; definition: string }>`
      SELECT c.contype::text AS kind, c.convalidated AS valid,
        ARRAY(SELECT a.attname::text FROM unnest(c.conkey) k(num)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num) AS columns,
        pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      WHERE c.conrelid = to_regclass('app.settle_jobs') AND c.conname = 'settle_jobs_job_check'
    `.execute(app)
  ).rows;
}

function quoted(definition: string): string[] {
  return [...definition.matchAll(/'([^']*)'/g)].map((match) => match[1]!).sort();
}

// 每条 it 的第一步：迁移未落地时由断言先红，不让 23514 之类的 SQL 错误冒充先红。
async function ready(): Promise<void> {
  const rows = await jobCheck();
  expect(rows, 'app.settle_jobs 上有且只有一个 settle_jobs_job_check').toHaveLength(1);
  const values = quoted(rows[0]!.definition);
  expect(values, 'settle_jobs_job_check 已放宽到 supplement').toContain('supplement');
}

it('[AC-B2-04rb#1] 约束名不变：settle_jobs_job_check 仍只约束 job、已验证，取值恰为原四值加 supplement；其余约束原样保留', async () => {
  await ready();
  const rows = await jobCheck();
  expect(rows).toEqual([
    { kind: 'c', valid: true, columns: ['job'], definition: expect.any(String) },
  ]);
  expect(quoted(rows[0]!.definition)).toEqual([...JOBS].sort());
  const all = await sql<{ name: string; valid: boolean }>`
    SELECT conname::text AS name, convalidated AS valid FROM pg_constraint
    WHERE conrelid = to_regclass('app.settle_jobs') AND contype IN ('p', 'u', 'c', 'f', 'x')
  `.execute(app);
  expect(all.rows.map((c) => c.name).sort()).toEqual([...CONSTRAINTS]);
  for (const c of all.rows) expect(c.valid, c.name).toBe(true);
});

it('[AC-B2-04rb#2] supplement 可由 couli_app 插入（三种运行状态），与同键 bill 并存，重跑同一名义时刻仍撞唯一键', async () => {
  await ready();
  for (const status of ['running', 'done', 'failed']) {
    const row = job({ status, finished_at: status === 'running' ? null : LATER });
    expect(await insert(row), status).toEqual([visible(row)]);
    expect(await stored(row), status).toEqual([visible(row)]);
  }
  // 补充批次改用独立 job：同一 (app_id, platform, run_at) 上 bill 与 supplement 各占一行。
  const billRow = job({ job: 'bill' });
  const supplementRow = job({ id: randomUUID(), app_id: billRow['app_id'], job: 'supplement' });
  expect(await insert(billRow)).toEqual([visible(billRow)]);
  expect(await insert(supplementRow)).toEqual([visible(supplementRow)]);
  // 同一补充任务按同一名义 run_at 重跑仍由 settle_jobs_run_key 去重（S20）。
  const rerun = { ...supplementRow, id: randomUUID() };
  await expect(insert(rerun)).rejects.toMatchObject({
    code: '23505',
    constraint: 'settle_jobs_run_key',
  });
  expect(await stored(rerun)).toEqual([]);
});

it('[AC-B2-04rb#3] 只放宽：原四个 job 值仍可插入，并与 supplement 在同一键上共存', async () => {
  await ready();
  for (const name of ORIGINAL_JOBS) {
    const row = job({ job: name, status: 'done', finished_at: LATER });
    expect(await insert(row), name).toEqual([visible(row)]);
    expect(await stored(row), name).toEqual([visible(row)]);
  }
  const appId = `b2_04rb_${randomUUID()}`;
  for (const name of JOBS) {
    const row = job({ app_id: appId, job: name });
    expect(await insert(row), name).toEqual([visible(row)]);
  }
  const together = await sql<{ job: string }>`
    SELECT job FROM app.settle_jobs WHERE app_id = ${appId}
  `.execute(app);
  expect(together.rows.map((r) => r.job).sort()).toEqual([...JOBS].sort());
});

it('[AC-B2-04rb#4] 其他 job 值（旧 credit / clawback / 批次执行、大小写与空白变体、近似名）被 settle_jobs_job_check 拒绝', async () => {
  await ready();
  const invalid = [
    'credit',
    'clawback',
    'batch_execute',
    'supplement_batch',
    'supplements',
    'bill_supplement',
    'unknown',
    '',
    ...JOBS.flatMap((name) => [name.toUpperCase(), `${name} `, ` ${name}`, `${name}\n`]),
    'Supplement',
  ];
  for (const name of invalid) {
    const row = job({ job: name });
    await expect(insert(row), JSON.stringify(name)).rejects.toMatchObject({
      code: '23514',
      constraint: 'settle_jobs_job_check',
    });
    expect(await stored(row), JSON.stringify(name)).toEqual([]);
  }
  const missing = job({ job: null });
  await expect(insert(missing)).rejects.toMatchObject({ code: '23502' });
  expect(await stored(missing)).toEqual([]);
});

it('[AC-B2-04rb#5] 授权不变：couli_app 仍不能改 job（含改成 supplement），状态列照常可更新', async () => {
  await ready();
  const row = job({ job: 'bill' });
  await insert(row);
  for (const name of ['supplement', 'bill']) {
    await expect(
      sql`UPDATE app.settle_jobs SET job = ${name}
        WHERE app_id = ${row['app_id']} AND id = ${row['id']}`.execute(app),
      name,
    ).rejects.toMatchObject({ code: '42501' });
  }
  expect(await stored(row)).toEqual([visible(row)]);
  const supplementRow = job();
  await insert(supplementRow);
  const done = await sql<Row>`UPDATE app.settle_jobs
    SET status = 'done', finished_at = ${LATER}, row_version = row_version + 1
    WHERE app_id = ${supplementRow['app_id']} AND id = ${supplementRow['id']}
    RETURNING job, status, row_version`.execute(app);
  expect(done.rows).toEqual([{ job: 'supplement', status: 'done', row_version: 1 }]);
});
