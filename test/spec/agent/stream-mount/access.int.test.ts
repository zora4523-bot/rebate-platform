// B3-03f 第 9 节 3：受理校验 ①–③ 经真实 config_items / consent_records（B3-03i 三端口 + B1-02r 同意读取，由
// createAgentStreamRuntime 装配）。每个码一例：agent.enabled=false 或缺键 → 30501；agent.require_phone=true 时
// 游客 → 10001、未绑手机 → 10005；无同意、已撤回、版本落后（legal.ai_third_party.version=2、记录是 v1）→ 10004
// （data.consent_type=ai_third_party）。被拒的请求不建会话、agent_runs 不增行、额度不变（agent_* 表快照不变）。
// 通过 ①–③ 的对照请求落到 ④（会话不存在 → 30504），证明拒绝来自 ①–③ 而不是更后面的步骤。
import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import { FakeReply } from '../stream-recovery/kit.ts';
import {
  APP,
  agentSnapshot,
  consent,
  message,
  newGuest,
  newMember,
  openAgent,
  openSession,
  refusedCode,
  retrace,
  rig,
  runsOf,
  send,
  setConfig,
  usePgEach,
  type Rig,
} from './kit.ts';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';

const pg = usePgEach(createTestDatabase);

/** sendMessage to a session that does not exist, and createSession; both answers' codes. */
async function codes(r: Rig, caller: AgentCaller): Promise<{ send: unknown; create: unknown }> {
  const sent = await send(r, caller, randomUUID(), message());
  const created = new FakeReply();
  await r.runtime.http.createSession(retrace(caller), created);
  return { send: refusedCode(sent), create: refusedCode(created) };
}

it('[AC-B3-03f#3][BR-AI-23][BR-AI-12] ① agent.enabled=false → 30501；缺键 → 30501；被拒不写 agent_* 表', async () => {
  const off = await newMember(pg.db, { appId: APP });
  await openAgent(pg.db, APP);
  await setConfig(pg.db, APP, 'agent.enabled', false);
  await consent(pg.db, off);
  const missingApp = 'couli-b3-03f-missing';
  const missing = await newMember(pg.db, { appId: missingApp });
  await setConfig(pg.db, missingApp, 'agent.whitelist_only', false);
  await consent(pg.db, missing);
  const r = await rig(pg.db);
  const before = await agentSnapshot(pg.db);

  expect(await codes(r, off)).toEqual({ send: 30501, create: 30501 });
  expect(await codes(r, missing)).toEqual({ send: 30501, create: 30501 });
  expect(await agentSnapshot(pg.db)).toBe(before);
}, 60_000);

it('[AC-B3-03f#4][BR-AI-23][BR-AI-11][BR-ID-03] ② agent.require_phone=true：游客 → 10001、未绑手机 → 10005；已绑手机通过 ①–③ 落到 ④ 30504；被拒不写 agent_* 表', async () => {
  await openAgent(pg.db);
  await setConfig(pg.db, APP, 'agent.require_phone', true);
  const guest = await newGuest(pg.db);
  const unbound = await newMember(pg.db, { phoneBound: false });
  const bound = await newMember(pg.db);
  for (const caller of [guest, unbound, bound]) await consent(pg.db, caller);
  const r = await rig(pg.db);
  const before = await agentSnapshot(pg.db);

  expect(await codes(r, guest)).toEqual({ send: 10001, create: 10001 });
  expect(await codes(r, unbound)).toEqual({ send: 10005, create: 10005 });
  expect(await agentSnapshot(pg.db)).toBe(before);
  const passed = await send(r, bound, randomUUID(), message());
  expect(refusedCode(passed)).toBe(30504);
}, 60_000);

it('[AC-B3-03f#5][BR-AI-13][BR-AI-23] ③ 无同意、已撤回、版本落后 → 10004（consent_type=ai_third_party）；当前版本的同意通过 ①–③ 落到 ④ 30504；被拒不写 agent_* 表', async () => {
  await openAgent(pg.db);
  await setConfig(pg.db, APP, 'legal.ai_third_party.version', 2);
  const none = await newMember(pg.db);
  const withdrawn = await newMember(pg.db);
  await consent(pg.db, withdrawn, { version: 2 });
  await consent(pg.db, withdrawn, { version: 2, accepted: false });
  const outdated = await newMember(pg.db);
  await consent(pg.db, outdated, { version: 1 });
  const current = await newMember(pg.db);
  await consent(pg.db, current, { version: 2 });
  const r = await rig(pg.db);
  const before = await agentSnapshot(pg.db);

  for (const [name, caller] of [
    ['none', none],
    ['withdrawn', withdrawn],
    ['outdated', outdated],
  ] as const) {
    const sent = await send(r, caller, randomUUID(), message());
    expect(refusedCode(sent), name).toBe(10004);
    expect(sent.jsons[0]!.body['data'], name).toEqual({ consent_type: 'ai_third_party' });
    expect((await codes(r, caller)).create, name).toBe(10004);
  }
  expect(await agentSnapshot(pg.db)).toBe(before);
  const passed = await send(r, current, randomUUID(), message());
  expect(refusedCode(passed)).toBe(30504);
}, 60_000);

it('[AC-B3-03f#19][BR-AI-13] 运行中发布新同意版本：同一 runtime 先以 v1 同意受理；legal.ai_third_party.version 发布为 2 并过了配置缓存期后，旧 v1 同意 → 10004、不建 run；补写 v2 同意后恢复受理（版本不被永久缓存）', async () => {
  await openAgent(pg.db);
  await setConfig(pg.db, APP, 'legal.ai_third_party.version', 1);
  const caller = await newMember(pg.db);
  await consent(pg.db, caller, { version: 1 });
  const r = await rig(pg.db);
  const sessionId = await openSession(r, caller);
  const first = await send(r, caller, sessionId, message());
  expect(first.jsons, 'v1 consent is accepted while v1 is current').toEqual([]);
  expect(await runsOf(pg.db, sessionId)).toHaveLength(1);

  await setConfig(pg.db, APP, 'legal.ai_third_party.version', 2);
  // Past any configuration cache lifetime (content's reader: 60 s).
  await r.time.by(61_000);
  const outdated = await send(r, caller, sessionId, message());
  expect(refusedCode(outdated)).toBe(10004);
  expect(outdated.jsons[0]!.body['data']).toEqual({ consent_type: 'ai_third_party' });
  expect(await runsOf(pg.db, sessionId)).toHaveLength(1);

  await consent(pg.db, caller, { version: 2 });
  const again = await send(r, caller, sessionId, message());
  expect(again.jsons, 'accepted again after consenting to v2').toEqual([]);
  expect(again.streams).toHaveLength(1);
  expect(await runsOf(pg.db, sessionId)).toHaveLength(2);
}, 60_000);
