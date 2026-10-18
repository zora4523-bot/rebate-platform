import { expect, it, vi } from 'vitest';
import {
  backfillOrderSource,
  type OrderSourcePorts,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { applicationInput, at, capture, log, matched, NONE, sourcePorts } from './kit.ts';

it.each([undefined, false])(
  '[AC-B1-08j#20] clickCode=%s 时有 lk 也不查 exact；缺省窗口为 360h',
  async (enabled) => {
    const f = sourcePorts();
    const request = applicationInput();
    const ports = enabled === undefined ? f.ports : { ...f.ports, clickCode: () => enabled };
    expect(await backfillOrderSource(ports, request)).toEqual(matched(log()));
    expect(f.linkByCode).not.toHaveBeenCalled();
    expect(f.productKey).toHaveBeenCalledExactlyOnceWith({ platform: 'pdd', order: request.order });
    expect(f.linkLogs).toHaveBeenCalledExactlyOnceWith({
      appId: 'app-one',
      userId: 'user-U',
      platform: 'pdd',
      from: at('2026-10-05T12:00:00+08:00'),
      to: request.attrAt,
    });
    expect(f.productKey.mock.invocationCallOrder[0]).toBeLessThan(
      f.linkLogs.mock.invocationCallOrder[0]!,
    );
  },
);

it('[AC-B1-08j#21] 开关按当前平台查询，exact 只使用本 app/platform/lk', async () => {
  const f = sourcePorts();
  const clickCode = vi.fn((platform: string) => platform === 'pdd');
  f.linkByCode.mockResolvedValue({
    link_id: 'exact',
    user_id: 'user-U',
    scene: 'share',
    agent_session_id: 'S8',
  });
  expect(await backfillOrderSource({ ...f.ports, clickCode }, applicationInput())).toEqual({
    source_match: 'exact',
    link_id: 'exact',
    source_scene: 'share',
    agent_session_id: 'S8',
  });
  expect(clickCode).toHaveBeenCalledWith('pdd');
  expect(f.linkByCode).toHaveBeenCalledExactlyOnceWith({
    appId: 'app-one',
    platform: 'pdd',
    lk: 'a1b2c3',
  });
  expect(f.productKey).not.toHaveBeenCalled();
  expect(f.linkLogs).not.toHaveBeenCalled();
});

it.each(['missing', 'other-user', 'no-port', 'no-code'] as const)(
  '[AC-B1-08j#22] exact %s 则回退 product',
  async (condition) => {
    const f = sourcePorts();
    if (condition === 'other-user')
      f.linkByCode.mockResolvedValue({ ...log(), link_id: 'exact', user_id: 'other' });
    const ports: OrderSourcePorts = { ...f.ports, clickCode: () => true };
    if (condition === 'no-port') delete ports.linkByCode;
    const request = applicationInput();
    const input =
      condition === 'no-code'
        ? {
            ...request,
            order: {
              ...request.order,
              attr_params: { relation_id: null, sub_union_id: null, custom_parameters: '{}' },
            },
          }
        : request;
    expect(await backfillOrderSource(ports, input)).toEqual(matched(log()));
    expect(f.linkByCode).toHaveBeenCalledTimes(
      condition === 'no-port' || condition === 'no-code' ? 0 : 1,
    );
  },
);

it('[AC-B1-08j#23] 推不出商品时可走 shop，shopId 空则 none；窗口配置传给端口与匹配器', async () => {
  const row = log({ created_at: at('2026-10-19T12:00:00+08:00') });
  const f = sourcePorts([row]);
  f.productKey.mockResolvedValue(null);
  expect(
    await backfillOrderSource({ ...f.ports, windowHours: () => 24 }, applicationInput()),
  ).toEqual(matched(row, 'shop'));
  expect(f.linkLogs.mock.calls[0]?.[0].from).toEqual(at('2026-10-19T12:00:00+08:00'));
  expect(await backfillOrderSource(f.ports, applicationInput({ shopId: null }))).toEqual(NONE);
  expect(
    await backfillOrderSource({ ...f.ports, windowHours: () => 23 }, applicationInput()),
  ).toEqual(NONE);
});

it.each(['linkByCode', 'productKey', 'linkLogs'] as const)(
  '[AC-B1-08j#24] %s 抛错原样向上传递，不吞成 none',
  async (port) => {
    const f = sourcePorts();
    const failure = new Error(`synthetic ${port} failure`);
    f[port].mockRejectedValue(failure);
    const result = await capture(() =>
      backfillOrderSource({ ...f.ports, clickCode: () => true }, applicationInput()),
    );
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('error', failure);
    if (!result.ok) expect(result.error).toBe(failure);
    expect(f[port]).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-08j#25] 复用入口按当时 userId 匹配，不沿用旧主人的来源；输入不变', async () => {
  const old = log({ user_id: 'old-owner' });
  const current = log({
    user_id: 'new-owner',
    link_id: 'new-link',
    scene: 'search',
    agent_session_id: null,
  });
  const f = sourcePorts([old, current]);
  const request = applicationInput({ userId: 'new-owner' });
  const before = structuredClone(request);
  expect(await backfillOrderSource(f.ports, request)).toEqual(matched(current));
  expect(f.linkLogs.mock.calls[0]?.[0].userId).toBe('new-owner');
  expect(request).toEqual(before);
});

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-08j#41] 其他平台开关开启不能让 %s 走 exact',
  async (platform) => {
    const row = log({ platform });
    const f = sourcePorts([row]);
    const base = applicationInput();
    const request = {
      ...base,
      platform,
      order: {
        ...base.order,
        platform,
        attr_params: {
          relation_id: null,
          sub_union_id: 'n_abcd1234_a1b2c3',
          custom_parameters: '{"lk":"a1b2c3"}',
        },
      },
    };
    const clickCode = vi.fn((asked: string) => asked !== platform);
    expect(await backfillOrderSource({ ...f.ports, clickCode }, request)).toEqual(matched(row));
    expect(clickCode).toHaveBeenCalledWith(platform);
    expect(f.linkByCode).not.toHaveBeenCalled();
  },
);
