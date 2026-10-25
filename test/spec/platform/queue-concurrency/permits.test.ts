// B1-01zzk 全局预算: the permit pool the worker's business lanes share (contract section 12 of
// apps/api/src/modules/platform/queue/index.ts, ./permits.ts). At most `size` permits are held at
// once; the others wait, first come first served; an aborted wait holds nothing.
// Unit tests: no database, no port. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { createPermits } from '../../../../apps/api/src/modules/platform/queue/index.ts';

/** Lets every pending promise reaction run. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

it('[B1-01zzk 全局预算] createPermits(2)：前 2 个 acquire 立即拿到，其余排队等待（不是失败）；每次 release 把许可交给等得最久的；任何时刻持有数不超过 2', async () => {
  const permits = createPermits(2);
  const open = new AbortController().signal;
  const order: string[] = [];
  const counts: Array<[number, number]> = [];
  const note = () => counts.push([permits.held(), permits.waiting()]);
  const take = (label: string) =>
    permits.acquire(open).then((ok) => {
      order.push(`${label}:${String(ok)}`);
    });
  const pending = ['a', 'b', 'c', 'd', 'e'].map(take);
  await flush();
  note();
  const first = [...order];
  permits.release();
  await flush();
  note();
  const second = [...order];
  permits.release();
  permits.release();
  await flush();
  note();
  const third = [...order];
  permits.release();
  permits.release();
  await flush();
  note();
  await Promise.all(pending);
  expect({ size: permits.size, first, second, third, all: order, counts }).toStrictEqual({
    size: 2,
    first: ['a:true', 'b:true'],
    second: ['a:true', 'b:true', 'c:true'],
    third: ['a:true', 'b:true', 'c:true', 'd:true', 'e:true'],
    all: ['a:true', 'b:true', 'c:true', 'd:true', 'e:true'],
    counts: [
      [2, 3],
      [2, 2],
      [2, 0],
      [0, 0],
    ],
  });
});

it('[B1-01zzk 全局预算; 停止] 等待中的 acquire 在信号中止时以 false 解决、不占许可、退出队列，许可交给下一个等待者；信号已中止时即使有空闲许可也以 false 解决', async () => {
  const permits = createPermits(1);
  const open = new AbortController().signal;
  const seen: Record<string, unknown> = { holder: await permits.acquire(open) };
  const stop = new AbortController();
  const stopped = permits.acquire(stop.signal);
  const next = permits.acquire(open);
  await flush();
  seen.waitingBefore = permits.waiting();
  stop.abort();
  seen.stopped = await stopped;
  seen.afterAbort = [permits.held(), permits.waiting()];
  permits.release();
  seen.next = await next;
  seen.afterHandOver = [permits.held(), permits.waiting()];
  permits.release();
  const gone = new AbortController();
  gone.abort();
  seen.preAborted = await permits.acquire(gone.signal);
  seen.final = [permits.held(), permits.waiting()];
  expect(seen).toStrictEqual({
    holder: true,
    waitingBefore: 2,
    stopped: false,
    afterAbort: [1, 1],
    next: true,
    afterHandOver: [1, 0],
    preAborted: false,
    final: [0, 0],
  });
});
