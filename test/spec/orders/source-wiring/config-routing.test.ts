import { expect, it, vi } from 'vitest';
import { backfillOrderSource } from '../../../../apps/api/src/modules/orders/index.ts';
import {
  applicationInput,
  at,
  capture,
  log,
  matched,
  sourcePorts,
} from '../source-backfill/kit.ts';
import type { ConfiguredSources } from './kit.ts';

it.each([true, false])(
  '[AC-B1-08q#2] 新异步配置端口按 App/平台调用并覆盖旧端口，exact 开关=%s',
  async (enabled) => {
    const f = sourcePorts();
    const clickCode = vi.fn(() => !enabled);
    const windowHours = vi.fn(() => 1);
    const sourceConfig = vi.fn(async () => ({
      clickCodeEnabled: enabled,
      backfillWindowHours: 480,
    }));
    f.linkByCode.mockResolvedValue({
      link_id: 'exact',
      user_id: 'user-U',
      scene: 'share',
      agent_session_id: null,
    });
    const ports: ConfiguredSources = { ...f.ports, clickCode, windowHours, sourceConfig };
    const request = applicationInput({ appId: 'app-scoped' });
    const result = await capture(() => backfillOrderSource(ports, request));
    expect(sourceConfig).toHaveBeenCalledExactlyOnceWith('app-scoped', 'pdd');
    expect(result).toEqual({
      ok: true,
      value: enabled
        ? {
            source_match: 'exact',
            link_id: 'exact',
            source_scene: 'share',
            agent_session_id: null,
          }
        : matched(log()),
    });
    expect(clickCode).not.toHaveBeenCalled();
    expect(windowHours).not.toHaveBeenCalled();
    if (enabled) {
      expect(f.linkByCode).toHaveBeenCalledExactlyOnceWith({
        appId: 'app-scoped',
        platform: 'pdd',
        lk: 'a1b2c3',
      });
      expect(f.productKey).not.toHaveBeenCalled();
      expect(f.linkLogs).not.toHaveBeenCalled();
    } else {
      expect(f.linkByCode).not.toHaveBeenCalled();
      expect(f.linkLogs).toHaveBeenCalledExactlyOnceWith({
        appId: 'app-scoped',
        userId: request.userId,
        platform: 'pdd',
        from: at('2026-09-30T12:00:00+08:00'),
        to: request.attrAt,
      });
      expect(f.productKey).toHaveBeenCalledExactlyOnceWith({
        platform: 'pdd',
        order: request.order,
      });
    }
  },
);

it('[AC-B1-08q#3] 新配置端口的窗口用于候选判定，开关开但缺短码口仍回退 product', async () => {
  const row = log({ created_at: at('2026-10-01T12:00:00+08:00') });
  const f = sourcePorts([row]);
  const sourceConfig = vi.fn(async () => ({ clickCodeEnabled: true, backfillWindowHours: 480 }));
  const ports: ConfiguredSources = { linkLogs: f.linkLogs, productKey: f.productKey, sourceConfig };
  const result = await capture(() => backfillOrderSource(ports, applicationInput()));
  expect(result).toEqual({ ok: true, value: matched(row) });
  expect(sourceConfig).toHaveBeenCalledExactlyOnceWith('app-one', 'pdd');
});

it('[AC-B1-08q#4] 新配置端口失败原样上抛，不查询候选或写成 none', async () => {
  const f = sourcePorts();
  const failure = new Error('synthetic source config failure');
  const sourceConfig = vi.fn(async () => {
    throw failure;
  });
  const ports: ConfiguredSources = { ...f.ports, sourceConfig };
  const result = await capture(() => backfillOrderSource(ports, applicationInput()));
  expect(result).toEqual({ ok: false, error: failure });
  if (!result.ok) expect(result.error).toBe(failure);
  expect(f.linkByCode).not.toHaveBeenCalled();
  expect(f.productKey).not.toHaveBeenCalled();
  expect(f.linkLogs).not.toHaveBeenCalled();
});
