// Migration sequence guard (CT-06q, 2026-10-18). Two pull requests that each add a
// db/migrations/NNNN_*.sql with the same number both pass on their own tree; the first merge
// takes the number and the second would put two NNNN on main (2026-10-09 two 0025, 2026-10-16
// two 0031, 2026-10-18 #775 and #750 both carrying 0046). packages/db migrations.test sees it
// only on the rebased tree, and the rename hotfix (ops/approvals.yaml id 32) is the repair, not
// the prevention. So guard-git holds the migrations a pull request adds to the base it is
// checked against (--base as given: the base branch tip in CI, so a branch behind the base sees
// what was merged meanwhile): their numbers must be max(base) + 1, + 2, … in file-name order,
// no gap, no repeat, none already taken on the base, and every name NNNN_kebab-name.sql.
// A file is "added" when its name is in the inspected tree and not on the base, so the hotfix
// rename of a colliding migration to max(base) + 1 passes, and files only the base has (a
// branch behind it) are not blamed. Changes to existing migrations are protected-paths' matter.
// No owner label waives these problems.

/** db/AGENTS.md rule 1 (the pattern of packages/db migrations.test and tools/ci/evidence-check.ts). */
export const MIGRATION_NAME = /^([0-9]{4})_[a-z0-9]+(?:-[a-z0-9]+)*\.sql$/;

export const MIGRATIONS_DIR = 'db/migrations';

function pad(n: number): string {
  return String(n).padStart(4, '0');
}

export type MigrationSequence = { problems: string[]; notices: string[] };

/**
 * `baseNames` and `headNames`: the file names directly under db/migrations on the base and in
 * the inspected tree. Names the base already has are left alone (even malformed ones: the
 * migration gate reports those); the names only the head has must continue the base sequence.
 */
export function migrationSequenceProblems(
  baseNames: readonly string[],
  headNames: readonly string[],
): MigrationSequence {
  const problems: string[] = [];
  const taken = new Map<number, string>();
  let max = 0;
  for (const name of [...baseNames].sort()) {
    const m = MIGRATION_NAME.exec(name);
    if (m === null) continue;
    const n = Number(m[1]);
    if (!taken.has(n)) taken.set(n, name);
    if (n > max) max = n;
  }
  const base = new Set(baseNames);
  const added = headNames.filter((name) => !base.has(name)).sort();
  if (added.length === 0) {
    return { problems, notices: [`no migration added (base max ${pad(max)})`] };
  }
  const numbered: { name: string; n: number }[] = [];
  for (const name of added) {
    const m = MIGRATION_NAME.exec(name);
    if (m === null) {
      problems.push(
        `${MIGRATIONS_DIR}/${name}: 新增的迁移文件名不是 NNNN_kebab-name.sql（db/AGENTS.md 规则 1）`,
      );
      continue;
    }
    numbered.push({ name, n: Number(m[1]) });
  }
  numbered.sort((a, b) => a.n - b.n || (a.name < b.name ? -1 : 1));
  let expected = max + 1;
  for (const { name, n } of numbered) {
    const path = `${MIGRATIONS_DIR}/${name}`;
    const holder = taken.get(n);
    if (holder !== undefined) {
      problems.push(`${path}: ${pad(n)} 已被 ${holder} 占用，请改为 ${pad(expected)}`);
    } else if (n !== expected) {
      problems.push(
        `${path}: 迁移号 ${pad(n)} 与 base 主干最大号 ${pad(max)} 不连号（本 PR 新增的迁移须依次为 ` +
          `${pad(max + 1)}…），请改为 ${pad(expected)}`,
      );
    }
    // The number is taken from here on, so a second added file with it is told the next slot.
    if (holder === undefined) taken.set(n, `${name}（本 PR 新增）`);
    expected++;
  }
  return {
    problems,
    notices: [`${added.length} migration(s) added after base max ${pad(max)}: ${added.join(', ')}`],
  };
}
