import { expect, it } from 'vitest';
import { parseJsonl } from '../../../packages/evals/src/index.ts';
import { sample } from './fixtures.ts';

it.each(['', '\n  \n\t\r\n'])('[B3-01a] 空文件与空白行跳过：%j', (text) => {
  expect(parseJsonl(text, 'synthetic.jsonl')).toEqual({ cases: [], problems: [] });
});

it.each(['\n', '\r\n'])('[B3-01a] JSONL 保留输入顺序，允许空行及末行无换行：%j', (newline) => {
  const first = sample({ id: 'syn-b' });
  const second = sample({ id: 'syn-a' });
  const text = [' ', JSON.stringify(first), '', JSON.stringify(second)].join(newline);
  expect(parseJsonl(text, 'synthetic.jsonl')).toEqual({ cases: [first, second], problems: [] });
});

it('[B3-01a] 语法错误与 schema 错误报告原文件、物理行号，并继续加载后续有效行', () => {
  const valid = sample();
  const result = parseJsonl(
    ['', '{bad json', ' ', JSON.stringify({ ...valid, turns: [] }), JSON.stringify(valid)].join(
      '\n',
    ),
    'synthetic/mixed.jsonl',
  );
  expect(result.cases).toEqual([valid]);
  expect(result.problems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        file: 'synthetic/mixed.jsonl',
        line: 2,
        message: expect.any(String),
      }),
      expect.objectContaining({ code: 'schema', file: 'synthetic/mixed.jsonl', line: 4 }),
    ]),
  );
  expect(
    result.problems.every(
      (problem) =>
        problem.file === 'synthetic/mixed.jsonl' &&
        [2, 4].includes(problem.line ?? 0) &&
        problem.message.length > 0,
    ),
  ).toBe(true);
});

it.each(['null', '[]', '"合成字符串"', '42', '{}'])(
  '[B3-01a] JSON 可解析但不是题目时按 schema 报错：%s',
  (text) => {
    const result = parseJsonl(text, 'synthetic/invalid.jsonl');
    expect(result.cases).toEqual([]);
    expect(result.problems.length).toBeGreaterThan(0);
    expect(
      result.problems.every(
        (problem) =>
          problem.code === 'schema' &&
          problem.file === 'synthetic/invalid.jsonl' &&
          problem.line === 1,
      ),
    ).toBe(true);
  },
);

it.each([false, true])(
  '[B3-01a] 文本内重复 id 必须报 duplicate_id，退役也不释放 id：%s',
  (retired) => {
    const first = sample();
    const second = sample({
      set: 'badcase',
      turns: [{ text: '同 id 的另一合成题' }],
      ...(retired ? { retired: { at: '2026-10-05', reason: '合成退役' } } : {}),
    });
    const result = parseJsonl(
      [first, second].map((value) => JSON.stringify(value)).join('\n'),
      'synthetic.jsonl',
    );
    expect(result.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'duplicate_id' })]),
    );
  },
);

it('[B3-01a] id 不重复时相同文本允许加载，近似重复由独立检查处理', () => {
  const cases = [sample({ id: 'syn-001' }), sample({ id: 'syn-002' })];
  expect(
    parseJsonl(cases.map((value) => JSON.stringify(value)).join('\n'), 'synthetic.jsonl'),
  ).toEqual({ cases, problems: [] });
});
