import { expect, it } from 'vitest';
import { requiredText } from './kit.ts';

it('[AC-CT-06a#25] 根开发依赖固定 squawk-cli 2.66.0', () => {
  const pkg = JSON.parse(requiredText('package.json')) as {
    devDependencies: Record<string, string>;
  };
  expect(pkg.devDependencies['squawk-cli']).toBe('2.66.0');
});

it('[AC-CT-06a#26] lint:migrations 调用包装脚本且 verify:fast 串联此门禁', () => {
  const pkg = JSON.parse(requiredText('package.json')) as { scripts: Record<string, string> };
  expect(pkg.scripts['lint:migrations']).toBe('node tools/ci/lint-migrations.ts');
  expect(pkg.scripts['verify:fast']?.split(/\s*&&\s*/)).toContain('pnpm run lint:migrations');
});

it('[AC-CT-06a#27] 配置使用 PG 18 与单事务，仅排除两个指定规则', () => {
  const config = requiredText('.squawk.toml').replace(/#.*$/gm, '');
  expect(config).toMatch(/^pg_version\s*=\s*["']18\.0["']\s*$/m);
  expect(config).toMatch(/^assume_in_transaction\s*=\s*true\s*$/m);
  const exclusions = config.match(/^excluded_rules\s*=\s*\[([^\]]*)\]/m);
  expect(exclusions).not.toBeNull();
  const rules = [...exclusions![1]!.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
  expect(rules.sort()).toEqual(['prefer-bigint-over-int', 'require-concurrent-index-creation']);
});

it('[AC-CT-06a#28] .squawk.toml 登记为第二类保护路径，CI 内嵌清单同步', () => {
  const config = JSON.parse(requiredText('tools/guard/protected-paths.json')) as {
    class2_verify_config: string[];
  };
  expect(config.class2_verify_config).toContain('.squawk.toml');
  const workflow = requiredText('.github/workflows/protected-paths.yml');
  const embedded = workflow.match(
    /# BEGIN protected-paths\.json\s*([\s\S]*?)\s*# END protected-paths\.json/,
  );
  expect(embedded).not.toBeNull();
  expect(JSON.parse(embedded![1]!)).toEqual(config);
});
