import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  at,
  check,
  compile,
  contract,
  examples,
  object,
  operation,
  parseYamlLite,
  root,
  sendPath,
  streamOperation,
  testRequire,
  text,
  type Obj,
} from './kit.ts';

type Frame = { event: string; id: number; data: Obj };
const methods = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];

function frames(value: unknown): Frame[] {
  const source = text(value).replaceAll('\r\n', '\n');
  const result: Frame[] = [];
  for (const block of source.trim().split(/\n\s*\n/u)) {
    const lines = block.split('\n').filter((line) => !line.startsWith(':'));
    if (lines.length === 0) continue;
    expect(lines, 'SSE 每帧由 event、id、data 三行组成').toHaveLength(3);
    const fields: Record<string, string> = {};
    for (const line of lines) {
      const match = /^(event|id|data): ?(.*)$/u.exec(line);
      expect(match, `无效 SSE 行：${line}`).not.toBeNull();
      const name = match![1]!;
      expect(fields, `SSE 字段 ${name} 不得重复`).not.toHaveProperty(name);
      fields[name] = match![2]!;
    }
    expect(Object.keys(fields).toSorted()).toEqual(['data', 'event', 'id']);
    expect(fields['id']).toMatch(/^[1-9][0-9]*$/u);
    let data: unknown;
    expect(() => {
      data = JSON.parse(fields['data']!) as unknown;
    }, 'SSE data 必须是合法 JSON').not.toThrow();
    result.push({ event: fields['event']!, id: Number(fields['id']), data: object(data) });
  }
  expect(result.length).toBeGreaterThanOrEqual(2);
  return result;
}

async function streams(): Promise<Frame[][]> {
  const op = operation(await contract(), 'post', sendPath);
  const media = at(op, 'responses', '200', 'content', 'text/event-stream');
  expect(Object.keys(at(media, 'examples')).length).toBeGreaterThanOrEqual(3);
  const schema = object(
    JSON.parse(
      readFileSync(new URL('contracts/agent-stream.schema.json', root), 'utf8'),
    ) as unknown,
  );
  const validate = compile(schema);
  return examples(media).map((value) => {
    const stream = frames(value);
    for (const [index, frame] of stream.entries()) {
      check(validate, frame, true);
      expect(frame.id, '每条响应独立从 1 连续编号').toBe(index + 1);
    }
    expect(stream[0]?.event).toBe('meta');
    const terminals = stream.filter((frame) => frame.event === 'done' || frame.event === 'error');
    expect(terminals, '终止帧恰好一个').toHaveLength(1);
    expect(stream.at(-1)).toEqual(terminals[0]);
    // 所有标记为重复的例子都只能有两帧，不能只找一个合格例子而放过错误的。
    if (stream[0]?.data['duplicate'] === true) {
      expect(stream).toHaveLength(2);
      if (stream[1]?.event === 'error' && stream[1].data['code'] === 30506) {
        expect(stream[1].data).toMatchObject({
          retryable: true,
          fallback: null,
          fallback_q: null,
        });
      }
    }
    return stream;
  });
}

it('[AC-CT-08d#6] 发送消息 200 只声明 SSE 字符串、必填 no-cache，并引用流协议与拒绝规则', async () => {
  const op = operation(await contract(), 'post', sendPath);
  const response = at(op, 'responses', '200');
  const content = at(response, 'content');
  expect(Object.keys(content)).toEqual(['text/event-stream']);
  expect(at(content, 'text/event-stream', 'schema')['type']).toBe('string');
  const cache = at(response, 'headers', 'Cache-Control');
  expect(cache['required']).toBe(true);
  expect(at(cache, 'schema')['enum']).toEqual(['no-cache']);
  const description = `${text(op['description'])}\n${text(response['description'])}`;
  expect(description).toContain('agent-stream.schema.json');
  expect(description).toMatch(/application\/json|JSON envelope/iu);
  expect(description).toContain('client_msg_id');
  expect(description).toMatch(/not compared|不比较/iu);
});

it('[AC-CT-08d#6] 每个 SSE 例子的帧通过流 schema，序号连续且只在末尾终止，并有正常受理例子', async () => {
  const values = await streams();
  expect(
    values.some((stream) =>
      [undefined, false].includes(stream[0]?.data['duplicate'] as boolean | undefined),
    ),
  ).toBe(true);
});

it('[AC-CT-08d#6] 重复已结束例子仅有 meta duplicate=true 与原终止事件，不含 30506', async () => {
  const values = await streams();
  const ended = values.filter(
    (stream) =>
      stream[0]?.data['duplicate'] === true &&
      (stream[1]?.event === 'done' ||
        (stream[1]?.event === 'error' && stream[1].data['code'] !== 30506)),
  );
  expect(ended.length).toBeGreaterThan(0);
  for (const stream of ended) expect(stream).toHaveLength(2);
});

it('[AC-CT-08d#6] 重复进行中例子仅两帧，30506 可重试且 fallback、fallback_q 都为 null', async () => {
  const values = await streams();
  const running = values.filter(
    (stream) =>
      stream[0]?.data['duplicate'] === true &&
      stream[1]?.event === 'error' &&
      stream[1].data['code'] === 30506,
  );
  expect(running.length).toBeGreaterThan(0);
  for (const stream of running) {
    expect(stream).toHaveLength(2);
    expect(stream[1]?.data).toMatchObject({
      code: 30506,
      retryable: true,
      fallback: null,
      fallback_q: null,
    });
  }
});

// 用命名空间读取将来新增的导出，缺 STREAM_OPERATIONS 时明确断言失败，
// 而不是静态导入一个不存在的符号造成类型检查或模块加载失败。
function conformance() {
  const module = testRequire(
    '../../../../packages/contracts-ts/scripts/conformance.ts',
  ) as typeof import('../../../../packages/contracts-ts/scripts/conformance.ts') & {
    STREAM_OPERATIONS?: unknown;
  };
  expect(module.STREAM_OPERATIONS).toEqual([streamOperation]);
  return module.checkConformance;
}

it('[AC-CT-08d#9] STREAM_OPERATIONS 只登记发送消息，所有接口响应中也只有它使用 SSE', async () => {
  conformance();
  const doc = await contract();
  const found = new Set<string>();
  for (const [path, item] of Object.entries(at(doc, 'paths'))) {
    for (const method of methods) {
      const op = object(item)[method];
      if (op === undefined) continue;
      for (const response of Object.values(at(op, 'responses'))) {
        const content = object(response)['content'];
        if (content !== undefined && Object.hasOwn(object(content), 'text/event-stream')) {
          found.add(`${method.toUpperCase()} ${path}`);
        }
      }
    }
  }
  expect([...found]).toEqual([streamOperation]);
});

// 测试专用 YAML 序列化，保留 $ref；不使用解引用文档，避免意外改变共享组件。
// 每份副本写出前检查 round-trip，避免 YAML 语法错误冒充 conformance 拒绝。
function yaml(value: unknown, depth = 0): string {
  const indent = '  '.repeat(depth);
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((item) => ['-', item])
    : Object.entries(object(value)).map(([key, item]) => [`${JSON.stringify(key)}:`, item]);
  return entries
    .map(([key, item]) => {
      if (item !== null && typeof item === 'object' && Object.keys(item).length > 0) {
        const nested = yaml(item, depth + 1);
        // yaml-lite 的对象序列要求首个键与 “- ” 同行。
        return key === '-'
          ? `${indent}- ${nested.slice(indent.length + 2)}`
          : `${indent}${key}\n${nested}`;
      }
      return `${indent}${key} ${JSON.stringify(item)}\n`;
    })
    .join('');
}

function mutationProblems(mutate: (doc: Obj) => void): string[] {
  const checkConformance = conformance();
  const { loadEnums, loadErrorCodes } = testRequire(
    '../../../../packages/contracts-ts/scripts/catalog.ts',
  ) as typeof import('../../../../packages/contracts-ts/scripts/catalog.ts');
  const enums = loadEnums();
  const { codes } = loadErrorCodes();
  const doc = object(parseYamlLite(readFileSync(new URL('contracts/openapi.yaml', root), 'utf8')));
  const parent = fileURLToPath(new URL('.tmp/ct-08d-agent-http/', root));
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'contract-'));
  const file = join(directory, 'openapi.yaml');
  try {
    const original = yaml(doc);
    expect(parseYamlLite(original)).toEqual(doc);
    writeFileSync(file, original);
    expect(
      checkConformance(enums, codes, file),
      '未篡改副本必须无问题，防止无关错误造成假阳性',
    ).toEqual([]);
    mutate(doc);
    const changed = yaml(doc);
    expect(changed).not.toBe(original);
    expect(parseYamlLite(changed)).toEqual(doc);
    writeFileSync(file, changed);
    let problems: string[] = [];
    expect(() => {
      problems = checkConformance(enums, codes, file);
    }, '校验器应返回问题而非解析异常').not.toThrow();
    return problems;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it.each([
  ['get', '/healthz'],
  ['post', '/v1/devices'],
])('[AC-CT-08d#9] 给未登记的 %s %s 的 200 添加 SSE，conformance 必须报错', (method, path) => {
  const problems = mutationProblems((doc) => {
    const content = at(operation(doc, method, path), 'responses', '200', 'content');
    const stream = at(
      operation(doc, 'post', sendPath),
      'responses',
      '200',
      'content',
      'text/event-stream',
    );
    content['text/event-stream'] = structuredClone(stream);
  });
  expect(problems.length).toBeGreaterThan(0);
  expect(
    problems.some(
      (problem) =>
        problem.includes(`${method.toUpperCase()} ${path}`) && /stream|SSE/iu.test(problem),
    ),
  ).toBe(true);
});

it('[AC-CT-08d#9] 删除发送消息的 SSE 示例，conformance 必须指出该接口的示例问题', () => {
  const problems = mutationProblems((doc) => {
    const media = at(
      operation(doc, 'post', sendPath),
      'responses',
      '200',
      'content',
      'text/event-stream',
    );
    expect(Object.keys(at(media, 'examples')).length).toBeGreaterThanOrEqual(3);
    delete media['examples'];
    delete media['example'];
  });
  expect(problems.length).toBeGreaterThan(0);
  expect(
    problems.some((problem) => problem.includes(streamOperation) && /example|示例/iu.test(problem)),
  ).toBe(true);
});
