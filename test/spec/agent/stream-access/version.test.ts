// B3-03i 第 9 节 3：当前 AgentConsent 版本的来源（BR-AI-13「version=当前 AgentConsent 版本」；出处按规划
// B3-05-plan §1.3 G-2 / U-1 的默认：配置键 legal.ai_third_party.version，缺省 1 并告警，口径同
// createQuotaLimitsSource）。合法值（正安全整数）原样返回；缺键或值不合法 → 1 并 warn 一次；读取失败 →
// 拒绝，不取默认。
import { expect, it } from 'vitest';

import { createConsentVersionSource } from '../../../../apps/api/src/modules/agent/stream/access/index.ts';
import { APP, FakeConfig, OTHER_APP } from './kit.ts';

/** Plan G-2 / U-1. */
const KEY = 'legal.ai_third_party.version';

function warnLog(): { warns: unknown[][]; logger: { warn: (...args: unknown[]) => void } } {
  const warns: unknown[][] = [];
  return { warns, logger: { warn: (...args: unknown[]) => void warns.push(args) } };
}

it('[AC-B3-03i#11][BR-AI-13] 合法版本（正安全整数）原样返回、不告警；按 app_id 读各自的值，每次调用都读', async () => {
  const config = new FakeConfig().set(APP, KEY, 2).set(OTHER_APP, KEY, 7);
  const { warns, logger } = warnLog();
  const version = createConsentVersionSource({ reader: config, logger });
  expect(await version(APP)).toBe(2);
  expect(await version(OTHER_APP)).toBe(7);
  config.set(APP, KEY, 3);
  expect(await version(APP), 'a raised version is seen on the next call').toBe(3);
  config.set(APP, KEY, 1);
  expect(await version(APP)).toBe(1);
  expect(warns).toEqual([]);
  expect(config.asked).toEqual(expect.arrayContaining([`${APP}:${KEY}`, `${OTHER_APP}:${KEY}`]));
});

it('[AC-B3-03i#12][BR-AI-13] 键缺失 → 1，并 warn 一次（提到该键）；每次调用各告警一次', async () => {
  const { warns, logger } = warnLog();
  const version = createConsentVersionSource({ reader: new FakeConfig(), logger });
  expect(await version(APP)).toBe(1);
  expect(warns).toHaveLength(1);
  expect(JSON.stringify(warns[0])).toContain(KEY);
  expect(await version(APP)).toBe(1);
  expect(warns).toHaveLength(2);
  // Without a logger the default still applies.
  expect(await createConsentVersionSource({ reader: new FakeConfig() })(APP)).toBe(1);
});

it.each([
  { value: 0 },
  { value: -2 },
  { value: 1.5 },
  { value: '2' },
  { value: true },
  { value: null },
  { value: [3] },
  { value: Number.MAX_SAFE_INTEGER + 1 },
])(
  '[AC-B3-03i#13][BR-AI-13] 值不是正安全整数（$value）→ 1，并 warn 一次（提到该键）',
  async (c) => {
    const { warns, logger } = warnLog();
    const config = new FakeConfig().set(APP, KEY, c.value);
    const version = createConsentVersionSource({ reader: config, logger });
    expect(await version(APP)).toBe(1);
    expect(warns).toHaveLength(1);
    expect(JSON.stringify(warns[0])).toContain(KEY);
  },
);

it('[AC-B3-03i#14][BR-AI-13] 读取失败 → 拒绝（reject），不取默认 1、不沿用上一次的值', async () => {
  const config = new FakeConfig().set(APP, KEY, 4);
  const version = createConsentVersionSource({ reader: config });
  expect(await version(APP)).toBe(4);
  config.fail = true;
  let rejected = false;
  let answer: unknown = 'not settled';
  try {
    answer = await version(APP);
  } catch (error) {
    rejected = true;
    expect(String(error)).not.toMatch(/NotImplemented/);
  }
  expect({ rejected, answer }).toEqual({ rejected: true, answer: 'not settled' });
});
