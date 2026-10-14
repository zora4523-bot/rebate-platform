import { expect, it } from 'vitest';
import {
  acceptanceOrder,
  cancelPath,
  cancelShape,
  commonShape,
  description,
  sendPath,
  sendShape,
} from './baseline.ts';
import { at, check, compile, contract, list, liveCode, text, type Obj } from './kit.ts';

// 依据 CT-08f §9、04 §6.5 / §8.1、BR-AI-23 细则及 08 §13.11。
// 回归断言与本次新增要求放在同一用例：每例都应因真实缺项先红，无运行时实现或占位失败。
it('[AC-CT-08f#1] 发送消息保留原标注、参数和错误码，补齐三个有效受理错误码，42901 登记不变', async () => {
  const op = commonShape(await contract(), sendPath, 'sendAgentMessage', 'id');
  const codes = list(op['x-error-codes']);
  expect(codes).toEqual(
    expect.arrayContaining([30501, 10001, 10005, 10004, 30504, 20001, 30506, 30502, 50302, 10405]),
  );
  for (const code of codes) {
    expect(code).toBeTypeOf('number');
    liveCode(code as number);
  }
  expect(liveCode(42901)).toEqual({
    code: 42901,
    http: 429,
    meaning: '请求过于频繁',
    action: '按 Retry-After 禁用按钮，缺省 5 秒',
    retry: '稍后',
    retry_kind: 'later',
    headers: ['Retry-After'],
    sources: ['BR-TEXT-14', 'BR-ID-05', 'BR-INV-02', 'BR-AI-23', 'BR-ID-34'],
  });
  expect(at(op, 'responses', '429', 'headers', 'Retry-After')['required']).toBe(true);
  for (const code of [42901, 50001, 50401]) liveCode(code);
  expect(codes).toEqual(expect.arrayContaining([42901, 50001, 50401]));
});

function jsonError(doc: Obj, op: Obj, status: string, code: number): void {
  const responses = at(op, 'responses');
  // 显式状态或原有 5XX 通配响应均可；本任务不强制新建 500 / 504 响应条目。
  const response = at(responses, Object.hasOwn(responses, status) ? status : '5XX');
  const content = at(response, 'content');
  expect(Object.keys(content)).toEqual(['application/json']);
  const schema = at(content, 'application/json', 'schema');
  expect(schema).toEqual(at(doc, 'components', 'schemas', 'ErrorEnvelope'));
  check(compile(schema), { code, msg: '受理失败', trace_id: 'ct08f-trace' }, true);
}

it('[AC-CT-08f#2] 受理结果未知用同一 client_msg_id 重试且不保证未计数，保留请求体与 200 的三个示例', async () => {
  const doc = await contract();
  const op = at(doc, 'paths', sendPath, 'post');
  sendShape(op);
  jsonError(doc, op, '504', 50401);
  const value = description(op);
  for (const marker of ['50401', 'same client_msg_id', 'not guaranteed']) {
    expect(value).toContain(marker);
  }
});

it('[AC-CT-08f#3] 待人工处理返回 JSON 50001 并引导新建对话，先于 ⑦ 且保留 ①–⑩ 顺序', async () => {
  const doc = await contract();
  const op = at(doc, 'paths', sendPath, 'post');
  acceptanceOrder(op);
  jsonError(doc, op, '500', 50001);
  const value = description(op);
  for (const marker of ['50001', 'pending manual handling', 'new session', 'before ⑦']) {
    expect(value).toContain(marker);
  }
});

it('[AC-CT-08f#4] 取消按取得锁后的截止与终止原因判 30505，重复成功幂等 200 且保证 cancelled，形状与码集不变', async () => {
  const op = commonShape(await contract(), cancelPath, 'cancelAgentRun', 'run_id');
  cancelShape(op);
  const codes = list(op['x-error-codes']);
  expect(new Set(codes)).toEqual(new Set([30501, 10001, 10005, 10004, 30505, 10405]));
  for (const code of codes) {
    expect(code).toBeTypeOf('number');
    liveCode(code as number);
  }
  const value = description(op);
  for (const marker of [
    '30505',
    'deadline',
    'end reason',
    'already cancelled',
    '200',
    'finish_reason=cancelled',
    'after the run row is locked',
  ]) {
    expect(value).toContain(marker);
  }
  expect(value).not.toContain('Repeating the call while it runs is harmless');
});

it.each([
  {
    ac: 5,
    code: 30505,
    http: 404,
    retry: '否',
    retry_kind: 'never',
    meaning: ['终止原因', '截止'],
    action: [],
  },
  {
    ac: 6,
    code: 50001,
    http: 500,
    retry: '是',
    retry_kind: 'immediate',
    meaning: ['待人工处理'],
    action: ['新建对话'],
  },
  {
    ac: 7,
    code: 50401,
    http: 504,
    retry: '是',
    retry_kind: 'immediate',
    meaning: ['受理结果未知', '不保证未计数'],
    action: ['同一 client_msg_id'],
  },
])('[AC-CT-08f#$ac] $code 同步受理或取消含义与动作，保留 HTTP 和重试策略', (expected) => {
  const entry = liveCode(expected.code);
  expect(entry).toMatchObject({
    code: expected.code,
    http: expected.http,
    retry: expected.retry,
    retry_kind: expected.retry_kind,
  });
  expect(list(entry['sources'])).toContain('BR-AI-23');
  for (const marker of expected.meaning) expect(text(entry['meaning'])).toContain(marker);
  for (const marker of expected.action) expect(text(entry['action'])).toContain(marker);
});
