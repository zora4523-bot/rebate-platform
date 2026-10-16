import { expect, it } from 'vitest';
import { expectFault, expectOpen, fastPolicy, fault, registry, rig, success, trip } from './kit.ts';

it('[AC-B1-14d#7] openMs 内拒绝查询，到点后恢复发送并持续成功', async () => {
  const r = rig(registry(), fault('server_error'));
  await trip(r);
  r.upstream.reply = success();
  await r.advance(fastPolicy.breaker.openMs - 1);
  const early = r.search();
  await r.advance(0);
  expectOpen(early);
  expect(r.transport).toHaveBeenCalledTimes(fastPolicy.breaker.minRequests);
  expect(r.take).toHaveBeenCalledTimes(fastPolicy.breaker.minRequests);

  await r.advance(1);
  const resumed = r.search();
  await r.advance(0);
  expect(resumed.settled).toBe('resolved');
  expect(resumed.value?.items).toHaveLength(1);
  expect(r.transport).toHaveBeenCalledTimes(3);
  expect(r.take).toHaveBeenCalledTimes(3);
  for (let i = 0; i < 2; i += 1) {
    const recovered = r.search();
    await r.advance(0);
    expect(recovered.settled).toBe('resolved');
    expect(recovered.value?.items).toHaveLength(1);
  }
  expect(r.transport).toHaveBeenCalledTimes(5);
  expect(r.take).toHaveBeenCalledTimes(5);
  expect(r.scheduler.pending).toBe(0);
});

it('[AC-B1-14d#8] openMs 到点清空窗口，失败重新攒满 minRequests 才再次熔断', async () => {
  const r = rig(registry(), fault('server_error'));
  await trip(r);
  // openMs 小于 windowMs，旧失败尚未自然过期；必须在关闭熔断时清空。
  expect(fastPolicy.breaker.openMs).toBeLessThan(fastPolicy.breaker.windowMs);
  await r.advance(fastPolicy.breaker.openMs);
  for (let attempt = 1; attempt <= fastPolicy.breaker.minRequests; attempt += 1) {
    const failed = r.search();
    await r.advance(0);
    // 未满 minRequests 时下一次仍发出；恰好达到阈值的本次也必须发出。
    expectFault(failed, 'server_error');
    expect(r.transport).toHaveBeenCalledTimes(fastPolicy.breaker.minRequests + attempt);
    expect(r.take).toHaveBeenCalledTimes(fastPolicy.breaker.minRequests + attempt);
  }
  const sent = fastPolicy.breaker.minRequests * 2;
  const blocked = r.search();
  await r.advance(0);
  expectOpen(blocked);
  expect(r.transport).toHaveBeenCalledTimes(sent);
  expect(r.take).toHaveBeenCalledTimes(sent);
  r.upstream.reply = success();
  await r.advance(fastPolicy.breaker.openMs - 1);
  const early = r.search();
  await r.advance(0);
  expectOpen(early);
  expect(r.transport).toHaveBeenCalledTimes(sent);
  expect(r.take).toHaveBeenCalledTimes(sent);
  await r.advance(1);
  const recovered = r.search();
  await r.advance(0);
  expect(recovered.settled).toBe('resolved');
  expect(recovered.value?.items).toHaveLength(1);
  expect(r.transport).toHaveBeenCalledTimes(sent + 1);
  expect(r.take).toHaveBeenCalledTimes(sent + 1);
  expect(r.scheduler.pending).toBe(0);
});
