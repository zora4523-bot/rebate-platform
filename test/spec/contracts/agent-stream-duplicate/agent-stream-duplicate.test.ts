import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

// CT-08c §9 / 04 §8.1–8.2 / BR-AI-23、BR-AI-14：只测契约与样例。
// AC-CT-08c#n 是本任务 §9 的断言组编号，不是新增业务验收编号。
type ObjectValue = Record<string, unknown>;
type Frame = { event: string; id: number; data: ObjectValue };
type Validator = ((value: unknown) => boolean) & { errors?: unknown };
interface AjvInstance {
  addFormat(name: string, format: { type: 'number'; validate: (value: number) => boolean }): void;
  compile(schema: object): Validator;
}

const root = new URL('../../../../', import.meta.url);
const newFixtures = [
  'duplicate-ended-done',
  'duplicate-ended-error',
  'duplicate-in-progress',
  'error-search-fallback',
];
const legacyFixtures = [
  'normal',
  'tool-failed',
  'cancelled',
  'disconnected',
  'unknown-card',
  'error',
  'fallback',
  'normal-page-guide',
  'normal-earnings',
  'normal-earnings-history',
  'unknown-card-page-guide',
];
const metaData: ObjectValue = {
  session_id: '019a0000-0000-7000-8000-000000000001',
  run_id: '019a0000-0000-7000-8000-000000000101',
  message_id: '019a0000-0000-7000-8000-000000000201',
  prompt_version: 'demo-prompt-v1',
  model_label: '演示模型',
  ai_label: '内容由 AI 生成，仅供参考',
};
const errorData: ObjectValue = {
  code: 50302,
  msg: 'AI 暂不可用，可以先用搜索找货',
  retryable: true,
  fallback: 'search_page',
};

function object(value: unknown): ObjectValue {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  expect(Array.isArray(value)).toBe(false);
  return value as ObjectValue;
}

function readText(path: string): string {
  const url = new URL(path, root);
  // 缺样例必须在读取前以断言失败；不以 ENOENT 或模块加载错误充当先红。
  expect(existsSync(url), `缺少 ${path}`).toBe(true);
  let text = '';
  expect(() => {
    text = readFileSync(url, 'utf8');
  }, `无法读取 ${path}`).not.toThrow();
  return text;
}

function parseObject(text: string): ObjectValue {
  let value: unknown;
  expect(() => {
    value = JSON.parse(text) as unknown;
  }, '必须是合法 JSON').not.toThrow();
  return object(value);
}

function validators(): { frame: Validator; ping: Validator } {
  const schema = parseObject(readText('contracts/agent-stream.schema.json'));
  // 与 CT-08a 一致：复用 API 已有的 Ajv 依赖，不增加依赖。
  const apiRequire = createRequire(new URL('apps/api/package.json', root));
  const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
    Ajv2020: new (options: { strict: true; allErrors: true }) => AjvInstance;
  };
  const addFormats = apiRequire('ajv-formats') as (ajv: AjvInstance) => void;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value) => Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  let frame: Validator | undefined;
  let ping: Validator | undefined;
  expect(() => {
    frame = ajv.compile(schema);
    ping = ajv.compile({
      $schema: schema['$schema'],
      $defs: schema['$defs'],
      $ref: '#/$defs/ping',
    });
  }, 'schema 必须可以用 Ajv2020 strict 编译').not.toThrow();
  expect(frame).toBeTypeOf('function');
  expect(ping).toBeTypeOf('function');
  return { frame: frame!, ping: ping! };
}

function check(validate: Validator, value: unknown, expected: boolean): void {
  const valid = validate(value);
  expect(valid, JSON.stringify({ value, errors: validate.errors })).toBe(expected);
}

function meta(patch: ObjectValue = {}): Frame {
  return { event: 'meta', id: 1, data: { ...metaData, ...patch } };
}

function error(patch: ObjectValue = {}): Frame {
  return { event: 'error', id: 2, data: { ...errorData, ...patch } };
}

function readFixture(name: string): ObjectValue[] {
  const text = readText(`contracts/fixtures/agent-streams/${name}.ndjson`).trimEnd();
  expect(text.length, `${name} 不得为空`).toBeGreaterThan(0);
  return text.split(/\r?\n/u).map(parseObject);
}

function newStream(name: string): Frame[] {
  const rows = readFixture(name);
  const { frame } = validators();
  for (const [index, row] of rows.entries()) {
    // 新样例每行一帧，不允许用心跳或额外帧凑成两帧响应。
    check(frame, row, true);
    expect(row['id'], `${name} 的 id 从 1 连续递增`).toBe(index + 1);
  }
  const frames = rows as Frame[];
  expect(frames[0]?.event).toBe('meta');
  const terminals = frames.filter((frame) => frame.event === 'done' || frame.event === 'error');
  expect(terminals, `${name} 恰好一个终止帧`).toHaveLength(1);
  expect(frames.at(-1)).toEqual(terminals[0]);
  return frames;
}

it('[AC-CT-08c#1] fallback_q 接受关键词、null 和缺省，保留旧 fallback 取值', () => {
  const { frame } = validators();
  check(frame, error({ fallback_q: '纯牛奶 24盒' }), true);
  // 不收窄既有 fallback 的开放字符串类型；只有非空 q 需要 search_page。
  for (const fallback of ['search_page', 'other_page', null]) {
    check(frame, error({ fallback, fallback_q: null }), true);
    check(frame, error({ fallback }), true);
  }
});

it('[AC-CT-08c#1] fallback_q 拒绝错误类型、空串及非 search_page 的关键词', () => {
  const { frame } = validators();
  // 正反成对，避免把“所有新增字段一律拒绝”误判为正确实现。
  check(frame, error({ fallback_q: '奶' }), true);
  for (const fallback_q of ['', 123, {}, { q: '奶' }, false, []]) {
    check(frame, error({ fallback_q }), false);
  }
  for (const fallback of [null, 'other_page', 'Search_page', '']) {
    check(frame, error({ fallback, fallback_q: '奶' }), false);
  }
  const missingFallback = error({ fallback_q: '奶' });
  delete missingFallback.data['fallback'];
  check(frame, missingFallback, false);
  check(frame, error({ fallback_q: null, unexpected: true }), false);
});

it('[AC-CT-08c#2] duplicate 接受 true、false、缺省，拒绝其他类型', () => {
  const { frame } = validators();
  check(frame, meta({ duplicate: true }), true);
  check(frame, meta({ duplicate: false }), true);
  check(frame, meta(), true);
  for (const duplicate of ['true', 'false', 0, 1, null, {}, []]) {
    check(frame, meta({ duplicate }), false);
  }
});

it('[AC-CT-08c#2] duplicate 不放宽 meta 其余必填字段、字段类型或额外字段限制', () => {
  const { frame } = validators();
  check(frame, meta({ duplicate: true }), true);
  for (const duplicate of [true, false]) {
    for (const key of Object.keys(metaData)) {
      const missing = meta({ duplicate });
      delete missing.data[key];
      check(frame, missing, false);
      for (const value of ['', null, 42]) {
        check(frame, meta({ duplicate, [key]: value }), false);
      }
    }
    check(frame, meta({ duplicate, unexpected: true }), false);
    check(frame, { ...meta({ duplicate }), unexpected: true }, false);
  }
});

it.each(['duplicate-ended-done', 'duplicate-ended-error'])(
  '[AC-CT-08c#3] %s：已结束重放仅有 meta 和终止帧',
  (name) => {
    const frames = newStream(name);
    expect(frames).toHaveLength(2);
    expect(frames[0]?.data['duplicate']).toBe(true);
    expect(frames[1]?.event).toBe(name === 'duplicate-ended-done' ? 'done' : 'error');
    // 不对样例任意指定原 run 的额度、文案或错误码；终止数据由 schema 校验。
    // 与原 run 持久化记录的逐字段相等属于运行时任务，本任务没有该记录。
    if (name === 'duplicate-ended-error') expect(frames[1]?.data['code']).not.toBe(30506);
  },
);

it('[AC-CT-08c#3] duplicate-in-progress：两帧，30506 可重试且无降级入口或关键词', () => {
  const frames = newStream('duplicate-in-progress');
  expect(frames).toHaveLength(2);
  expect(frames[0]?.data['duplicate']).toBe(true);
  expect(frames[1]?.event).toBe('error');
  expect(frames[1]?.data).toMatchObject({
    code: 30506,
    retryable: true,
    fallback: null,
    fallback_q: null,
  });
});

it('[AC-CT-08c#3] error-search-fallback：正常受理，50302 以搜索入口及非空关键词结束', () => {
  const frames = newStream('error-search-fallback');
  expect(frames.length).toBeGreaterThanOrEqual(2);
  expect([undefined, false]).toContain(frames[0]?.data['duplicate']);
  const terminal = frames.at(-1)!;
  expect(terminal.event).toBe('error');
  expect(terminal.data).toMatchObject({ code: 50302, fallback: 'search_page' });
  expect(terminal.data['fallback_q']).toBeTypeOf('string');
  expect((terminal.data['fallback_q'] as string).trim().length).toBeGreaterThan(0);
});

it('[AC-CT-08c#4] 新样例所有错误码及 30506、50302 均已登记在错误码契约', () => {
  // error-codes.yaml 的条目按固定的 “- code: 五位整数” 写法读取，与生成 TS 解耦。
  const codes = new Set(
    [...readText('contracts/error-codes.yaml').matchAll(/^\s*- code: (\d{5})\s*$/gmu)].map(
      (match) => Number(match[1]),
    ),
  );
  expect(codes.has(30506)).toBe(true);
  expect(codes.has(50302)).toBe(true);
  const replayErrors: number[] = [];
  for (const name of newFixtures) {
    for (const row of readFixture(name)) {
      if (row['event'] !== 'error') continue;
      const code = object(row['data'])['code'];
      expect(code).toBeTypeOf('number');
      expect(codes.has(code as number), `${name} 使用未登记错误码 ${String(code)}`).toBe(true);
      if (name === 'duplicate-ended-error') replayErrors.push(code as number);
    }
  }
  expect(replayErrors).toHaveLength(1);
});

it('[AC-CT-08c#5] 11 个旧样例原样兼容，显式 duplicate=false、fallback_q=null 也兼容', () => {
  const { frame, ping } = validators();
  const frames: Frame[] = [];
  for (const name of legacyFixtures) {
    for (const row of readFixture(name)) {
      if ('comment' in row) check(ping, row, true);
      else {
        check(frame, row, true);
        frames.push(row as Frame);
      }
    }
  }
  // 在同一回归用例内验证缺省与显式默认值等价；旧样例文件保持原样。
  const metas = frames.filter((row) => row.event === 'meta');
  const errors = frames.filter((row) => row.event === 'error');
  // normal-earnings-history 是单张历史卡片，不是带 meta 的完整流。
  expect(metas.length).toBeGreaterThan(0);
  expect(errors.length).toBeGreaterThan(0);
  for (const row of metas) {
    check(frame, { ...row, data: { ...row.data, duplicate: false } }, true);
  }
  for (const row of errors) {
    check(frame, { ...row, data: { ...row.data, fallback_q: null } }, true);
  }
});
