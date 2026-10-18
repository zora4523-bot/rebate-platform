// Migration sequence guard (CT-06q): the pure numbering rule over file names.
import { describe, expect, it } from 'vitest';
import { MIGRATION_NAME, migrationSequenceProblems } from './migration-sequence.ts';

const BASE = [
  '0001_app-schema.sql',
  '0002_pgboss-schema-v42.sql',
  '0044_risk-hits-invite-relation.sql',
  '0045_agreements.sql',
  '0046_order-claims.sql',
];

describe('MIGRATION_NAME', () => {
  it('accepts NNNN_kebab-name.sql only', () => {
    expect(MIGRATION_NAME.exec('0046_order-claims.sql')?.[1]).toBe('0046');
    for (const bad of [
      '46_x.sql',
      '0046_Order.sql',
      '0046_x.js',
      '0046-x.sql',
      '0046_x-.sql',
      '0046_.sql',
    ]) {
      expect(MIGRATION_NAME.test(bad), bad).toBe(false);
    }
  });
});

describe('migrationSequenceProblems', () => {
  it('no migration added: a notice with the base max', () => {
    expect(migrationSequenceProblems(BASE, BASE)).toEqual({
      problems: [],
      notices: ['no migration added (base max 0046)'],
    });
    // Files only the base has (a branch behind it) are not the branch's doing.
    expect(migrationSequenceProblems(BASE, BASE.slice(0, 4)).problems).toEqual([]);
    expect(migrationSequenceProblems([], []).notices).toEqual([
      'no migration added (base max 0000)',
    ]);
  });

  it('the next number passes; several added files must follow each other', () => {
    expect(migrationSequenceProblems(BASE, [...BASE, '0047_x.sql'])).toEqual({
      problems: [],
      notices: ['1 migration(s) added after base max 0046: 0047_x.sql'],
    });
    expect(
      migrationSequenceProblems(BASE, [...BASE, '0049_c.sql', '0047_a.sql', '0048_b.sql']).problems,
    ).toEqual([]);
    expect(migrationSequenceProblems([], ['0001_init.sql', '0002_next.sql']).problems).toEqual([]);
  });

  it('#750 against #775: the number the base took is named with its holder and the next slot', () => {
    const { problems } = migrationSequenceProblems(BASE, [
      ...BASE,
      '0046_notify-templates-variant-override.sql',
    ]);
    expect(problems).toEqual([
      'db/migrations/0046_notify-templates-variant-override.sql: 0046 已被 0046_order-claims.sql 占用，请改为 0047',
    ]);
  });

  it('a gap and a number below the base max are refused with the expected number', () => {
    expect(migrationSequenceProblems(BASE, [...BASE, '0048_x.sql']).problems).toEqual([
      'db/migrations/0048_x.sql: 迁移号 0048 与 base 主干最大号 0046 不连号（本 PR 新增的迁移须依次为 0047…），请改为 0047',
    ]);
    // Two files with a hole between them: the second one is told its slot.
    expect(migrationSequenceProblems(BASE, [...BASE, '0047_a.sql', '0049_b.sql']).problems).toEqual(
      [
        'db/migrations/0049_b.sql: 迁移号 0049 与 base 主干最大号 0046 不连号（本 PR 新增的迁移须依次为 0047…），请改为 0048',
      ],
    );
    // A hole in the base itself (never on main, migrations.test forbids it): not a slot to fill.
    expect(
      migrationSequenceProblems(
        ['0001_a.sql', '0003_c.sql'],
        ['0001_a.sql', '0002_b.sql', '0003_c.sql'],
      ).problems,
    ).toEqual([
      'db/migrations/0002_b.sql: 迁移号 0002 与 base 主干最大号 0003 不连号（本 PR 新增的迁移须依次为 0004…），请改为 0004',
    ]);
  });

  it('two added files with the same number: the second is told the next slot', () => {
    expect(migrationSequenceProblems(BASE, [...BASE, '0047_a.sql', '0047_b.sql']).problems).toEqual(
      ['db/migrations/0047_b.sql: 0047 已被 0047_a.sql（本 PR 新增） 占用，请改为 0048'],
    );
    // A collision with the base plus a correct follower: both are told to move up.
    expect(migrationSequenceProblems(BASE, [...BASE, '0046_x.sql', '0047_y.sql']).problems).toEqual(
      [
        'db/migrations/0046_x.sql: 0046 已被 0046_order-claims.sql 占用，请改为 0047',
        'db/migrations/0047_y.sql: 迁移号 0047 与 base 主干最大号 0046 不连号（本 PR 新增的迁移须依次为 0047…），请改为 0048',
      ],
    );
  });

  it('the rename hotfix of ops/approvals.yaml id 32 passes: the renamed file takes max + 1', () => {
    const collided = [...BASE, '0046_commission-rules.sql'];
    const fixed = [...BASE, '0047_commission-rules.sql'];
    expect(migrationSequenceProblems(collided, fixed).problems).toEqual([]);
    // While the base still has the two 0046, another PR's next number is 0047 as well.
    expect(migrationSequenceProblems(collided, [...collided, '0047_z.sql']).problems).toEqual([]);
    expect(migrationSequenceProblems(collided, [...collided, '0046_w.sql']).problems).toEqual([
      'db/migrations/0046_w.sql: 0046 已被 0046_commission-rules.sql 占用，请改为 0047',
    ]);
  });

  it('a malformed added name is refused; malformed base names are left to the migration gate', () => {
    expect(
      migrationSequenceProblems(BASE, [...BASE, '0047_Bad.sql', '47_x.sql', '0047_ok.sql'])
        .problems,
    ).toEqual([
      'db/migrations/0047_Bad.sql: 新增的迁移文件名不是 NNNN_kebab-name.sql（db/AGENTS.md 规则 1）',
      'db/migrations/47_x.sql: 新增的迁移文件名不是 NNNN_kebab-name.sql（db/AGENTS.md 规则 1）',
    ]);
    expect(
      migrationSequenceProblems([...BASE, 'README.md'], [...BASE, 'README.md', '0047_x.sql'])
        .problems,
    ).toEqual([]);
  });
});
