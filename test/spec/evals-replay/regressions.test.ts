import { expect, it } from 'vitest';
import {
  checkDuplicateIds,
  checkManifest,
  computeManifest,
  validateCase,
} from '../../../packages/evals/src/index.ts';
import type { Manifest, Problem } from '../../../packages/evals/src/index.ts';
import { sample } from './fixtures.ts';

it('[B3-01b] 跨文件重复 id 报 duplicate_id，指出两处文件名；同文件重复不重报', () => {
  const cases = [sample(), sample(), sample()];
  const problems = checkDuplicateIds(cases, ['a.jsonl', 'a.jsonl', 'b.jsonl']);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatchObject({ code: 'duplicate_id', id: cases[0]?.id });
  expect(problems[0]?.message).toContain('a.jsonl');
  expect(problems[0]?.message).toContain('b.jsonl');
  expect(checkDuplicateIds(cases.slice(0, 2), ['a.jsonl', 'a.jsonl'])).toEqual([]);
});

it('[B3-01b] 不重复的跨文件 id 与空输入通过，退役题 id 仍不可跨文件重复', () => {
  expect(checkDuplicateIds([], [])).toEqual([]);
  expect(
    checkDuplicateIds([sample({ id: 'syn-A' }), sample({ id: 'syn-B' })], ['a.jsonl', 'b.jsonl']),
  ).toEqual([]);
  const retired = sample({ retired: { at: '2026-10-05', reason: '合成退役' } });
  expect(checkDuplicateIds([sample(), retired], ['a.jsonl', 'b.jsonl'])).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'duplicate_id' })]),
  );
});

it.each([
  { label: 'null', edit: () => null },
  { label: '缺字段', edit: () => ({ set: 'smoke', version: 'v1' }) },
  { label: '额外字段', edit: (m: Manifest) => ({ ...m, extra: true }) },
  { label: '版本类型', edit: (m: Manifest) => ({ ...m, version: 12 }) },
  { label: '计数类型', edit: (m: Manifest) => ({ ...m, count: '1' }) },
  { label: '类别结构', edit: (m: Manifest) => ({ ...m, by_category: [] }) },
  { label: '摘要类型', edit: (m: Manifest) => ({ ...m, content_sha256: null }) },
])('[B3-01b] B3-01a 补强：清单 $label 返回 schema，不能抛异常', ({ edit }) => {
  const cases = [sample()];
  const manifest = computeManifest('smoke', 'v1', cases);
  let problems: Problem[] = [];
  let threw = false;
  try {
    problems = checkManifest(edit(manifest) as Manifest, cases);
  } catch {
    threw = true;
  }
  // 将旧实现的异常转为明确的断言红，不能让 TypeError 成为红测原因。
  expect(threw).toBe(false);
  expect(problems).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'schema' })]));
});

it.each(['only-hole', 'middle-hole', 'trailing-hole'] as const)(
  '[B3-01b] B3-01a 补强：turns 稀疏数组 %s 报 schema',
  (kind) => {
    const turns =
      kind === 'only-hole'
        ? new Array<{ text: string }>(1)
        : [{ text: '合成第一轮' }, { text: '合成第二轮' }, { text: '合成第三轮' }];
    if (kind === 'middle-hole') delete turns[1];
    if (kind === 'trailing-hole') delete turns[2];
    expect(validateCase(sample({ turns }))).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'schema' })]),
    );
  },
);
