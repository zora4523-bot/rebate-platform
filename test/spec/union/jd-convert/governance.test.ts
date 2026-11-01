import { expect, it } from 'vitest';
import type { QuotaLimiter, Scheduler } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createGovernedAdapter,
  type UnionAdapter,
} from '../../../../apps/api/src/modules/union/index.ts';
import { endpoint, response, setup } from '../jd-core/kit.ts';
import { num } from '../jd-orders/kit.ts';
import { clickUrl, ctx, expectNothingSent, failure, identity, reply, req, wire } from './kit.ts';

// 注入固定调度器：退避立即结束，超时只等待取消；不读取宿主时钟或监听端口。
const scheduler: Scheduler = {
  now: () => 0,
  sleep: (ms, signal) =>
    ms < 3000
      ? Promise.resolve()
      : new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
};

function govern(raw: UnionAdapter) {
  const take: QuotaLimiter['tryAcquire'] = () => true;
  return createGovernedAdapter(raw, {
    endpoint,
    scheduler,
    quota: { bucketKey: endpoint.quotaKey, tryAcquire: take },
  });
}

it('[AC-B1-04zd#40] 治理包装后转链可到达注入传输，带治理层的取消信号', async () => {
  const h = wire();
  await expect(govern(h.adapter).convert(req, identity, ctx)).resolves.toEqual({
    kind: 'url',
    url: clickUrl,
  });
  expect(h.transport).toHaveBeenCalledTimes(1);
  expect(h.transport.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
});

it.each([
  ['内层 429', reply(failure(num('429'))), 'rate_limited'],
  ['内层 2001609', reply(failure(num('2001609'))), 'upstream_unavailable'],
  ['内层 2001104', reply(failure(num('2001104'))), 'item_unavailable'],
  ['HTTP 503', response({}, 503), 'upstream_unavailable'],
] as const)('[AC-B1-04zd#41] 真实 convert 端口遇到 %s 只发送一次', async (_name, answer, code) => {
  const h = wire(answer);
  await expect(govern(h.adapter).convert(req, identity, ctx)).rejects.toMatchObject({
    code,
    platform: 'jd',
  });
  expect(h.transport).toHaveBeenCalledTimes(1);
});

it('[AC-B1-04zd#42] 没有 siteId 时经治理仍是 adapter_unimplemented，不取凭据、不发请求', async () => {
  const h = setup();
  await expect(govern(h.adapter).convert(req, identity, ctx)).rejects.toMatchObject({
    code: 'adapter_unimplemented',
    platform: 'jd',
  });
  expectNothingSent(h);
});
