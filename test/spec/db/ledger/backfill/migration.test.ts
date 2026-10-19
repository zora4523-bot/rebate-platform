import { expect, it } from 'vitest';

import { migration } from './kit.ts';

// Ignore comments without interpreting SQL strings as comments. Only ordinary SQL is allowed.
function uncomment(source: string): string {
  return source.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (token) =>
    token.startsWith("'") ? token : ' ',
  );
}

it('[AC-B2-02h#1] 回填迁移有 Up 标记并先设置两个非零事务内超时', () => {
  const source = migration();
  expect(source.split(/\r?\n/)[0]).toBe('-- Up Migration');
  const statements = uncomment(source)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  expect(statements.slice(0, 2).join(';')).toMatch(/\bSET\s+LOCAL\s+lock_timeout\s*=/i);
  expect(statements.slice(0, 2).join(';')).toMatch(/\bSET\s+LOCAL\s+statement_timeout\s*=/i);
  for (const statement of statements.slice(0, 2)) {
    expect(statement).toMatch(
      /^SET\s+LOCAL\s+(?:lock_timeout|statement_timeout)\s*=\s*'[1-9]\d*(?:ms|s|min|h)?'$/i,
    );
  }
});

it('[AC-B2-02h#2] 回填只用普通 INSERT SELECT ON CONFLICT DO NOTHING，不改结构授权或已有行', () => {
  const source = uncomment(migration());
  expect(source).not.toMatch(
    /\b(?:UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE|RESET)\b/i,
  );
  expect(source).not.toMatch(/\bDO\s+(?!NOTHING\b)/i);
  expect(source).not.toMatch(
    /\b(?:uuidv7|now|CURRENT_TIMESTAMP|CURRENT_DATE|clock_timestamp|statement_timestamp|transaction_timestamp|set_config)\b/i,
  );
  expect(source).toMatch(/\bgen_random_uuid\s*\(\s*\)/i);
  const statements = source
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  const inserts = statements.slice(2);
  expect(inserts.length).toBeGreaterThanOrEqual(2);
  for (const statement of inserts) {
    expect(statement).toMatch(/^INSERT\s+INTO\s+app\.(?:ledger_accounts|account_balances)\b/i);
    expect(statement).toMatch(/\bSELECT\b/i);
    expect(statement).toMatch(/\bON\s+CONFLICT\b[\s\S]*\bDO\s+NOTHING\s*$/i);
    const columns = statement.match(/^INSERT\s+INTO\s+app\.\w+\s*\(([^)]*)\)/i);
    expect(columns, '显式列清单保留 created_at 的列默认值').not.toBeNull();
    expect(columns![1]).not.toMatch(/\bcreated_at\b/i);
  }
  expect(inserts.some((s) => /^INSERT\s+INTO\s+app\.ledger_accounts\b/i.test(s))).toBe(true);
  expect(inserts.some((s) => /^INSERT\s+INTO\s+app\.account_balances\b/i.test(s))).toBe(true);
});
