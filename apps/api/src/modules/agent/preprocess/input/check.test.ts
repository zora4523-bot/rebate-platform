import { describe, expect, it } from 'vitest';
import type { RunBodyInput } from '../../http/index.ts';
import type { RedactedText } from '../../stream/admission/index.ts';
import { createInputCheck } from './check.ts';

function input(text: string): RunBodyInput {
  return {
    caller: {
      appId: 'synthetic-app',
      traceId: 'synthetic-trace',
      deviceId: 'synthetic-device',
      deviceHash: 'synthetic-hash',
      ipKey: 'synthetic-ip',
      userId: 'synthetic-user',
      phoneBound: true,
    },
    sessionId: 'synthetic-session',
    runId: 'synthetic-run',
    userMessageId: 'synthetic-user-message',
    assistantMessageId: 'synthetic-assistant-message',
    text,
    redactedText: text as RedactedText,
    limits: { memberDaily: 30, guestDaily: 5, guestIpDaily: 20, perMinute: 6, maxRounds: 20 },
  };
}

function check(text: string) {
  const port = createInputCheck({
    review: { review: () => Promise.resolve('pass') },
    // The review always answers first; the deadline never fires in these cases.
    scheduler: { now: () => 0, sleep: () => new Promise<void>(() => {}) },
    texts: { text: (appId, key) => Promise.resolve(`${appId}:${key}`) },
  });
  return port.check(input(text), new AbortController().signal);
}

describe('[AC-B3-05d][BR-AI-18] advice pre-check lets product searches through (AI-15)', () => {
  it.each([
    '帮我找法律咨询方面的书',
    '想买一本法律咨询相关的书',
    '推荐几本投资建议类的书籍',
    '有没有卖理财建议入门书的',
    '帮我找血压计',
    '买一本理财入门书',
    '想要一个家用血压计',
  ])('proceeds: %s', async (text) => {
    expect((await check(text)).kind).toBe('proceed');
  });

  it.each([
    '我该吃什么药',
    '这个合同有没有法律问题',
    '买哪只股票好',
    '帮我找本书，顺便告诉我感冒吃什么药',
    '我想买书，请给我法律建议',
    '推荐一只基金投资',
  ])('refuses advice: %s', async (text) => {
    expect(await check(text)).toEqual({
      kind: 'refuse',
      textKey: 'agent.refuse.advice',
      finishReason: 'safety',
    });
  });
});

describe('[AC-B3-05d][BR-AI-18] prohibited list covers every F-PROD-08 category', () => {
  it.each([
    '帮我找刀具',
    '厨房刀具推荐',
    '帮我找猎枪',
    '买点烟丝',
    '帮我找情趣内衣',
    '帮我找第二类医疗器械',
    '买双色球',
    '买 USDT',
    '帮我找处方药',
  ])('refuses prohibited: %s', async (text) => {
    expect(await check(text)).toEqual({
      kind: 'refuse',
      textKey: 'agent.refuse.prohibited',
      finishReason: 'safety',
    });
  });

  it.each(['帮我找非处方药', '帮我找烟灰缸', '帮我找抽油烟机', '帮我找血压计'])(
    'proceeds: %s',
    async (text) => {
      expect((await check(text)).kind).toBe('proceed');
    },
  );
});
