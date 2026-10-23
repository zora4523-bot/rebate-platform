// B1-22i 过审 r1 S1 / D10-221 A，唯一口径按 D10-231。
// 集成测试只能以业务角色连库、不执行 DDL（@couli/db/testing 不提供 couli_migrator），无法在测试库里
// 重建「加索引之前、已有重复 active」的状态去跑迁移；这里按内容（不按文件名、不钉编号）找到建
// active 部分唯一索引的迁移，静态核对：建索引之前先按同一键查重复 active，发现即 RAISE EXCEPTION
// 并带出键与行数；全文不对 union_pids 做 UPDATE / DELETE / TRUNCATE / MERGE / INSERT（不自动改数据）。
import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const DIR = new URL('../../../../../db/migrations/', import.meta.url);
const KEY = ['app_id', 'platform', 'pid_scene', 'union_account_id'];
const TABLE = String.raw`(?:ONLY\s+)?(?:"?app"?\s*\.\s*)?"?union_pids"?(?![\w"])`;
const UNIQUE_INDEX = new RegExp(
  String.raw`CREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?(union_pids_\w*)"?\s+ON\s+` +
    TABLE +
    String.raw`\s*(?:USING\s+\w+\s*)?\(([^)]*)\)\s*WHERE\s+([^;]+);`,
  'gi',
);
const WRITES = [
  new RegExp(String.raw`\bUPDATE\s+` + TABLE, 'i'),
  new RegExp(String.raw`\bDELETE\s+FROM\s+` + TABLE, 'i'),
  new RegExp(String.raw`\bINSERT\s+INTO\s+` + TABLE, 'i'),
  new RegExp(String.raw`\bMERGE\s+INTO\s+` + TABLE, 'i'),
  /\bTRUNCATE\b[^;]*\bunion_pids\b/i,
];

/** Line and block comments removed, so prose such as "不 UPDATE" never counts as SQL. */
function code(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/--[^\n]*/g, ' ');
}

function activeIndex(body: string): { at: number } | null {
  for (const match of body.matchAll(UNIQUE_INDEX)) {
    const columns = match[2]!
      .split(',')
      .map((column) => column.replaceAll(/["\s]/g, ''))
      .sort();
    const predicate = match[3]!.replaceAll(/::text|[()\s"]/g, '');
    if (
      JSON.stringify(columns) === JSON.stringify([...KEY].sort()) &&
      predicate === "status='active'"
    ) {
      return { at: match.index ?? 0 };
    }
  }
  return null;
}

function migrations() {
  return readdirSync(DIR)
    .filter((name) => /^\d{4}_[a-z0-9-]+\.sql$/.test(name))
    .map((name) => ({ name, body: code(readFileSync(new URL(name, DIR), 'utf8')) }))
    .flatMap(({ name, body }) => {
      const index = activeIndex(body);
      return index === null ? [] : [{ name, body, at: index.at }];
    });
}

it('[AC-B1-22i#7] 恰有一个迁移建 active 部分唯一索引，建索引前先查重复 active，发现即 RAISE 并带出键与行数', () => {
  const found = migrations();
  expect(found.map(({ name }) => name)).toHaveLength(1);
  const { body, at } = found[0]!;
  const check = body.slice(0, at);
  expect(check).toMatch(/\bunion_pids\b/);
  expect(check).toMatch(/\bstatus\s*=\s*'active'/i);
  for (const column of KEY) expect(check).toMatch(new RegExp(String.raw`\b${column}\b`));
  expect(check).toMatch(/\bcount\s*\(/i);
  expect(check).toMatch(/\bRAISE\s+EXCEPTION\b/i);
});

it('[AC-B1-22i#7] 该迁移不自动改数据：全文不对 union_pids 做 UPDATE / DELETE / INSERT / MERGE / TRUNCATE', () => {
  const found = migrations();
  expect(found.map(({ name }) => name)).toHaveLength(1);
  const { body } = found[0]!;
  for (const write of WRITES) expect(body).not.toMatch(write);
});
