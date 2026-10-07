import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

export const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const SCRIPT = join(ROOT, 'tools/ci/lint-migrations.ts');
export const TIMEOUTS = "SET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '30s';\n";

interface Problem {
  file: string;
  line: number;
  message: string;
}

interface Gate {
  GATE_BASELINE: number;
  selectMigrations(names: string[], baseline?: number): { lint: string[]; badNames: string[] };
  isFundsTable(ref: string): boolean;
  checkMigration(file: string, sql: string): Problem[];
}

export function requiredText(path: string): string {
  const file = join(ROOT, path);
  expect(existsSync(file), `任务要求交付 ${path}`).toBe(true);
  return readFileSync(file, 'utf8');
}

export async function gate(): Promise<Gate> {
  // tools/** 本轮禁止改；先断言交付物，避免模块缺失成为无效红。
  expect(existsSync(SCRIPT), '任务要求交付 lint-migrations.ts').toBe(true);
  const url = new URL('../../../../tools/ci/lint-migrations.ts', import.meta.url).href;
  const module = (await import(/* @vite-ignore */ url)) as Gate;
  expect(typeof module.selectMigrations).toBe('function');
  expect(typeof module.isFundsTable).toBe('function');
  expect(typeof module.checkMigration).toBe('function');
  return module;
}

export function withFixture(
  files: Record<string, string>,
  check: (root: string) => void,
  withConfig = true,
): void {
  const scratch = join(ROOT, 'test/.tmp');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'ct-06a-迁移 '));
  try {
    mkdirSync(join(root, 'db/migrations'), { recursive: true });
    for (const [name, sql] of Object.entries(files)) {
      writeFileSync(join(root, 'db/migrations', name), sql);
    }
    if (withConfig) {
      expect(existsSync(join(ROOT, '.squawk.toml')), '任务要求交付 .squawk.toml').toBe(true);
      copyFileSync(join(ROOT, '.squawk.toml'), join(root, '.squawk.toml'));
    }
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function run(
  args: string[],
  options: { cwd?: string; path?: string; script?: string } = {},
) {
  const result = spawnSync(process.execPath, [options.script ?? SCRIPT, ...args], {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...(options.path === undefined ? {} : { PATH: options.path }) },
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.error, 'Node 子进程应正常启动并结束').toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}
