// @vitest-environment jsdom
// F1-06zu (D10-284): only the real entry (main.tsx) hands the generated planned list to the shell.
// The shell module is replaced by a recorder so the entry's options can be read as passed.
import { afterEach, expect, it, vi } from 'vitest';
import type { AdminShellOptions } from '../../../../apps/admin/src/shell-options.ts';
import { plannedFromContract } from './contract.ts';

const recorded = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock('../../../../apps/admin/src/shell.ts', () => ({
  createAdminShell: (options: unknown) => {
    recorded.options.push(options);
    return null;
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  document.body.replaceChildren();
});

it('[AC-F1-06zu-ENTRY#1] 正式构建入口把生成的 planned 清单经 plannedOperations 传给 createAdminShell', async () => {
  const expected = plannedFromContract();
  expect(expected.length).toBeGreaterThan(0);
  // A production build (import.meta.env.DEV false): the live options of main.tsx.
  vi.stubEnv('DEV', false);
  const container = document.createElement('div');
  container.id = 'root';
  document.body.append(container);
  await import('../../../../apps/admin/src/main.tsx');
  expect(recorded.options).toHaveLength(1);
  const options = recorded.options[0] as AdminShellOptions;
  expect(options.router).toBe('browser');
  expect(options.environment).toBe('production');
  const planned = options.plannedOperations;
  expect(Object.prototype.toString.call(planned), 'plannedOperations is a Set').toBe(
    '[object Set]',
  );
  expect([...(planned ?? [])].sort()).toEqual(expected);
});
