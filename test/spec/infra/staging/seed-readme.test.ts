import { expect, it } from 'vitest';
import { asset } from './kit.ts';

// B1-01zzn ledger (D10-299 B) defines this local AC identifier. README section 3 is the
// operator's description of what deploy.sh does; check its migration step statically.
function migrationStep(): string {
  const lines = asset('infra/staging/README.md').split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+3\.\s/.test(line));
  expect(start, 'README keeps section 3').toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  const section = lines.slice(start + 1, end < 0 ? undefined : end);
  const steps = section.filter((line) => /^2\.\s/.test(line));
  expect(steps, 'section 3 keeps exactly one step 2').toHaveLength(1);
  return steps[0] ?? '';
}

it('[AC-B1-01zzn-README#1] 第 3 节第 2 步写明迁移成功后接着跑种子、种子可重复执行、种子失败与迁移失败一样不切换', () => {
  const step = migrationStep();
  const migrate = step.search(/migrate\.(?:ts|js)|db:migrate/);
  const seed = step.search(/seed\.(?:ts|js)|db:seed/);
  expect(migrate, 'step 2 names the migration').toBeGreaterThanOrEqual(0);
  expect(seed, 'step 2 names the seed script').toBeGreaterThanOrEqual(0);
  expect(seed, 'seed runs after the migration').toBeGreaterThan(migrate);
  expect(step).toMatch(/种子/);
  expect(step, 'seeds are re-run on every deployment').toMatch(
    /幂等|可重复执行|重复执行|idempotent|re-?runnable/i,
  );
  expect(step, 'a seed failure is handled like a migration failure').toMatch(
    /种子[^。；\n]*失败|seed[^.;\n]*fail/i,
  );
  expect(step, 'running processes are not switched').toMatch(/不受影响|不切换|不碰/);
  expect(step, 'still the migrator credentials only').toContain('staging-migrator.env');
  expect(step, 'logs still hide the password').toMatch(/口令/);
});
