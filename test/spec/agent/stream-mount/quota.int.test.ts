// B3-03f 额度接线（BR-AI-23 ⑩、BR-AI-15；B3-03g：同一个 QuotaLimitsSource 交给 createPgRunPorts 与
// AgentHttpDeps.limits）。运营把会员日额度设成非默认的 2（config_items agent.member_daily_quota）：
// - HTTP 受理一侧：第三条新消息被拒 30502（data 带 reset_at），不建 run、已用额度不变；
// - PG 结算一侧：前两条的 done 帧 quota_left 依次是 1、0——结算按同一份额度计算剩余（默认额度源会给出别的值）；
// - runtime.limits 就是两侧共用的那个实例：每条消息经它读一次额度（spy 计数），把它的读数临时换成更小的额度，
//   受理与结算同时看到（受理拒绝且不另建 run）。
// 降级空结果（fallback、未出卡）按 BR-AI-15 计入额度（不退），所以用放行的输入检查缝让 run 计数。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';

import {
  APP,
  PassInputCheck,
  consent,
  framesOf,
  message,
  newMember,
  openAgent,
  openSession,
  refusedCode,
  rig,
  runsOf,
  send,
  setConfig,
  usePgEach,
  usedOf,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);

function quotaLeftOf(chunks: readonly string[]): unknown {
  const frames = framesOf(chunks);
  const last = frames[frames.length - 1]!;
  expect(last.event).toBe('done');
  return last.data['quota_left'];
}

it('[AC-B3-03f#20][BR-AI-23][BR-AI-15] 会员日额度设为 2：前两条 done 的 quota_left 依次 1、0（结算用配置额度），第三条 30502、不建 run、已用不变；runtime.limits 每条消息被读一次', async () => {
  const caller = await newMember(pg.db);
  await openAgent(pg.db);
  await setConfig(pg.db, APP, 'agent.member_daily_quota', 2);
  await consent(pg.db, caller);
  const r = await rig(pg.db, { inputCheck: new PassInputCheck() });
  const current = vi.spyOn(r.runtime.limits, 'current');
  const sessionId = await openSession(r, caller);

  const first = await send(r, caller, sessionId, message('帮我找保温杯'));
  expect(first.jsons).toEqual([]);
  expect(quotaLeftOf(first.chunks)).toBe(1);
  const second = await send(r, caller, sessionId, message('帮我找水杯'));
  expect(second.jsons).toEqual([]);
  expect(quotaLeftOf(second.chunks)).toBe(0);
  expect(await usedOf(pg.db, caller.userId!)).toBe(2);

  const third = await send(r, caller, sessionId, message('帮我找茶杯'));
  expect(refusedCode(third)).toBe(30502);
  expect(third.jsons[0]!.body['data']).toHaveProperty('reset_at');
  expect(await runsOf(pg.db, sessionId)).toHaveLength(2);
  expect(await usedOf(pg.db, caller.userId!)).toBe(2);
  expect(current).toHaveBeenCalledTimes(3);
  expect(current.mock.calls.every(([appId]) => appId === APP)).toBe(true);
}, 60_000);

it('[AC-B3-03f#21][BR-AI-23] 同一个 limits 实例：把 runtime.limits 的读数换成会员日额度 1，受理侧第二条即 30502，结算侧第一条 done 的 quota_left 为 0', async () => {
  const caller = await newMember(pg.db);
  await openAgent(pg.db);
  await consent(pg.db, caller);
  const r = await rig(pg.db, { inputCheck: new PassInputCheck() });
  const real = r.runtime.limits.current.bind(r.runtime.limits);
  vi.spyOn(r.runtime.limits, 'current').mockImplementation(async (appId: string) => ({
    ...(await real(appId)),
    memberDaily: 1,
  }));
  const sessionId = await openSession(r, caller);

  const first = await send(r, caller, sessionId, message('帮我找保温杯'));
  expect(first.jsons).toEqual([]);
  expect(quotaLeftOf(first.chunks)).toBe(0);
  const second = await send(r, caller, sessionId, message('帮我找水杯'));
  expect(refusedCode(second)).toBe(30502);
  expect(await runsOf(pg.db, sessionId)).toHaveLength(1);
}, 60_000);
