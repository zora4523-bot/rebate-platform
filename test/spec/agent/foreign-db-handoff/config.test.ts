// B3-08k (D10-294): createAgentConfigReader (stream/mount/config.ts) keeps the semantics of
// createAgentSwitchReader without a database handle: agent.* keys through the injected reader's
// freshConfigValue, read at most once per (appId, key) while the age on the injected clock is in
// [0, 1 000) ms (followup 23), every answer a deep copy; other keys through configValue as they
// are. FixedClock only; no database.
import { expect, it } from 'vitest';

import type { ContentConfig } from '../../../../apps/api/src/modules/content/index.ts';
import { createAgentConfigReader } from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import { APP, FakeContentReader, fixedClock } from './kit.ts';

/** A key that is not agent.* although it starts with "agent" (no dot after it). */
const AGENTS_KEY = 'agents.version';
const ROUTES = 'agent.page_guide.routes';
const FAILED = 'fixture: config read failed';

function row(value: ContentConfig['value']): ContentConfig {
  return { value, version: 1 };
}

it('[AC-B3-08k#4] agent.* 键：同一 (appId, key) 1 秒内只读一次注入读取器的 freshConfigValue，满 1 000 ms 重读，时钟回拨重读；别的 app 或别的键各读各的', async () => {
  const clock = fixedClock();
  const content = new FakeContentReader()
    .set(APP, 'agent.enabled', true)
    .set('other', 'agent.enabled', false)
    .set(APP, 'agent.require_phone', true);
  const reader = createAgentConfigReader({ clock, content });
  const fresh = (appId: string, key: string) => content.count('freshConfigValue', appId, key);

  expect(await reader.configValue(APP, 'agent.enabled')).toEqual(row(true));
  expect(fresh(APP, 'agent.enabled')).toBe(1);
  clock.advanceMs(999);
  expect(await reader.configValue(APP, 'agent.enabled')).toEqual(row(true));
  expect(fresh(APP, 'agent.enabled'), 'age 999 ms: kept').toBe(1);

  expect(await reader.configValue('other', 'agent.enabled')).toEqual(row(false));
  expect(await reader.configValue(APP, 'agent.require_phone')).toEqual(row(true));
  expect(fresh('other', 'agent.enabled')).toBe(1);
  expect(fresh(APP, 'agent.require_phone')).toBe(1);

  // The switch changes; it is seen once the kept answer is 1 000 ms old.
  content.set(APP, 'agent.enabled', false);
  clock.advanceMs(1);
  expect(await reader.configValue(APP, 'agent.enabled')).toEqual(row(false));
  expect(fresh(APP, 'agent.enabled'), 'age 1 000 ms: read again').toBe(2);

  // A clock moved back is no reason to keep an answer.
  clock.advanceMs(-1);
  expect(await reader.configValue(APP, 'agent.enabled')).toEqual(row(false));
  expect(fresh(APP, 'agent.enabled'), 'clock moved back: read again').toBe(3);

  // A missing agent.* key is null, kept like any other answer.
  expect(await reader.configValue(APP, 'agent.whitelist_only')).toBeNull();
  expect(await reader.configValue(APP, 'agent.whitelist_only')).toBeNull();
  expect(fresh(APP, 'agent.whitelist_only')).toBe(1);
  expect(content.keys('configValue')).toEqual([]);
});

it('[AC-B3-08k#4] 非 agent.* 键走注入读取器的 configValue（ordinary），本层不缓存；agent.* 前缀按 "agent." 判定', async () => {
  const clock = fixedClock();
  const content = new FakeContentReader()
    .set(APP, 'search.enabled.taobao', true)
    .set(APP, AGENTS_KEY, 2);
  const reader = createAgentConfigReader({ clock, content });

  expect(await reader.configValue(APP, 'search.enabled.taobao')).toEqual(row(true));
  expect(await reader.configValue(APP, 'search.enabled.taobao')).toEqual(row(true));
  expect(await reader.configValue(APP, AGENTS_KEY)).toEqual(row(2));
  expect(content.count('configValue', APP, 'search.enabled.taobao')).toBe(2);
  expect(content.count('configValue', APP, AGENTS_KEY)).toBe(1);
  expect(content.keys('freshConfigValue')).toEqual([]);
});

it('[AC-B3-08k#4] agent.* 的答案是深拷贝：改动返回值不改读取器里的值，也不改 1 秒内的下一次答案', async () => {
  const clock = fixedClock();
  const content = new FakeContentReader().set(APP, ROUTES, {
    routes: ['Wallet'],
    nested: { level: 1 },
  });
  const reader = createAgentConfigReader({ clock, content });

  const first = await reader.configValue(APP, ROUTES);
  expect(first).toEqual(row({ routes: ['Wallet'], nested: { level: 1 } }));
  expect(first!.value, 'not the reader object').not.toBe(content.stored(APP, ROUTES));
  const changed = first!.value as { routes: string[]; nested: { level: number } };
  changed.routes.push('Orders');
  changed.nested.level = 2;

  const second = await reader.configValue(APP, ROUTES);
  expect(content.count('freshConfigValue', APP, ROUTES), 'within 1 s: kept').toBe(1);
  expect(second).toEqual(row({ routes: ['Wallet'], nested: { level: 1 } }));
  expect(second!.value).not.toBe(first!.value);
  expect(content.stored(APP, ROUTES)).toEqual({ routes: ['Wallet'], nested: { level: 1 } });
});

it('[AC-B3-08k#4] agent.* 读取失败：拒绝原样传出、不留缓存，下一次重新读', async () => {
  const clock = fixedClock();
  const content = new FakeContentReader().fail(APP, 'agent.enabled');
  const reader = createAgentConfigReader({ clock, content });

  await expect(reader.configValue(APP, 'agent.enabled')).rejects.toThrow(FAILED);
  await expect(reader.configValue(APP, 'agent.enabled')).rejects.toThrow(FAILED);
  expect(content.count('freshConfigValue', APP, 'agent.enabled')).toBe(2);
});
