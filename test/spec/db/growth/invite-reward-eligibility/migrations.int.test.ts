// Source assertions supplement the live catalog checks: a final schema alone cannot prove
// that 0055 stayed frozen, a backfill default was removed, or validation used the next file.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { expect, it } from 'vitest';

import { STATUSES } from './kit.ts';

const directory = new URL('../../../../../db/migrations/', import.meta.url);
function migrations() {
  return readdirSync(directory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const source = readFileSync(new URL(name, directory), 'utf8');
      return {
        name,
        number: Number(name.slice(0, 4)),
        source,
        sql: source.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ''),
      };
    });
}
function eligibilityMigration() {
  const candidates = migrations().filter(
    (migration) =>
      migration.number > 55 &&
      /ALTER\s+TABLE\s+app\.invite_rewards\s+ADD\s+COLUMN\s+eligibility_days\b/i.test(
        migration.sql,
      ),
  );
  expect(candidates, 'add eligibility_days in a new migration after 0055').toHaveLength(1);
  return candidates[0]!;
}

it('[AC-CT-25d#8] 0055 字节不变，新迁移补 30 后撤默认且保留具名下界约束', () => {
  const original = readFileSync(new URL('0055_invite-rewards.sql', directory));
  // Frozen baseline from CT-25b, independent of the implementer's new migration/snapshot.
  expect(createHash('sha256').update(original).digest('hex')).toBe(
    'ed8d14cf5c4795504b77bb48451629aa8f6c5d0b435d9d06fe2c0778f9bd3fae',
  );
  expect(original.toString('utf8')).toContain("'budget_exhausted'");
  const migration = eligibilityMigration();
  const add = migration.sql.match(
    /ALTER\s+TABLE\s+app\.invite_rewards\s+ADD\s+COLUMN\s+eligibility_days\b[^;]*;/i,
  );
  expect(add?.[0]).toMatch(/\beligibility_days\s+integer\s+NOT\s+NULL\s+DEFAULT\s+30\b/i);
  expect(migration.sql).toMatch(
    /\bCONSTRAINT\s+invite_rewards_eligibility_days_check\s+CHECK\s*\(\s*eligibility_days\s*>=\s*1\s*\)/i,
  );
  const drop = migration.sql.match(
    /ALTER\s+TABLE\s+app\.invite_rewards\s+ALTER\s+COLUMN\s+eligibility_days\s+DROP\s+DEFAULT\s*;/i,
  );
  expect(drop).not.toBeNull();
  expect(drop!.index).toBeGreaterThan(add!.index!);
  // A different table's migration may mention invite_rewards only in a comment.
  for (const file of migrations().filter((file) => /\bapp\.invite_rewards\b/i.test(file.sql))) {
    expect(file.source, file.name).not.toMatch(/squawk-ignore/i);
  }
});

it('[AC-CT-25d#9] 同名 NOT VALID 替换状态约束，下一连号迁移单独验证且不改写历史行', () => {
  const migration = eligibilityMigration();
  const statements = migration.sql
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  const drop = statements.findIndex((part) =>
    /^ALTER\s+TABLE\s+app\.invite_rewards\s+DROP\s+CONSTRAINT\s+invite_rewards_status_check$/i.test(
      part,
    ),
  );
  expect(drop, 'drop the old constraint under the same name').toBeGreaterThanOrEqual(0);
  const add = statements.findIndex((part) =>
    /^ALTER\s+TABLE\s+app\.invite_rewards\s+ADD\s+CONSTRAINT\s+invite_rewards_status_check\s+CHECK\b/i.test(
      part,
    ),
  );
  expect(add).toBeGreaterThan(drop);
  const definition = statements[add]!;
  expect(definition).toMatch(/\bNOT\s+VALID$/i);
  const values = Array.from(definition.matchAll(/'([^']*)'/g), (match) => match[1]);
  expect(values.sort()).toEqual([...STATUSES].sort());
  expect(migration.sql).not.toMatch(/\bVALIDATE\s+CONSTRAINT\b/i);

  const validations = migrations().filter((file) =>
    /ALTER\s+TABLE\s+app\.invite_rewards\s+VALIDATE\s+CONSTRAINT\s+invite_rewards_status_check\s*;/i.test(
      file.sql,
    ),
  );
  expect(validations).toHaveLength(1);
  const validation = validations[0]!;
  expect(validation.number).toBe(migration.number + 1);
  const validateStatements = validation.sql
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  expect(validateStatements.filter((part) => !/^SET\s+LOCAL\b/i.test(part))).toEqual([
    expect.stringMatching(
      /^ALTER\s+TABLE\s+app\.invite_rewards\s+VALIDATE\s+CONSTRAINT\s+invite_rewards_status_check$/i,
    ),
  ]);
  for (const file of [migration, validation]) {
    expect(file.source).toMatch(/^-- Up Migration\b/);
    expect(file.sql, file.name).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\b/i);
    expect(file.sql, 'CT-25d leaves existing grants alone').not.toMatch(/\b(?:GRANT|REVOKE)\b/i);
  }
});
