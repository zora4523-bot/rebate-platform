// planned-operations.gen.ts（D10-284）：生成的清单与 contracts/openapi.yaml 里 operation 一级的
// `x-implementation: planned` 标记一致，排好序且不重复。这里按行扫描契约（operation 在 paths 下缩进
// 4 格，其字段缩进 6 格），与生成器用的 YAML 解析互为对照。
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { plannedOperations } from './index.ts';

const OPERATION = /^ {4}(get|put|post|delete|options|head|patch|trace):\s*$/;

function scanPlanned(source: string): string[] {
  const ids: string[] = [];
  let id: string | undefined;
  let planned = false;
  const flush = (): void => {
    if (planned && id !== undefined) ids.push(id);
    id = undefined;
    planned = false;
  };
  for (const line of source.split('\n')) {
    const indent = line.length - line.trimStart().length;
    if (line.trim() !== '' && indent <= 4) flush();
    if (OPERATION.test(line)) continue;
    if (indent !== 6) continue;
    const found = /^operationId:\s*(\S+)\s*$/.exec(line.trim());
    if (found !== null) id = found[1];
    if (line.trim() === 'x-implementation: planned') planned = true;
  }
  flush();
  return ids.sort();
}

const contract = readFileSync(new URL('../../../contracts/openapi.yaml', import.meta.url), 'utf8');

it('生成清单与 openapi.yaml 的 planned 标记逐个一致', () => {
  const expected = scanPlanned(contract);
  expect(expected.length).toBeGreaterThan(0);
  expect([...plannedOperations].sort()).toEqual(expected);
});

it('生成清单按字母排序且不重复，是一个 Set', () => {
  const ids = [...plannedOperations];
  expect(plannedOperations).toBeInstanceOf(Set);
  expect(ids).toEqual([...ids].sort());
  expect(new Set(ids).size).toBe(ids.length);
});
